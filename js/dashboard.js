/**
 * js/dashboard.js
 * =============================================================================
 * CONTROLE DE GASTOS — Controlador do painel (dashboard.html).
 *
 * FONTES DE DADOS (todas reais, RLS protegidas — nenhuma tabela/coluna inventada)
 *   • RPC dashboard_totals(p_from, p_to, p_category_id, p_debt_id, p_status,
 *     p_company) → totais, gráficos e período (database/functions.sql).
 *   • View pública.v_agenda → próximos vencimentos pendentes
 *     (colunas: due_date, status, amount, title, subtitle, category_name,
 *     kind, installment_number, installments_total, debt_id, expense_id, id).
 *   • Tabela public.expenses → lançamentos recentes
 *     (v_agenda não possui purchase_date/created_at — por isso a fonte é a
 *     própria tabela de compras, ordenada por purchase_date DESC).
 *   • Tabela public.categories → filtro de categorias (sistema + pessoais).
 *
 * SEGURANÇA
 *   • requireAuth() (js/supabase.js) protege a página: sem sessão → login.html;
 *     status da conta lido no BANCO (profiles.status). O bloqueio definitivo
 *     permanece na RLS — este módulo apenas não renderiza sem autorização.
 *   • Listas e chips são montados com createElement/textContent (nunca
 *     innerHTML com dados do usuário). Os SVGs de charts.js escapam o texto
 *     internamente.
 *
 * CONSISTÊNCIA
 *   • Um contador de requisição (numeroRequisicao) impede que uma resposta
 *     antiga sobrescreva o resultado de filtros aplicados depois.
 *   • Uma única chamada de dashboard_totals alimenta cards + gráficos
 *     (sem consultas redundantes). Listas usam duas consultas distintas,
 *     necessárias e em paralelo.
 * =============================================================================
 */

import {
  requireAuth,
  callRpc,
  logout,
  normalizarErro,
  obterCliente
} from './supabase.js';

import {
  graficoBarrasMensais,
  graficoBarrasHorizontais,
  graficoDonut,
  formatarMoeda
} from './charts.js';

/* -----------------------------------------------------------------------------
 * Referências de elementos (IDs conferidos em dashboard.html)
 * --------------------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);

const el = {
  chip: $('usuario-chip'),
  inicial: $('usuario-inicial'),
  nome: $('usuario-nome'),
  papel: $('usuario-papel'),
  periodo: $('periodo-atual'),
  erroGlobal: $('estado-erro-global'),
  erroMensagem: $('erro-mensagem'),
  btnTentar: $('btn-tentar-novamente'),
  formFiltros: $('form-filtros'),
  filtroMes: $('filtro-mes'),
  filtroAno: $('filtro-ano'),
  filtroCategoria: $('filtro-categoria'),
  filtroEmpresa: $('filtro-empresa'),
  filtroStatus: $('filtro-status'),
  btnAplicar: $('btn-aplicar'),
  btnLimpar: $('btn-limpar'),
  chips: $('chips-filtros'),
  graficoMensal: $('grafico-mensal'),
  graficoDonut: $('grafico-donut'),
  graficoCategorias: $('grafico-categorias'),
  graficoEmpresas: $('grafico-empresas'),
  listaVencimentos: $('lista-vencimentos'),
  listaRecentes: $('lista-recentes'),
  btnTema: $('btn-tema'),
  btnSair: $('btn-sair')
};

/* -----------------------------------------------------------------------------
 * Estado do módulo
 * --------------------------------------------------------------------------- */
let numeroRequisicao = 0;       // descarta respostas antigas de filtros superados
let ultimosTotais = null;       // cache pára re-render dos gráficos na troca de tema
let acaoRecuperacao = 'repetir';// 'repetir' | 'login' (botão do estado de erro)
let categoriasCache = null;     // cache da consulta a public.categories (1 chamada)
const CHAVE_TEMA = 'theme';     // preferência de UI (nunca dado financeiro)

const filtros = {
  mes: null,        // 1..12 (inicializado a partir de period.today)
  ano: null,
  categoria: '',    // uuid | ''
  empresa: '',      // texto para p_company (ilike no banco)
  status: ''        // '' | 'pending' | 'paid'
};

