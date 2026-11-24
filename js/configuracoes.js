/**
 * js/configuracoes.js
 * =============================================================================
 * CONTROLE DE GASTOS — Configurações da conta (Fase 7-F).
 *
 * CONTRATOS REAIS (conferidos em js/supabase.js e database/schema.sql)
 *   • requireAuth() → { user, perfil } — protege a página; RLS é o bloqueio real.
 *   • salvarPerfil({ full_name?, timezone? }) — whitelist REAL: somente esses
 *     dois campos; atualiza public.profiles e devolve a linha atualizada.
 *     E-mail, status e papel NÃO podem ser alterados: o trigger
 *     trg_profiles_protect_columns bloqueia no banco (aqui são somente leitura).
 *   • logout('login.html') encerra a sessão.
 *   • Tema: data-theme no <html> + localStorage('theme') — o MESMO mecanismo
 *     usado por todas as páginas; 'auto' remove atributo e chave.
 *   • app_today() (banco) lê profiles.timezone: a mudança de fuso afeta o
 *     cálculo de "hoje", vencimentos e atrasos — por isso o aviso na interface.
 *
 * SEGURANÇA
 *   • Toda a interface é montada com createElement/textContent (nada de
 *     innerHTML com dados do usuário).
 *   • Sucesso apenas após confirmação do servidor (nada de otimismo).
 * =============================================================================
 */

import {
  requireAuth,
  logout,
  normalizarErro,
  salvarPerfil
} from './supabase.js';

/* -----------------------------------------------------------------------------
 * Referências (IDs conferidos em configuracoes.html)
 * --------------------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);

const el = {
  chip: $('usuario-chip'),
  inicial: $('usuario-inicial'),
  nome: $('usuario-nome'),
  papel: $('usuario-papel'),
  btnTema: $('btn-tema'),
  btnSair: $('btn-sair'),
  btnEncerrarSessao: $('btn-encerrar-sessao'),
  erroGlobal: $('estado-erro-global'),
  erroMensagem: $('erro-mensagem'),
  btnTentar: $('btn-tentar-novamente'),
  mensagemPerfil: $('mensagem-perfil'),
  formPerfil: $('form-perfil'),
  campoNome: $('campo-nome'),
  campoFuso: $('campo-fuso'),
  avisoFuso: $('aviso-fuso'),
  btnSalvar: $('btn-salvar-perfil'),
  btnRestaurar: $('btn-restaurar-perfil'),
  contaStatus: $('conta-status'),
  contaEmail: $('conta-email'),
  contaPapel: $('conta-papel'),
  contaCriada: $('conta-criada'),
  contaUltimoAcesso: $('conta-ultimo-acesso'),
  radiosTema: () => document.querySelectorAll('input[name="tema"]'),
  toasts: $('area-toasts')
};

/* -----------------------------------------------------------------------------
 * Estado
 * --------------------------------------------------------------------------- */
let perfilAtual = null;      // baseline do perfil carregado (para "Desfazer")
let acaoRecuperacao = 'repetir';

const FUSO_PADRAO = 'America/Sao_Paulo';
const CHAVE_TEMA = 'theme';

const ROTULO_PAPEL = { user: 'Conta pessoal', admin: 'Administrador' };

/* -----------------------------------------------------------------------------
 * Utilidades
 * --------------------------------------------------------------------------- */
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

function definirMensagem(tipo, texto) {
  el.mensagemPerfil.className = `mensagem mensagem-${tipo}`;
  el.mensagemPerfil.textContent = texto || '';
  el.mensagemPerfil.hidden = !texto;
}

