/**
 * js/admin.js
 * =============================================================================
 * CONTROLE DE GASTOS — Área administrativa (Fase 7-H).
 *
 * CONTRATOS REAIS (conferidos em database/functions.sql / schema.sql / rls.sql)
 *   • callRpc('admin_list_users', { p_search, p_limit, p_offset })
 *       → { id, email, full_name, status, role, created_at, last_login_at }[];
 *         busca por e-mail/nome (ilike); limite real ≤ 200; guarda is_admin().
 *   • callRpc('admin_set_account_status', { p_user, p_status, p_reason })
 *       → { id, status, changed }; bloqueia auto-inativação (P0001);
 *         grava automaticamente em admin_audit_log.
 *   • admin_audit_log (tabela): id, actor_id, target_id, action, details
 *     (jsonb: reason, previous_status), created_at — leitura somente-leitura
 *     via PostgREST (RLS: apenas admins).
 *
 * SEGURANÇA
 *   • requireAuth() primeiro; papel verificado ANTES de qualquer RPC
 *     administrativa — usuários comuns não disparam consultas de admin.
 *   • A exibição da interface é UX; a autorização real está no servidor
 *     (is_admin() nas RPCs + policies RLS). Nada é contornado aqui.
 *   • Dados financeiros de terceiros NUNCA são consultados ou exibidos.
 *   • Interface montada com createElement/textContent (nada de innerHTML).
 * =============================================================================
 */

import {
  requireAuth,
  logout,
  normalizarErro,
  callRpc,
  obterCliente
} from './supabase.js';

/* -----------------------------------------------------------------------------
 * Referências (IDs conferidos em admin.html)
 * --------------------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);

const el = {
  chip: $('usuario-chip'),
  inicial: $('usuario-inicial'),
  nome: $('usuario-nome'),
  papel: $('usuario-papel'),
  btnTema: $('btn-tema'),
  btnSair: $('btn-sair'),
  acessoNegado: $('estado-acesso-negado'),
  erroGlobal: $('estado-erro-global'),
  erroMensagem: $('erro-mensagem'),
  btnTentar: $('btn-tentar-novamente'),
  conteudoAdmin: $('conteudo-admin'),
  busca: $('campo-busca'),
  btnAtualizar: $('btn-atualizar'),
  corpo: $('corpo-usuarios'),
  contador: $('contador-usuarios'),
  estadoVazio: $('estado-vazio-usuarios'),
  btnAnterior: $('btn-pagina-anterior'),
  btnSeguinte: $('btn-pagina-seguinte'),
  infoPaginacao: $('info-paginacao'),
  listaAuditoria: $('lista-auditoria'),
  btnMaisAuditoria: $('btn-mais-auditoria'),
  modalStatus: $('modal-status'),
  statusResumo: $('status-resumo'),
  campoMotivo: $('campo-motivo'),
  mensagemStatus: $('mensagem-status'),
  btnFecharStatus: $('btn-fechar-status'),
  btnCancelarStatus: $('btn-cancelar-status'),
  btnConfirmarStatus: $('btn-confirmar-status'),
  toasts: $('area-toasts')
};

/* -----------------------------------------------------------------------------
 * Estado
 * --------------------------------------------------------------------------- */
const LIMITE_PAGINA = 20;          // dentro do teto real da RPC (200)
let numeroRequisicao = 0;
let perfilAtual = null;            // admin autenticado
let offsetUsuarios = 0;
let buscaAtual = '';
let contaEmAlteracao = null;       // { id, email, full_name, status, novoStatus }
let auditOffset = 0;
let acaoRecuperacao = 'repetir';
let ultimoFoco = null;
const CHAVE_TEMA = 'theme';

const ROTULO_PAPEL = { user: 'Conta pessoal', admin: 'Administrador' };
const ROTULO_ACAO_AUDIT = {
  activate_account: 'Conta ativada',
  deactivate_account: 'Conta inativada'
};

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

