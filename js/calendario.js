/**
 * js/calendario.js
 * =============================================================================
 * CONTROLE DE GASTOS — Calendário financeiro (Etapa 6-B).
 *
 * FONTE REAL DE DADOS
 *   View pública.v_agenda (mesma do painel e das parcelas), consultada
 *   diretamente (padrão já usado por js/dashboard.js):
 *     colunas: kind ('debt_occurrence'|'expense_installment'), id, due_date,
 *              status ('pending'|'paid'), amount, paid_at, title, subtitle,
 *              category_name, expense_id, installment_number, installments_total
 *     filtros: due_date >= primeiro dia do mês exibido, due_date <= último dia,
 *              status opcional. RLS garante somente as linhas do usuário.
 *
 * DATAS (regra 18 — sem deslocamento de fuso)
 *   • Datas do banco são civis ('YYYY-MM-DD'): manipuladas como STRING e,
 *     quando precisa de aritmética, via Date.UTC (que não depende do fuso).
 *   • NUNCA new Date('YYYY-MM-DD') (parseia como UTC e desloca o dia).
 *   • "Hoje" vem da data LOCAL do dispositivo (formada por partes).
 *
 * SOMENTE LEITURA
 *   O calendário não altera pagamentos (regra da Etapa 6): itens de parcela
 *   apontam para parcelas.html?compra=<expense_id>, onde o pagamento é feito.
 * =============================================================================
 */

import { requireAuth, logout, normalizarErro, obterCliente } from './supabase.js';
import { formatarMoeda } from './charts.js';

/* -----------------------------------------------------------------------------
 * Referências (IDs conferidos em calendario.html)
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
  btnAnterior: $('btn-mes-anterior'),
  btnSeguinte: $('btn-mes-seguinte'),
  btnHoje: $('btn-hoje'),
  titulo: $('cal-titulo'),
  filtroSituacao: $('filtro-situacao'),
  grade: $('cal-grade'),
  painelDia: $('painel-dia'),
  tituloDia: $('titulo-dia'),
  listaDia: $('lista-dia'),
  listaMes: $('lista-mes'),
  toasts: $('area-toasts')
};

/* -----------------------------------------------------------------------------
 * Estado
 * --------------------------------------------------------------------------- */
let numeroRequisicao = 0;      // descarta respostas de navegações antigas
let mesExibido = null;         // { ano, mes (1..12) }
let itensDoMes = [];           // linhas reais de v_agenda do mês exibido
let diaSelecionado = null;     // 'YYYY-MM-DD'
let acaoRecuperacao = 'repetir';
let ultimoFoco = null;
const CHAVE_TEMA = 'theme';

const NOMES_MESES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
];
const DIAS_SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

/* -----------------------------------------------------------------------------
 * Utilidades de data (string-first, sem pegadinhas de fuso)
 * --------------------------------------------------------------------------- */