function dataHoraBR(iso) {
  if (!iso) return '—';
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return '—';
  return data.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

/* -----------------------------------------------------------------------------
 * Tema — mesmo mecanismo único do app (data-theme + localStorage('theme'))
 * --------------------------------------------------------------------------- */
function temaEfetivo() {
  const explicito = document.documentElement.dataset.theme;
  if (explicito === 'claro' || explicito === 'escuro') return explicito;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'escuro' : 'claro';
}

function temaEscolhido() {
  // 'claro' | 'escuro' quando o usuário fixou; 'auto' quando não há atributo.
  const explicito = document.documentElement.dataset.theme;
  return explicito === 'claro' || explicito === 'escuro' ? explicito : 'auto';
}

function aplicarTema(escolha) {
  if (escolha === 'claro' || escolha === 'escuro') {
    document.documentElement.dataset.theme = escolha;
    try { localStorage.setItem(CHAVE_TEMA, escolha); } catch (_e) { /* sem storage */ }
  } else {
    delete document.documentElement.dataset.theme;
    try { localStorage.removeItem(CHAVE_TEMA); } catch (_e) { /* sem storage */ }
  }
  refletirTemaNaInterface();
  atualizarBotaoTema();
}

/** Rótulo acessível do botão de tema do cabeçalho (o ícone é CSS). */
function atualizarBotaoTema() {
  if (!el.btnTema) return;
  const escuro = temaEfetivo() === 'escuro';
  el.btnTema.setAttribute('aria-label', escuro ? 'Mudar para tema claro' : 'Mudar para tema escuro');
  el.btnTema.setAttribute('title', escuro ? 'Mudar para tema claro' : 'Mudar para tema escuro');
  el.btnTema.dataset.temaAtual = escuro ? 'escuro' : 'claro';
}

function refletirTemaNaInterface() {
  const escolha = temaEscolhido();
  el.radiosTema().forEach((radio) => {
    radio.checked = radio.value === escolha;
  });
}

/* -----------------------------------------------------------------------------
 * Perfil
 * --------------------------------------------------------------------------- */
function preencherConta(perfil) {
  el.nome.textContent = perfil.full_name || perfil.email || 'Usuário';
  el.papel.textContent = ROTULO_PAPEL[perfil.role] || perfil.role;
  el.inicial.textContent = (el.nome.textContent.trim()[0] || '?').toUpperCase();
  el.chip.hidden = false;

  el.contaEmail.textContent = perfil.email || '—';

  el.contaStatus.textContent = '';
  if (perfil.status === 'active') {
    el.contaStatus.className = 'etiqueta etiqueta-pago';
    el.contaStatus.textContent = 'Ativa';
  } else {
    el.contaStatus.className = 'etiqueta etiqueta-atrasado';
    el.contaStatus.textContent = 'Inativa';
  }

  el.contaPapel.textContent = ROTULO_PAPEL[perfil.role] || perfil.role || '—';
  el.contaCriada.textContent = dataHoraBR(perfil.created_at);
  el.contaUltimoAcesso.textContent = dataHoraBR(perfil.last_login_at);
}

function preencherFormulario(perfil) {
  el.campoNome.value = perfil.full_name || '';
  // Garante que o fuso salvo exista na lista (caso venha outro IANA válido)
  const fuso = perfil.timezone || FUSO_PADRAO;
  if (![...el.campoFuso.options].some((o) => o.value === fuso)) {
    const opcao = criarElemento('option', null, fuso);
    opcao.value = fuso;
    el.campoFuso.appendChild(opcao);
  }
  el.campoFuso.value = fuso;
  atualizarAvisoFuso();
  atualizarBotaoRestaurar();
}

function atualizarAvisoFuso() {
  const mudou = perfilAtual && el.campoFuso.value !== perfilAtual.timezone;
  el.avisoFuso.hidden = !mudou;
}

function atualizarBotaoRestaurar() {
  const mudou = perfilAtual && (
    el.campoNome.value.trim() !== (perfilAtual.full_name || '') ||
    el.campoFuso.value !== (perfilAtual.timezone || FUSO_PADRAO)
  );
  el.btnRestaurar.hidden = !mudou;
}

async function salvarPerfilInterface(evento) {
  evento.preventDefault();

  const nome = el.campoNome.value.trim();
  if (nome.length < 2 || nome.length > 120) {
    definirMensagem('erro', 'O nome completo deve ter entre 2 e 120 caracteres.');
    return;
  }

  const fusoMudou = perfilAtual && el.campoFuso.value !== perfilAtual.timezone;
  el.btnSalvar.disabled = true;
  el.btnSalvar.setAttribute('aria-busy', 'true');
  definirMensagem('', '');

  try {
    // Whitelist real de salvarPerfil: somente full_name e timezone.
    const atualizado = await salvarPerfil({
      full_name: nome,
      timezone: el.campoFuso.value
    });

    if (!atualizado) throw normalizarErro(new Error('A atualização não retornou dados.'));

    perfilAtual = atualizado;       // confirmação do servidor vira novo baseline
    preencherConta(atualizado);
    preencherFormulario(atualizado);
    definirMensagem('sucesso',
      'Perfil salvo.' + (fusoMudou
        ? ' A partir de agora, “hoje”, vencimentos e atrasos usam o fuso ' + atualizado.timezone + '.'
        : ''));
    criarToast('sucesso', 'Perfil atualizado com sucesso.');
  } catch (erro) {
    const traduzido = normalizarErro(erro);
    definirMensagem('erro', traduzido.message); // mensagem real do banco/trigger
    criarToast('erro', 'Não foi possível salvar o perfil.');
    if (traduzido.codigo === 'auth' || traduzido.codigo === 'permissao') {
      acaoRecuperacao = 'login';
      el.erroGlobal.hidden = false;
      el.erroMensagem.textContent = traduzido.message + ' Faça login novamente.';
    }
  } finally {
    el.btnSalvar.disabled = false;
    el.btnSalvar.removeAttribute('aria-busy');
  }
}

/* -----------------------------------------------------------------------------
 * Eventos e inicialização
 * --------------------------------------------------------------------------- */
function habilitarControles() {
  document.querySelectorAll('[data-aguardando="js/configuracoes.js"]').forEach((elemento) => {
    elemento.disabled = false;
    elemento.removeAttribute('data-aguardando');
  });
}

function registrarEventos() {
  el.formPerfil.addEventListener('submit', salvarPerfilInterface);

  el.btnRestaurar.addEventListener('click', () => {
    if (perfilAtual) preencherFormulario(perfilAtual);
    definirMensagem('', '');
  });

  el.campoFuso.addEventListener('change', () => {
    atualizarAvisoFuso();
    atualizarBotaoRestaurar();
  });
  el.campoNome.addEventListener('input', atualizarBotaoRestaurar);

  el.radiosTema().forEach((radio) => {
    radio.addEventListener('change', () => {
      if (radio.checked) aplicarTema(radio.value); // 'auto' | 'claro' | 'escuro'
    });
  });

  if (el.btnTema) {
    el.btnTema.addEventListener('click', () => {
      aplicarTema(temaEfetivo() === 'escuro' ? 'claro' : 'escuro');
    });
  }

  el.btnSair.addEventListener('click', () => logout('login.html'));
  if (el.btnEncerrarSessao) {
    el.btnEncerrarSessao.addEventListener('click', () => logout('login.html'));
  }

  el.btnTentar.addEventListener('click', () => {
    if (acaoRecuperacao === 'login') {
      logout('login.html');
    } else {
      acaoRecuperacao = 'repetir';
      window.location.reload(); // recarrega o perfil a partir do banco
    }
  });
}

(async function iniciarConfiguracoes() {
  try {
    const conta = await requireAuth();
    if (!conta) return; // redirecionado ao login ou conta inativa

    perfilAtual = conta.perfil;
    preencherConta(conta.perfil);
    preencherFormulario(conta.perfil);
    refletirTemaNaInterface();
    atualizarBotaoTema();

    // Link de Administração apenas para o papel real "admin" (ver js/navegacao.js).
    if (typeof window !== 'undefined' && typeof window.cgAdicionarLinkAdmin === 'function') {
      window.cgAdicionarLinkAdmin(conta.perfil);
    }

    habilitarControles();
    registrarEventos();
  } catch (erro) {
    const traduzido = normalizarErro(erro);
    acaoRecuperacao = 'repetir';
    el.erroMensagem.textContent = traduzido.message;
    el.erroGlobal.hidden = false;
  }
})();
