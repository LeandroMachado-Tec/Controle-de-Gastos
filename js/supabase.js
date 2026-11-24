/**
 * js/supabase.js
 * =============================================================================
 * CONTROLE DE GASTOS — Camada de acesso, sessão e erros.
 *
 * FINALIDADE
 *   1. Reutilizar O CLIENTE ÚNICO criado em js/config.js (nenhuma página cria
 *      instância própria).
 *   2. Traduzir erros do Supabase/PostgreSQL para mensagens claras em
 *      português, SEM expor tokens, chaves ou detalhes internos.
 *   3. Oferecer helpers de sessão e o guarda de páginas privadas requireAuth().
 *   4. Verificar o status real da conta LENDO A TABELA profiles no banco
 *      (não confia em afirmação dentro do JWT nem em verificação apenas JS).
 *
 * AUTORIZAÇÃO (regra 10 do enunciado)
 *   - requireAuth() protege a NAVEGAÇÃO (UX). A proteção REAL está no banco:
 *       * RLS (database/rls.sql): cada usuário só vê/altera as próprias linhas;
 *       * is_active_user(): conta INATIVA não lê nem escreve nada financeiro,
 *         mesmo com JWT válido;
 *       * escrita financeira apenas pelas RPCs (database/functions.sql).
 *
 * OBJETOS REAIS DO BANCO USADOS NESTE ARQUIVO (conferidos no disco):
 *   - Tabela public.profiles: id, email, full_name, status ('active'|'inactive'),
 *     role ('user'|'admin'), timezone, created_at, updated_at, last_login_at.
 *   - RPC public.register_login(): devolve { id, email, full_name, status,
 *     role, timezone } e grava last_login_at (chamada somente APÓS login bem-
 *     sucedido; usada por js/auth.js).
 *   - Políticas RLS permitem ler a PRÓPRIA linha de profiles mesmo com conta
 *     inativa — por isso conseguimos exibir a mensagem correta; o bloqueio
 *     financeiro continua no banco.
 * =============================================================================
 */

import { quandoPronto, showFatalError } from './config.js';

/* -----------------------------------------------------------------------------
 * Constantes (valores EXATOS dos ENUMs do banco: account_status e app_role)
 * --------------------------------------------------------------------------- */
export const STATUS_CONTA = { ATIVA: 'active', INATIVA: 'inactive' };
export const PAPEIS = { USUARIO: 'user', ADMIN: 'admin' };

/* -----------------------------------------------------------------------------
 * Erros tipados
 * --------------------------------------------------------------------------- */
export class ErroApp extends Error {
  constructor(codigo, mensagem, erroOriginal = null) {
    super(mensagem);
    this.name = 'ErroApp';
    this.codigo = codigo;          // 'rede' | 'config' | 'auth' | 'permissao' | 'validacao' | 'conflito' | 'banco' | 'desconhecido'
    this.erroOriginal = erroOriginal;
  }
}

export class ContaInativaError extends ErroApp {
  constructor() {
    super('conta-inativa',
      'Sua conta está inativa. Você não consegue acessar os dados financeiros. ' +
      'Procure o administrador do sistema para reativá-la.');
    this.name = 'ContaInativaError';
  }
}

export class SessaoAusenteError extends ErroApp {
  constructor() {
    super('sessao-ausente', 'Você precisa entrar com sua conta para acessar esta página.');
    this.name = 'SessaoAusenteError';
  }
}

/* -----------------------------------------------------------------------------
 * Acesso ao client único (com espera da inicialização)
 * --------------------------------------------------------------------------- */

/**
 * Devolve o client Supabase compartilhado, aguardando a inicialização
 * (config validada + SDK vendorizado carregado).
 * Rejeita com ErroApp('config') se a configuração estiver inválida.
 */
export async function obterCliente() {
  try {
    return await quandoPronto;
  } catch (erro) {
    throw new ErroApp('config',
      erro && erro.message ? erro.message : 'Falha na configuração do Supabase.', erro);
  }
}

