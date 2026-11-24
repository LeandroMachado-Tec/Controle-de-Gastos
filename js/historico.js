/**
 * js/historico.js
 * =============================================================================
 * CONTROLE DE GASTOS — Histórico financeiro (Etapa 8-A, Parte 2).
 *
 * FONTE REAL DE DADOS
 *   Tabela public.payment_history — SOMENTE LEITURA (RLS
 *   payment_history_select_own: apenas as linhas do próprio usuário; sem
 *   policies de escrita — o histórico é gravado exclusivamente pelas RPCs).
 *   Colunas usadas (todas reais): id, user_id, entity_type
 *   ('expense_installment'|'debt_occurrence'), occurrence_id, installment_id,
 *   action ('created'|'updated'|'paid'|'reverted'|'deleted'), amount, due_date,
 *   reference (snapshot textual), occurred_at (timestamptz).
 *
 * DECISÃO: sem junção com v_agenda — "reference" é snapshot autossuficiente
 * ("Nubank - competencia 10/2026", "Compra X - parcela 2/3") e registros de
 * itens excluídos permanecem legíveis. Nada depende da existência atual da
 * parcela/competência.
 *
 * FILTROS DE DATA E FUSO
 *   occurred_at é timestamptz (UTC). "De/Até" representam DIAS LOCAIS do
 *   usuário: converte-se meia-noite local → UTC (toISOString) para gte e
 *   23:59:59.999 local → UTC para lte. Exibição via toLocaleString('pt-BR').
 *
 * SEGURANÇA
 *   requireAuth() antes de QUALQUER consulta (anônimo → login; inativo →
 *   aviso). Isolamento garantido pela RLS — os filtros da interface são só UX.
 *   Somente leitura: nenhuma escrita/exclusão. Interface montada com
 *   createElement/textContent (nada de innerHTML com dados do banco).
 * =============================================================================
 */

import {
  requireAuth,
  logout,
  normalizarErro,
  obterCliente
} from './supabase.js';

import { formatarMoeda } from './charts.js';

/* -----------------------------------------------------------------------------
 * Referências (IDs conferidos em historico.html)
 * --------------------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);

const el = {
  chip: $('usuario-chip'),
  inicial: $('usuario-inicial'),
  nome: $('usuario-nome'),
  papel: $('usuario-papel'),
  btnTema: $('btn-tema'),
  btnSair: $('btn-sair'),
  erroGlobal: $('estado-erro-global'),
  erroMensagem: $('erro-mensagem'),
  btnTentar: $('btn-tentar-novamente'),
  formFiltros: $('form-filtros'),
  filtroDe: $('filtro-de'),
  filtroAte: $('filtro-ate'),
  filtroEntidade: $('filtro-entidade'),
  filtroAcao: $('filtro-acao'),
  btnAplicar: $('btn-aplicar'),
  btnLimpar: $('btn-limpar-filtros'),
  corpo: $('corpo-historico'),
  contador: $('contador-historico'),
  estadoVazio: $('estado-vazio-historico'),
  estadoVazioDica: $('estado-vazio-dica'),
  btnAnterior: $('btn-pagina-anterior'),
  btnSeguinte: $('btn-pagina-seguinte'),
  infoPaginacao: $('info-paginacao'),
  toasts: $('area-toasts')
};

/* -----------------------------------------------------------------------------
 * Estado
 * --------------------------------------------------------------------------- */
const LIMITE_PAGINA = 20;         // registros por página (range real do banco)
let numeroRequisicao = 0;        // descarta respostas antigas
let offset = 0;
let filtros = { de: '', ate: '', entidade: '', acao: '' };
let acaoRecuperacao = 'repetir';
const CHAVE_TEMA = 'theme';

/* Rótulos dos valores REAIS dos ENUMs (desconhecidos futuros: valor bruto). */
const ROTULO_ENTIDADE = {
  expense_installment: 'Parcela de compra',
  debt_occurrence: 'Competência de dívida'
};