function definirMensagemStatus(tipo, texto) {
  el.mensagemStatus.className = `mensagem mensagem-${tipo}`;
  el.mensagemStatus.textContent = texto || '';
  el.mensagemStatus.hidden = !texto;
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
 * Usuários (admin_list_users)
 * --------------------------------------------------------------------------- */
function mostrarCarregandoUsuarios() {
  el.corpo.innerHTML = '';
  const tr = criarElemento('tr');
  const td = criarElemento('td');
  td.colSpan = 6;
  const interno = criarElemento('div', 'carregando-painel');
  interno.setAttribute('role', 'status');
  interno.setAttribute('aria-label', 'Carregando usuários');
  interno.appendChild(criarElemento('span', 'esqueleto-linha'));
  interno.appendChild(criarElemento('span', 'esqueleto-linha'));
  td.appendChild(interno);
  tr.appendChild(td);
  el.corpo.appendChild(tr);
  el.estadoVazio.hidden = true;
}

function renderizarLinhaUsuario(usuario) {
  const tr = criarElemento('tr');
  const eVoce = perfilAtual && usuario.id === perfilAtual.id;

  const tdUsuario = criarElemento('td');
  tdUsuario.setAttribute('data-label', 'Usuário');
  const textos = criarElemento('div', 'item-textos');
  textos.appendChild(criarElemento('span', 'item-principal', usuario.email || '—'));
  textos.appendChild(criarElemento('span', 'item-secundario',
    (usuario.full_name || 'Sem nome') + (eVoce ? ' · (sua conta)' : '')));
  tdUsuario.appendChild(textos);
  tr.appendChild(tdUsuario);

  const tdPapel = criarElemento('td');
  tdPapel.setAttribute('data-label', 'Papel');
  tdPapel.appendChild(criarElemento('span', null, ROTULO_PAPEL[usuario.role] || usuario.role));
  tr.appendChild(tdPapel);

  const tdStatus = criarElemento('td');
  tdStatus.setAttribute('data-label', 'Status');
  const etiqueta = usuario.status === 'active'
    ? criarElemento('span', 'etiqueta etiqueta-pago', 'Ativa')
    : criarElemento('span', 'etiqueta etiqueta-atrasado', 'Inativa');
  tdStatus.appendChild(etiqueta);
  tr.appendChild(tdStatus);

  const tdCriada = criarElemento('td');
  tdCriada.setAttribute('data-label', 'Criada em');
  tdCriada.appendChild(criarElemento('span', null, dataBR(
    usuario.created_at ? String(usuario.created_at).slice(0, 10) : null)));
  tr.appendChild(tdCriada);

  const tdAcesso = criarElemento('td');
  tdAcesso.setAttribute('data-label', 'Último acesso');
  tdAcesso.appendChild(criarElemento('span', null,
    usuario.last_login_at ? dataHoraBR(usuario.last_login_at) : 'Nunca acessou'));
  tr.appendChild(tdAcesso);

  const tdAcao = criarElemento('td');
  tdAcao.setAttribute('data-label', 'Ação');
  if (eVoce) {
    // O banco também bloqueia (P0001); a interface nem oferece o botão.
    tdAcao.appendChild(criarElemento('span', 'item-secundario', 'Sua conta'));
  } else {
    const desativar = usuario.status === 'active';
    const botao = criarElemento('button',
      desativar ? 'botao-perigo botao-pequeno' : 'botao botao-pequeno',
      desativar ? 'Desativar' : 'Ativar');
    botao.type = 'button';
    botao.setAttribute('aria-label',
      (desativar ? 'Desativar a conta de ' : 'Ativar a conta de ') + (usuario.email || 'usuário'));
    botao.addEventListener('click', () => abrirModalStatus(usuario));
    tdAcao.appendChild(botao);
  }
  tr.appendChild(tdAcao);

  return tr;
}

async function carregarUsuarios() {
  const token = ++numeroRequisicao;
  mostrarCarregandoUsuarios();
  el.erroGlobal.hidden = true;

  try {
    const usuarios = await callRpc('admin_list_users', {
      p_search: buscaAtual || null,
      p_limit: LIMITE_PAGINA,
      p_offset: offsetUsuarios
    });

    if (token !== numeroRequisicao) return; // busca antiga: descartar

    const lista = usuarios || [];
    el.corpo.innerHTML = '';
    el.contador.textContent = `${lista.length} conta(s) nesta página`;

    if (!lista.length) {
      el.estadoVazio.hidden = false;
    } else {
      el.estadoVazio.hidden = true;
      const fragmento = document.createDocumentFragment();
      lista.forEach((usuario) => fragmento.appendChild(renderizarLinhaUsuario(usuario)));
      el.corpo.appendChild(fragmento);
    }

    el.btnAnterior.disabled = offsetUsuarios === 0;
    el.btnSeguinte.disabled = lista.length < LIMITE_PAGINA;
    const paginaAtual = Math.floor(offsetUsuarios / LIMITE_PAGINA) + 1;
    el.infoPaginacao.textContent = `Página ${paginaAtual}`;
  } catch (erro) {
    if (token !== numeroRequisicao) return;
    const traduzido = normalizarErro(erro);
    el.corpo.innerHTML = '';
    el.estadoVazio.hidden = true;
    if (traduzido.codigo === 'auth' || traduzido.codigo === 'permissao') {
      acaoRecuperacao = 'login';
      el.erroMensagem.textContent = traduzido.message + ' Faça login com uma conta de administrador.';
    } else {
      acaoRecuperacao = 'repetir';
      el.erroMensagem.textContent = traduzido.message;
    }
    el.erroGlobal.hidden = false;
  }
}

/* -----------------------------------------------------------------------------
 * Mudança de status (admin_set_account_status)
 * --------------------------------------------------------------------------- */
function abrirModalStatus(usuario) {
  contaEmAlteracao = {
    id: usuario.id,
    email: usuario.email,
    full_name: usuario.full_name,
    status: usuario.status,
    novoStatus: usuario.status === 'active' ? 'inactive' : 'active'
  };
  const desativando = contaEmAlteracao.novoStatus === 'inactive';

  el.statusResumo.textContent =
    (desativando ? 'Desativar' : 'Ativar') + ' a conta de “' +
    (usuario.email || 'usuário') + '”' +
    (usuario.full_name ? ' (' + usuario.full_name + ')' : '') + '?';
  el.campoMotivo.value = '';
  definirMensagemStatus('', '');
  el.btnConfirmarStatus.textContent = desativando ? 'Desativar conta' : 'Ativar conta';
  el.btnConfirmarStatus.className = desativando ? 'botao-perigo' : 'botao';

  ultimoFoco = document.activeElement;
  el.modalStatus.hidden = false;
  document.addEventListener('keydown', teclaEsc);
  (desativando ? el.campoMotivo : el.btnConfirmarStatus).focus();
}

function fecharModalStatus() {
  el.modalStatus.hidden = true;
  document.removeEventListener('keydown', teclaEsc);
  contaEmAlteracao = null;
  if (ultimoFoco && typeof ultimoFoco.focus === 'function') ultimoFoco.focus();
}

function teclaEsc(evento) {
  if (evento.key === 'Escape' && !el.modalStatus.hidden) fecharModalStatus();
}

async function confirmarStatus() {
  if (!contaEmAlteracao) return;
  const desativando = contaEmAlteracao.novoStatus === 'inactive';
  const motivo = el.campoMotivo.value.trim();

  if (desativando && motivo.length < 3) {
    definirMensagemStatus('erro', 'Descreva o motivo da desativação (mínimo 3 caracteres).');
    return;
  }

  el.btnConfirmarStatus.disabled = true;
  el.btnConfirmarStatus.setAttribute('aria-busy', 'true');
  definirMensagemStatus('', '');

  try {
    const retorno = await callRpc('admin_set_account_status', {
      p_user: contaEmAlteracao.id,
      p_status: contaEmAlteracao.novoStatus,
      p_reason: motivo || null
    });

    if (retorno.changed === false) {
      criarToast('aviso', 'A conta já estava nessa situação.');
    } else {
      criarToast('sucesso',
        'Conta ' + (contaEmAlteracao.novoStatus === 'active' ? 'ativada' : 'desativada') +
        ' com sucesso.');
    }
    fecharModalStatus();
    await carregarUsuarios();   // lista só atualiza após confirmação do banco
    auditOffset = 0;
    await carregarAuditoria();  // o log ganhou um registro novo
  } catch (erro) {
    const traduzido = normalizarErro(erro);
    definirMensagemStatus('erro', traduzido.message); // ex.: auto-inativação (P0001)
  } finally {
    el.btnConfirmarStatus.disabled = false;
    el.btnConfirmarStatus.removeAttribute('aria-busy');
  }
}

/* -----------------------------------------------------------------------------
 * Auditoria (admin_audit_log — somente leitura, via PostgREST)
 * --------------------------------------------------------------------------- */
async function carregarAuditoria() {
  el.btnMaisAuditoria.disabled = true;
  if (auditOffset === 0) {
    el.listaAuditoria.innerHTML = '';
    const carregando = criarElemento('li', 'carregando-painel');
    carregando.setAttribute('role', 'status');
    carregando.setAttribute('aria-label', 'Carregando auditoria');
    carregando.appendChild(criarElemento('span', 'esqueleto-linha'));
    el.listaAuditoria.appendChild(carregando);
  }

  try {
    const client = await obterCliente();
    const { data, error } = await client
      .from('admin_audit_log')
      .select('id, actor_id, target_id, action, details, created_at')
      .order('created_at', { ascending: false })
      .range(auditOffset, auditOffset + LIMITE_PAGINA - 1);

    if (error) throw normalizarErro(error);
    const registros = data || [];

    // Resolve e-mails de ator/alvo (a policy de admin permite ler profiles)
    const ids = new Set();
    registros.forEach((r) => {
      if (r.actor_id) ids.add(r.actor_id);
      if (r.target_id) ids.add(r.target_id);
    });
    let mapaEmails = {};
    if (ids.size) {
      const { data: perfis, error: erroPerfis } = await client
        .from('profiles')
        .select('id, email')
        .in('id', Array.from(ids));
      if (erroPerfis) throw normalizarErro(erroPerfis);
      (perfis || []).forEach((p) => { mapaEmails[p.id] = p.email; });
    }

    if (auditOffset === 0) el.listaAuditoria.innerHTML = '';
    if (!registros.length && auditOffset === 0) {
      const vazio = criarElemento('li', 'estado-vazio');
      const icone = criarElemento('span', 'icone-estado');
      icone.setAttribute('aria-hidden', 'true');
      vazio.appendChild(icone);
      vazio.appendChild(criarElemento('p', 'titulo-estado',
        'Nenhuma ação administrativa registrada ainda.'));
      el.listaAuditoria.appendChild(vazio);
    }

    registros.forEach((registro) => {
      const li = criarElemento('li', 'item-lancamento');
      const textos = criarElemento('div', 'item-textos');
      textos.appendChild(criarElemento('span', 'item-principal',
        ROTULO_ACAO_AUDIT[registro.action] || registro.action));
      const detalhes = [];
      detalhes.push('Alvo: ' + (mapaEmails[registro.target_id] ||
        (registro.target_id ? registro.target_id.slice(0, 8) + '…' : '—')));
      if (registro.details && registro.details.reason) {
        detalhes.push('Motivo: ' + registro.details.reason);
      }
      if (registro.details && registro.details.previous_status) {
        detalhes.push('Status anterior: ' +
          (registro.details.previous_status === 'active' ? 'ativa' : 'inativa'));
      }
      textos.appendChild(criarElemento('span', 'item-secundario', detalhes.join(' · ')));
      li.appendChild(textos);

      const direita = criarElemento('div', 'item-textos');
      direita.style.textAlign = 'right';
      direita.appendChild(criarElemento('span', 'item-secundario',
        dataHoraBR(registro.created_at)));
      direita.appendChild(criarElemento('span', 'item-secundario',
        'Por: ' + (mapaEmails[registro.actor_id] || '—')));
      li.appendChild(direita);
      el.listaAuditoria.appendChild(li);
    });

    el.btnMaisAuditoria.hidden = registros.length < LIMITE_PAGINA;
    auditOffset += registros.length;
  } catch (erro) {
    const traduzido = normalizarErro(erro);
    criarToast('erro', 'Não foi possível carregar o log de auditoria: ' + traduzido.message);
  } finally {
    el.btnMaisAuditoria.disabled = false;
  }
}

/* -----------------------------------------------------------------------------
 * Eventos e inicialização
 * --------------------------------------------------------------------------- */
function habilitarControles() {
  document.querySelectorAll('[data-aguardando="js/admin.js"]').forEach((elemento) => {
    elemento.disabled = false;
    elemento.removeAttribute('data-aguardando');
  });
}

function registrarEventos() {
  let temporizador = null;
  el.busca.addEventListener('input', () => {
    clearTimeout(temporizador);
    temporizador = setTimeout(() => {
      buscaAtual = el.busca.value.trim();
      offsetUsuarios = 0;
      carregarUsuarios();
    }, 400);
  });

  el.btnAtualizar.addEventListener('click', () => {
    offsetUsuarios = 0;
    carregarUsuarios();
  });
  el.btnAnterior.addEventListener('click', () => {
    offsetUsuarios = Math.max(0, offsetUsuarios - LIMITE_PAGINA);
    carregarUsuarios();
  });
  el.btnSeguinte.addEventListener('click', () => {
    offsetUsuarios += LIMITE_PAGINA;
    carregarUsuarios();
  });
  el.btnMaisAuditoria.addEventListener('click', carregarAuditoria);

  el.btnConfirmarStatus.addEventListener('click', confirmarStatus);
  el.btnCancelarStatus.addEventListener('click', fecharModalStatus);
  el.btnFecharStatus.addEventListener('click', fecharModalStatus);
  el.modalStatus.addEventListener('click', (evento) => {
    if (evento.target === el.modalStatus) fecharModalStatus();
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
      window.location.reload();
    }
  });
}