/* -----------------------------------------------------------------------------
 * Formatação auxiliar
 * --------------------------------------------------------------------------- */
function dataBR(dataISO) {
  if (!dataISO || typeof dataISO !== 'string') return '—';
  const partes = dataISO.split('-');
  if (partes.length !== 3) return dataISO;
  return `${partes[2]}/${partes[1]}/${partes[0]}`;
}

function numeroBR(valor) {
  return (Number(valor) || 0).toLocaleString('pt-BR');
}

/** Cria elemento com texto seguro (nunca innerHTML com dado do usuário). */
function criarElemento(tag, classe, texto) {
  const nodo = document.createElement(tag);
  if (classe) nodo.className = classe;
  if (texto !== undefined && texto !== null) nodo.textContent = texto;
  return nodo;
}

function estadoVazioLista(mensagem) {
  const li = criarElemento('li', 'estado-vazio');
  li.setAttribute('role', 'status');
  const icone = criarElemento('span', 'icone-estado');
  icone.setAttribute('aria-hidden', 'true');
  li.appendChild(icone);
  li.appendChild(criarElemento('p', 'titulo-estado', mensagem));
  return li;
}

const ESQUELETO_GRAFICO = [
  '<div class="carregando-painel" role="status" aria-label="Carregando gráfico">',
  '<span class="esqueleto-linha" style="width:75%"></span>',
  '<span class="esqueleto-linha" style="width:90%"></span>',
  '<span class="esqueleto-linha" style="width:55%"></span>',
  '</div>'
].join('');

const ESQUELETO_LISTA = [
  '<li class="carregando-painel" role="status" aria-label="Carregando lista">',
  '<span class="esqueleto-linha" style="width:88%"></span>',
  '<span class="esqueleto-linha" style="width:60%"></span>',
  '</li>'
].join('');

/* -----------------------------------------------------------------------------
 * Usuário e controles
 * --------------------------------------------------------------------------- */
function preencherUsuario(conta) {
  const nome = conta.perfil.full_name || conta.perfil.email || 'Usuário';
  el.nome.textContent = nome;
  el.papel.textContent = conta.perfil.role === 'admin' ? 'Administrador' : 'Conta pessoal';
  el.inicial.textContent = (nome.trim()[0] || '?').toUpperCase();
  el.chip.hidden = false;
}

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
  document.querySelectorAll('[data-aguardando="js/dashboard.js"]').forEach((botao) => {
    botao.disabled = false;
    botao.removeAttribute('data-aguardando');
  });
}

/* -----------------------------------------------------------------------------
 * Tema claro/escuro (preferência de UI — data-theme + localStorage('theme'))
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
  // Cores dos gráficos vêm dos tokens: re-render com o tema novo.
  if (ultimosTotais) renderizarGraficos(ultimosTotais);
}

function atualizarBotaoTema() {
  const escuro = temaEfetivo() === 'escuro';
  // O ícone é trocado por CSS (data-theme); aqui só o rótulo acessível.
  el.btnTema.setAttribute('aria-label', escuro ? 'Mudar para tema claro' : 'Mudar para tema escuro');
  el.btnTema.setAttribute('title', escuro ? 'Mudar para tema claro' : 'Mudar para tema escuro');
  el.btnTema.dataset.temaAtual = escuro ? 'escuro' : 'claro';
}

/**
 * Quando o tema segue o sistema, uma mudança da preferência do dispositivo
 * também precisa redesenhar os SVGs: as cores são incorporadas ao markup.
 */
function observarTemaDoSistema() {
  if (!window.matchMedia) return;
  const consulta = window.matchMedia('(prefers-color-scheme: dark)');
  const aoMudar = () => {
    if (document.documentElement.dataset.theme) return;
    atualizarBotaoTema();
    if (ultimosTotais) renderizarGraficos(ultimosTotais);
  };

  if (consulta.addEventListener) consulta.addEventListener('change', aoMudar);
  else if (consulta.addListener) consulta.addListener(aoMudar);
}

