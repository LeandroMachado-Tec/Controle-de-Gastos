/**
 * js/gastos.js
 * =============================================================================
 * CONTROLE DE GASTOS — Controlador da página de gastos (Fase 5-C).
 *
 * Fontes de dados: EXCLUSIVAMENTE js/api.js (camada única) e js/supabase.js.
 * Nada de cliente Supabase paralelo; nenhuma regra financeira local além da
 * PRÉVIA (api.preverParcelas/paraCentavos — espelho das regras do banco; a
 * palavra final é sempre da RPC/constraints).
 *
 * SEGURANÇA
 *   • requireAuth() protege a página; contas inativas/não autenticadas não
 *     chegam a ver dados (e a RLS é o bloqueio definitivo).
 *   • Toda a listagem/prévia é montada com createElement/textContent —
 *     NUNCA innerHTML com dados do usuário.
 *
 * IDEMPOTÊNCIA (regra 17)
 *   • Ao abrir o modal para CRIAR, gera-se uma chave nova
 *     (api.gerarChaveIdempotencia) e a MESMA chave é reutilizada se o usuário
 *     repetir o envio da mesma operação (ex.: clique duplo, falha de rede e
 *     "tentar de novo" sem fechar o formulário).
 *   • Fechar o formulário ou salvar com sucesso invalida a chave: uma nova
 *     compra recebe SEMPRE uma chave nova.
 * =============================================================================
 */

import {
  requireAuth,
  logout,
  normalizarErro
} from './supabase.js';

import {
  gastos,
  dividas,
  preverParcelas,
  paraCentavos,
  gerarChaveIdempotencia,
  centavosParaNumero
} from './api.js';

import { formatarMoeda } from './charts.js';

/* -----------------------------------------------------------------------------
 * Referências (IDs conferidos em gastos.html)
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
  filtroSituacao: $('filtro-situacao'),
  filtroOrdem: $('filtro-ordem'),
  btnNovo: $('btn-novo-gasto'),
  corpo: $('corpo-gastos'),
  contador: $('contador-gastos'),
  estadoVazio: $('estado-vazio-gastos'),
  modalGasto: $('modal-gasto'),
  tituloModal: $('titulo-modal-gasto'),
  btnFechar: $('btn-fechar-gasto'),
  mensagemGasto: $('mensagem-gasto'),
  form: $('form-gasto'),
  campoDescricao: $('campo-descricao'),
  campoValor: $('campo-valor'),
  campoData: $('campo-data-compra'),
  campoLocal: $('campo-local'),
  campoDivida: $('campo-divida'),
  campoParcelas: $('campo-parcelas'),
  campoVencimento: $('campo-primeiro-vencimento'),
  previaContainer: $('previa-parcelas-container'),
  previaLista: $('previa-parcelas'),
  previaSoma: $('previa-soma'),
  previaNota: $('previa-nota'),
  btnCancelar: $('btn-cancelar-gasto'),
  btnSalvar: $('btn-salvar-gasto'),
  modalExcluir: $('modal-excluir'),
  excluirResumo: $('excluir-resumo'),
  mensagemExcluir: $('mensagem-excluir'),
  btnCancelarExcluir: $('btn-cancelar-excluir'),
  btnConfirmarExcluir: $('btn-confirmar-excluir'),
  toasts: $('area-toasts')
};

/* -----------------------------------------------------------------------------
 * Estado
 * --------------------------------------------------------------------------- */
const filtros = { busca: '', situacao: '', ordem: 'purchase_date', direcao: 'desc' };
let numeroRequisicao = 0;         // descarta listagens antigas (busca acelerada)
let dividasCache = [];
let editandoId = null;            // null = criar; uuid = editar
let chaveIdempotenciaAtual = null; // somente para CRIAR
let compraSendoExcluida = null;   // { id, descricao }
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

/** Data de hoje no fuso LOCAL em ISO (sem usar toISOString, que é UTC). */
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

