/**
 * js/auth.js
 * =============================================================================
 * CONTROLE DE GASTOS — Controlador das páginas de autenticação.
 *
 * Páginas atendidas (identificadas por <body data-pagina="...">):
 *   login.html          → data-pagina="login"
 *   cadastro.html       → data-pagina="cadastro"
 *   recuperar-senha.html→ data-pagina="recuperar-senha"
 *   redefinir-senha.html→ data-pagina="redefinir-senha"
 *
 * RESPONSABILIDADES
 *   1. Cadastro com e-mail/senha (Supabase Auth envia o e-mail de confirmação).
 *   2. Login com verificação do status REAL da conta (RPC register_login,
 *      que lê public.profiles no banco) e redirecionamento seguro via ?next=.
 *   3. Recuperação de senha (mensagem genérica, sem revelar se o e-mail existe).
 *   4. Redefinição de senha (página aberta pelo link do e-mail; a troca do
 *      "código" por sessão é feita automaticamente pelo SDK - PKCE).
 *   5. Bloqueio de contas INATIVAS na entrada (regra 7) — o bloqueio definitivo
 *      permanece no banco (RLS + is_active_user); aqui é a UX correta.
 *   6. Validação de campos, prevenção de envio duplicado e mensagens claras.
 *
 * DEPENDÊNCIAS (todas existentes)
 *   js/config.js     → client único + quandoPronto
 *   js/supabase.js   → cadastrarConta, entrar, registrarLogin,
 *                      solicitarRecuperacaoSenha, definirNovaSenha, logout,
 *                      getSessao, observarSessao, ContaInativaError, ErroApp
 *
 * OBSERVAÇÃO: os validadores e helpers de UI deste arquivo são locais por
 * enquanto; quando js/utils.js, js/validacoes.js e js/components.js forem
 * criados (Etapa 4), a lógica comum migrará para lá sem mudar os fluxos.
 * =============================================================================
 */

import {
  cadastrarConta,
  entrar,
  registrarLogin,
  solicitarRecuperacaoSenha,
  definirNovaSenha,
  logout,
  getSessao,
  observarSessao,
  ContaInativaError
} from './supabase.js';

/* -----------------------------------------------------------------------------
 * Constantes e utilidades básicas
 * --------------------------------------------------------------------------- */
const PAGINA_INICIAL = 'dashboard.html';   // destino padrão após autenticação
const PAGINA_LOGIN = 'login.html';

const $ = (seletor) => document.querySelector(seletor);

const REGEX_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const REGEX_LETRA = /\p{L}/u;
const REGEX_NUMERO = /\d/;

let redirecionando = false; // evita duplo redirecionamento (sessão inicial x evento)

/** Caminho interno seguro (evita redirecionamento para domínios externos). */
export function caminhoSeguro(valor) {
  if (!valor || typeof valor !== 'string') return null;
  const v = valor.trim();
  if (v.startsWith('/') && !v.startsWith('//')) return v;
  if (/^[\w\-]+\.html$/i.test(v)) return v; // ex.: "dashboard.html"
  return null;
}

function redirecionar(url) {
  window.location.href = url;
}

/* -----------------------------------------------------------------------------
 * Validações (espelham as restrições do banco)
 * --------------------------------------------------------------------------- */

/** E-mail válido (formato; o Supabase valida unicidade). */
export function validarEmail(email) {
  return typeof email === 'string' && email.length <= 254 && REGEX_EMAIL.test(email);
}

/**
 * Senha forte: mínimo 8 caracteres, com pelo menos 1 letra e 1 número.
 * (o Supabase Auth também exige o mínimo configurado no painel)
 */
export function validarSenha(senha) {
  const falhas = [];
  if (typeof senha !== 'string' || senha.length < 8) falhas.push('mínimo de 8 caracteres');
  if (!REGEX_LETRA.test(senha || '')) falhas.push('pelo menos 1 letra');
  if (!REGEX_NUMERO.test(senha || '')) falhas.push('pelo menos 1 número');
  return falhas;
}

/** Nome completo: 2 a 120 caracteres (constraint profiles_full_name_length). */
export function validarNome(nome) {
  const n = String(nome || '').trim();
  return n.length >= 2 && n.length <= 120;
}

/* -----------------------------------------------------------------------------
 * Helpers de interface (mensagens, carregamento, checklist de senha)
 * --------------------------------------------------------------------------- */

/**
 * Exibe mensagem na área #mensagem da página.
 * tipo: 'erro' | 'sucesso' | 'aviso'
 */
export function definirMensagem(tipo, texto) {
  const area = $('#mensagem');
  if (!area) {
    if (texto) console.warn('[auth] mensagem sem área (' + tipo + '):', texto);
    return;
  }
  area.className = 'mensagem mensagem-' + tipo;
  area.textContent = texto || '';
  area.hidden = !texto;
  if (texto) area.setAttribute('role', tipo === 'erro' ? 'alert' : 'status');
}

