/**
 * js/api.js
 * =============================================================================
 * CONTROLE DE GASTOS — Camada de acesso a dados (Fase 5-B).
 *
 * PRINCÍPIO
 *   Camada FINA sobre os contratos REAIS do banco (database/functions.sql e
 *   database/schema.sql). Nenhuma regra financeira é reimplementada como
 *   autoridade: a divisão de parcelas, a âncora de vencimento e as validações
 *   pertencem às RPCs/constraints. A prévia em JavaScript (preverParcelas)
 *   existe apenas para UX e replica EXATAMENTE public.split_amount e
 *   public.add_months_clamped — o banco continua validando no COMMIT.
 *
 * CONTRATOS UTILIZADOS (conferidos em disco)
 *   RPC create_expense_with_installments(p_payload jsonb)
 *      payload: description, place, purchase_date, total_amount,
 *               installments_count (1..12), first_due_date, debt_id?, idempotency_key
 *      retorno: { expense_id, duplicated, installments:[{number,amount,due_date}],
 *                 installments_total, total_amount, first_due_date, last_due_date }
 *   RPC update_expense(p_id uuid, p_payload jsonb) — bloqueia alteração de
 *      valor/parcelamento/vencimento com parcelas pagas
 *   RPC delete_expense(p_id uuid) — snapshot no histórico + cascade
 *   RPC set_installment_paid(p_id uuid, p_paid boolean) — UMA parcela por vez;
 *      retorno { id, expense_id, status, paid_at, changed, installments_paid,
 *                installments_pending, pending_amount, overall_status }
 *   View v_expense_summary — por compra: installments_paid/pending, paid_amount,
 *      pending_amount, next_due_date, overall_status ('paid'|'partial'|'pending')
 *   View v_agenda — colunas: kind, id, due_date, status, amount, title,
 *      subtitle, category_name, installment_number, installments_total,
 *      expense_id, debt_id (kind = 'expense_installment' nas parcelas)
 *   Tabelas: expenses, expense_installments, debts, categories
 *
 * SEGURANÇA
 *   Toda leitura/escrita passa pela RLS (user_id = auth.uid()) e pelas RPCs
 *   SECURITY DEFINER — este módulo nunca usa chaves privilegiadas.
 * =============================================================================
 */

import { callRpc, normalizarErro, obterCliente } from './supabase.js';

/* -----------------------------------------------------------------------------
 * Utilidades internas (inteiros de centavos — sem ponto flutuante)
 * --------------------------------------------------------------------------- */

/** Converte texto "R$ 1.234,56" / "1234.56" em centavos inteiros (ou null). */
export function paraCentavos(texto) {
  const limpo = String(texto ?? '')
    .replace(/\s/g, '')
    .replace(/r\$/gi, '')
    .replace(/\./g, (m, offset, s) => (s.indexOf(',') > -1 ? '' : m)) // 1.234,56 → 1234,56
    .replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(limpo)) return null;
  const [reais, decimos = ''] = limpo.split('.');
  return Number(reais) * 100 + Number((decimos + '00').slice(0, 2));
}

/** Centavos → número em reais para envio à RPC (que normaliza com money()). */
export function centavosParaNumero(centavos) {
  return (Number(centavos) || 0) / 100;
}

/** UUID v4 para idempotência (regra 17: envio repetido não duplica). */
export function gerarChaveIdempotencia() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  // Fallback (navegadores antigos): UUID v4 via getRandomValues
  const bytes = window.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const ehUuid = (valor) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(valor || ''));

/* -----------------------------------------------------------------------------
 * PRÉVIA DE PARCELAS (espelho exato de split_amount + add_months_clamped)
 * Autoridade final: constraint trigger no banco (soma = total, qtde = N).
 * --------------------------------------------------------------------------- */