/* -----------------------------------------------------------------------------
 * Tema (mesmo contrato do dashboard: data-theme + localStorage('theme'))
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
 * Listagem
 * --------------------------------------------------------------------------- */
function etiquetaSituacao(status) {
  const mapa = {
    paid:    { classe: 'etiqueta-pago',     texto: 'Quitada' },
    partial: { classe: 'etiqueta-parcial',  texto: 'Parcial' },
    pending: { classe: 'etiqueta-pendente', texto: 'Pendente' }
  };
  const info = mapa[status] || { classe: 'etiqueta-pendente', texto: status || '—' };
  const etiqueta = criarElemento('span', `etiqueta ${info.classe}`, info.texto);
  return etiqueta;
}

function acoesDaLinha(linha) {
  const celula = criarElemento('td');
  celula.setAttribute('data-label', 'Ações');

  const btnEditar = criarElemento('button', 'botao-secundario botao-pequeno', 'Editar');
  btnEditar.type = 'button';
  btnEditar.addEventListener('click', () => abrirModalEdicao(linha.expense_id));
  celula.appendChild(btnEditar);

  const linkParcelas = criarElemento('a', 'botao-fantasma botao-pequeno', 'Parcelas');
  linkParcelas.href = `parcelas.html?compra=${encodeURIComponent(linha.expense_id)}`;
  celula.appendChild(linkParcelas);

  const btnExcluir = criarElemento('button', 'botao-fantasma botao-pequeno', 'Excluir');
  btnExcluir.type = 'button';
  btnExcluir.addEventListener('click', () => abrirModalExclusao(linha));
  celula.appendChild(btnExcluir);

  return celula;
}

function renderizarLinha(linha) {
  const tr = criarElemento('tr');

  const tdDescricao = criarElemento('td');
  tdDescricao.setAttribute('data-label', 'Descrição');
  tdDescricao.appendChild(criarElemento('strong', 'item-principal', linha.description));
  tr.appendChild(tdDescricao);

  const tdLocal = criarElemento('td');
  tdLocal.setAttribute('data-label', 'Local / dívida');
  tdLocal.appendChild(criarElemento('span', null, linha.place || '—'));
  tr.appendChild(tdLocal);

  const tdCompra = criarElemento('td');
  tdCompra.setAttribute('data-label', 'Compra');
  tdCompra.appendChild(criarElemento('span', null, dataBR(linha.purchase_date)));
  tr.appendChild(tdCompra);

  const tdValor = criarElemento('td');
  tdValor.setAttribute('data-label', 'Valor total');
  tdValor.appendChild(criarElemento('span', 'item-valor', formatarMoeda(linha.total_amount)));
  tr.appendChild(tdValor);

  const tdParcelas = criarElemento('td');
  tdParcelas.setAttribute('data-label', 'Parcelas');
  tdParcelas.appendChild(criarElemento('span', null,
    `${linha.installments_paid}/${linha.installments_count} pagas · restam ${formatarMoeda(linha.pending_amount)}`));
  tr.appendChild(tdParcelas);

  const tdVencimento = criarElemento('td');
  tdVencimento.setAttribute('data-label', 'Próximo venc.');
  tdVencimento.appendChild(criarElemento('span', null, dataBR(linha.next_due_date)));
  tr.appendChild(tdVencimento);

  const tdSituacao = criarElemento('td');
  tdSituacao.setAttribute('data-label', 'Situação');
  tdSituacao.appendChild(etiquetaSituacao(linha.overall_status));
  tr.appendChild(tdSituacao);

  tr.appendChild(acoesDaLinha(linha));
  return tr;
}