function chaveDe(ano, mes, dia) {
  return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

function hojeChave() {
  const d = new Date();
  return chaveDe(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function diasNoMes(ano, mes) {
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate(); // mes é 1-based aqui
}

function diaDaSemanaPrimeiro(ano, mes) {
  return new Date(Date.UTC(ano, mes - 1, 1)).getUTCDay(); // 0 = domingo
}

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

/** Estado derivado (DB fornece pending/paid; "vencida" é derivada no cliente). */
function estadoDoItem(item, hoje) {
  if (item.status === 'paid') return { chave: 'pago', rotulo: 'Pago', classe: 'etiqueta-pago' };
  if (item.due_date < hoje) return { chave: 'vencido', rotulo: 'Vencida', classe: 'etiqueta-atrasado' };
  return { chave: 'pendente', rotulo: 'Pendente', classe: 'etiqueta-pendente' };
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
 * Carga do mês
 * --------------------------------------------------------------------------- */
function mostrarCarregando() {
  el.erroGlobal.hidden = true;
  el.grade.innerHTML = '';
  el.painelDia.hidden = true;
  el.listaMes.innerHTML = '';
  const skeleton = criarElemento('div', 'carregando-painel');
  skeleton.setAttribute('role', 'status');
  skeleton.setAttribute('aria-label', 'Carregando vencimentos');
  skeleton.appendChild(criarElemento('span', 'esqueleto-linha'));
  skeleton.appendChild(criarElemento('span', 'esqueleto-linha'));
  el.listaMes.appendChild(skeleton);
}

async function carregarMes() {
  const token = ++numeroRequisicao;
  mostrarCarregando();

  const { ano, mes } = mesExibido;
  const de = chaveDe(ano, mes, 1);
  const ate = chaveDe(ano, mes, diasNoMes(ano, mes));

  el.titulo.textContent = `${NOMES_MESES[mes - 1]} ${ano}`;

  try {
    const client = await obterCliente();

    let consulta = client
      .from('v_agenda')
      .select('id, kind, due_date, status, amount, paid_at, title, subtitle, category_name, expense_id, installment_number, installments_total')
      .gte('due_date', de)
      .lte('due_date', ate)
      .order('due_date', { ascending: true });

    if (el.filtroSituacao.value) {
      consulta = consulta.eq('status', el.filtroSituacao.value);
    }

    const { data, error } = await consulta;
    if (error) throw normalizarErro(error);
    if (token !== numeroRequisicao) return; // navegação mais recente venceu

    itensDoMes = data || [];
    diaSelecionado = null;
    renderizarTudo(hojeChave());
  } catch (erro) {
    if (token !== numeroRequisicao) return;
    const traduzido = normalizarErro(erro);
    if (traduzido.codigo === 'auth' || traduzido.codigo === 'permissao') {
      acaoRecuperacao = 'login';
      el.erroMensagem.textContent = traduzido.message + ' Faça login novamente para continuar.';
    } else {
      acaoRecuperacao = 'repetir';
      el.erroMensagem.textContent = traduzido.message;
    }
    el.erroGlobal.hidden = false;
    el.listaMes.innerHTML = '';
  }
}

/* -----------------------------------------------------------------------------
 * Renderização: grade mensal + lista (celular) + detalhes do dia
 * --------------------------------------------------------------------------- */
function agruparPorDia(hoje) {
  const mapa = new Map();
  itensDoMes.forEach((item) => {
    if (!mapa.has(item.due_date)) mapa.set(item.due_date, []);
    mapa.get(item.due_date).push(item);
  });
  return { mapa, hoje };
}

function renderizarTudo(hoje) {
  const { mapa } = agruparPorDia(hoje);
  renderizarGrade(mapa, hoje);
  renderizarListaMes(mapa, hoje);
  if (diaSelecionado) selecionarDia(diaSelecionado, hoje);
}

function renderizarGrade(mapa, hoje) {
  const { ano, mes } = mesExibido;
  el.grade.innerHTML = '';

  DIAS_SEMANA.forEach((nome) => {
    el.grade.appendChild(criarElemento('div', 'cal-dia-semana', nome));
  });

  const primeiroDiaSemana = diaDaSemanaPrimeiro(ano, mes);
  const total = diasNoMes(ano, mes);

  // Células vazias antes do dia 1
  for (let i = 0; i < primeiroDiaSemana; i++) {
    const vazia = criarElemento('div', 'cal-celula vazio');
    vazia.setAttribute('aria-hidden', 'true');
    el.grade.appendChild(vazia);
  }

  for (let dia = 1; dia <= total; dia++) {
    const chave = chaveDe(ano, mes, dia);
    const itens = mapa.get(chave) || [];

    const celula = criarElemento('button', 'cal-celula');
    celula.type = 'button';
    celula.setAttribute('role', 'gridcell');
    if (chave === hoje) celula.classList.add('hoje');
    if (chave === diaSelecionado) celula.classList.add('selecionado');

    const resumo = resumoDoDia(itens, hoje);
    celula.setAttribute('aria-label',
      `${dia} de ${NOMES_MESES[mes - 1]}: ${resumo.descricaoCurta || 'sem vencimentos'}`);

    celula.appendChild(criarElemento('span', 'cal-numero', String(dia)));

    if (itens.length) {
      const marcadores = criarElemento('div', 'cal-marcadores');
      itens.slice(0, 4).forEach((item) => {
        const estado = estadoDoItem(item, hoje);
        const ponto = criarElemento('span', `cal-ponto ${estado.chave}`);
        ponto.title = `${estado.rotulo}: ${item.title}`;
        marcadores.appendChild(ponto);
      });
      if (itens.length > 4) {
        marcadores.appendChild(criarElemento('span', 'cal-total-dia', `+${itens.length - 4}`));
      }
      celula.appendChild(marcadores);
      celula.appendChild(criarElemento('span', 'cal-total-dia', resumo.descricaoCurta));
    }

    celula.addEventListener('click', () => selecionarDia(chave, hoje));
    el.grade.appendChild(celula);
  }
}

function resumoDoDia(itens, hoje) {
  const total = itens.reduce((soma, item) => soma + (Number(item.amount) || 0), 0);
  const vencidas = itens.filter((i) => estadoDoItem(i, hoje).chave === 'vencido').length;
  let descricaoCurta = itens.length ? formatarMoeda(total) : '';
  if (vencidas > 0) descricaoCurta = `${vencidas} vencida(s) · ${descricaoCurta}`;
  return { total, vencidas, descricaoCurta };
}

function selecaoTextual(chave) {
  const [ano, mes, dia] = chave.split('-').map(Number);
  return `${dia} de ${NOMES_MESES[mes - 1]} de ${ano}`;
}

function selecionarDia(chave, hoje) {
  diaSelecionado = chave;
  const { mapa } = agruparPorDia(hoje);
  const itens = (mapa.get(chave) || [])
    .slice()
    .sort((a, b) => (a.title || '').localeCompare(b.title || ''));

  // Marca visual na grade
  el.grade.querySelectorAll('.cal-celula.selecionado').forEach((c) => c.classList.remove('selecionado'));
  const [, , diaSel] = chave.split('-').map(Number);
  // seleção simples: localiza a célula pelo aria-label
  const celulas = el.grade.querySelectorAll('.cal-celula');
  const alvo = Array.from(celulas).find((c) => (c.getAttribute('aria-label') || '').startsWith(`${diaSel} de`));
  if (alvo) alvo.classList.add('selecionado');

  // Painel de detalhes
  el.painelDia.hidden = false;
  el.tituloDia.textContent = `Vencimentos de ${selecaoTextual(chave)}`;
  el.listaDia.innerHTML = '';

  if (!itens.length) {
    const vazio = criarElemento('li', 'estado-vazio');
    const icone = criarElemento('span', 'icone-estado');
    icone.setAttribute('aria-hidden', 'true');
    vazio.appendChild(icone);
    vazio.appendChild(criarElemento('p', 'titulo-estado', 'Nenhum vencimento neste dia.'));
    el.listaDia.appendChild(vazio);
    return;
  }

  itens.forEach((item) => el.listaDia.appendChild(renderizarItemDetalhe(item, hoje)));
}

function rotuloDoTipo(item) {
  if (item.kind === 'expense_installment') {
    return item.installment_number && item.installments_total
      ? `Parcela ${item.installment_number}/${item.installments_total}`
      : 'Parcela de compra';
  }
  return 'Dívida';
}

function renderizarItemDetalhe(item, hoje) {
  const estado = estadoDoItem(item, hoje);
  const li = criarElemento('li', 'item-lancamento item-calendario');

  const textos = criarElemento('div', 'item-textos item-calendario-textos');
  textos.appendChild(criarElemento('span', 'item-principal', item.title || 'Lançamento'));

  /* Contexto do lançamento fica em uma faixa própria: tipo, detalhe e
     categoria não são mais misturados à data de vencimento. */
  const metadados = criarElemento('div', 'item-meta');
  metadados.appendChild(criarElemento('span', 'item-meta-tipo', rotuloDoTipo(item)));
  if (item.subtitle) {
    metadados.appendChild(criarElemento('span', 'item-meta-texto', item.subtitle));
  }
  if (item.category_name) {
    metadados.appendChild(criarElemento('span', 'item-meta-texto', item.category_name));
  }
  textos.appendChild(metadados);

  /* Vencimento e pagamento têm rótulos próprios e linhas independentes. */
  const datas = criarElemento('div', 'item-datas');
  const vencimento = criarElemento('div', 'item-data');
  vencimento.appendChild(criarElemento('span', 'item-data-rotulo', 'Vencimento'));
  vencimento.appendChild(criarElemento('span', 'item-data-valor', dataBR(item.due_date)));
  datas.appendChild(vencimento);

  if (item.status === 'paid' && item.paid_at) {
    const pagamento = criarElemento('div', 'item-data');
    pagamento.appendChild(criarElemento('span', 'item-data-rotulo', 'Pagamento'));
    pagamento.appendChild(criarElemento('span', 'item-data-valor', dataHoraBR(item.paid_at)));
    datas.appendChild(pagamento);
  }
  textos.appendChild(datas);
  li.appendChild(textos);

  const direita = criarElemento('div', 'item-textos item-calendario-lado');
  direita.appendChild(criarElemento('span', 'item-valor', formatarMoeda(item.amount)));
  direita.appendChild(etiquetaSituacaoInline(estado));

  // Itens de parcela apontam para a tela de pagamento (o calendário é só leitura)
  if (item.kind === 'expense_installment' && item.expense_id) {
    const link = criarElemento('a', 'botao-fantasma botao-pequeno', 'Ver parcelas');
    link.href = `parcelas.html?compra=${encodeURIComponent(item.expense_id)}`;
    direita.appendChild(link);
  }

  li.appendChild(direita);
  return li;
}

function etiquetaSituacaoInline(estado) {
  return criarElemento('span', `etiqueta ${estado.classe}`, estado.rotulo);
}

/** Lista contínua do mês — usada no celular no lugar da grade. */
function renderizarListaMes(mapa, hoje) {
  el.listaMes.innerHTML = '';

  if (!itensDoMes.length) {
    const vazio = criarElemento('div', 'estado-vazio');
    const icone = criarElemento('span', 'icone-estado');
    icone.setAttribute('aria-hidden', 'true');
    vazio.appendChild(icone);
    vazio.appendChild(criarElemento('p', 'titulo-estado',
      'Nenhum vencimento neste mês com os filtros atuais.'));
    el.listaMes.appendChild(vazio);
    return;
  }

  const chaves = Array.from(mapa.keys()).sort();
  chaves.forEach((chave) => {
    const grupo = criarElemento('div', 'cal-grupo-dia');
    const itens = mapa.get(chave);
    const resumo = resumoDoDia(itens, hoje);
    const titulo = criarElemento('h3', null,
      `${dataBR(chave)} — ${itens.length} vencimento(s) · ${formatarMoeda(resumo.total)}`);
    grupo.appendChild(titulo);

    const lista = criarElemento('ul', 'lista-lancamentos');
    itens.forEach((item) => lista.appendChild(renderizarItemDetalhe(item, hoje)));
    grupo.appendChild(lista);

    el.listaMes.appendChild(grupo);
  });
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
  document.querySelectorAll('[data-aguardando="js/calendario.js"]').forEach((botao) => {
    botao.disabled = false;
    botao.removeAttribute('data-aguardando');
  });
}

function registrarEventos() {
  el.btnAnterior.addEventListener('click', () => navegarMes(-1));
  el.btnSeguinte.addEventListener('click', () => navegarMes(1));
  el.btnHoje.addEventListener('click', () => {
    const d = new Date();
    mesExibido = { ano: d.getFullYear(), mes: d.getMonth() + 1 };
    carregarMes();
  });
  el.filtroSituacao.addEventListener('change', carregarMes);

  el.btnTema.addEventListener('click', () => {
    aplicarTema(temaEfetivo() === 'escuro' ? 'claro' : 'escuro');
  });
  el.btnSair.addEventListener('click', () => logout('login.html'));

  el.btnTentar.addEventListener('click', () => {
    if (acaoRecuperacao === 'login') {
      logout('login.html');
    } else {
      acaoRecuperacao = 'repetir';
      carregarMes();
    }
  });
}

function navegarMes(delta) {
  let { ano, mes } = mesExibido;
  mes += delta;
  if (mes < 1) { mes = 12; ano--; }
  if (mes > 12) { mes = 1; ano++; }
  mesExibido = { ano, mes };
  carregarMes();
}

(async function iniciarCalendario() {
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

    const d = new Date();
    mesExibido = { ano: d.getFullYear(), mes: d.getMonth() + 1 };
    await carregarMes();
  } catch (erro) {
    const traduzido = normalizarErro(erro);
    acaoRecuperacao = 'repetir';
    el.erroMensagem.textContent = traduzido.message;
    el.erroGlobal.hidden = false;
  }
})();
