/**
 * js/config.js
 * =============================================================================
 * CONTROLE DE GASTOS — Carregamento e validação da configuração pública.
 *
 * FINALIDADE
 *   1. Ler as credenciais PÚBLICAS do Supabase a partir de js/config.local.js
 *      (variáveis SUPABASE_URL e SUPABASE_ANON_KEY).
 *   2. Validar a configuração e apresentar erros CLAROS quando estiver ausente
 *      ou inválida (não deixa a página "quebrar em silêncio").
 *   3. Criar UM ÚNICO client Supabase (singleton) compartilhado por todas as
 *      páginas, com sessão persistente e fluxo PKCE.
 *   4. Recusar explicitamente qualquer chave que não seja a pública do navegador
 *      (nunca a service_role / secret).
 *
 * SEGURANÇA
 *   - A chave anon/publishable é pública POR DESIGN: só identifica o projeto.
 *   - A proteção REAL dos dados está no PostgreSQL (database/rls.sql):
 *       * cada linha só é visível/alterável pelo dono (auth.uid());
 *       * contas INATIVAS não leem nem escrevem nada (is_active_user());
 *       * escrita financeira apenas pelas RPCs de database/functions.sql.
 *   - As checagens JavaScript aqui presentes são apenas UX: o banco é a última
 *     instância de autorização e deve continuar sendo a única fonte de verdade.
 *
 * INTEGRAÇÃO
 *   js/config.local.js  →  js/config.js (este)  →  js/supabase.js  →  js/auth.js
 *   As páginas importam js/supabase.js; nenhuma página cria client próprio.
 * =============================================================================
 */

/** Chave usada pelo supabase-js para guardar a sessão no localStorage. */
export const AUTH_STORAGE_KEY = 'cg-auth-v1';

/** Mensagem de erro de configuração (null quando tudo estiver ok). */
export let CONFIG_ERROR = null;

/** URL do projeto (normalizada, sem barra final). */
export let SUPABASE_URL = null;

/** Chave pública do navegador (anon ou publishable). */
export let SUPABASE_ANON_KEY = null;

/** Client Supabase compartilhado (null enquanto a configuração for inválida). */
export let supabase = null;

let resolvePronto, rejeitarPronto;
/**
 * Promise que resolve com o client quando a inicialização terminar
 * (config validada + SDK vendorizado carregado) ou rejeita com o erro fatal.
 *
 * IMPORTANTE: como a inicialização é assíncrona, SEMPRE aguarde esta promise
 * (diretamente ou através das funções de js/supabase.js) antes de usar o
 * client. Usar `supabase` imediatamente após o import gera condição de corrida.
 */
export const quandoPronto = new Promise((resolve, reject) => {
  resolvePronto = resolve;
  rejeitarPronto = reject;
});

/* -----------------------------------------------------------------------------
 * Utilidades internas
 * --------------------------------------------------------------------------- */

function decodeBase64Url(part) {
  let s = String(part).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4 !== 0) s += '=';
  return atob(s);
}

/**
 * Detecta chaves que NÃO devem estar no navegador:
 *  - chaves novas de serviço: "sb_secret_..."
 *  - JWTs legados cujo payload traz "role" diferente de "anon"
 *    (ex.: "service_role" — administrativa, proibida no front-end).
 */
function looksLikePrivilegedKey(key) {
  const k = String(key).trim();
  if (k.startsWith('sb_secret_')) return true;

  const parts = k.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(decodeBase64Url(parts[1]));
      if (payload && payload.role && payload.role !== 'anon') return true;
    } catch (_e) { /* payload ilegível: segue a validação normal */ }
  }
  return false;
}

function normalizeUrl(raw) {
  let url = String(raw || '').trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    const parsed = new URL(url);
    // URLs do Supabase são na raiz do domínio: o SDK acrescenta "/auth/v1" e "/rest/v1".
    const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
    return parsed.origin + path;
  } catch (_e) {
    return null;
  }
}