/** Cores atuais dos tokens (lidas em tempo de render → acompanham o tema). */
function coresDosGraficos() {
  const estilos = getComputedStyle(document.documentElement);
  const pega = (nome, padrao) => (estilos.getPropertyValue(nome) || '').trim() || padrao;
  return {
    corPago: pega('--grafico-pago', '#147a57'),
    corPendente: pega('--grafico-pendente', '#c98a2e'),
    corPrimaria: pega('--grafico-principal', '#0f6b54'),
    corSecundaria: pega('--grafico-secundario', '#5d8f80'),
    corTexto: pega('--texto-suave', '#5d6c65'),
    corTextoForte: pega('--texto', '#13221d'),
    corLinha: pega('--grafico-grade', '#eae7de'),
    corFundoBarra: pega('--grafico-trilho', '#eef1ec')
  };
}

/* -----------------------------------------------------------------------------
 * Filtros
 * --------------------------------------------------------------------------- */
function mesPadrao(dataISO) {
  return Number((dataISO || '').slice(5, 7)) || (new Date().getMonth() + 1);
}
function anoPadrao(dataISO) {
  return Number((dataISO || '').slice(0, 4)) || new Date().getFullYear();
}

/** Configura mês/ano a partir do período REAL devolvido pela RPC (1ª carga). */
function sincronizarFiltrosComPeriodo(totais) {
  const hoje = (totais && totais.period && totais.period.today) || '';
  filtros.mes = filtros.mes ?? mesPadrao(hoje);
  filtros.ano = filtros.ano ?? anoPadrao(hoje);

  // Anos: atual ± 2 (janela fixa de navegação, sem dado inventado).
  const anoCentral = filtros.ano;
  el.filtroAno.innerHTML = '';
  for (let ano = anoCentral + 2; ano >= anoCentral - 2; ano--) {
    const opcao = document.createElement('option');
    opcao.value = String(ano);
    opcao.textContent = String(ano);
    el.filtroAno.appendChild(opcao);
  }
  el.filtroAno.value = String(filtros.ano);
  el.filtroMes.value = String(filtros.mes);
}

/** Carrega categorias reais (sistema + pessoais) — uma única consulta. */
async function carregarCategorias() {
  if (categoriasCache) return categoriasCache;
  const client = await obterCliente();
  const { data, error } = await client
    .from('categories')
    .select('id, name, is_system')
    .order('is_system', { ascending: false })
    .order('name', { ascending: true });
  if (error) throw normalizarErro(error);
  categoriasCache = data || [];
  el.filtroCategoria.innerHTML = '';
  const opcaoTodas = document.createElement('option');
  opcaoTodas.value = '';
  opcaoTodas.textContent = 'Todas';
  el.filtroCategoria.appendChild(opcaoTodas);
  categoriasCache.forEach((categoria) => {
    const opcao = document.createElement('option');
    opcao.value = categoria.id;
    opcao.textContent = categoria.name + (categoria.is_system ? '' : ' •');
    el.filtroCategoria.appendChild(opcao);
  });
  el.filtroCategoria.value = filtros.categoria;
  return categoriasCache;
}

function primeirosParametros() {
  // 1ª carga: sem filtros → a RPC usa o mês corrente no fuso do perfil.
  return { p_from: null, p_to: null, p_category_id: null, p_debt_id: null, p_status: null, p_company: null };
}

function parametrosDosFiltros() {
  const ano = Number(filtros.ano);
  const mes = Number(filtros.mes);
  const p_from = `${ano}-${String(mes).padStart(2, '0')}-01`;
  const p_to = new Date(Date.UTC(ano, mes, 0)).toISOString().slice(0, 10); // último dia do mês
  return {
    p_from,
    p_to,
    p_category_id: filtros.categoria || null,
    p_debt_id: null,
    p_status: filtros.status || null,
    p_company: filtros.empresa ? filtros.empresa : null
  };
}

function temFiltroAtivo() {
  return Boolean(filtros.categoria || filtros.empresa || filtros.status);
}

