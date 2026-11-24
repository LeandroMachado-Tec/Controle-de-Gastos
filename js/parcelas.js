/**
 * js/parcelas.js
 * =============================================================================
 * CONTROLE DE GASTOS — Agenda de parcelas (Fase 5-D).
 *
 * FONTES REAIS
 *   • Modo geral: view pública.v_agenda (kind = 'expense_installment') com os
 *     filtros efetivamente suportados: status ('pending'|'paid'),
 *     due_date (gte/lte), ordenação por due_date — via api.parcelas.listar.
 *   • Modo ?compra=<expense_id>: api.parcelas.listarPorCompra (tabela
 *     expense_installments) + api.gastos.obter para o banner (dados reais).
 *   • Pagamento/reversão: RPC set_installment_paid(p_id uuid, p_paid boolean)
 *     — afeta UMA parcela; retorno confirmado antes de tocar na interface.
 *
 * SEGURANÇA E CONSISTÊNCIA
 *   • requireAuth() protege a página; a RLS é o bloqueio definitivo.
 *   • Nada de atualização otimista: a linha só muda depois do retorno da RPC.
 *   • Uma operação por parcela por clique: conjunto "emAndamento" + botão
 *     desabilitado durante a chamada.
 *   • Interface montada com createElement/textContent — nunca innerHTML com
 *     dados do usuário/banco.
 * =============================================================================
 */

import {
  requireAuth,
  logout,
  normalizarErro
} from './supabase.js';

import {
  parcelas,
  gastos
} from './api.js';

import { formatarMoeda } from './charts.js';

/* -----------------------------------------------------------------------------
 * Referências (IDs conferidos em parcelas.html)
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
  banner: $('banner-compra'),
  compraTitulo: $('compra-titulo'),
  compraInfo: $('compra-info'),
  compraSituacao: $('compra-situacao'),
  formFiltros: $('form-filtros'),
  filtroStatus: $('filtro-status'),
  filtroDe: $('filtro-de'),
  filtroAte: $('filtro-ate'),
  filtroOrdem: $('filtro-ordem'),
  btnLimpar: $('btn-limpar-filtros'),
  subtituloPagina: $('subtitulo-pagina'),
  resumo: $('resumo-lista'),
  corpo: $('corpo-parcelas'),
  estadoVazio: $('estado-vazio-parcelas'),
  estadoVazioDica: $('estado-vazio-dica'),
  modalReverter: $('modal-reverter'),
  reverterResumo: $('reverter-resumo'),
  mensagemReverter: $('mensagem-reverter'),
  btnCancelarReverter: $('btn-cancelar-reverter'),
  btnConfirmarReverter: $('btn-confirmar-reverter'),
  toasts: $('area-toasts')
};

/* -----------------------------------------------------------------------------
 * Estado
 * --------------------------------------------------------------------------- */
let numeroRequisicao = 0;
let modoCompraId = null;          // ?compra=<expense_id>
let linhasAtuais = [];            // dados reais exibidos (para atualização local)
let parcelaEmReversao = null;     // parcela aguardando confirmação de reversão
let emAndamento = new Set();      // ids com operação em curso (anti clique duplo)
let acaoRecuperacao = 'repetir';
let ultimoFoco = null;
const CHAVE_TEMA = 'theme';

/* -----------------------------------------------------------------------------
 * Utilidades
 * --------------------------------------------------------------------------- */
function dataBR(iso) {
  if (!iso || typeof iso !== 'string') return '—';
  const p = iso.split('-');
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : iso;
}