/** Último dia do mês (1-based), trata anos bissextos. */
export function ultimoDiaDoMes(ano, mes) {
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

/**
 * Soma meses preservando o DIA ÂNCORA (ex.: 31/01 → 28/02 → 31/03).
 * Idêntico a public.add_months_clamped (functions.sql).
 */
export function somarMesesComAncora(primeiroVencimentoISO, meses) {
  const [ano0, mes0, dia0] = String(primeiroVencimentoISO).split('-').map(Number);
  if (!ano0 || !mes0 || !dia0) return null;
  const totalMeses = (mes0 - 1) + meses;
  const ano = ano0 + Math.floor(totalMeses / 12);
  const mes = (totalMeses % 12) + 1;
  const dia = Math.min(dia0, ultimoDiaDoMes(ano, mes));
  return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

/**
 * Divide um total (em centavos) em N parcelas inteiras de centavos.
 * Idêntico a public.split_amount: o resto vai 1 centavo por parcela,
 * começando da primeira — a soma é EXATAMENTE o total.
 */
export function dividirEmCentavos(centavos, quantidade) {
  const total = Number(centavos) || 0;
  const n = Number(quantidade) || 1;
  if (total <= 0 || n < 1) return [];
  const base = Math.floor(total / n);
  const resto = total % n;
  const partes = [];
  for (let i = 1; i <= n; i++) {
    partes.push(base + (i <= resto ? 1 : 0));
  }
  return partes;
}

/**
 * Prévia para o formulário: [{numero, valor, vencimento}] + somaCentavos.
 * @param {number} centavosTotal      total em centavos (inteiro)
 * @param {number} quantidade         1..12
 * @param {string} primeiroVencimento 'YYYY-MM-DD'
 */
export function preverParcelas(centavosTotal, quantidade, primeiroVencimento) {
  const partes = dividirEmCentavos(centavosTotal, quantidade);
  if (!partes.length) return { parcelas: [], somaCentavos: 0 };
  const parcelas = partes.map((centavos, indice) => ({
    numero: indice + 1,
    centavos,
    valor: centavosParaNumero(centavos),
    vencimento: indice === 0
      ? primeiroVencimento
      : somarMesesComAncora(primeiroVencimento, indice)
  }));
  const somaCentavos = parcelas.reduce((total, p) => total + p.centavos, 0);
  return { parcelas, somaCentavos };
}

/* -----------------------------------------------------------------------------
 * GASTOS
 * --------------------------------------------------------------------------- */
const COLUNAS_RESUMO = [
  'expense_id', 'debt_id', 'description', 'place', 'purchase_date',
  'total_amount', 'installments_count', 'installments_created',
  'installments_paid', 'installments_pending', 'paid_amount',
  'pending_amount', 'next_due_date', 'overall_status', 'created_at'
].join(', ');

const CAMPOS_ORDENACAO = new Set([
  'purchase_date', 'total_amount', 'next_due_date', 'overall_status', 'created_at'
]);

export const gastos = {
  /**
   * Lista compras do usuário com resumo financeiro.
   * @param {object} opcoes { busca, status ('paid'|'partial'|'pending'),
   *                          ordem ('purchase_date'|'total_amount'|'next_due_date'|
   *                          'overall_status'|'created_at'), direcao ('asc'|'desc'),
   *                          limite }
   */
  async listar(opcoes = {}) {
    try {
      const client = await obterCliente();
      let consulta = client
        .from('v_expense_summary')
        .select(COLUNAS_RESUMO);

      if (opcoes.busca && String(opcoes.busca).trim()) {
        const termo = String(opcoes.busca).trim().slice(0, 60).replace(/["\\]/g, '');
        consulta = consulta.or(`description.ilike."*${termo}*",place.ilike."*${termo}*"`);
      }
      if (opcoes.status && ['paid', 'partial', 'pending'].includes(opcoes.status)) {
        consulta = consulta.eq('overall_status', opcoes.status);
      }

      const campo = CAMPOS_ORDENACAO.has(opcoes.ordem) ? opcoes.ordem : 'purchase_date';
      const direcao = opcoes.direcao === 'asc' ? 'asc' : 'desc';
      consulta = consulta.order(campo, { ascending: direcao === 'asc', nullsFirst: false });

      const limite = Math.min(Math.max(Number(opcoes.limite) || 100, 1), 200);
      consulta = consulta.limit(limite);

      const { data, error } = await consulta;
      if (error) throw normalizarErro(error);
      return data || [];
    } catch (erro) {
      throw erro instanceof Error && erro.name === 'ErroApp' ? erro : normalizarErro(erro);
    }
  },

  /** Uma compra + suas parcelas (todas com RLS do próprio usuário). */
  async obter(id) {
    if (!ehUuid(id)) throw normalizarErro(new Error('Compra inválida.'));
    try {
      const client = await obterCliente();
      const { data: compra, error: erroCompra } = await client
        .from('expenses')
        .select('id, debt_id, description, place, purchase_date, total_amount, installments_count, first_due_date, created_at')
        .eq('id', id)
        .maybeSingle();
      if (erroCompra) throw normalizarErro(erroCompra);
      if (!compra) throw normalizarErro(new Error('Compra não encontrada.'));

      const { data: parcelas, error: erroParcelas } = await client
        .from('expense_installments')
        .select('id, installment_number, installments_total, amount, due_date, status, paid_at')
        .eq('expense_id', id)
        .order('installment_number', { ascending: true });
      if (erroParcelas) throw normalizarErro(erroParcelas);

      let divida = null;
      if (compra.debt_id) {
        const { data: dadosDivida, error: erroDivida } = await client
          .from('debts')
          .select('id, company, category_id, status')
          .eq('id', compra.debt_id)
          .maybeSingle();
        if (erroDivida) throw normalizarErro(erroDivida);
        divida = dadosDivida || null;
      }

      return { compra, parcelas: parcelas || [], divida };
    } catch (erro) {
      throw erro instanceof Error && erro.name === 'ErroApp' ? erro : normalizarErro(erro);
    }
  },

  /**
   * Cria a compra + parcelas via RPC transacional (regra 17: idempotência).
   * @param {object} dados { description, place, purchase_date, total_amount,
   *                         installments_count, first_due_date, debt_id }
   * @param {string} chaveIdempotencia uuid gerado no cliente
   */
  async criar(dados, chaveIdempotencia) {
    const payload = {
      description: String(dados.description || '').trim(),
      place: dados.place ? String(dados.place).trim() : null,
      purchase_date: dados.purchase_date,
      total_amount: centavosParaNumero(dados.total_amount_centavos),
      installments_count: Number(dados.installments_count) || 1,
      first_due_date: dados.first_due_date,
      debt_id: dados.debt_id || null,
      idempotency_key: chaveIdempotencia || gerarChaveIdempotencia()
    };
    return callRpc('create_expense_with_installments', { p_payload: payload });
  },

  /**
   * Edita a compra. payload: description, place, purchase_date, debt_id e,
   * quando não houver parcela paga: total_amount, installments_count,
   * first_due_date (a RPC regera as parcelas).
   */
  async atualizar(id, payload) {
    if (!ehUuid(id)) throw normalizarErro(new Error('Compra inválida.'));
    return callRpc('update_expense', { p_id: id, p_payload: payload });
  },

  async excluir(id) {
    if (!ehUuid(id)) throw normalizarErro(new Error('Compra inválida.'));
    return callRpc('delete_expense', { p_id: id });
  }
};

/* -----------------------------------------------------------------------------
 * PARCELAS
 * --------------------------------------------------------------------------- */
export const parcelas = {
  /**
   * Agenda de parcelas (v_agenda) com filtros reais suportados pelo banco.
   * @param {object} opcoes { status ('pending'|'paid'), de ('YYYY-MM-DD'),
   *                          ate ('YYYY-MM-DD'), limite, ordem ('asc'|'desc') }
   */
  async listar(opcoes = {}) {
    try {
      const client = await obterCliente();
      let consulta = client
        .from('v_agenda')
        .select('id, kind, due_date, status, amount, paid_at, title, subtitle, category_name, installment_number, installments_total, expense_id, debt_id')
        .eq('kind', 'expense_installment');

      if (opcoes.status === 'pending' || opcoes.status === 'paid') {
        consulta = consulta.eq('status', opcoes.status);
      }
      if (opcoes.de) consulta = consulta.gte('due_date', opcoes.de);
      if (opcoes.ate) consulta = consulta.lte('due_date', opcoes.ate);

      const direcao = opcoes.ordem === 'desc' ? 'desc' : 'asc';
      consulta = consulta.order('due_date', { ascending: direcao === 'asc' });

      const limite = Math.min(Math.max(Number(opcoes.limite) || 100, 1), 300);
      consulta = consulta.limit(limite);

      const { data, error } = await consulta;
      if (error) throw normalizarErro(error);
      return data || [];
    } catch (erro) {
      throw erro instanceof Error && erro.name === 'ErroApp' ? erro : normalizarErro(erro);
    }
  },

  /** Parcelas de UMA compra (tela de detalhe/edição). */
  async listarPorCompra(expenseId) {
    if (!ehUuid(expenseId)) throw normalizarErro(new Error('Compra inválida.'));
    const client = await obterCliente();
    const { data, error } = await client
      .from('expense_installments')
      .select('id, installment_number, installments_total, amount, due_date, status, paid_at')
      .eq('expense_id', expenseId)
      .order('installment_number', { ascending: true });
    if (error) throw normalizarErro(error);
    return data || [];
  },

  /**
   * Marca UMA parcela como paga/pendente — RPC afeta somente essa linha
   * (nenhuma outra parcela é alterada).
   * @returns jsonb com totais atualizados da compra (para feedback imediato)
   */
  async definirPagamento(parcelaId, pago) {
    if (!ehUuid(parcelaId)) throw normalizarErro(new Error('Parcela inválida.'));
    if (typeof pago !== 'boolean') throw normalizarErro(new Error('Situação inválida.'));
    return callRpc('set_installment_paid', { p_id: parcelaId, p_paid: pago });
  }
};

/* -----------------------------------------------------------------------------
 * DÍVIDAS (para o seletor "Dívida relacionada")
 * --------------------------------------------------------------------------- */
export const dividas = {
  async listar() {
    const client = await obterCliente();
    const { data, error } = await client
      .from('debts')
      .select('id, company, category_id, periodicity, amount, status')
      .order('company', { ascending: true });
    if (error) throw normalizarErro(error);
    return data || [];
  }
};

/* -----------------------------------------------------------------------------
 * CATEGORIAS (sistema + pessoais, com cache por sessão da página)
 * --------------------------------------------------------------------------- */
export const categorias = {
  _cache: null,
  async listar(forcar = false) {
    if (this._cache && !forcar) return this._cache;
    const client = await obterCliente();
    const { data, error } = await client
      .from('categories')
      .select('id, name, is_system')
      .order('is_system', { ascending: false })
      .order('name', { ascending: true });
    if (error) throw normalizarErro(error);
    this._cache = data || [];
    return this._cache;
  }
};

export default { gastos, parcelas, dividas, categorias, paraCentavos, centavosParaNumero, preverParcelas, gerarChaveIdempotencia, dividirEmCentavos, somarMesesComAncora, ultimoDiaDoMes };