function atualizarChips() {
  el.chips.innerHTML = '';
  const definidos = [
    filtros.categoria && {
      rotulo: 'Categoria: ' + (categoriasCache?.find(c => c.id === filtros.categoria)?.name || '—'),
      limpar: () => { filtros.categoria = ''; el.filtroCategoria.value = ''; }
    },
    filtros.empresa && {
      rotulo: 'Empresa: ' + filtros.empresa,
      limpar: () => { filtros.empresa = ''; el.filtroEmpresa.value = ''; }
    },
    filtros.status && {
      rotulo: 'Status: ' + (filtros.status === 'paid' ? 'Pago' : 'Pendente'),
      limpar: () => { filtros.status = ''; el.filtroStatus.value = ''; }
    }
  ].filter(Boolean);

  definidos.forEach((filtro) => {
    const chip = criarElemento('span', 'filtro-chip');
    chip.appendChild(criarElemento('span', null, filtro.rotulo));
    const botao = document.createElement('button');
    botao.type = 'button';
    botao.textContent = '×';
    botao.setAttribute('aria-label', 'Remover filtro: ' + filtro.rotulo);
    botao.addEventListener('click', () => {
      filtro.limpar();
      carregarPainel();
    });
    chip.appendChild(botao);
    el.chips.appendChild(chip);
  });

  el.btnLimpar.hidden = !temFiltroAtivo();
}

/* -----------------------------------------------------------------------------
 * Renderização: CARDS (chaves reais da RPC dashboard_totals)
 * --------------------------------------------------------------------------- */
function lerCaminho(objeto, caminho) {
  return caminho.split('.').reduce((atual, parte) => (atual ? atual[parte] : undefined), objeto);
}

const CHAVES_MONETARIAS = new Set([
  'payments.total_paid_period',
  'pending.total_pending_period',
  'purchases.total_period',
  'overdue.amount',
  'due_today.amount',
  'due_next_7d.amount',
  'installments.pending_amount',
  'installments.paid_amount'
]);

function renderizarCards(totais) {
  document.querySelectorAll('[data-indicador]').forEach((elemento) => {
    const caminho = elemento.dataset.indicador;
    const valor = lerCaminho(totais, caminho);
    elemento.textContent = valor === undefined || valor === null
      ? '—'
      : (CHAVES_MONETARIAS.has(caminho) ? formatarMoeda(valor) : numeroBR(valor));
  });

  const detalhes = {
    'debts': `Mensais: ${numeroBR(totais.debts?.monthly)} · Anuais: ${numeroBR(totais.debts?.annual)} · Eventuais: ${numeroBR(totais.debts?.once)}`,
    'purchases': `Total do período: ${formatarMoeda(totais.purchases?.total_period)}`,
    'payments': `Parcelas: ${formatarMoeda(totais.payments?.installments_paid_amount)} · Obrigações: ${formatarMoeda(totais.payments?.occurrences_paid_amount)}`,
    'pending': `Parcelas: ${formatarMoeda(totais.pending?.installments_pending_amount)} · Obrigações: ${formatarMoeda(totais.pending?.occurrences_pending_amount)}`,
    'overdue': `Valor: ${formatarMoeda(totais.overdue?.amount)}`,
    'due_today': `Valor: ${formatarMoeda(totais.due_today?.amount)}`,
    'due_next_7d': `Valor: ${formatarMoeda(totais.due_next_7d?.amount)}`,
    'installments.pending': `Valor pendente: ${formatarMoeda(totais.installments?.pending_amount)}`,
    'installments.paid': `Valor pago: ${formatarMoeda(totais.installments?.paid_amount)}`
  };
  Object.entries(detalhes).forEach(([chave, texto]) => {
    const elemento = document.querySelector(`[data-detalhe="${chave}"]`);
    if (elemento) elemento.textContent = texto;
  });

  const periodo = totais.period || {};
  el.periodo.textContent = `Período: ${dataBR(periodo.from)} a ${dataBR(periodo.to)} · Hoje: ${dataBR(periodo.today)}`;
}

/* -----------------------------------------------------------------------------
 * Renderização: GRÁFICOS (funções reais de js/charts.js)
 * --------------------------------------------------------------------------- */
function definirGrafico(container, svg) {
  container.innerHTML = '';
  if (!svg) {
    const vazio = criarElemento('div', 'estado-vazio');
    vazio.setAttribute('role', 'status');
    const icone = criarElemento('span', 'icone-estado');
    icone.setAttribute('aria-hidden', 'true');
    vazio.appendChild(icone);
    vazio.appendChild(criarElemento('p', 'titulo-estado', 'Nenhum lançamento no período selecionado.'));
    container.appendChild(vazio);
    return;
  }
  container.innerHTML = svg; // charts.js escapa todo o texto antes de montar o SVG
}