/** Exibe um overlay de erro fatal legível (usado também por js/supabase.js). */
export function showFatalError(title, message) {
  if (document.getElementById('cg-fatal-error')) return;
  const box = document.createElement('div');
  box.id = 'cg-fatal-error';
  box.setAttribute('role', 'alert');
  box.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:99999', 'display:flex',
    'align-items:center', 'justify-content:center', 'padding:16px',
    'background:#0f172a', 'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif'
  ].join(';');

  const painel = document.createElement('div');
  painel.style.cssText = [
    'max-width:560px', 'width:100%', 'background:#fff', 'border-radius:14px',
    'padding:24px', 'box-shadow:0 20px 60px rgba(0,0,0,.45)'
  ].join(';');

  const cabecalho = document.createElement('h1');
  cabecalho.style.cssText = 'margin:0 0 8px;font-size:20px;color:#b91c1c';
  cabecalho.textContent = title; // texto puro: nada de HTML vindo de fora

  const corpo = document.createElement('div');
  corpo.style.cssText = 'font-size:15px;line-height:1.6;color:#1f2937;white-space:pre-wrap';
  corpo.textContent = message || '';

  const rodape = document.createElement('p');
  rodape.style.cssText = 'margin:16px 0 0;font-size:13px;color:#6b7280';
  rodape.textContent = 'Instruções completas: docs/INSTALACAO.md (Parte 5 e Parte 6).';

  painel.appendChild(cabecalho);
  painel.appendChild(corpo);
  painel.appendChild(rodape);
  box.appendChild(painel);
  document.body.appendChild(box);
}

/* -----------------------------------------------------------------------------
 * Carregamento da configuração local
 * --------------------------------------------------------------------------- */

async function loadLocalConfig() {
  // 1) Se a página já incluiu <script src="js/config.local.js">, ele está aqui:
  if (window.__APP_CONFIG__ && window.__APP_CONFIG__.SUPABASE_URL) {
    return window.__APP_CONFIG__;
  }
  // 2) Caso contrário, tenta importar o arquivo como módulo.
  try {
    await import('./config.local.js');
  } catch (_e) {
    return null; // arquivo ausente — tratado abaixo com mensagem clara
  }
  return window.__APP_CONFIG__ || null;
}

function validateConfig(cfg) {
  // --- Presença do arquivo -------------------------------------------------
  if (!cfg || typeof cfg !== 'object') {
    return 'O arquivo "js/config.local.js" não foi encontrado.\n\n' +
           'Crie o arquivo na pasta js/ com o seguinte conteúdo (chaves PÚBLICAS):\n\n' +
           "window.__APP_CONFIG__ = {\n" +
           "  SUPABASE_URL: 'https://SEU-PROJETO.supabase.co',\n" +
           "  SUPABASE_ANON_KEY: 'SUA-CHAVE-ANON-OU-PUBLISHABLE'\n" +
           '};\n\n' +
           'As credenciais ficam em: Supabase → Project Settings → API.';
  }

  // --- SUPABASE_URL --------------------------------------------------------
  const url = normalizeUrl(cfg.SUPABASE_URL);
  if (!url) {
    return 'SUPABASE_URL está ausente ou inválida em js/config.local.js.\n\n' +
           'Copie a "Project URL" em Supabase → Project Settings → API\n' +
           '(exemplo: https://xxxxxxxx.supabase.co).';
  }
  if (!url.startsWith('https://') &&
      !/(^|\.)localhost$|^127\.0\.0\.1$/.test(new URL(url).hostname)) {
    return 'SUPABASE_URL deve usar HTTPS.\n\nRecebido: ' + url;
  }

  // --- Chave pública -------------------------------------------------------
  const key = String(cfg.SUPABASE_ANON_KEY || '').trim();
  if (!key) {
    return 'SUPABASE_ANON_KEY está ausente em js/config.local.js.\n\n' +
           'Copie a chave "anon / public" (ou "Publishable key") em\n' +
           'Supabase → Project Settings → API. NUNCA use a service_role aqui.';
  }
  if (key.length < 20) {
    return 'SUPABASE_ANON_KEY parece incompleta (menos de 20 caracteres).\n\n' +
           'Copie a chave inteira em Supabase → Project Settings → API.';
  }
  if (looksLikePrivilegedKey(key)) {
    return 'A chave configurada NÃO é a chave pública do navegador.\n\n' +
           'Foi detectada uma chave administrativa (service_role/secret), que é ' +
           'PROIBIDA no front-end e expõe todo o banco de dados.\n\n' +
           'Substitua pela chave "anon / public" (ou "Publishable key") em\n' +
           'Supabase → Project Settings → API e, se essa chave secreta foi ' +
           'exposta, revogue-a em API Keys → Rotate.';
  }

  return null; // configuração válida
}

/* -----------------------------------------------------------------------------
 * Inicialização (executa uma vez, no carregamento do módulo)
 * --------------------------------------------------------------------------- */