function limparMensagem() {
  definirMensagem('', '');
}

/** Alterna o estado "enviando" de um botão (evita envio duplicado). */
function definirCarregando(botao, carregando) {
  if (!botao) return;
  if (carregando) {
    botao.dataset.textoOriginal = botao.textContent;
    botao.textContent = 'Aguarde…';
    botao.disabled = true;
    botao.setAttribute('aria-busy', 'true');
  } else {
    botao.textContent = botao.dataset.textoOriginal || botao.textContent;
    botao.disabled = false;
    botao.removeAttribute('aria-busy');
  }
}

/** Atualiza o checklist visual de requisitos da senha (se existir na página). */
function atualizarChecklistSenha(senha) {
  const itens = {
    tamanho: (senha || '').length >= 8,
    letra: REGEX_LETRA.test(senha || ''),
    numero: REGEX_NUMERO.test(senha || '')
  };
  document.querySelectorAll('[data-requisito]').forEach((item) => {
    const chave = item.dataset.requisito;
    const ok = Boolean(itens[chave]);
    item.classList.toggle('ok', ok);
    item.setAttribute('aria-checked', ok ? 'true' : 'false');
  });
}

/** Mensagens pré-definidas chegando pela URL (?status= / ?msg=). */
function mostrarAvisosDaURL() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('status') === 'inativa') {
    definirMensagem('aviso',
      'Sua conta está inativa. Os dados financeiros permanecem bloqueados até que ' +
      'o administrador reative o acesso.');
  }
  if (params.get('msg') === 'senha-alterada') {
    definirMensagem('sucesso', 'Senha alterada com sucesso! Entre com a nova senha.');
  }
  if (params.get('msg') === 'conta-criada') {
    definirMensagem('sucesso',
      'Conta criada! Se a confirmação de e-mail estiver ativa, verifique sua caixa ' +
      'de entrada antes de entrar.');
  }
}

/* -----------------------------------------------------------------------------
 * Redirecionamento pós-autenticação (com checagem do status no banco)
 * --------------------------------------------------------------------------- */

/**
 * Chamado sempre que uma sessão válida surge (login, confirmação de e-mail).
 * 1. Chama a RPC register_login() — que lê public.profiles e grava last_login_at.
 * 2. Se a conta estiver INATIVA, encerra a sessão e avisa (nenhum dado carregado).
 * 3. Se estiver ATIVA, redireciona para ?next= (seguro) ou dashboard.html.
 */
async function irParaAreaLogada() {
  if (redirecionando) return;
  redirecionando = true;
  try {
    await registrarLogin(); // lança ContaInativaError se status != 'active'
    const params = new URLSearchParams(window.location.search);
    const destino = caminhoSeguro(params.get('next')) || PAGINA_INICIAL;
    redirecionar(destino);
  } catch (erro) {
    redirecionando = false;
    if (erro instanceof ContaInativaError) {
      await logout(); // remove a sessão local; o banco já bloqueia os dados
      definirMensagem('aviso', erro.message);
    } else {
      definirMensagem('erro', erro.message || 'Não foi possível concluir a entrada.');
    }
  }
}

/* -----------------------------------------------------------------------------
 * Página: LOGIN
 * --------------------------------------------------------------------------- */
function iniciarLogin() {
  mostrarAvisosDaURL();

  const form = $('#form-login');
  if (!form) return;

  const campoEmail = $('#email');
  const campoSenha = $('#senha');
  const botao = $('#btn-entrar');
  let emProcesso = false;

  (async () => {
    try {
      const sessao = await getSessao();
      if (sessao) { await irParaAreaLogada(); return; }
      // Link de confirmação pode concluir a sessão nesta página (?code=...).
      await observarSessao((evento) => {
        if (evento === 'SIGNED_IN') irParaAreaLogada();
      });
    } catch (erro) {
      definirMensagem('erro', erro.message || 'Falha ao verificar sua sessão.');
    }
  })();

  form.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    if (emProcesso || redirecionando) return;
    limparMensagem();

    const email = (campoEmail && campoEmail.value || '').trim();
    const senha = (campoSenha && campoSenha.value) || '';

    const problemas = [];
    if (!validarEmail(email)) problemas.push('Informe um e-mail válido.');
    if (!senha) problemas.push('Informe sua senha.');
    if (problemas.length) {
      definirMensagem('erro', problemas.join(' '));
      return;
    }

    emProcesso = true;
    definirCarregando(botao, true);
    try {
      await entrar(email, senha);
      await irParaAreaLogada(); // em caso de conta inativa, avisa e encerra a sessão
    } catch (erro) {
      emProcesso = false;
      definirCarregando(botao, false);
      definirMensagem('erro', erro.message || 'Não foi possível entrar.');
    }
  });
}

