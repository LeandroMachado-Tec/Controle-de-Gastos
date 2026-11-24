/**
 * js/dividas.js
 * =============================================================================
 * CONTROLE DE GASTOS — Módulo de dívidas (Fase 7-E).
 *
 * FONTES REAIS (conferidas em database/functions.sql e database/schema.sql)
 *   • Listagem: view pública.v_debt_summary — debt_id, company, category_name,
 *     periodicity, amount, due_day, anchor_date, status, description,
 *     expenses_count/total, occurrences pendentes/pagas, next_due_date,
 *     overdue_count/amount.
 *   • Competências: view pública.v_agenda com kind = 'debt_occurrence'
 *     (id, due_date, status, amount, paid_at, title, reference_period).
 *   • Escrita: EXCLUSIVAMENTE via RPCs — create_debt, update_debt, delete_debt,
 *     ensure_occurrences, update_occurrence, set_occurrence_paid.
 *
 * REGRAS DO BANCO RESPEITADAS (sem reimplementação)
 *   • periodicidade e data-âncora são imutáveis após o cadastro (P0001).
 *   • dívida com gastos vinculados não é excluída (23503, mensagem real).
 *   • competência paga precisa ser revertida antes de editar (P0001).
 *   • uma competência por mês por dívida (23505).
 *   • ensure_occurrences é idempotente (chave única debt_id+reference_period).
 *
 * SEGURANÇA
 *   • requireAuth() protege a página; RLS é o bloqueio definitivo.
 *   • Interface montada com createElement/textContent — nada de innerHTML
 *     com dados do usuário.
 * =============================================================================
 */

import {
  requireAuth,
  logout,
  normalizarErro,
  callRpc,
  obterCliente
} from './supabase.js';

import { categorias, paraCentavos, centavosParaNumero } from './api.js';

import { formatarMoeda } from './charts.js';

/* -----------------------------------------------------------------------------
 * Referências (IDs conferidos em dividas.html)
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
  busca: $('campo-busca'),
  btnNova: $('btn-nova-divida'),
  corpo: $('corpo-dividas'),
  contador: $('contador-dividas'),
  estadoVazio: $('estado-vazio-dividas'),
  modalDivida: $('modal-divida'),
  tituloModal: $('titulo-modal-divida'),
  btnFechar: $('btn-fechar-divida'),
  mensagemDivida: $('mensagem-divida'),
  form: $('form-divida'),
  campoEmpresa: $('campo-empresa'),
  campoCategoria: $('campo-categoria'),
  campoPeriodicidade: $('campo-periodicidade'),
  dicaPeriodicidade: $('dica-periodicidade'),
  campoValor: $('campo-valor'),
  linhaDia: $('linha-dia-vencimento'),
  campoDia: $('campo-dia-vencimento'),
  rotuloDataReferencia: $('rotulo-data-referencia'),
  campoDataReferencia: $('campo-data-referencia'),
  dicaDataReferencia: $('dica-data-referencia'),
  campoDescricao: $('campo-descricao'),
  btnCancelar: $('btn-cancelar-divida'),
  btnSalvar: $('btn-salvar-divida'),
  modalOcorrencias: $('modal-ocorrencias'),
  tituloOcorrencias: $('titulo-ocorrencias'),
  infoDivida: $('info-divida-ocorrencias'),
  mensagemOcorrencias: $('mensagem-ocorrencias'),
  btnGerar: $('btn-gerar-competencias'),
  listaOcorrencias: $('lista-ocorrencias'),
  btnFecharOcorrencias: $('btn-fechar-ocorrencias'),
  modalExcluir: $('modal-excluir-divida'),
  excluirResumo: $('excluir-divida-resumo'),
  mensagemExcluir: $('mensagem-excluir-divida'),
  btnCancelarExcluir: $('btn-cancelar-excluir-divida'),
  btnConfirmarExcluir: $('btn-confirmar-excluir-divida'),
  toasts: $('area-toasts')
};

/* -----------------------------------------------------------------------------
 * Estado
 * --------------------------------------------------------------------------- */