(async function initConfig() {
  // Aviso em ambiente file:// (módulos ES não funcionam abrindo o HTML direto).
  if (location.protocol === 'file:') {
    showFatalError(
      'Abrir o arquivo diretamente não funciona',
      'Este sistema usa módulos ES e precisa ser servido por HTTP.\n\n' +
      'Siga docs/INSTALACAO.md, Parte 7:\n' +
      '  python -m http.server 5500\n' +
      'e acesse http://localhost:5500'
    );
    CONFIG_ERROR = 'Execução em file:// não suportada. Sirva o projeto por HTTP (porta 5500).';
    rejeitarPronto(new Error(CONFIG_ERROR));
    return;
  }

  const cfg = await loadLocalConfig();
  const error = validateConfig(cfg);
  if (error) {
    CONFIG_ERROR = error;
    showFatalError('Configuração do Supabase incompleta', error);
    console.error('[config] ' + error);
    rejeitarPronto(new Error(error));
    return;
  }

  SUPABASE_URL = normalizeUrl(cfg.SUPABASE_URL);
  SUPABASE_ANON_KEY = String(cfg.SUPABASE_ANON_KEY).trim();

  // O SDK vive em vendor/supabase-js.esm.js (origem local estável para o PWA).
  try {
    const mod = await import('../vendor/supabase-js.esm.js');
    const createClient = mod.createClient;
    if (typeof createClient !== 'function') {
      throw new Error('createClient não encontrado no arquivo do SDK.');
    }

    // O wrapper vendorizado (vendor/supabase-js.esm.js) expõe createClient
    // ASSÍNCRONO: ele carrega o build UMD oficial na primeira chamada.
    supabase = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,        // sessão sobrevive a recarregamentos (regra 16)
        autoRefreshToken: true,      // renova o JWT automaticamente
        detectSessionInUrl: true,    // lida com links de confirmação/recuperação
        flowType: 'pkce',            // fluxo recomendado para SPA/MPA sem servidor
        storageKey: AUTH_STORAGE_KEY
      }
    });

    console.info('[config] Cliente Supabase iniciado:', SUPABASE_URL);
    resolvePronto(supabase); // libera todos os consumidores aguardando o client
  } catch (err) {
    CONFIG_ERROR =
      'Não foi possível carregar o SDK do Supabase (vendor/supabase-js.esm.js).\n\n' +
      'Detalhe técnico: ' + (err && err.message ? err.message : String(err)) + '\n\n' +
      'Verifique se o arquivo existe em vendor/ (fornecido na Etapa 3).';
    showFatalError('SDK do Supabase não encontrado', CONFIG_ERROR);
    console.error('[config] ' + CONFIG_ERROR, err);
    rejeitarPronto(new Error(CONFIG_ERROR));
  }
})();

/**
 * Acesso seguro ao client: lança erro amigável quando a configuração falhou.
 * Usado por js/supabase.js antes de qualquer operação.
 */
export function requireSupabase() {
  if (!supabase) {
    throw new Error(CONFIG_ERROR || 'Cliente Supabase não inicializado.');
  }
  return supabase;
}

/** true quando a configuração está válida e o client existe. */
export function isConfigured() {
  return Boolean(supabase);
}

/* -----------------------------------------------------------------------------
 * PWA (Etapa 8-B2): registro ÚNICO do service worker — config.js é carregado
 * por todas as páginas (direta ou via supabase.js/auth.js), evitando duplicar
 * scripts de registro. Falhas não interrompem navegação nem autenticação.
 * --------------------------------------------------------------------------- */
if ('serviceWorker' in navigator &&
    (window.location.protocol === 'https:' ||
     /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname))) {
  const registrarServiceWorker = () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' })
      .then((registro) => {
        // Verifica atualizações em visitas seguintes (deploy = novo VERSAO_CACHE).
        registro.update().catch(() => {});
        console.info('[pwa] service worker ativo, escopo:', registro.scope);
      })
      .catch((erro) => {
        console.warn('[pwa] registro do service worker falhou (app segue funcionando):', erro && erro.message);
      });
  };
  // Robusto a módulos carregados APÓS o evento load (import dinâmico):
  // se o documento já concluiu o carregamento, registra imediatamente.
  if (document.readyState === 'complete') {
    registrarServiceWorker();
  } else {
    window.addEventListener('load', registrarServiceWorker);
  }
}