/* -----------------------------------------------------------------------------
 * Detecção de erros de rede / infraestrutura
 * --------------------------------------------------------------------------- */
export function isNetworkError(erro) {
  if (!erro) return false;
  const nome = String(erro.name || '');
  const msg = String(erro.message || '');
  return (
    nome === 'TypeError' && /fetch|network/i.test(msg) ||
    nome === 'AuthRetryableFetchError' ||
    /failed to fetch|networkerror|load failed|network request failed/i.test(msg) ||
    ['08000', '08001', '08003', '08006'].includes(String(erro.code || ''))
  );
}

/* -----------------------------------------------------------------------------
 * Tradução de erros para português (sem expor dados sensíveis)
 * --------------------------------------------------------------------------- */
const MAPA_MENSAGENS_AUTH = [
  [/invalid login credentials/i, 'E-mail ou senha incorretos.'],
  [/email not confirmed/i, 'Confirme seu e-mail antes de entrar. Verifique a caixa de entrada (e o spam).'],
  [/user already registered|already been registered/i, 'Este e-mail já está cadastrado. Tente entrar ou recuperar a senha.'],
  [/password should be at least (\d+)/i, (m) => `A senha deve ter pelo menos ${m[1]} caracteres.`],
  [/signups not allowed/i, 'O cadastro de novas contas está desativado neste sistema.'],
  [/email rate limit exceeded/i, 'Muitos e-mails enviados em pouco tempo. Aguarde alguns minutos e tente novamente.'],
  [/request this once every 60 seconds/i, 'Por segurança, aguarde 1 minuto antes de tentar novamente.'],
  [/new password should be different/i, 'A nova senha deve ser diferente da senha anterior.'],
  [/same password/i, 'A nova senha deve ser diferente da senha anterior.'],
  [/invalid email or password/i, 'E-mail ou senha incorretos.'],
  [/captcha verification failed/i, 'Verificação anti-robô falhou. Tente novamente.'],
  [/over request rate limit|too many requests/i, 'Muitas tentativas seguidas. Aguarde alguns minutos.'],
  [/user not found/i, 'Conta não encontrada para este e-mail.'],
  [/session missing|no session/i, 'Sua sessão expirou. Entre novamente.'],
  [/token|jwt/i, 'Sua sessão expirou ou é inválida. Entre novamente.']
];

const MAPA_CODIGOS_PG = {
  '42P01': 'O banco de dados ainda não foi configurado (tabelas ausentes). Execute os arquivos SQL em docs/INSTALACAO.md, Parte 2.',
  'PGRST205': 'Tabela não encontrada no banco de dados. Se os scripts SQL já foram executados, recarregue a página; caso contrário, execute-os em docs/INSTALACAO.md, Parte 2.',
  'PGRST202': 'Função do banco de dados não encontrada. Execute database/functions.sql (docs/INSTALACAO.md, Parte 2).',
  '42883': 'Uma função do banco de dados não foi encontrada. Execute database/functions.sql (docs/INSTALACAO.md, Parte 2).',
  '42501': 'Você não tem permissão para esta operação.',
  '28000': 'Sessão não autenticada. Entre novamente.',
  'PGRST301': 'Sua sessão expirou. Entre novamente.',
  '23505': 'Registro duplicado: esta informação já foi salva.',
  '23503': 'Operação recusada: existe vínculo com outro registro.',
  '23514': 'Dados inválidos: a operação viola as regras de integridade.',
  '22P02': 'Valor inválido em um dos campos.',
  '22023': 'Valor inválido em um dos campos.',
  '57014': 'A operação no banco demorou demais e foi cancelada. Tente novamente.'
};

/**
 * Converte qualquer erro do SDK/PostgreSQL em mensagem amigável.
 * Mensagens que já chegam em português das nossas RPCs passam intactas.
 */