function mostrarCarregandoLista() {
  el.corpo.innerHTML = '';
  const tr = criarElemento('tr');
  const td = criarElemento('td');
  td.colSpan = 8;
  const interno = criarElemento('div', 'carregando-painel');
  interno.setAttribute('role', 'status');
  interno.setAttribute('aria-label', 'Carregando gastos');
  interno.appendChild(criarElemento('span', 'esqueleto-linha'));
  interno.appendChild(criarElemento('span', 'esqueleto-linha'));
  td.appendChild(interno);
  tr.appendChild(td);
  el.corpo.appendChild(tr);
  el.estadoVazio.hidden = true;
}

async function carregarGastos() {
  const token = ++numeroRequisicao;
  mostrarCarregandoLista();
  el.erroGlobal.hidden = true;

  try {
    const linhas = await gastos.listar({
      busca: filtros.busca,
      status: filtros.situacao,
      ordem: filtros.ordem,
      direcao: filtros.direcao,
      limite: 200
    });

    if (token !== numeroRequisicao) return; // resposta de busca antiga

    el.corpo.innerHTML = '';
    el.contador.textContent = `${linhas.length} gasto(s)`;

    if (!linhas.length) {
      el.estadoVazio.hidden = false;
      return;
    }
    el.estadoVazio.hidden = true;
    const fragmento = document.createDocumentFragment();
    linhas.forEach((linha) => fragmento.appendChild(renderizarLinha(linha)));
    el.corpo.appendChild(fragmento);
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
 * Modal de gasto (criar/editar)
 * --------------------------------------------------------------------------- */
function abrirModal() {
  ultimoFoco = document.activeElement;
  el.modalGasto.hidden = false;
  document.addEventListener('keydown', teclaEsc);
}

function fecharModal() {
  el.modalGasto.hidden = true;
  document.removeEventListener('keydown', teclaEsc);
  if (ultimoFoco && typeof ultimoFoco.focus === 'function') ultimoFoco.focus();
}

function teclaEsc(evento) {
  if (evento.key === 'Escape' && !el.modalGasto.hidden) fecharModal();
}

function definirMensagemGasto(tipo, texto) {
  el.mensagemGasto.className = `mensagem mensagem-${tipo}`;
  el.mensagemGasto.textContent = texto || '';
  el.mensagemGasto.hidden = !texto;
}

function popularSelectDividas(selecionada) {
  el.campoDivida.innerHTML = '';
  const opcaoNenhuma = criarElemento('option', null, 'Sem dívida (gasto avulso)');
  opcaoNenhuma.value = '';
  el.campoDivida.appendChild(opcaoNenhuma);
  dividasCache.forEach((divida) => {
    const opcao = criarElemento('option', null, divida.company);
    opcao.value = divida.id;
    el.campoDivida.appendChild(opcao);
  });
  el.campoDivida.value = selecionada || '';
}

function abrirModalCriacao() {
  editandoId = null;
  chaveIdempotenciaAtual = gerarChaveIdempotencia(); // chave NOVA por compra
  el.tituloModal.textContent = 'Novo gasto';
  el.form.reset();
  el.campoData.value = hojeISO();
  el.campoVencimento.value = hojeISO();
  popularSelectDividas('');
  atualizarPrevia();
  definirMensagemGasto('', '');
  el.btnSalvar.textContent = 'Salvar gasto';
  liberarCamposDeCronograma();
  abrirModal();
  el.campoDescricao.focus();
}

async function abrirModalEdicao(id) {
  try {
    const { compra, parcelas, divida } = await gastos.obter(id);
    const pagas = parcelas.filter((p) => p.status === 'paid').length;

    editandoId = compra.id;
    chaveIdempotenciaAtual = null; // edição não usa idempotência
    el.tituloModal.textContent = 'Editar gasto';
    el.campoDescricao.value = compra.description;
    el.campoValor.value = formatarMoeda(compra.total_amount);
    el.campoData.value = compra.purchase_date;
    el.campoLocal.value = compra.place || '';
    popularSelectDividas(compra.debt_id || '');
    el.campoParcelas.value = String(compra.installments_count);
    el.campoVencimento.value = compra.first_due_date;

    if (pagas > 0) {
      bloquearCamposDeCronograma(
        `Há ${pagas} parcela(s) paga(s): valor, quantidade de parcelas e 1º vencimento ` +
        'não podem mudar. Reverta os pagamentos na tela de Parcelas, se precisar.'
      );
    } else {
      liberarCamposDeCronograma();
    }

    atualizarPrevia();
    definirMensagemGasto('', '');
    el.btnSalvar.textContent = 'Salvar alterações';
    abrirModal();
    el.campoDescricao.focus();
  } catch (erro) {
    criarToast('erro', normalizarErro(erro).message);
  }
}

function bloquearCamposDeCronograma(motivo) {
  [el.campoValor, el.campoParcelas, el.campoVencimento].forEach((campo) => {
    campo.disabled = true;
  });
  definirMensagemGasto('aviso', motivo);
}

function liberarCamposDeCronograma() {
  [el.campoValor, el.campoParcelas, el.campoVencimento].forEach((campo) => {
    campo.disabled = false;
  });
}

/* -----------------------------------------------------------------------------
 * Prévia das parcelas (api.preverParcelas — mesma regra do banco)
 * --------------------------------------------------------------------------- */
function atualizarPrevia() {
  const centavos = paraCentavos(el.campoValor.value);
  const quantidade = Number(el.campoParcelas.value) || 1;
  const vencimento = el.campoVencimento.value;

  const valida = centavos !== null && centavos > 0 && quantidade >= 1 &&
                 quantidade <= 12 && Boolean(vencimento);

  if (!valida) {
    el.previaContainer.hidden = true;
    return;
  }

  const previa = preverParcelas(centavos, quantidade, vencimento);
  el.previaLista.innerHTML = '';

  previa.parcelas.forEach((parcela) => {
    const li = criarElemento('li', 'item-lancamento');
    const textos = criarElemento('div', 'item-textos');
    textos.appendChild(criarElemento('span', 'item-principal',
      `Parcela ${parcela.numero}/${quantidade}`));
    textos.appendChild(criarElemento('span', 'item-secundario',
      `Vence em ${dataBR(parcela.vencimento)}`));
    li.appendChild(textos);
    li.appendChild(criarElemento('span', 'item-valor', formatarMoeda(parcela.valor)));
    el.previaLista.appendChild(li);
  });

  el.previaSoma.textContent = `Soma: ${formatarMoeda(previa.somaCentavos / 100)}`;

  if (previa.somaCentavos !== centavos || previa.parcelas.some((p) => p.centavos < 1)) {
    el.previaNota.textContent =
      'Ajuste o valor: cada parcela precisa de no mínimo R$ 0,01.';
  } else {
    const ultima = previa.parcelas[previa.parcelas.length - 1];
    const dia = Number(vencimento.split('-')[2]);
    el.previaNota.textContent = quantidade > 1
      ? `Último vencimento: ${dataBR(ultima.vencimento)} · âncora: dia ${dia}`
      : `Único vencimento: ${dataBR(ultima.vencimento)}`;
  }

  el.previaContainer.hidden = false;
}

/* -----------------------------------------------------------------------------
 * Salvar (criar/atualizar) — nunca otimista: só sucesso confirmado pelo banco
 * --------------------------------------------------------------------------- */
function validarFormulario() {
  const problemas = [];
  const descricao = el.campoDescricao.value.trim();
  const centavos = paraCentavos(el.campoValor.value);
  const quantidade = Number(el.campoParcelas.value);
  const cronogramaBloqueado = el.campoValor.disabled;

  if (descricao.length < 1 || descricao.length > 160) {
    problemas.push('Informe a descrição (1 a 160 caracteres).');
  }
  if (centavos === null || centavos <= 0) {
    problemas.push('Informe um valor total válido (maior que zero).');
  }
  if (!el.campoData.value) problemas.push('Informe a data da compra.');
  if (!cronogramaBloqueado) {
    if (!quantidade || quantidade < 1 || quantidade > 12) {
      problemas.push('A quantidade de parcelas deve estar entre 1 e 12.');
    }
    if (!el.campoVencimento.value) problemas.push('Informe o vencimento da 1ª parcela.');
    if (centavos !== null && centavos < quantidade) {
      problemas.push('O valor é baixo demais para essa quantidade de parcelas (mínimo R$ 0,01 cada).');
    }
  }
  return { problemas, centavos, quantidade, cronogramaBloqueado };
}

async function salvarGasto(evento) {
  evento.preventDefault();
  const { problemas, centavos, quantidade, cronogramaBloqueado } = validarFormulario();
  if (problemas.length) {
    definirMensagemGasto('erro', problemas.join(' '));
    return;
  }

  const dados = {
    description: el.campoDescricao.value.trim(),
    place: el.campoLocal.value.trim(),
    purchase_date: el.campoData.value,
    debt_id: el.campoDivida.value || null
  };

  const eEdicao = Boolean(editandoId);
  el.btnSalvar.disabled = true;
  el.btnSalvar.setAttribute('aria-busy', 'true');
  definirMensagemGasto('', '');

  try {
    if (eEdicao) {
      // Campos de cronograma só vão quando estiverem editáveis
      // (a RPC update_expense é a autoridade final e bloqueia com parcela paga).
      if (cronogramaBloqueado) {
        await gastos.atualizar(editandoId, dados);
      } else {
        await gastos.atualizar(editandoId, {
          ...dados,
          total_amount: centavosParaNumero(centavos),
          installments_count: quantidade,
          first_due_date: el.campoVencimento.value
        });
      }
      criarToast('sucesso', 'Gasto atualizado com sucesso.');
    } else {
      const retorno = await gastos.criar(
        {
          ...dados,
          total_amount_centavos: centavos,
          installments_count: quantidade,
          first_due_date: el.campoVencimento.value
        },
        chaveIdempotenciaAtual // MESMA chave em repetições desta operação
      );
      if (retorno && retorno.duplicated) {
        criarToast('aviso', 'Este gasto já havia sido salvo (proteção contra envio repetido).');
      } else {
        const qtd = retorno && retorno.installments_total ? retorno.installments_total : quantidade;
        criarToast('sucesso', `Gasto salvo com ${qtd} parcela(s).`);
      }
      chaveIdempotenciaAtual = gerarChaveIdempotencia(); // próxima compra = chave nova
    }

    fecharModal();
    await carregarGastos(); // listagem só atualiza após confirmação do banco
  } catch (erro) {
    const traduzido = normalizarErro(erro);
    definirMensagemGasto('erro', traduzido.message); // mensagem REAL do banco
    criarToast('erro', 'Não foi possível salvar o gasto.');
  } finally {
    el.btnSalvar.disabled = false;
    el.btnSalvar.removeAttribute('aria-busy');
  }
}

/* -----------------------------------------------------------------------------
 * Exclusão
 * --------------------------------------------------------------------------- */
function abrirModalExclusao(linha) {
  compraSendoExcluida = { id: linha.expense_id, descricao: linha.description };
  el.excluirResumo.textContent =
    `Excluir “${linha.description}” (${formatarMoeda(linha.total_amount)}, ` +
    `${linha.installments_count} parcela(s))? Esta ação exclui o gasto e TODAS as ` +
    'suas parcelas. O histórico de pagamentos já registrados é preservado.';
  definirMensagemExcluir('', '');
  ultimoFoco = document.activeElement;
  el.modalExcluir.hidden = false;
  document.addEventListener('keydown', teclaEscExcluir);
  el.btnCancelarExcluir.focus();
}

function fecharModalExclusao() {
  el.modalExcluir.hidden = true;
  document.removeEventListener('keydown', teclaEscExcluir);
  compraSendoExcluida = null;
  if (ultimoFoco && typeof ultimoFoco.focus === 'function') ultimoFoco.focus();
}

function teclaEscExcluir(evento) {
  if (evento.key === 'Escape' && !el.modalExcluir.hidden) fecharModalExclusao();
}

function definirMensagemExcluir(tipo, texto) {
  el.mensagemExcluir.className = `mensagem mensagem-${tipo}`;
  el.mensagemExcluir.textContent = texto || '';
  el.mensagemExcluir.hidden = !texto;
}

async function confirmarExclusao() {
  if (!compraSendoExcluida) return;
  el.btnConfirmarExcluir.disabled = true;
  el.btnConfirmarExcluir.setAttribute('aria-busy', 'true');
  definirMensagemExcluir('', '');

  try {
    await gastos.excluir(compraSendoExcluida.id);
    criarToast('sucesso', 'Gasto excluído.');
    fecharModalExclusao();
    await carregarGastos();
  } catch (erro) {
    const traduzido = normalizarErro(erro);
    definirMensagemExcluir('erro', traduzido.message); // motivo real do banco
    criarToast('erro', 'A exclusão não foi concluída.');
  } finally {
    el.btnConfirmarExcluir.disabled = false;
    el.btnConfirmarExcluir.removeAttribute('aria-busy');
  }
}

/* -----------------------------------------------------------------------------
 * Debounce da pesquisa
 * --------------------------------------------------------------------------- */
function comDebounce(funcao, espera) {
  let temporizador = null;
  return (...argumentos) => {
    clearTimeout(temporizador);
    temporizador = setTimeout(() => funcao(...argumentos), espera);
  };
}

const buscaComDebounce = comDebounce(() => {
  filtros.busca = el.busca.value.trim();
  carregarGastos();
}, 350);

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
  document.querySelectorAll('[data-aguardando="js/gastos.js"]').forEach((botao) => {
    botao.disabled = false;
    botao.removeAttribute('data-aguardando');
  });
}

function registrarEventos() {
  el.busca.addEventListener('input', buscaComDebounce);
  el.filtroSituacao.addEventListener('change', () => {
    filtros.situacao = el.filtroSituacao.value;
    carregarGastos();
  });
  el.filtroOrdem.addEventListener('change', () => {
    const [ordem, direcao] = el.filtroOrdem.value.split(':');
    filtros.ordem = ordem;
    filtros.direcao = direcao;
    carregarGastos();
  });

  el.btnNovo.addEventListener('click', abrirModalCriacao);
  el.form.addEventListener('submit', salvarGasto);
  el.btnCancelar.addEventListener('click', fecharModal);
  el.btnFechar.addEventListener('click', fecharModal);
  el.modalGasto.addEventListener('click', (evento) => {
    if (evento.target === el.modalGasto) fecharModal();
  });

  [el.campoValor, el.campoParcelas, el.campoVencimento, el.campoData, el.campoDivida]
    .forEach((campo) => campo.addEventListener('input', atualizarPrevia));

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
      carregarGastos();
    }
  });
}

(async function iniciarGastos() {
  try {
    const conta = await requireAuth();
    if (!conta) return; // redirecionado ao login ou conta inativa (aviso já exibido)

    el.nome.textContent = conta.perfil.full_name || conta.perfil.email || 'Usuário';
    el.papel.textContent = conta.perfil.role === 'admin' ? 'Administrador' : 'Conta pessoal';
    el.inicial.textContent = (el.nome.textContent.trim()[0] || '?').toUpperCase();
    el.chip.hidden = false;
    adicionarLinkAdmin(conta.perfil);

    habilitarControles();
    atualizarBotaoTema();
    registrarEventos();

    dividasCache = await dividas.listar();
    popularSelectDividas('');

    await carregarGastos();
  } catch (erro) {
    const traduzido = normalizarErro(erro);
    acaoRecuperacao = 'repetir';
    el.erroMensagem.textContent = traduzido.message;
    el.erroGlobal.hidden = false;
  }
})();