/** Largura útil (em px) do contêiner do gráfico, já descontando o padding. */
function larguraUtil(container) {
  if (!container) return 0;
  const rect = container.getBoundingClientRect();
  const estilo = getComputedStyle(container);
  const padding = (parseFloat(estilo.paddingLeft) || 0) + (parseFloat(estilo.paddingRight) || 0);
  return Math.max(0, Math.round(rect.width - padding));
}

/**
 * Os rankings usam uma largura máxima confortável. Em telas largas, o SVG
 * fica centralizado no card em vez de se esticar por toda a superfície.
 */
const LARGURA_MAXIMA_RANKING = 820;
function larguraRanking(container) {
  return Math.min(larguraUtil(container), LARGURA_MAXIMA_RANKING);
}

function renderizarGraficos(totais) {
  const cores = coresDosGraficos();

  const mensal = (totais.by_month || []).map((m) => ({
    rotulo: m.label || m.month,
    pago: Number(m.paid) || 0,
    pendente: Number(m.pending) || 0
  }));
  definirGrafico(el.graficoMensal, graficoBarrasMensais(mensal, {
    ...cores,
    altura: 220,
    largura: larguraUtil(el.graficoMensal),
    ariaLabel: 'Gráfico de gastos pagos e pendentes por mês nos últimos 12 meses'
  }));

  const pagoPend = totais.paid_vs_pending || {};
  definirGrafico(el.graficoDonut, graficoDonut([
    { rotulo: 'Pago', valor: Number(pagoPend.paid) || 0, cor: cores.corPago },
    { rotulo: 'Pendente', valor: Number(pagoPend.pending) || 0, cor: cores.corPendente }
  ], {
    ...cores,
    altura: 220,
    largura: larguraUtil(el.graficoDonut),
    ariaLabel: 'Gráfico de valores pagos e pendentes no período'
  }));

  const categorias = (totais.by_category || []).map((c) => ({
    rotulo: c.category,
    valor: Number(c.total) || 0,
    itens: c.items
  }));
  definirGrafico(el.graficoCategorias, graficoBarrasHorizontais(categorias, {
    ...cores,
    corBarra: cores.corPrimaria,
    largura: larguraRanking(el.graficoCategorias),
    ariaLabel: 'Gráfico de gastos por categoria no período'
  }));

  const empresas = (totais.by_company || []).map((e) => ({
    rotulo: e.company,
    valor: Number(e.total) || 0,
    itens: e.items
  }));
  definirGrafico(el.graficoEmpresas, graficoBarrasHorizontais(empresas, {
    ...cores,
    corBarra: cores.corPrimaria,
    largura: larguraRanking(el.graficoEmpresas),
    ariaLabel: 'Gráfico de gastos por empresa ou estabelecimento no período'
  }));
}

/* Re-desenha os gráficos quando a largura real do contêiner muda
   (troca de aba, redimensionamento da janela, abertura/fechamento de menus). */
let observadorGraficos = null;
let larguraGraficosAnterior = '';

function instalarObservadorDeLargura() {
  if (observadorGraficos || typeof ResizeObserver === 'undefined') return;
  const alvos = [el.graficoMensal, el.graficoDonut, el.graficoCategorias, el.graficoEmpresas]
    .filter(Boolean);
  if (!alvos.length) return;

  observadorGraficos = new ResizeObserver(() => {
    if (!ultimosTotais) return;
    const assinatura = alvos.map((alvo) => larguraUtil(alvo)).join('|');
    if (assinatura === larguraGraficosAnterior) return;
    larguraGraficosAnterior = assinatura;
    renderizarGraficos(ultimosTotais);
  });
  alvos.forEach((alvo) => observadorGraficos.observe(alvo));
}

/* -----------------------------------------------------------------------------
 * Renderização: LISTAS (v_agenda + expenses — consultas reais e distintas)
 * --------------------------------------------------------------------------- */