/* -----------------------------------------------------------------------------
 * Página: CADASTRO
 * --------------------------------------------------------------------------- */
function iniciarCadastro() {
  const form = $('#form-cadastro');
  if (!form) return;

  const campoNome = $('#nome');
  const campoEmail = $('#email');
  const campoSenha = $('#senha');
  const campoConfirmar = $('#confirmar-senha');
  const botao = $('#btn-cadastrar');
  let emProcesso = false;

  if (campoSenha) {
    campoSenha.addEventListener('input', () => atualizarChecklistSenha(campoSenha.value));
  }

  (async () => {
    try {
      const sessao = await getSessao();
      if (sessao) { await irParaAreaLogada(); return; }
    } catch (_erro) { /* sem sessão: fluxo normal de cadastro */ }
  })();

  form.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    if (emProcesso || redirecionando) return;
    limparMensagem();

    const nome = (campoNome && campoNome.value || '').trim();
    const email = (campoEmail && campoEmail.value || '').trim();
    const senha = (campoSenha && campoSenha.value) || '';
    const confirmar = (campoConfirmar && campoConfirmar.value) || '';

    const problemas = [];
    if (!validarNome(nome)) problemas.push('Informe seu nome completo (2 a 120 caracteres).');
    if (!validarEmail(email)) problemas.push('Informe um e-mail válido.');
    const falhasSenha = validarSenha(senha);
    if (falhasSenha.length) problemas.push('A senha precisa de: ' + falhasSenha.join(', ') + '.');
    if (senha !== confirmar) problemas.push('A confirmação de senha não corresponde.');
    if (problemas.length) {
      definirMensagem('erro', problemas.join(' '));
      return;
    }

    emProcesso = true;
    definirCarregando(botao, true);
    try {
      const resultado = await cadastrarConta(email, senha, nome);
      if (resultado && resultado.session) {
        // Confirmação de e-mail DESATIVADA: sessão criada imediatamente.
        definirMensagem('sucesso', 'Conta criada! Entrando…');
        await irParaAreaLogada();
      } else {
        // Confirmação de e-mail ATIVADA (padrão do projeto): e-mail enviado.
        form.reset();
        atualizarChecklistSenha('');
        definirCarregando(botao, false);
        emProcesso = false;
        definirMensagem('sucesso',
          'Conta criada! Enviamos um e-mail de confirmação para ' + email + '. ' +
          'Abra o link recebido para ativar o acesso (confira também o spam).');
      }
    } catch (erro) {
      emProcesso = false;
      definirCarregando(botao, false);
      definirMensagem('erro', erro.message || 'Não foi possível criar a conta.');
    }
  });
}

/* -----------------------------------------------------------------------------
 * Página: RECUPERAR SENHA
 * --------------------------------------------------------------------------- */
function iniciarRecuperarSenha() {
  const form = $('#form-recuperar');
  if (!form) return;

  const campoEmail = $('#email');
  const botao = $('#btn-recuperar');
  let emProcesso = false;

  form.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    if (emProcesso) return;
    limparMensagem();

    const email = (campoEmail && campoEmail.value || '').trim();
    if (!validarEmail(email)) {
      definirMensagem('erro', 'Informe um e-mail válido.');
      return;
    }

    emProcesso = true;
    definirCarregando(botao, true);
    try {
      await solicitarRecuperacaoSenha(email);
      // Mensagem GENÉRICA (não revela se o e-mail existe — segurança).
      definirMensagem('sucesso',
        'Se existir uma conta para este e-mail, as instruções de redefinição serão ' +
        'enviadas em instantes. Verifique também a caixa de spam.');
      form.reset();
    } catch (erro) {
      // Falhas reais (rede, limite de envio) são exibidas normalmente.
      definirMensagem('erro', erro.message || 'Não foi possível enviar o e-mail.');
    } finally {
      emProcesso = false;
      definirCarregando(botao, false);
    }
  });
}

/* -----------------------------------------------------------------------------
 * Página: REDEFINIR SENHA (aberta pelo link do e-mail)
 * --------------------------------------------------------------------------- */