export function traduzErro(erro) {
  if (!erro) return 'Ocorreu um erro inesperado. Tente novamente.';

  // 1) Falha de rede (tratada primeiro: é a mais comum em celular).
  if (isNetworkError(erro)) {
    return 'Sem conexão com o servidor. Verifique sua internet e tente novamente.';
  }

  const mensagem = String(erro.message || '');
  const codigo = String(erro.code || '');

  // 2) Mensagens de autenticação (GoTrue) — em inglês.
  for (const [padrao, resposta] of MAPA_MENSAGENS_AUTH) {
    const m = mensagem.match(padrao);
    if (m) return typeof resposta === 'function' ? resposta(m) : resposta;
  }

  // 3) Códigos do PostgreSQL / PostgREST conhecidos.
  if (codigo && MAPA_CODIGOS_PG[codigo]) {
    // Nossas RPCs enviam mensagens já em português: preferimos a mensagem
    // original quando ela NÃO parece ser um texto técnico em inglês.
    const pareceTecnico = /permission denied|duplicate key|violates|relation|function|role/i.test(mensagem);
    if (!mensagem || pareceTecnico) return MAPA_CODIGOS_PG[codigo];
    return mensagem;
  }

  // 4) Qualquer outra mensagem: mostra a mensagem do banco quando existir,
  //    desde que não contenha detalhes técnicos sensíveis.
  if (mensagem && mensagem.length <= 300 && !/key|token|service_role|password/i.test(mensagem)) {
    return mensagem;
  }

  return 'Não foi possível concluir a operação. Tente novamente em instantes.';
}

/** Normaliza um erro qualquer em ErroApp com código e mensagem traduzida. */
export function normalizarErro(erro) {
  if (erro instanceof ErroApp) return erro;
  let codigo = 'desconhecido';
  if (isNetworkError(erro)) codigo = 'rede';
  else if (String(erro.code || '').startsWith('23') || ['22P02', '22023'].includes(String(erro.code || ''))) codigo = 'validacao';
  else if (['42501', '28000'].includes(String(erro.code || ''))) codigo = 'permissao';
  else if (String(erro.status || '') === '400' || String(erro.status || '') === '401') codigo = 'auth';
  return new ErroApp(codigo, traduzErro(erro), erro);
}

/* -----------------------------------------------------------------------------
 * Cliente compartilhado
 * --------------------------------------------------------------------------- */
export async function getClient() {
  return await obterCliente(); // lança erro claro se a configuração falhou
}

/**
 * Chamada padronizada de RPC: resolve o client, executa e devolve
 * { data, error } com o erro já traduzido (ErroApp).
 */
export async function callRpc(nomeFuncao, parametros = {}) {
  const client = await obterCliente();
  try {
    const { data, error } = await client.rpc(nomeFuncao, parametros);
    if (error) throw normalizarErro(error);
    return data;
  } catch (erro) {
    if (erro instanceof ErroApp) throw erro;
    throw normalizarErro(erro);
  }
}

/* -----------------------------------------------------------------------------
 * Sessão
 * --------------------------------------------------------------------------- */

/** Devolve a sessão atual (ou null). Nunca lança por ausência de sessão. */
export async function getSessao() {
  const client = await obterCliente();
  const { data, error } = await client.auth.getSession();
  if (error) throw normalizarErro(error);
  return data.session || null;
}

/** Observa mudanças de sessão. Retorna função para cancelar a observação. */
export async function observarSessao(funcao) {
  const client = await obterCliente();
  const { data } = client.auth.onAuthStateChange((evento, sessao) => {
    funcao(evento, sessao); // eventos: SIGNED_IN, SIGNED_OUT, TOKEN_REFRESHED, USER_UPDATED, PASSWORD_RECOVERY
  });
  return () => data.subscription.unsubscribe();
}

/** Encerra a sessão com segurança e, opcionalmente, redireciona. */
export async function logout(urlDestino = null) {
  const client = await obterCliente();
  try {
    await client.auth.signOut();
  } catch (erro) {
    // Mesmo com falha local, o cookie/token deixa de ser usado pelo app.
    console.warn('[supabase] falha ao encerrar sessão:', traduzErro(erro));
  }
  if (urlDestino) irPara(urlDestino);
  return true;
}