async function renderizarListas(totais, token) {
  el.listaVencimentos.innerHTML = ESQUELETO_LISTA;
  el.listaRecentes.innerHTML = ESQUELETO_LISTA;

  const hoje = (totais.period && totais.period.today) || new Date().toISOString().slice(0, 10);
  const client = await obterCliente();

  const [resultadoVenc, resultadoRec] = await Promise.allSettled([
    client
      .from('v_agenda')
      .select('id, kind, due_date, status, amount, title, subtitle, category_name, installment_number, installments_total')
      .eq('status', 'pending')
      .gte('due_date', hoje)
      .order('due_date', { ascending: true })
      .limit(8),
    client
      .from('expenses')
      .select('id, description, place, purchase_date, total_amount, installments_count')
      .order('purchase_date', { ascending: false })
      .limit(8)
  ]);

  if (token !== numeroRequisicao) return; // resposta de filtro antigo: descartar

  // --- Próximos vencimentos ---
  el.listaVencimentos.innerHTML = '';
  if (resultadoVenc.status === 'rejected') {
    throw normalizarErro(resultadoVenc.reason);
  }
  const vencimentos = resultadoVenc.value.data || [];
  if (resultadoVenc.value.error) throw normalizarErro(resultadoVenc.value.error);
  if (!vencimentos.length) {
    el.listaVencimentos.appendChild(estadoVazioLista('Nenhum vencimento pendente nos próximos dias.'));
  } else {
    vencimentos.forEach((item) => {
      const li = criarElemento('li', 'item-lancamento');
      const textos = criarElemento('div', 'item-textos');
      textos.appendChild(criarElemento('span', 'item-principal', item.title || 'Lançamento'));
      const partes = [dataBR(item.due_date)];
      if (item.category_name) partes.push(item.category_name);
      if (item.kind === 'expense_installment' && item.installment_number && item.installments_total) {
        partes.push(`Parcela ${item.installment_number}/${item.installments_total}`);
      }
      textos.appendChild(criarElemento('span', 'item-secundario', partes.join(' · ')));
      li.appendChild(textos);
      li.appendChild(criarElemento('span', 'item-valor', formatarMoeda(item.amount)));
      el.listaVencimentos.appendChild(li);
    });
  }

  // --- Lançamentos recentes (compras) ---
  el.listaRecentes.innerHTML = '';
  if (resultadoRec.status === 'rejected') {
    throw normalizarErro(resultadoRec.reason);
  }
  const recentes = resultadoRec.value.data || [];
  if (resultadoRec.value.error) throw normalizarErro(resultadoRec.value.error);
  if (!recentes.length) {
    el.listaRecentes.appendChild(estadoVazioLista('Nenhum gasto cadastrado ainda.'));
  } else {
    recentes.forEach((item) => {
      const li = criarElemento('li', 'item-lancamento');
      const textos = criarElemento('div', 'item-textos');
      textos.appendChild(criarElemento('span', 'item-principal', item.description));
      const partes = [dataBR(item.purchase_date)];
      if (item.place) partes.push(item.place);
      partes.push(`${item.installments_count}×`);
      textos.appendChild(criarElemento('span', 'item-secundario', partes.join(' · ')));
      li.appendChild(textos);
      li.appendChild(criarElemento('span', 'item-valor', formatarMoeda(item.total_amount)));
      el.listaRecentes.appendChild(li);
    });
  }
}

/* -----------------------------------------------------------------------------
 * Estados
 * --------------------------------------------------------------------------- */
function mostrarCarregando() {
  el.erroGlobal.hidden = true;
  el.btnAplicar.disabled = true;
  el.btnAplicar.setAttribute('aria-busy', 'true');
  document.querySelectorAll('[data-indicador]').forEach((nodo) => { nodo.textContent = '—'; });
  el.graficoMensal.innerHTML = ESQUELETO_GRAFICO;
  el.graficoDonut.innerHTML = ESQUELETO_GRAFICO;
  el.graficoCategorias.innerHTML = ESQUELETO_GRAFICO;
  el.graficoEmpresas.innerHTML = ESQUELETO_GRAFICO;
  el.listaVencimentos.innerHTML = ESQUELETO_LISTA;
  el.listaRecentes.innerHTML = ESQUELETO_LISTA;
}