function iniciarRedefinirSenha() {
  const estadoCarregando = $('#estado-carregando');
  const estadoInvalido = $('#estado-link-invalido');
  const form = $('#form-redefinir');
  if (!form) return;

  const campoSenha = $('#senha');
  const campoConfirmar = $('#confirmar-senha');
  const botao = $('#btn-redefinir');
  let emProcesso = false;
  let recoveryAutorizada = false;
  let sessaoAtual = null;

  const mostrar = (el) => { if (el) el.hidden = false; };
  const ocultar = (el) => { if (el) el.hidden = true; };

  function mostrarFormulario() {
    ocultar(estadoCarregando);
    ocultar(estadoInvalido);
    form.hidden = false;
    if (campoSenha) campoSenha.focus();
  }

  function mostrarLinkInvalido() {
    ocultar(estadoCarregando);
    ocultar(form);
    mostrar(estadoInvalido);
  }

  if (campoSenha) {
    campoSenha.addEventListener('input', () => atualizarChecklistSenha(campoSenha.value));
  }

  // A existência de uma sessão comum NÃO comprova um fluxo de recuperação.
  // A autorização vem exclusivamente do evento PASSWORD_RECOVERY emitido pelo
  // Supabase ao validar/trocar o token recebido no link de recuperação.
  (async () => {
    try {
      await observarSessao((evento, sessao) => {
        if (evento === 'PASSWORD_RECOVERY') {
          recoveryAutorizada = true;
          sessaoAtual = sessao || null;
          if (sessaoAtual && recoveryAutorizada) mostrarFormulario();
          else mostrarLinkInvalido();
        } else if (evento === 'SIGNED_OUT') {
          recoveryAutorizada = false;
          sessaoAtual = null;
          mostrarLinkInvalido();
        }
      });

      // Dá tempo ao SDK para processar o código do link após a inscrição do
      // observador. INITIAL_SESSION / SIGNED_IN isoladamente não autorizam.
      sessaoAtual = await getSessao();
      if (!recoveryAutorizada || !sessaoAtual) mostrarLinkInvalido();
      else mostrarFormulario();
    } catch (erro) {
      recoveryAutorizada = false;
      mostrarLinkInvalido();
      definirMensagem('erro', erro.message || 'Falha ao validar o link de redefinição.');
    }
  })();

  form.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    if (emProcesso) return;
    limparMensagem();

    // Revalida o estado no momento do envio; uma sessão de login comum não basta.
    try {
      sessaoAtual = await getSessao();
    } catch (_erro) {
      sessaoAtual = null;
    }
    if (!recoveryAutorizada || !sessaoAtual) {
      recoveryAutorizada = false;
      mostrarLinkInvalido();
      definirMensagem('erro', 'O link de recuperação não é válido nesta sessão. Solicite um novo link.');
      return;
    }

    const senha = (campoSenha && campoSenha.value) || '';
    const confirmar = (campoConfirmar && campoConfirmar.value) || '';
    const problemas = [];
    const falhasSenha = validarSenha(senha);
    if (falhasSenha.length) problemas.push('A nova senha precisa de: ' + falhasSenha.join(', ') + '.');
    if (senha !== confirmar) problemas.push('A confirmação de senha não corresponde.');
    if (problemas.length) {
      definirMensagem('erro', problemas.join(' '));
      return;
    }

    emProcesso = true;
    definirCarregando(botao, true);
    try {
      await definirNovaSenha(senha);
      // Consome a autorização local antes de encerrar a sessão.
      recoveryAutorizada = false;
      sessaoAtual = null;
      ocultar(form);
      await logout();
      redirecionar(PAGINA_LOGIN + '?msg=senha-alterada');
    } catch (erro) {
      emProcesso = false;
      definirCarregando(botao, false);
      definirMensagem('erro', erro.message || 'Não foi possível alterar a senha.');
    }
  });
}

/* -----------------------------------------------------------------------------
 * Inicialização por página
 * --------------------------------------------------------------------------- */
function iniciarPaginaAtual() {
  const pagina = document.body ? document.body.dataset.pagina : null;
  switch (pagina) {
    case 'login': iniciarLogin(); break;
    case 'cadastro': iniciarCadastro(); break;
    case 'recuperar-senha': iniciarRecuperarSenha(); break;
    case 'redefinir-senha': iniciarRedefinirSenha(); break;
    default:
      // Página sem data-pagina (ex.: diagnostico.html): apenas carrega os módulos.
      console.info('[auth] Nenhuma página de autenticação nesta tela.');
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', iniciarPaginaAtual);
} else {
  iniciarPaginaAtual();
}

/* -----------------------------------------------------------------------------
 * Exportações reutilizáveis pelas páginas internas
 * --------------------------------------------------------------------------- */

/** Sair da conta (usado pelo menu das páginas privadas). */
export async function sair(urlDestino = PAGINA_LOGIN) {
  await logout(urlDestino);
}

/** Redireciona para o login preservando a página atual como destino. */
export function irParaLogin(paginaLogin = PAGINA_LOGIN) {
  const destino = caminhoSeguro(window.location.pathname + window.location.search);
  redirecionar(destino
    ? paginaLogin + '?next=' + encodeURIComponent(destino)
    : paginaLogin);
}

export default {
  caminhoSeguro,
  validarEmail,
  validarSenha,
  validarNome,
  definirMensagem,
  sair,
  irParaLogin
};