/* -----------------------------------------------------------------------------
 * Perfil e status da conta (fonte de verdade: banco de dados)
 * --------------------------------------------------------------------------- */

/**
 * Lê a linha do perfil do usuário logado direto em public.profiles.
 * (A RLS permite ler apenas a própria linha.)
 */
export async function carregarPerfil(userId) {
  const client = await obterCliente();
  const { data, error } = await client
    .from('profiles')
    .select('id, email, full_name, status, role, timezone, created_at, updated_at, last_login_at')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw normalizarErro(error);
  return data; // null quando o perfil não existir (ex.: SQL não executado)
}

/**
 * Valida a conta do usuário logado CONTRA O BANCO.
 * Uma sessão válida NÃO é prova de conta ativa (regra do projeto):
 * o status é lido de profiles a cada verificação.
 * @returns {Promise<{user: object, perfil: object}>}
 * @throws {SessaoAusenteError} sem sessão
 * @throws {ContaInativaError}  status = 'inactive'
 * @throws {ErroApp}            sem perfil (banco não configurado) ou falha
 */
export async function verificarConta() {
  const sessao = await getSessao();
  if (!sessao || !sessao.user) throw new SessaoAusenteError();

  const perfil = await carregarPerfil(sessao.user.id);

  if (!perfil) {
    throw new ErroApp('banco',
      'Seu perfil de usuário não foi encontrado no banco de dados. ' +
      'Isso acontece quando os scripts SQL ainda não foram executados — ' +
      'veja docs/INSTALACAO.md, Parte 2.');
  }

  if (perfil.status !== STATUS_CONTA.ATIVA) {
    throw new ContaInativaError();
  }

  return { user: sessao.user, perfil };
}

/* -----------------------------------------------------------------------------
 * Guarda de páginas privadas
 * --------------------------------------------------------------------------- */

function irPara(url) {
  window.location.href = url;
}

/** Caminho interno seguro (evita redirecionamento para domínios externos). */
function caminhoInternoSeguro(valor) {
  if (!valor || typeof valor !== 'string') return null;
  if (!valor.startsWith('/') || valor.startsWith('//')) return null;
  return valor;
}

function urlAtualComCaminho() {
  return window.location.pathname + window.location.search;
}

function redirecionarParaLogin(paginaLogin = 'login.html') {
  const destino = caminhoInternoSeguro(urlAtualComCaminho());
  const extra = destino ? `?next=${encodeURIComponent(destino)}` : '';
  irPara(paginaLogin + extra);
}

/**
 * Exibe aviso de conta inativa com opção de sair. Não exibe nenhum dado
 * financeiro — o bloqueio real continua no banco (RLS), isso é só a UX.
 */
function exibirAvisoContaInativa(mensagem) {
  if (document.getElementById('cg-conta-inativa')) return;
  const box = document.createElement('div');
  box.id = 'cg-conta-inativa';
  box.setAttribute('role', 'alertdialog');
  box.setAttribute('aria-live', 'assertive');
  box.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:99998', 'display:flex',
    'align-items:center', 'justify-content:center', 'padding:16px',
    'background:rgba(15,23,42,.75)', 'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif'
  ].join(';');

  const painel = document.createElement('div');
  painel.style.cssText = [
    'max-width:480px', 'width:100%', 'background:#fff', 'border-radius:14px',
    'padding:24px', 'text-align:center'
  ].join(';');

  // Ícone vetorial (sem emoji): escudo de bloqueio.
  const icone = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icone.setAttribute('viewBox', '0 0 24 24');
  icone.setAttribute('width', '40');
  icone.setAttribute('height', '40');
  icone.setAttribute('aria-hidden', 'true');
  icone.setAttribute('fill', 'none');
  icone.setAttribute('stroke', '#b45309');
  icone.setAttribute('stroke-width', '1.7');
  icone.setAttribute('stroke-linecap', 'round');
  icone.setAttribute('stroke-linejoin', 'round');
  const caminho = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  caminho.setAttribute('d', 'M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z');
  const trinco = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  trinco.setAttribute('d', 'M9.5 11.5v-1.2a2.5 2.5 0 0 1 5 0v1.2M9.5 11.5h5v4h-5z');
  icone.appendChild(caminho);
  icone.appendChild(trinco);

  const titulo = document.createElement('h1');
  titulo.style.cssText = 'margin:8px 0;font-size:20px;color:#b45309';
  titulo.textContent = 'Conta inativa';

  const texto = document.createElement('p');
  texto.style.cssText = 'margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151';
  texto.textContent = mensagem || '';

  const botao = document.createElement('button');
  botao.id = 'cg-btn-sair';
  botao.type = 'button';
  botao.style.cssText = [
    'min-height:48px', 'padding:0 24px', 'border:0', 'border-radius:10px',
    'background:#0f6b54', 'color:#fff', 'font-size:15px', 'font-weight:600', 'cursor:pointer'
  ].join(';');
  botao.textContent = 'Sair';
  botao.addEventListener('click', () => {
    logout('login.html?status=inativa');
  });

  painel.appendChild(icone);
  painel.appendChild(titulo);
  painel.appendChild(texto);
  painel.appendChild(botao);
  box.appendChild(painel);
  document.body.appendChild(box);
}