function dataHoraBR(iso) {
  if (!iso) return '—';
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return '—';
  return data.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
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

function etiquetaSituacao(status) {
  const mapa = {
    paid:    { classe: 'etiqueta-pago',     texto: 'Paga' },
    pending: { classe: 'etiqueta-pendente', texto: 'Pendente' }
  };
  const info = mapa[status] || { classe: 'etiqueta-pendente', texto: status || '—' };
  return criarElemento('span', `etiqueta ${info.classe}`, info.texto);
}

/* -----------------------------------------------------------------------------
 * Tema (mesmo contrato das outras páginas)
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
 * Carga da agenda
 * --------------------------------------------------------------------------- */
function mostrarCarregando() {
  el.erroGlobal.hidden = true;
  el.corpo.innerHTML = '';
  const tr = criarElemento('tr');
  const td = criarElemento('td');
  td.colSpan = 6;
  const interno = criarElemento('div', 'carregando-painel');
  interno.setAttribute('role', 'status');
  interno.setAttribute('aria-label', 'Carregando parcelas');
  interno.appendChild(criarElemento('span', 'esqueleto-linha'));
  interno.appendChild(criarElemento('span', 'esqueleto-linha'));
  td.appendChild(interno);
  tr.appendChild(td);
  el.corpo.appendChild(tr);
  el.estadoVazio.hidden = true;
  el.resumo.textContent = '';
}

function tratarFalha(erro) {
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

async function carregarParcelas() {
  const token = ++numeroRequisicao;
  mostrarCarregando();

  try {
    let linhas;

    if (modoCompraId) {
      linhas = await parcelas.listarPorCompra(modoCompraId);
    } else {
      linhas = await parcelas.listar({
        status: el.filtroStatus.value || null,
        de: el.filtroDe.value || null,
        ate: el.filtroAte.value || null,
        ordem: el.filtroOrdem.value === 'desc' ? 'desc' : 'asc',
        limite: 300
      });
    }

    if (token !== numeroRequisicao) return; // filtro mais recente venceu

    linhasAtuais = linhas || [];
    renderizarLista();
    el.erroGlobal.hidden = true;
  } catch (erro) {
    if (token !== numeroRequisicao) return;
    tratarFalha(erro);
  }
}

/* -----------------------------------------------------------------------------
 * Renderização
 * --------------------------------------------------------------------------- */
function renderizarLista() {
  el.corpo.innerHTML = '';
  contadorResumo();

  if (!linhasAtuais.length) {
    el.estadoVazio.hidden = false;
    el.estadoVazioDica.textContent = modoCompraId
      ? 'Esta compra não tem parcelas (ou já foram excluídas).'
      : 'Ajuste os filtros ou cadastre um gasto em Gastos.';
    return;
  }
  el.estadoVazio.hidden = true;

  const fragmento = document.createDocumentFragment();
  linhasAtuais.forEach((linha) => fragmento.appendChild(renderizarLinha(linha)));
  el.corpo.appendChild(fragmento);
}

/** Resumo com números reais das parcelas listadas (nunca inventado). */
function contadorResumo() {
  if (!linhasAtuais.length) {
    el.resumo.textContent = '';
    return;
  }
  const pagas = linhasAtuais.filter((l) => l.status === 'paid');
  const pendentes = linhasAtuais.filter((l) => l.status === 'pending');
  const somaPagas = pagas.reduce((t, l) => t + (Number(l.amount) || 0), 0);
  const somaPendentes = pendentes.reduce((t, l) => t + (Number(l.amount) || 0), 0);

  const partes = [
    `${linhasAtuais.length} parcela(s) listada(s)`,
    `${pagas.length} paga(s) · ${formatarMoeda(somaPagas)}`,
    `${pendentes.length} pendente(s) · ${formatarMoeda(somaPendentes)}`
  ];
  el.resumo.textContent = partes.join(' · ');
}

function renderizarLinha(linha) {
  const tr = criarElemento('tr');
  tr.dataset.parcelaId = linha.id;

  const tdCompra = criarElemento('td');
  tdCompra.setAttribute('data-label', 'Compra');
  const celulaCompra = criarElemento('div', 'item-textos');
  celulaCompra.appendChild(criarElemento('span', 'item-principal', linha.title || 'Lançamento'));
  const detalhes = [];
  if (linha.subtitle) detalhes.push(linha.subtitle);
  if (linha.category_name) detalhes.push(linha.category_name);
  if (detalhes.length) {
    celulaCompra.appendChild(criarElemento('span', 'item-secundario', detalhes.join(' · ')));
  }
  tdCompra.appendChild(celulaCompra);
  tr.appendChild(tdCompra);

  const tdNumero = criarElemento('td');
  tdNumero.setAttribute('data-label', 'Parcela');
  tdNumero.appendChild(criarElemento('span', null,
    linha.installment_number && linha.installments_total
      ? `${linha.installment_number}/${linha.installments_total}`
      : '—'));
  tr.appendChild(tdNumero);

  const tdVencimento = criarElemento('td');
  tdVencimento.setAttribute('data-label', 'Vencimento');
  tdVencimento.appendChild(criarElemento('span', null, dataBR(linha.due_date)));
  tr.appendChild(tdVencimento);

  const tdValor = criarElemento('td');
  tdValor.setAttribute('data-label', 'Valor');
  tdValor.appendChild(criarElemento('span', 'item-valor', formatarMoeda(linha.amount)));
  tr.appendChild(tdValor);

  const tdSituacao = criarElemento('td');
  tdSituacao.setAttribute('data-label', 'Situação');
  const celulaSituacao = criarElemento('div', 'item-textos');
  celulaSituacao.appendChild(etiquetaSituacao(linha.status));
  if (linha.status === 'paid' && linha.paid_at) {
    celulaSituacao.appendChild(criarElemento('span', 'item-secundario',
      `Pago em ${dataHoraBR(linha.paid_at)}`));
  }
  tdSituacao.appendChild(celulaSituacao);
  tr.appendChild(tdSituacao);

  const tdAcao = criarElemento('td');
  tdAcao.setAttribute('data-label', 'Ação');
  tdAcao.appendChild(criarBotaoAcao(linha));
  tr.appendChild(tdAcao);

  return tr;
}

/** Botão da ação individual (Pagar / Reverter), estado conforme a linha. */
function criarBotaoAcao(linha) {
  const pago = linha.status === 'paid';
  const botao = criarElemento('button', pago ? 'botao-fantasma botao-pequeno' : 'botao botao-pequeno');
  botao.type = 'button';
  botao.textContent = pago ? 'Reverter' : 'Marcar paga';
  botao.setAttribute('aria-label',
    (pago ? 'Reverter pagamento da parcela ' : 'Marcar como paga a parcela ') +
    (linha.installment_number ? `${linha.installment_number}/${linha.installments_total}` : linha.title));

  if (emAndamento.has(linha.id)) {
    botao.disabled = true;
    botao.setAttribute('aria-busy', 'true');
  }

  botao.addEventListener('click', () => {
    if (emAndamento.has(linha.id)) return; // anti clique duplo
    if (pago) {
      abrirModalReversao(linha);            // reversão pede confirmação
    } else {
      aplicarPagamento(linha, true);        // pagar: ação direta, confirmada pelo banco
    }
  });

  return botao;
}

/** Substitui o botão da linha mantendo o estado de carregamento. */
function atualizarBotaoLinha(parcelaId) {
  const linha = linhasAtuais.find((l) => l.id === parcelaId);
  const tr = el.corpo.querySelector(`tr[data-parcela-id="${parcelaId}"]`);
  if (!linha || !tr) return;
  const celulaAcao = tr.querySelector('td[data-label="Ação"]');
  if (!celulaAcao) return;
  celulaAcao.innerHTML = '';
  celulaAcao.appendChild(criarBotaoAcao(linha));
}

/* -----------------------------------------------------------------------------
 * Pagamento / reversão (uma parcela por vez, confirmado pela RPC)
 * --------------------------------------------------------------------------- */
async function aplicarPagamento(linha, pago) {
  if (emAndamento.has(linha.id)) return;
  emAndamento.add(linha.id);
  atualizarBotaoLinha(linha.id);

  try {
    const retorno = await parcelas.definirPagamento(linha.id, pago);

    // Atualiza SOMENTE esta linha com os dados retornados pelo banco.
    linha.status = retorno.status;
    linha.paid_at = retorno.paid_at;
    atualizarBotaoLinha(linha.id);

    const tr = el.corpo.querySelector(`tr[data-parcela-id="${linha.id}"]`);
    if (tr) {
      const celulaSituacao = tr.querySelector('td[data-label="Situação"] > div');
      if (celulaSituacao) {
        celulaSituacao.innerHTML = '';
        celulaSituacao.appendChild(etiquetaSituacao(retorno.status));
        if (retorno.status === 'paid' && retorno.paid_at) {
          celulaSituacao.appendChild(criarElemento('span', 'item-secundario',
            `Pago em ${dataHoraBR(retorno.paid_at)}`));
        }
      }
    }

    contadorResumo(); // indicadores recalculados dos dados reais

    if (retorno.changed === false) {
      criarToast('aviso', 'Essa parcela já estava nessa situação.');
    } else if (pago) {
      criarToast('sucesso',
        `Parcela marcada como paga. ${retorno.installments_pending} restante(s) nesta compra.`);
    } else {
      criarToast('sucesso', 'Pagamento revertido. A parcela voltou a ficar pendente.');
    }
  } catch (erro) {
    const traduzido = normalizarErro(erro);
    criarToast('erro', traduzido.message); // motivo real do banco, sem ocultar
  } finally {
    emAndamento.delete(linha.id);
    atualizarBotaoLinha(linha.id);
  }
}

/* -----------------------------------------------------------------------------
 * Modal de confirmação de reversão
 * --------------------------------------------------------------------------- */
function abrirModalReversao(linha) {
  parcelaEmReversao = linha;
  el.reverterResumo.textContent =
    `Reverter o pagamento da parcela ${linha.installment_number || ''}` +
    `${linha.installments_total ? '/' + linha.installments_total : ''} de ` +
    `“${linha.title}” (${formatarMoeda(linha.amount)}, paga em ${dataHoraBR(linha.paid_at)})?`;
  definirMensagemReverter('', '');
  ultimoFoco = document.activeElement;
  el.modalReverter.hidden = false;
  document.addEventListener('keydown', teclaEsc);
  el.btnCancelarReverter.focus();
}

function fecharModalReversao() {
  el.modalReverter.hidden = true;
  document.removeEventListener('keydown', teclaEsc);
  parcelaEmReversao = null;
  if (ultimoFoco && typeof ultimoFoco.focus === 'function') ultimoFoco.focus();
}

function teclaEsc(evento) {
  if (evento.key === 'Escape' && !el.modalReverter.hidden) fecharModalReversao();
}

function definirMensagemReverter(tipo, texto) {
  el.mensagemReverter.className = `mensagem mensagem-${tipo}`;
  el.mensagemReverter.textContent = texto || '';
  el.mensagemReverter.hidden = !texto;
}

async function confirmarReversao() {
  if (!parcelaEmReversao) return;
  const linha = parcelaEmReversao;
  el.btnConfirmarReverter.disabled = true;
  el.btnConfirmarReverter.setAttribute('aria-busy', 'true');
  try {
    await aplicarPagamento(linha, false);
    fecharModalReversao();
  } finally {
    el.btnConfirmarReverter.disabled = false;
    el.btnConfirmarReverter.removeAttribute('aria-busy');
  }
}

/* -----------------------------------------------------------------------------
 * Banner ?compra=<expense_id>
 * --------------------------------------------------------------------------- */
async function carregarBannerCompra(expenseId) {
  const { compra, parcelas: lista, divida } = await gastos.obter(expenseId);
  el.compraTitulo.textContent = compra.description;
  const partes = [dataBR(compra.purchase_date), formatarMoeda(compra.total_amount)];
  if (divida && divida.company) partes.push(divida.company);
  partes.push(`${compra.installments_count} parcela(s)`);
  el.compraInfo.textContent = partes.join(' · ');
  el.compraSituacao.innerHTML = '';
  const pagas = lista.filter((p) => p.status === 'paid').length;
  const situacao = pagas === 0 ? 'pending' : pagas === lista.length ? 'paid' : 'partial';
  const rotulos = { pending: 'Pendente', partial: 'Parcialmente paga', paid: 'Quitada' };
  const classes = { pending: 'etiqueta-pendente', partial: 'etiqueta-parcial', paid: 'etiqueta-pago' };
  el.compraSituacao.appendChild(
    criarElemento('span', `etiqueta ${classes[situacao]}`,
      `${rotulos[situacao]} · ${pagas}/${lista.length} parcela(s) paga(s)`));
  el.banner.hidden = false;
  el.formFiltros.hidden = true; // modo compra: filtros gerais fora de cena
}

/* -----------------------------------------------------------------------------
 * Eventos e inicialização
 * --------------------------------------------------------------------------- */
/* -----------------------------------------------------------------------------
 * Link Admin — exibido SOMENTE quando perfil.role === 'admin' (dado real do
 * banco via requireAuth). A exibição é apenas UX: a autorização real está nas
 * RPCs admin_* e nas policies is_admin() — página admin.html na Fase 7-H.
 * --------------------------------------------------------------------------- */
function adicionarLinkAdmin(perfil) {
  // A marcação e a injeção ficam em js/navegacao.js (comportamento compartilhado).
  if (typeof window !== 'undefined' && typeof window.cgAdicionarLinkAdmin === 'function') {
    window.cgAdicionarLinkAdmin(perfil);
  }
}

function habilitarControles() {
  document.querySelectorAll('[data-aguardando="js/parcelas.js"]').forEach((botao) => {
    botao.disabled = false;
    botao.removeAttribute('data-aguardando');
  });
}

function registrarEventos() {
  el.filtroStatus.addEventListener('change', carregarParcelas);
  el.filtroDe.addEventListener('change', carregarParcelas);
  el.filtroAte.addEventListener('change', carregarParcelas);
  el.filtroOrdem.addEventListener('change', carregarParcelas);

  el.btnLimpar.addEventListener('click', () => {
    el.filtroStatus.value = '';
    el.filtroDe.value = '';
    el.filtroAte.value = '';
    el.filtroOrdem.value = 'asc';
    carregarParcelas();
  });

  el.btnConfirmarReverter.addEventListener('click', confirmarReversao);
  el.btnCancelarReverter.addEventListener('click', fecharModalReversao);
  el.modalReverter.addEventListener('click', (evento) => {
    if (evento.target === el.modalReverter) fecharModalReversao();
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
      carregarParcelas();
    }
  });
}

(async function iniciarParcelas() {
  try {
    const conta = await requireAuth();
    if (!conta) return; // redirecionado ao login ou conta inativa

    el.nome.textContent = conta.perfil.full_name || conta.perfil.email || 'Usuário';
    el.papel.textContent = conta.perfil.role === 'admin' ? 'Administrador' : 'Conta pessoal';
    el.inicial.textContent = (el.nome.textContent.trim()[0] || '?').toUpperCase();
    el.chip.hidden = false;
    adicionarLinkAdmin(conta.perfil);

    habilitarControles();
    atualizarBotaoTema();
    registrarEventos();

    // Modo ?compra=<expense_id>: valida uuid e filtra para a compra.
    const params = new URLSearchParams(window.location.search);
    const compra = params.get('compra');
    if (compra && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(compra)) {
      modoCompraId = compra;
      el.subtituloPagina.textContent = 'Parcelas de uma compra específica.';
      try {
        await carregarBannerCompra(compra);
      } catch (erro) {
        // Compra inexistente/de outro usuário: banner não abre, agenda fica vazia.
        modoCompraId = null;
        el.formFiltros.hidden = false;
        criarToast('erro', normalizarErro(erro).message);
      }
    } else if (compra) {
      el.subtituloPagina.textContent = 'Identificador de compra inválido — exibindo todas as parcelas.';
    }

    await carregarParcelas();
  } catch (erro) {
    const traduzido = normalizarErro(erro);
    acaoRecuperacao = 'repetir';
    el.erroMensagem.textContent = traduzido.message;
    el.erroGlobal.hidden = false;
  }
})();