/* -----------------------------------------------------------------------------
 * Link Admin — nesta página o item é o próprio destino atual; a marcação e a
 * injeção compartilhada ficam em js/navegacao.js (visível só para papel admin).
 * --------------------------------------------------------------------------- */
function adicionarLinkAdmin(perfil) {
  if (typeof window !== 'undefined' && typeof window.cgAdicionarLinkAdmin === 'function') {
    window.cgAdicionarLinkAdmin(perfil);
  }
}

(async function iniciarAdmin() {
  try {
    // 1) Autenticação pelo mecanismo existente.
    const conta = await requireAuth();
    if (!conta) return; // anônimo → login; inativo → aviso (nenhum dado exibido)

    // 2) Gate de papel ANTES de qualquer RPC administrativa.
    if (conta.perfil.role !== 'admin') {
      el.acessoNegado.hidden = false;
      el.papel.textContent = ROTULO_PAPEL[conta.perfil.role] || conta.perfil.role;
      el.nome.textContent = conta.perfil.full_name || conta.perfil.email || '';
      el.inicial.textContent = (el.nome.textContent.trim()[0] || '?').toUpperCase();
      el.chip.hidden = false;
      el.btnTema.disabled = false;
      atualizarBotaoTema();
      el.btnTema.addEventListener('click', () => {
        aplicarTema(temaEfetivo() === 'escuro' ? 'claro' : 'escuro');
      });
      el.btnSair.disabled = false;
      el.btnSair.addEventListener('click', () => logout('login.html'));
      return; // NENHUMA consulta administrativa é disparada
    }

    // 3) Autorizado: revela a área e carrega.
    perfilAtual = conta.perfil;
    el.nome.textContent = conta.perfil.full_name || conta.perfil.email || 'Usuário';
    el.papel.textContent = ROTULO_PAPEL[conta.perfil.role] || conta.perfil.role;
    el.inicial.textContent = (el.nome.textContent.trim()[0] || '?').toUpperCase();
    el.chip.hidden = false;
    el.conteudoAdmin.hidden = false;

    adicionarLinkAdmin(conta.perfil);

    habilitarControles();
    atualizarBotaoTema();
    registrarEventos();

    await Promise.all([carregarUsuarios(), carregarAuditoria()]);
  } catch (erro) {
    const traduzido = normalizarErro(erro);
    acaoRecuperacao = 'repetir';
    el.erroMensagem.textContent = traduzido.message;
    el.erroGlobal.hidden = false;
  }
})();