function concluirCarregando() {
  el.btnAplicar.disabled = false;
  el.btnAplicar.removeAttribute('aria-busy');
}

function mostrarErroGlobal(mensagem) {
  concluirCarregando();
  el.erroGlobal.hidden = false;
  el.erroMensagem.textContent = mensagem;
  if (acaoRecuperacao === 'login') {
    el.btnTentar.textContent = 'Ir para o login';
  } else {
    el.btnTentar.textContent = 'Tentar novamente';
  }
}

/* -----------------------------------------------------------------------------
 * Carga do painel
 * --------------------------------------------------------------------------- */
async function carregarPainel(comFiltros = true) {
  const token = ++numeroRequisicao;
  // Impede que troca de tema/redimensionamento redesenhe totais do filtro
  // anterior enquanto a nova consulta ainda está em andamento.
  ultimosTotais = null;
  mostrarCarregando();

  try {
    const parametros = comFiltros ? parametrosDosFiltros() : primeirosParametros();
    const totais = await callRpc('dashboard_totals', parametros);

    if (token !== numeroRequisicao) return; // filtro mais recente venceu esta resposta

    if (!comFiltros) sincronizarFiltrosComPeriodo(totais);

    renderizarCards(totais);
    ultimosTotais = totais;
    renderizarGraficos(totais);
    await carregarCategorias();
    await renderizarListas(totais, token);

    if (token !== numeroRequisicao) return;
    atualizarChips();
    concluirCarregando();
    el.erroGlobal.hidden = true;
  } catch (erro) {
    if (token !== numeroRequisicao) return;
    const traduzido = normalizarErro(erro);
    // Sessão expirada/permissão: sem estado enganoso — oferece o login.
    if (traduzido.codigo === 'auth' || traduzido.codigo === 'permissao') {
      acaoRecuperacao = 'login';
      mostrarErroGlobal(traduzido.message + ' Faça login novamente para continuar.');
    } else {
      acaoRecuperacao = 'repetir';
      mostrarErroGlobal(traduzido.message);
    }
  }
}

/* -----------------------------------------------------------------------------
 * Eventos
 * --------------------------------------------------------------------------- */
function registrarEventos() {
  el.formFiltros.addEventListener('submit', (evento) => {
    evento.preventDefault();
    filtros.mes = Number(el.filtroMes.value) || filtros.mes;
    filtros.ano = Number(el.filtroAno.value) || filtros.ano;
    filtros.categoria = el.filtroCategoria.value;
    filtros.empresa = el.filtroEmpresa.value.trim();
    filtros.status = el.filtroStatus.value;
    carregarPainel();
  });

  el.btnLimpar.addEventListener('click', () => {
    filtros.categoria = '';
    filtros.empresa = '';
    filtros.status = '';
    el.filtroCategoria.value = '';
    el.filtroEmpresa.value = '';
    el.filtroStatus.value = '';
    carregarPainel();
  });

  el.btnTema.addEventListener('click', () => {
    aplicarTema(temaEfetivo() === 'escuro' ? 'claro' : 'escuro');
  });

  el.btnSair.addEventListener('click', () => {
    logout('login.html');
  });

  el.btnTentar.addEventListener('click', () => {
    if (acaoRecuperacao === 'login') {
      logout('login.html');
    } else {
      acaoRecuperacao = 'repetir';
      carregarPainel();
    }
  });
}

/* -----------------------------------------------------------------------------
 * Inicialização
 * --------------------------------------------------------------------------- */
(async function iniciarDashboard() {
  try {
    const conta = await requireAuth();
    if (!conta) return; // redirecionado ao login ou bloqueado (conta inativa)

    preencherUsuario(conta);
    adicionarLinkAdmin(conta.perfil);
    habilitarControles();
    atualizarBotaoTema();
    registrarEventos();
    instalarObservadorDeLargura();
    observarTemaDoSistema();

    await carregarPainel(false); // 1ª carga: mês corrente definido pelo banco
  } catch (erro) {
    const traduzido = normalizarErro(erro);
    acaoRecuperacao = 'repetir';
    mostrarErroGlobal(traduzido.message);
  }
})();