const ROTULO_ACAO = {
  created:  { texto: 'Criação',    classe: 'etiqueta-parcial' },
  updated:  { texto: 'Atualização', classe: 'etiqueta-parcial' },
  paid:     { texto: 'Pagamento',  classe: 'etiqueta-pago' },
  reverted: { texto: 'Reversão',  classe: 'etiqueta-pendente' },
  deleted:  { texto: 'Exclusão',  classe: 'etiqueta-atrasado' }
};

/* -----------------------------------------------------------------------------
 * Utilidades
 * --------------------------------------------------------------------------- */
function dataHoraBR(iso) {
  if (!iso) return '—';
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return '—';
  return data.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function dataBR(iso) {
  if (!iso || typeof iso !== 'string') return '—';
  const p = iso.split('-');
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : iso;
}

/** 'YYYY-MM-DD' local → instante UTC (ISO com Z) na hora informada. */
function localParaUTC(diaISO, hora) {
  if (!diaISO) return null;
  const data = new Date(`${diaISO}T${hora}`);
  if (Number.isNaN(data.getTime())) return null;
  return data.toISOString();
}

function criarElemento(tag, classe, texto) {
  const nodo = document.createElement(tag);
  if (classe) nodo.className = classe;
  if (texto !== undefined && texto !== null) nodo.textContent = texto;
  return nodo;
}

function criarToast(tipo, texto) {
  const toast = criarElemento('div', `toast toast-${tipo}`);
  toast.setAttribute('role', tipo === 'erro' ? 'alert' : 'status');
  toast.textContent = texto;
  toast.addEventListener('click', () => toast.remove());
  el.toasts.appendChild(toast);
  setTimeout(() => toast.remove(), 6000);
}

/* -----------------------------------------------------------------------------
 * Tema (mesmo contrato das demais páginas)
 * --------------------------------------------------------------------------- */
function temaEfetivo() {
  const explicito = document.documentElement.dataset.theme;
  if (explicito === 'claro' || explicito === 'escuro') return explicito;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'escuro' : 'claro';
}

function aplicarTema(tema) {
  if (tema === 'claro' || tema === 'escuro') {
    document.documentElement.dataset.theme = tema;
    try { localStorage.setItem(CHAVE_TEMA, tema); } catch (_e) { /* sem storage */ }
  } else {
    delete document.documentElement.dataset.theme;
    try { localStorage.removeItem(CHAVE_TEMA); } catch (_e) { /* sem storage */ }
  }
  atualizarBotaoTema();
}

function atualizarBotaoTema() {
  const escuro = temaEfetivo() === 'escuro';
  // O ícone é trocado por CSS (data-theme); aqui só o rótulo acessível.
  el.btnTema.setAttribute('aria-label', escuro ? 'Mudar para tema claro' : 'Mudar para tema escuro');
  el.btnTema.setAttribute('title', escuro ? 'Mudar para tema claro' : 'Mudar para tema escuro');
  el.btnTema.dataset.temaAtual = escuro ? 'escuro' : 'claro';
}

/* -----------------------------------------------------------------------------
 * Consulta (payment_history — somente leitura)
 * --------------------------------------------------------------------------- */
function mostrarCarregando() {
  el.erroGlobal.hidden = true;
  el.corpo.innerHTML = '';
  const tr = criarElemento('tr');
  const td = criarElemento('td');
  td.colSpan = 6;
  const interno = criarElemento('div', 'carregando-painel');
  interno.setAttribute('role', 'status');
  interno.setAttribute('aria-label', 'Carregando histórico');
  interno.appendChild(criarElemento('span', 'esqueleto-linha'));
  interno.appendChild(criarElemento('span', 'esqueleto-linha'));
  td.appendChild(interno);
  tr.appendChild(td);
  el.corpo.appendChild(tr);
  el.estadoVazio.hidden = true;
}

async function carregarHistorico() {
  const token = ++numeroRequisicao;
  mostrarCarregando();

  try {
    const client = await obterCliente();
    let consulta = client
      .from('payment_history')
      .select('id, user_id, entity_type, occurrence_id, installment_id, action, amount, due_date, reference, occurred_at');

    // Período: dias LOCAIS convertidos para UTC (occurred_at é timestamptz).
    const gte = localParaUTC(filtros.de, '00:00:00');
    const lte = localParaUTC(filtros.ate, '23:59:59.999');
    if (gte) consulta = consulta.gte('occurred_at', gte);
    if (lte) consulta = consulta.lte('occurred_at', lte);

    if (filtros.entidade) consulta = consulta.eq('entity_type', filtros.entidade);
    if (filtros.acao) consulta = consulta.eq('action', filtros.acao);

    // Ordenação estável: mais recentes primeiro, desempate por id.
    consulta = consulta
      .order('occurred_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + LIMITE_PAGINA - 1);

    const { data, error } = await consulta;
    if (error) throw normalizarErro(error);
    if (token !== numeroRequisicao) return; // resposta antiga: descartar

    const registros = data || [];
    el.corpo.innerHTML = '';
    el.contador.textContent = `${registros.length} registro(s) nesta página`;

    if (!registros.length) {
      el.estadoVazioDica.textContent =
        'Nenhum registro com os filtros atuais. Pague uma parcela ou competência para gerar histórico.';
      el.estadoVazio.hidden = false;
    } else {
      el.estadoVazio.hidden = true;
      const fragmento = document.createDocumentFragment();
      registros.forEach((registro) => fragmento.appendChild(renderizarLinha(registro)));
      el.corpo.appendChild(fragmento);
    }

    el.btnAnterior.disabled = offset === 0;
    el.btnSeguinte.disabled = registros.length < LIMITE_PAGINA;
    el.infoPaginacao.textContent = `Página ${Math.floor(offset / LIMITE_PAGINA) + 1}`;
  } catch (erro) {
    if (token !== numeroRequisicao) return;
    const traduzido = normalizarErro(erro);
    el.corpo.innerHTML = '';
    el.estadoVazio.hidden = true;
    if (traduzido.codigo === 'auth' || traduzido.codigo === 'permissao') {
      acaoRecuperacao = 'login';
      el.erroMensagem.textContent = traduzido.message + ' Faça login novamente para continuar.';
    } else {
      acaoRecuperacao = 'repetir';
      el.erroMensagem.textContent = traduzido.message;
    }
    el.erroGlobal.hidden = false;
  }
}

/* -----------------------------------------------------------------------------
 * Renderização (DOM API — nada de innerHTML com dados do banco)
 * --------------------------------------------------------------------------- */
function renderizarLinha(registro) {
  const tr = criarElemento('tr');

  const tdData = criarElemento('td');
  tdData.setAttribute('data-label', 'Data/hora');
  tdData.appendChild(criarElemento('span', null, dataHoraBR(registro.occurred_at)));
  tr.appendChild(tdData);

  const tdDescricao = criarElemento('td');
  tdDescricao.setAttribute('data-label', 'Descrição');
  const textos = criarElemento('div', 'item-textos');
  textos.appendChild(criarElemento('span', 'item-principal',
    registro.reference || 'Registro do histórico'));
  if (registro.due_date) {
    textos.appendChild(criarElemento('span', 'item-secundario',
      `Vencimento em ${dataBR(registro.due_date)}`));
  }
  tdDescricao.appendChild(textos);
  tr.appendChild(tdDescricao);

  const tdTipo = criarElemento('td');
  tdTipo.setAttribute('data-label', 'Tipo');
  tdTipo.appendChild(criarElemento('span', null,
    ROTULO_ENTIDADE[registro.entity_type] || registro.entity_type || '—'));
  tr.appendChild(tdTipo);

  const tdAcao = criarElemento('td');
  tdAcao.setAttribute('data-label', 'Ação');
  const infoAcao = ROTULO_ACAO[registro.action] ||
    { texto: registro.action || '—', classe: 'etiqueta-parcial' };
  tdAcao.appendChild(criarElemento('span', `etiqueta ${infoAcao.classe}`, infoAcao.texto));
  tr.appendChild(tdAcao);

  const tdValor = criarElemento('td');
  tdValor.setAttribute('data-label', 'Valor');
  tdValor.appendChild(criarElemento('span', 'item-valor',
    registro.amount !== null && registro.amount !== undefined
      ? formatarMoeda(registro.amount)
      : '—'));
  tr.appendChild(tdValor);

  const tdVencimento = criarElemento('td');
  tdVencimento.setAttribute('data-label', 'Vencimento');
  tdVencimento.appendChild(criarElemento('span', null, dataBR(registro.due_date)));
  tr.appendChild(tdVencimento);

  return tr;
}

/* -----------------------------------------------------------------------------
 * Eventos e inicialização
 * --------------------------------------------------------------------------- */
function habilitarControles() {
  document.querySelectorAll('[data-aguardando="js/historico.js"]').forEach((elemento) => {
    elemento.disabled = false;
    elemento.removeAttribute('data-aguardando');
  });
}

function registrarEventos() {
  el.formFiltros.addEventListener('submit', (evento) => {
    evento.preventDefault();
    filtros = {
      de: el.filtroDe.value,
      ate: el.filtroAte.value,
      entidade: el.filtroEntidade.value,
      acao: el.filtroAcao.value
    };
    offset = 0; // nova consulta volta à primeira página
    carregarHistorico();
  });

  el.btnLimpar.addEventListener('click', () => {
    el.filtroDe.value = '';
    el.filtroAte.value = '';
    el.filtroEntidade.value = '';
    el.filtroAcao.value = '';
    filtros = { de: '', ate: '', entidade: '', acao: '' };
    offset = 0;
    carregarHistorico();
  });

  el.btnAnterior.addEventListener('click', () => {
    offset = Math.max(0, offset - LIMITE_PAGINA);
    carregarHistorico();
  });
  el.btnSeguinte.addEventListener('click', () => {
    offset += LIMITE_PAGINA;
    carregarHistorico();
  });

  el.btnTema.addEventListener('click', () => {
    aplicarTema(temaEfetivo() === 'escuro' ? 'claro' : 'escuro');
  });
  el.btnSair.addEventListener('click', () => logout('login.html'));

  el.btnTentar.addEventListener('click', () => {
    if (acaoRecuperacao === 'login') {
      logout('login.html');
    } else {
      acaoRecuperacao = 'repetir';
      carregarHistorico();
    }
  });
}

/* -----------------------------------------------------------------------------
 * Link Admin — exibido SOMENTE quando perfil.role === 'admin' (dado real do
 * banco via requireAuth). A marcação e a injeção ficam em js/navegacao.js.
 * --------------------------------------------------------------------------- */
function adicionarLinkAdmin(perfil) {
  if (typeof window !== 'undefined' && typeof window.cgAdicionarLinkAdmin === 'function') {
    window.cgAdicionarLinkAdmin(perfil);
  }
}

(async function iniciarHistorico() {
  try {
    // Nenhuma consulta acontece antes da autenticação e do status da conta.
    const conta = await requireAuth();
    if (!conta) return; // anônimo → login; inativo → aviso (nada é consultado)

    el.nome.textContent = conta.perfil.full_name || conta.perfil.email || 'Usuário';
    el.papel.textContent = conta.perfil.role === 'admin' ? 'Administrador' : 'Conta pessoal';
    el.inicial.textContent = (el.nome.textContent.trim()[0] || '?').toUpperCase();
    el.chip.hidden = false;

    adicionarLinkAdmin(conta.perfil);

    habilitarControles();
    atualizarBotaoTema();
    registrarEventos();

    await carregarHistorico();
  } catch (erro) {
    const traduzido = normalizarErro(erro);
    acaoRecuperacao = 'repetir';
    el.erroMensagem.textContent = traduzido.message;
    el.erroGlobal.hidden = false;
  }
})();