/**
 * PROTEÇÃO DE PÁGINAS PRIVADAS.
 *
 * Como usar no início do módulo de cada página interna:
 *   const conta = await requireAuth();
 *   if (!conta) return;            // já houve redirecionamento/aviso
 *   // ... só a partir daqui a página carrega dados financeiros
 *
 * Comportamento (fail-closed):
 *   - config inválida  → overlay de erro fatal (js/config.js) e erro;
 *   - sem sessão       → redireciona para login.html?next=<página atual>;
 *   - conta inativa    → aviso "Conta inativa" e NENHUM dado é carregado;
 *   - perfil ausente   → erro orientando a executar os scripts SQL;
 *   - erro de rede     → erro traduzido (a página decide como exibir).
 *
 * @param {object}  opcoes
 * @param {string}  opcoes.paginaLogin  página de login (padrão 'login.html')
 * @returns {Promise<{user:object, perfil:object}|null>}
 */
export async function requireAuth(opcoes = {}) {
  const paginaLogin = opcoes.paginaLogin || 'login.html';

  // 0) Aguarda a inicialização do client único (config + SDK vendorizado).
  //    Falha FECHADA: sem client válido, a página não prossegue.
  try {
    await obterCliente();
  } catch (erro) {
    showFatalError('Configuração incompleta', erro.message);
    throw erro;
  }

  // 1) Sessão (com teto de tempo: falha fechada em vez de tela infinita).
  let sessao = null;
  try {
    sessao = await comTimeout(getSessao(), 15000);
  } catch (erro) {
    throw normalizarErro(erro);
  }
  if (!sessao) {
    redirecionarParaLogin(paginaLogin);
    return null;
  }

  // 2) Status real da conta lido no BANCO (não no token).
  try {
    return await verificarConta();
  } catch (erro) {
    if (erro instanceof ContaInativaError) {
      exibirAvisoContaInativa(erro.message);
      return null; // a página NÃO prossegue
    }
    throw normalizarErro(erro);
  }
}

/** Promise com limite de tempo (evita telas travadas em rede ruim). */
export function comTimeout(promise, milissegundos = 15000) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new ErroApp('rede',
        'A resposta do servidor demorou demais. Verifique a conexão e tente novamente.')), milissegundos);
    })
  ]);
}

/* -----------------------------------------------------------------------------
 * Ações de autenticação usadas por js/auth.js e pelas páginas de acesso
 * --------------------------------------------------------------------------- */

/** Cadastra a conta (Supabase envia o e-mail de confirmação, se habilitado). */
export async function cadastrarConta(email, senha, nomeCompleto) {
  const client = await obterCliente();
  try {
    const { data, error } = await client.auth.signUp({
      email: String(email).trim(),
      password: String(senha),
      options: { data: { full_name: String(nomeCompleto || '').trim() } }
    });
    if (error) throw normalizarErro(error);
    return data; // data.user; data.session pode ser null quando exige confirmação
  } catch (erro) {
    throw erro instanceof ErroApp ? erro : normalizarErro(erro);
  }
}