let numeroRequisicao = 0;
let dividasCarregadas = [];      // linhas reais de v_debt_summary
let dividaEmEdicao = null;       // uuid quando editando
let dividaOcorrencias = null;    // dívida aberta no modal de competências
let dividaSendoExcluida = null;  // { id, company }
let categoriasCache = null;
let acaoRecuperacao = 'repetir';
let ultimoFoco = null;
const CHAVE_TEMA = 'theme';

const ROTULO_PERIODICIDADE = { monthly: 'Mensal', annual: 'Anual', once: 'Eventual' };

/* -----------------------------------------------------------------------------
 * Utilidades
 * --------------------------------------------------------------------------- */
function dataBR(iso) {
  if (!iso || typeof iso !== 'string') return '—';
  const p = iso.split('-');
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : iso;
}

function hojeISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

function definirMensagem(elemento, tipo, texto) {
  elemento.className = `mensagem mensagem-${tipo}`;
  elemento.textContent = texto || '';
  elemento.hidden = !texto;
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
 * Listagem (v_debt_summary)
 * --------------------------------------------------------------------------- */
function etiquetaSituacao(linha) {
  if (linha.overdue_count > 0) {
    return criarElemento('span', 'etiqueta etiqueta-atrasado', 'Com atraso');
  }
  if (linha.status === 'pending') {
    return criarElemento('span', 'etiqueta etiqueta-pendente', 'Pendente');
  }
  if (linha.status === 'paid') {
    return criarElemento('span', 'etiqueta etiqueta-pago', 'Quitada');
  }
  return criarElemento('span', 'etiqueta etiqueta-parcial', 'Sem ocorrências');
}

function renderizarLinha(linha) {
  const tr = criarElemento('tr');

  const tdEmpresa = criarElemento('td');
  tdEmpresa.setAttribute('data-label', 'Credor / empresa');
  const textosEmpresa = criarElemento('div', 'item-textos');
  textosEmpresa.appendChild(criarElemento('span', 'item-principal', linha.company));
  if (linha.description) {
    textosEmpresa.appendChild(criarElemento('span', 'item-secundario', linha.description));
  }
  tdEmpresa.appendChild(textosEmpresa);
  tr.appendChild(tdEmpresa);

  const tdCategoria = criarElemento('td');
  tdCategoria.setAttribute('data-label', 'Categoria');
  tdCategoria.appendChild(criarElemento('span', null, linha.category_name || '—'));
  tr.appendChild(tdCategoria);

  const tdPeriodicidade = criarElemento('td');
  tdPeriodicidade.setAttribute('data-label', 'Periodicidade');
  let textoPeriodo = ROTULO_PERIODICIDADE[linha.periodicity] || linha.periodicity;
  if (linha.periodicity === 'monthly' && linha.due_day) {
    textoPeriodo += ` · dia ${linha.due_day}`;
  }
  tdPeriodicidade.appendChild(criarElemento('span', null, textoPeriodo));
  tr.appendChild(tdPeriodicidade);

  const tdValor = criarElemento('td');
  tdValor.setAttribute('data-label', 'Valor');
  tdValor.appendChild(criarElemento('span', 'item-valor',
    linha.amount ? formatarMoeda(linha.amount) : '—'));
  tr.appendChild(tdValor);

  const tdCompetencias = criarElemento('td');
  tdCompetencias.setAttribute('data-label', 'Competências');
  tdCompetencias.appendChild(criarElemento('span', null,
    `${linha.occurrences_paid}/${linha.occurrences_count} pagas · ${linha.occurrences_pending} pendente(s)`));
  tr.appendChild(tdCompetencias);

  const tdGastos = criarElemento('td');
  tdGastos.setAttribute('data-label', 'Gastos vinculados');
  tdGastos.appendChild(criarElemento('span', null,
    linha.expenses_count > 0
      ? `${linha.expenses_count} · ${formatarMoeda(linha.expenses_total)}`
      : '—'));
  tr.appendChild(tdGastos);

  const tdVencimento = criarElemento('td');
  tdVencimento.setAttribute('data-label', 'Próx. venc.');
  tdVencimento.appendChild(criarElemento('span', null, dataBR(linha.next_due_date)));
  tr.appendChild(tdVencimento);

  const tdSituacao = criarElemento('td');
  tdSituacao.setAttribute('data-label', 'Situação');
  const textosSituacao = criarElemento('div', 'item-textos');
  textosSituacao.appendChild(etiquetaSituacao(linha));
  if (linha.overdue_count > 0) {
    textosSituacao.appendChild(criarElemento('span', 'item-secundario',
      `${linha.overdue_count} em atraso · ${formatarMoeda(linha.overdue_amount)}`));
  }
  tdSituacao.appendChild(textosSituacao);
  tr.appendChild(tdSituacao);

  const tdAcoes = criarElemento('td');
  tdAcoes.setAttribute('data-label', 'Ações');

  const btnOcorrencias = criarElemento('button', 'botao-secundario botao-pequeno', 'Competências');
  btnOcorrencias.type = 'button';
  btnOcorrencias.addEventListener('click', () => abrirOcorrencias(linha));
  tdAcoes.appendChild(btnOcorrencias);

  const btnEditar = criarElemento('button', 'botao-fantasma botao-pequeno', 'Editar');
  btnEditar.type = 'button';
  btnEditar.addEventListener('click', () => abrirModalEdicao(linha));
  tdAcoes.appendChild(btnEditar);

  const btnExcluir = criarElemento('button', 'botao-fantasma botao-pequeno', 'Excluir');
  btnExcluir.type = 'button';
  btnExcluir.addEventListener('click', () => abrirModalExclusao(linha));
  tdAcoes.appendChild(btnExcluir);

  tr.appendChild(tdAcoes);
  return tr;
}

function aplicarFiltroBusca() {
  const termo = el.busca.value.trim().toLowerCase();
  el.corpo.innerHTML = '';
  const visiveis = dividasCarregadas.filter((linha) =>
    !termo || (linha.company || '').toLowerCase().includes(termo));

  el.contador.textContent = `${visiveis.length} de ${dividasCarregadas.length} dívida(s)`;

  if (!visiveis.length) {
    el.estadoVazio.hidden = false;
    return;
  }
  el.estadoVazio.hidden = true;
  const fragmento = document.createDocumentFragment();
  visiveis.forEach((linha) => fragmento.appendChild(renderizarLinha(linha)));
  el.corpo.appendChild(fragmento);
}

function mostrarCarregandoLista() {
  el.corpo.innerHTML = '';
  const tr = criarElemento('tr');
  const td = criarElemento('td');
  td.colSpan = 9;
  const interno = criarElemento('div', 'carregando-painel');
  interno.setAttribute('role', 'status');
  interno.setAttribute('aria-label', 'Carregando dívidas');
  interno.appendChild(criarElemento('span', 'esqueleto-linha'));
  interno.appendChild(criarElemento('span', 'esqueleto-linha'));
  td.appendChild(interno);
  tr.appendChild(td);
  el.corpo.appendChild(tr);
  el.estadoVazio.hidden = true;
}

async function carregarDividas() {
  const token = ++numeroRequisicao;
  mostrarCarregandoLista();
  el.erroGlobal.hidden = true;

  try {
    const client = await obterCliente();
    const { data, error } = await client
      .from('v_debt_summary')
      .select('debt_id, company, category_name, category_id, periodicity, amount, due_day, anchor_date, status, description, expenses_count, expenses_total, installments_paid, installments_pending, occurrences_count, occurrences_paid, occurrences_pending, next_due_date, overdue_count, overdue_amount')
      .order('company', { ascending: true });

    if (error) throw normalizarErro(error);
    if (token !== numeroRequisicao) return;

    dividasCarregadas = data || [];
    aplicarFiltroBusca();
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
 * Modal de dívida (criar/editar)
 * --------------------------------------------------------------------------- */
function abrirModal() {
  ultimoFoco = document.activeElement;
  el.modalDivida.hidden = false;
  document.addEventListener('keydown', teclaEscDivida);
}

function fecharModal() {
  el.modalDivida.hidden = true;
  document.removeEventListener('keydown', teclaEscDivida);
  if (ultimoFoco && typeof ultimoFoco.focus === 'function') ultimoFoco.focus();
}

function teclaEscDivida(evento) {
  if (evento.key === 'Escape' && !el.modalDivida.hidden) fecharModal();
}

function atualizarCamposPorPeriodicidade() {
  const periodicidade = el.campoPeriodicidade.value;
  const mensal = periodicidade === 'monthly';
  const anual = periodicidade === 'annual';

  el.linhaDia.hidden = !mensal;
  el.rotuloDataReferencia.textContent =
    mensal ? 'Primeiro vencimento' : anual ? 'Data do vencimento anual' : 'Data do vencimento';
  el.dicaPeriodicidade.textContent = mensal
    ? 'Mensal: gera uma competência por mês, com dia de vencimento fixo.'
    : anual
      ? 'Anual: gera uma competência por ano, no mês e dia da data informada.'
      : 'Eventual: uma única competência, sem recorrência.';
  el.dicaDataReferencia.textContent = mensal
    ? 'Data do primeiro vencimento (âncora da recorrência).'
    : anual
      ? 'Mês e dia desta data definem o vencimento de cada ano.'
      : 'Data em que esta obrigação vence.';
}

function popularCategorias(selecionadaId) {
  el.campoCategoria.innerHTML = '';
  const opcaoNenhuma = criarElemento('option', null, 'Sem categoria');
  opcaoNenhuma.value = '';
  el.campoCategoria.appendChild(opcaoNenhuma);
  (categoriasCache || []).forEach((categoria) => {
    const opcao = criarElemento('option', null,
      categoria.name + (categoria.is_system ? '' : ' •'));
    opcao.value = categoria.id;
    el.campoCategoria.appendChild(opcao);
  });
  el.campoCategoria.value = selecionadaId || '';
}

function abrirModalCriacao() {
  dividaEmEdicao = null;
  el.tituloModal.textContent = 'Nova dívida';
  el.form.reset();
  popularCategorias('');
  el.campoPeriodicidade.value = 'monthly';
  el.campoDataReferencia.value = hojeISO();
  el.campoDia.value = String(new Date().getDate());
  atualizarCamposPorPeriodicidade();
  definirMensagem(el.mensagemDivida, '', '');
  el.btnSalvar.textContent = 'Salvar dívida';
  [el.campoEmpresa, el.campoCategoria, el.campoPeriodicidade, el.campoValor,
   el.campoDia, el.campoDataReferencia, el.campoDescricao].forEach((c) => { c.disabled = false; });
  abrirModal();
  el.campoEmpresa.focus();
}

function abrirModalEdicao(linha) {
  dividaEmEdicao = linha.debt_id;
  el.tituloModal.textContent = 'Editar dívida';
  el.campoEmpresa.value = linha.company;
  popularCategorias(linha.category_id || '');
  el.campoPeriodicidade.value = linha.periodicity;
  el.campoValor.value = linha.amount ? formatarMoeda(linha.amount) : '';
  el.campoDia.value = String(linha.due_day || 1);
  el.campoDataReferencia.value = linha.anchor_date;
  el.campoDescricao.value = linha.description || '';
  atualizarCamposPorPeriodicidade();

  // Regras reais do update_debt: periodicidade e âncora são imutáveis.
  el.campoPeriodicidade.disabled = true;
  el.campoDataReferencia.disabled = true;
  definirMensagem(el.mensagemDivida, 'aviso',
    'Periodicidade e data-âncora não podem ser alteradas depois do cadastro (regra do banco). ' +
    'Para mudá-las, crie uma nova dívida.');
  el.btnSalvar.textContent = 'Salvar alterações';
  abrirModal();
  el.campoEmpresa.focus();
}

function validarFormularioDivida() {
  const problemas = [];
  const empresa = el.campoEmpresa.value.trim();
  const centavos = el.campoValor.value.trim() ? paraCentavos(el.campoValor.value) : 0;
  const dia = Number(el.campoDia.value);
  const mensal = el.campoPeriodicidade.value === 'monthly';

  if (empresa.length < 2 || empresa.length > 120) {
    problemas.push('Informe a empresa/credor (2 a 120 caracteres).');
  }
  if (el.campoValor.value.trim() && (centavos === null || centavos <= 0)) {
    problemas.push('Informe um valor válido maior que zero.');
  }
  if (mensal && (!Number.isInteger(dia) || dia < 1 || dia > 31)) {
    problemas.push('O dia de vencimento deve estar entre 1 e 31.');
  }
  // A data-âncora é obrigatória somente na criação. Na edição ela é
  // imutável, não entra no payload e por isso não pode bloquear a alteração
  // de outros campos (por exemplo, o valor da dívida).
  if (!dividaEmEdicao && !el.campoDataReferencia.value) {
    problemas.push('Informe a data de referência.');
  }
  return { problemas, centavos, empresa };
}

async function salvarDivida(evento) {
  evento.preventDefault();
  const { problemas, centavos, empresa } = validarFormularioDivida();
  if (problemas.length) {
    definirMensagem(el.mensagemDivida, 'erro', problemas.join(' '));
    return;
  }

  const mensal = el.campoPeriodicidade.value === 'monthly';
  el.btnSalvar.disabled = true;
  el.btnSalvar.setAttribute('aria-busy', 'true');
  definirMensagem(el.mensagemDivida, '', '');

  try {
    if (dividaEmEdicao) {
      const payload = {
        company: empresa,
        description: el.campoDescricao.value.trim() || null,
        category_id: el.campoCategoria.value || null,
        amount: el.campoValor.value.trim() ? centavosParaNumero(centavos) : null
      };
      if (mensal) payload.due_day = Number(el.campoDia.value);
      await callRpc('update_debt', { p_id: dividaEmEdicao, p_payload: payload });
      criarToast('sucesso', 'Dívida atualizada.');
    } else {
      const payload = {
        company: empresa,
        description: el.campoDescricao.value.trim() || null,
        category_id: el.campoCategoria.value || null,
        periodicity: el.campoPeriodicidade.value,
        amount: el.campoValor.value.trim() ? centavosParaNumero(centavos) : null,
        anchor_date: el.campoDataReferencia.value
      };
      if (mensal) payload.due_day = Number(el.campoDia.value);
      const retorno = await callRpc('create_debt', { p_payload: payload });
      criarToast('sucesso',
        `Dívida salva. ${retorno && retorno.occurrences_created ? retorno.occurrences_created + ' competência(s) gerada(s).' : ''}`);
    }
    fecharModal();
    await carregarDividas();
  } catch (erro) {
    const traduzido = normalizarErro(erro);
    definirMensagem(el.mensagemDivida, 'erro', traduzido.message); // mensagem real do banco
    criarToast('erro', 'Não foi possível salvar a dívida.');
  } finally {
    el.btnSalvar.disabled = false;
    el.btnSalvar.removeAttribute('aria-busy');
  }
}

/* -----------------------------------------------------------------------------
 * Exclusão
 * --------------------------------------------------------------------------- */
function abrirModalExclusao(linha) {
  dividaSendoExcluida = { id: linha.debt_id, company: linha.company };
  el.excluirResumo.textContent =
    `Excluir “${linha.company}” e todas as suas competências? ` +
    (linha.expenses_count > 0
      ? `ATENÇÃO: esta dívida possui ${linha.expenses_count} gasto(s) vinculado(s) — a exclusão será bloqueada pelo banco.`
      : 'Os gastos vinculados, se existirem no futuro, também impedem a exclusão.');
  definirMensagem(el.mensagemExcluir, '', '');
  ultimoFoco = document.activeElement;
  el.modalExcluir.hidden = false;
  document.addEventListener('keydown', teclaEscExcluir);
  el.btnCancelarExcluir.focus();
}

function fecharModalExclusao() {
  el.modalExcluir.hidden = true;
  document.removeEventListener('keydown', teclaEscExcluir);
  dividaSendoExcluida = null;
  if (ultimoFoco && typeof ultimoFoco.focus === 'function') ultimoFoco.focus();
}

function teclaEscExcluir(evento) {
  if (evento.key === 'Escape' && !el.modalExcluir.hidden) fecharModalExclusao();
}

async function confirmarExclusao() {
  if (!dividaSendoExcluida) return;
  el.btnConfirmarExcluir.disabled = true;
  el.btnConfirmarExcluir.setAttribute('aria-busy', 'true');
  definirMensagem(el.mensagemExcluir, '', '');

  try {
    await callRpc('delete_debt', { p_id: dividaSendoExcluida.id });
    criarToast('sucesso', 'Dívida excluída.');
    fecharModalExclusao();
    await carregarDividas();
  } catch (erro) {
    const traduzido = normalizarErro(erro);
    definirMensagem(el.mensagemExcluir, 'erro', traduzido.message); // motivo real do banco
    criarToast('erro', 'A exclusão não foi concluída.');
  } finally {
    el.btnConfirmarExcluir.disabled = false;
    el.btnConfirmarExcluir.removeAttribute('aria-busy');
  }
}

/* -----------------------------------------------------------------------------
 * Competências (v_agenda kind='debt_occurrence' + RPCs)
 * --------------------------------------------------------------------------- */
function abrirOcorrencias(linha) {
  dividaOcorrencias = linha;
  el.tituloOcorrencias.textContent = `Competências — ${linha.company}`;
  const partes = [ROTULO_PERIODICIDADE[linha.periodicity] || linha.periodicity];
  if (linha.amount) partes.push(formatarMoeda(linha.amount));
  partes.push(`${linha.occurrences_paid}/${linha.occurrences_count} pagas`);
  el.infoDivida.textContent = partes.join(' · ');

  ultimoFoco = document.activeElement;
  el.modalOcorrencias.hidden = false;
  document.addEventListener('keydown', teclaEscOcorrencias);
  carregarOcorrencias();
}

function fecharOcorrencias() {
  el.modalOcorrencias.hidden = true;
  document.removeEventListener('keydown', teclaEscOcorrencias);
  dividaOcorrencias = null;
  if (ultimoFoco && typeof ultimoFoco.focus === 'function') ultimoFoco.focus();
  carregarDividas(); // listagem reflete pagamentos feitos
}

function teclaEscOcorrencias(evento) {
  if (evento.key === 'Escape' && !el.modalOcorrencias.hidden) fecharOcorrencias();
}

function definirMensagemOcorrencias(tipo, texto) {
  definirMensagem(el.mensagemOcorrencias, tipo, texto);
}

async function carregarOcorrencias() {
  if (!dividaOcorrencias) return;
  el.listaOcorrencias.innerHTML = '';
  const carregando = criarElemento('li', 'carregando-painel');
  carregando.setAttribute('role', 'status');
  carregando.setAttribute('aria-label', 'Carregando competências');
  carregando.appendChild(criarElemento('span', 'esqueleto-linha'));
  el.listaOcorrencias.appendChild(carregando);

  try {
    const client = await obterCliente();
    const { data, error } = await client
      .from('v_agenda')
      .select('id, kind, due_date, status, amount, paid_at, title, reference_period, occurrence_id')
      .eq('kind', 'debt_occurrence')
      .eq('debt_id', dividaOcorrencias.debt_id)
      .order('due_date', { ascending: true });

    if (error) throw normalizarErro(error);
    el.listaOcorrencias.innerHTML = '';

    const competencias = data || [];
    if (!competencias.length) {
      const vazio = criarElemento('li', 'estado-vazio');
      const icone = criarElemento('span', 'icone-estado');
      icone.setAttribute('aria-hidden', 'true');
      vazio.appendChild(icone);
      vazio.appendChild(criarElemento('p', 'titulo-estado', 'Nenhuma competência gerada ainda.'));
      el.listaOcorrencias.appendChild(vazio);
      return;
    }

    competencias.forEach((competencia) => {
      el.listaOcorrencias.appendChild(renderizarOcorrencia(competencia));
    });
  } catch (erro) {
    definirMensagemOcorrencias('erro', normalizarErro(erro).message);
  }
}

function renderizarOcorrencia(competencia) {
  const pago = competencia.status === 'paid';
  const li = criarElemento('li', 'item-lancamento');
  li.dataset.ocorrenciaId = competencia.id;

  const textos = criarElemento('div', 'item-textos');
  textos.appendChild(criarElemento('span', 'item-principal',
    `Vencimento ${dataBR(competencia.due_date)}`));
  const secundarios = [`Competência ${dataBR(competencia.reference_period)}`];
  if (pago && competencia.paid_at) {
    const pagoData = new Date(competencia.paid_at);
    secundarios.push(`Pago em ${pagoData.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}`);
  }
  textos.appendChild(criarElemento('span', 'item-secundario', secundarios.join(' · ')));
  li.appendChild(textos);

  const direita = criarElemento('div', 'item-textos');
  direita.style.textAlign = 'right';
  direita.appendChild(criarElemento('span', 'item-valor',
    competencia.amount ? formatarMoeda(competencia.amount) : 'Sem valor'));
  direita.appendChild(criarElemento('span',
    `etiqueta ${pago ? 'etiqueta-pago' : 'etiqueta-pendente'}`,
    pago ? 'Paga' : 'Pendente'));

  const acoes = criarElemento('div');
  acoes.style.marginTop = '6px';

  const btnPagar = criarElemento('button', pago ? 'botao-fantasma botao-pequeno' : 'botao botao-pequeno');
  btnPagar.type = 'button';
  btnPagar.textContent = pago ? 'Reverter' : 'Marcar paga';
  btnPagar.setAttribute('aria-label',
    (pago ? 'Reverter pagamento da competência de ' : 'Marcar como paga a competência de ') +
    dataBR(competencia.due_date));
  btnPagar.addEventListener('click', () => alternarPagamento(competencia, !pago));
  acoes.appendChild(btnPagar);

  if (!pago) {
    const btnEditar = criarElemento('button', 'botao-fantasma botao-pequeno', 'Editar');
    btnEditar.type = 'button';
    btnEditar.setAttribute('aria-label', 'Editar competência de ' + dataBR(competencia.due_date));
    btnEditar.addEventListener('click', () => alternarEdicao(li, competencia));
    acoes.appendChild(btnEditar);
  }

  direita.appendChild(acoes);
  li.appendChild(direita);
  return li;
}

/** Formulário inline de edição (apenas competências pendentes). */
function alternarEdicao(li, competencia) {
  if (li.querySelector('.form-edicao-ocorrencia')) {
    li.querySelector('.form-edicao-ocorrencia').remove();
    return;
  }

  const formulario = criarElemento('form', 'form-edicao-ocorrencia');
  formulario.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:10px;width:100%';

  const grupoValor = criarElemento('div', 'campo-filtro');
  grupoValor.appendChild(criarElemento('label', null, 'Valor (R$)'));
  const inputValor = document.createElement('input');
  inputValor.type = 'text';
  inputValor.inputMode = 'decimal';
  inputValor.value = competencia.amount ? formatarMoeda(competencia.amount) : '';
  inputValor.setAttribute('aria-label', 'Novo valor da competência');
  grupoValor.appendChild(inputValor);

  const grupoData = criarElemento('div', 'campo-filtro');
  grupoData.appendChild(criarElemento('label', null, 'Vencimento'));
  const inputData = document.createElement('input');
  inputData.type = 'date';
  inputData.value = competencia.due_date;
  inputData.setAttribute('aria-label', 'Novo vencimento da competência');
  grupoData.appendChild(inputData);

  const botaoSalvar = criarElemento('button', 'botao botao-pequeno', 'Salvar');
  botaoSalvar.type = 'submit';
  const botaoCancelar = criarElemento('button', 'botao-fantasma botao-pequeno', 'Cancelar');
  botaoCancelar.type = 'button';
  botaoCancelar.addEventListener('click', () => formulario.remove());

  formulario.appendChild(grupoValor);
  formulario.appendChild(grupoData);
  formulario.appendChild(botaoSalvar);
  formulario.appendChild(botaoCancelar);

  formulario.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const centavos = inputValor.value.trim() ? paraCentavos(inputValor.value) : null;
    if (inputValor.value.trim() && (centavos === null || centavos <= 0)) {
      definirMensagemOcorrencias('erro', 'Informe um valor válido maior que zero (ou vazio para manter).');
      return;
    }
    if (!inputData.value) {
      definirMensagemOcorrencias('erro', 'Informe o vencimento.');
      return;
    }

    botaoSalvar.disabled = true;
    botaoSalvar.setAttribute('aria-busy', 'true');
    try {
      await callRpc('update_occurrence', {
        p_id: competencia.id,
        p_amount: centavos !== null ? centavosParaNumero(centavos) : null,
        p_due_date: inputData.value
      });
      definirMensagemOcorrencias('', '');
      criarToast('sucesso', 'Competência atualizada.');
      await carregarOcorrencias();
    } catch (erro) {
      const traduzido = normalizarErro(erro);
      definirMensagemOcorrencias('erro', traduzido.message); // ex.: competência paga, mês duplicado
      botaoSalvar.disabled = false;
      botaoSalvar.removeAttribute('aria-busy');
    }
  });

  li.appendChild(formulario);
  inputValor.focus();
}

async function alternarPagamento(competencia, pago) {
  const li = el.listaOcorrencias.querySelector(`li[data-ocorrencia-id="${competencia.id}"]`);
  const botao = li ? li.querySelector('button') : null;
  if (botao) {
    botao.disabled = true;
    botao.setAttribute('aria-busy', 'true');
  }

  try {
    const retorno = await callRpc('set_occurrence_paid', { p_id: competencia.id, p_paid: pago });
    if (retorno.changed === false) {
      criarToast('aviso', 'Essa competência já estava nessa situação.');
    } else if (pago) {
      criarToast('sucesso', 'Competência marcada como paga.');
    } else {
      criarToast('sucesso', 'Pagamento revertido. A competência voltou a ficar pendente.');
    }
    definirMensagemOcorrencias('', '');
    await carregarOcorrencias();
  } catch (erro) {
    const traduzido = normalizarErro(erro);
    definirMensagemOcorrencias('erro', traduzido.message); // motivo real do banco
    if (botao) {
      botao.disabled = false;
      botao.removeAttribute('aria-busy');
    }
  }
}

async function gerarCompetencias() {
  if (!dividaOcorrencias) return;
  el.btnGerar.disabled = true;
  el.btnGerar.setAttribute('aria-busy', 'true');
  definirMensagemOcorrencias('', '');
  try {
    const criadas = await callRpc('ensure_occurrences', {
      p_debt_id: dividaOcorrencias.debt_id,
      p_until: null // o banco usa hoje + 12 meses (mensal/eventual) ou + 24 (anual)
    });
    criarToast('sucesso',
      criadas > 0 ? `${criadas} nova(s) competência(s) gerada(s).` : 'Nenhuma competência nova a gerar.');
    await carregarOcorrencias();
  } catch (erro) {
    definirMensagemOcorrencias('erro', normalizarErro(erro).message);
  } finally {
    el.btnGerar.disabled = false;
    el.btnGerar.removeAttribute('aria-busy');
  }
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
  document.querySelectorAll('[data-aguardando="js/dividas.js"]').forEach((botao) => {
    botao.disabled = false;
    botao.removeAttribute('data-aguardando');
  });
}

function registrarEventos() {
  // Pesquisa client-side sobre as linhas já carregadas (campo pequeno por usuário)
  let temporizador = null;
  el.busca.addEventListener('input', () => {
    clearTimeout(temporizador);
    temporizador = setTimeout(aplicarFiltroBusca, 250);
  });

  el.btnNova.addEventListener('click', abrirModalCriacao);
  el.form.addEventListener('submit', salvarDivida);
  el.btnCancelar.addEventListener('click', fecharModal);
  el.btnFechar.addEventListener('click', fecharModal);
  el.modalDivida.addEventListener('click', (evento) => {
    if (evento.target === el.modalDivida) fecharModal();
  });
  el.campoPeriodicidade.addEventListener('change', atualizarCamposPorPeriodicidade);

  el.btnFecharOcorrencias.addEventListener('click', fecharOcorrencias);
  el.modalOcorrencias.addEventListener('click', (evento) => {
    if (evento.target === el.modalOcorrencias) fecharOcorrencias();
  });
  el.btnGerar.addEventListener('click', gerarCompetencias);

  el.btnConfirmarExcluir.addEventListener('click', confirmarExclusao);
  el.btnCancelarExcluir.addEventListener('click', fecharModalExclusao);
  el.modalExcluir.addEventListener('click', (evento) => {
    if (evento.target === el.modalExcluir) fecharModalExclusao();
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
      carregarDividas();
    }
  });
}

(async function iniciarDividas() {
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

    categoriasCache = await categorias.listar();
    await carregarDividas();
  } catch (erro) {
    const traduzido = normalizarErro(erro);
    acaoRecuperacao = 'repetir';
    el.erroMensagem.textContent = traduzido.message;
    el.erroGlobal.hidden = false;
  }
})();