/** Entrar com e-mail e senha. */
export async function entrar(email, senha) {
  const client = await obterCliente();
  try {
    const { data, error } = await client.auth.signInWithPassword({
      email: String(email).trim(),
      password: String(senha)
    });
    if (error) throw normalizarErro(error);
    return data; // { user, session }
  } catch (erro) {
    throw erro instanceof ErroApp ? erro : normalizarErro(erro);
  }
}

/**
 * Após o login bem-sucedido: registra o acesso e devolve o status REAL da
 * conta lido pelo banco (RPC public.register_login, functions.sql).
 * @throws {ContaInativaError} quando o banco informar status != 'active'
 */
export async function registrarLogin() {
  let resultado = null;
  try {
    resultado = await callRpc('register_login');
  } catch (erro) {
    // Sem o script functions.sql o RPC não existe — mensagem orientativa.
    if (String(erro.erroOriginal && erro.erroOriginal.code) === '404' ||
        /not found|does not exist/i.test(String(erro.message))) {
      throw new ErroApp('banco',
        'A função register_login() não foi encontrada no banco. ' +
        'Execute database/functions.sql (docs/INSTALACAO.md, Parte 2).');
    }
    throw erro;
  }

  if (!resultado || resultado.status !== STATUS_CONTA.ATIVA) {
    throw new ContaInativaError();
  }
  return resultado;
}

/** Envia o e-mail de recuperação de senha (link volta para redefinir-senha.html). */
export async function solicitarRecuperacaoSenha(email) {
  const client = await obterCliente();
  const destino = new URL('redefinir-senha.html', window.location.href).href;
  try {
    const { data, error } = await client.auth.resetPasswordForEmail(String(email).trim(), {
      redirectTo: destino
    });
    if (error) throw normalizarErro(error);
    return data;
  } catch (erro) {
    throw erro instanceof ErroApp ? erro : normalizarErro(erro);
  }
}

/** Define a nova senha (página redefinir-senha.html, após o link do e-mail). */
export async function definirNovaSenha(novaSenha) {
  const client = await obterCliente();
  try {
    const { data, error } = await client.auth.updateUser({ password: String(novaSenha) });
    if (error) throw normalizarErro(error);
    return data;
  } catch (erro) {
    throw erro instanceof ErroApp ? erro : normalizarErro(erro);
  }
}

/** Salva campos do próprio perfil (lista branca — nada de status/role/e-mail). */
export async function salvarPerfil(dados) {
  const client = await obterCliente();
  const sessao = await getSessao();
  if (!sessao) throw new SessaoAusenteError();

  const permitidos = {};
  if (Object.prototype.hasOwnProperty.call(dados, 'full_name')) {
    permitidos.full_name = String(dados.full_name || '').trim() || null;
  }
  if (Object.prototype.hasOwnProperty.call(dados, 'timezone')) {
    permitidos.timezone = String(dados.timezone || 'America/Sao_Paulo').trim();
  }
  if (Object.keys(permitidos).length === 0) return null;

  const { data, error } = await client
    .from('profiles')
    .update(permitidos)
    .eq('id', sessao.user.id)
    .select('id, email, full_name, status, role, timezone, created_at, updated_at, last_login_at')
    .single();
  if (error) throw normalizarErro(error);
  return data; // o trigger trg_profiles_protect_columns bloqueia status/role/e-mail
}

export default {
  STATUS_CONTA,
  PAPEIS,
  ErroApp,
  ContaInativaError,
  SessaoAusenteError,
  isNetworkError,
  traduzErro,
  normalizarErro,
  obterCliente,
  getClient,
  callRpc,
  getSessao,
  observarSessao,
  logout,
  carregarPerfil,
  verificarConta,
  requireAuth,
  comTimeout,
  cadastrarConta,
  entrar,
  registrarLogin,
  solicitarRecuperacaoSenha,
  definirNovaSenha,
  salvarPerfil
};
