/**
 * sw.js — Service Worker do Controle de Gastos (Etapa 8-B2)
 * =============================================================================
 * POLÍTICA CONSERVADORA DE CACHE
 *
 * O QUE É CACHEADO (precadastro, somente origem própria):
 *   • CSS da aplicação (tokens, style, auth)
 *   • JS da aplicação (config, supabase, auth, api, charts e módulos de página)
 *   • SDK vendorizado local (vendor/*)
 *   • manifest.webmanifest, ícones e offline.html
 *   Todos com verificação de existência na instalação; falha individual não
 *   impede a instalação (Promise individual com catch).
 *
 * O QUE NUNCA É CACHEADO (regra absoluta):
 *   • QUALQUER recurso de outra origem — em especial *.supabase.co
 *     (/rest/v1/*, /auth/v1/*, /realtime/*): repassados direto à rede,
 *     sem respondWith; offline eles simplesmente falham (correto: sem dados
 *     falsos, sem proxy de API).
 *   • Qualquer requisição que não seja GET (POST/PUT/PATCH/DELETE): repasse
 *     direto à rede — o SW nunca intercepta operações de escrita.
 *   • Páginas HTML da aplicação (exceto offline.html): navegações usam
 *     rede-first e, sem conexão, caem em offline.html — páginas autenticadas
 *     JAMAIS são servidas de cache (nada de conteúdo protegido offline).
 *   • Qualquer resposta de requisição com cabeçalho Authorization.
 *
 * ATUALIZAÇÃO: versão do cache no nome (cg-estaticos-vX); activate remove
 * APENAS caches deste app (prefixo "cg-"), nunca de outros apps/bibliotecas.
 * Sem background sync, sem filas offline, sem respostas simuladas.
 * =============================================================================
 */

const VERSAO_CACHE = 'cg-estaticos-v8';

/* Recursos estáticos confirmados em disco (projeto 3.2). */
const ARQUIVOS_ESTATICOS = [
  './css/tokens.css',
  './css/style.css',
  './css/auth.css',
  './js/config.js',
  './js/theme-preload.js',
  './js/navegacao.js',
  './js/config.local.js',      // credenciais PÚBLICAS (anon/publishable) — seguras por design
  './js/supabase.js',
  './js/auth.js',
  './js/api.js',
  './js/charts.js',
  './js/dashboard.js',
  './js/gastos.js',
  './js/parcelas.js',
  './js/dividas.js',
  './js/calendario.js',
  './js/configuracoes.js',
  './js/admin.js',
  './js/historico.js',
  './vendor/supabase-js.esm.js',
  './vendor/supabase-js.umd.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/marca-machado.png',
  './offline.html'
];

const CAMINHO_OFFLINE = './offline.html';

/* -----------------------------------------------------------------------------
 * Instalação: precadastro tolerante a falhas individuais
 * --------------------------------------------------------------------------- */
self.addEventListener('install', (evento) => {
  evento.waitUntil((async () => {
    const cache = await caches.open(VERSAO_CACHE);
    // Cada recurso é tentado individualmente: uma falha não derruba a instalação.
    await Promise.all(ARQUIVOS_ESTATICOS.map((caminho) =>
      cache.add(new Request(caminho, { cache: 'reload' })).catch((erro) => {
        console.warn('[sw] falha ao pré-cachear (instalação continua):', caminho, erro && erro.message);
      })
    ));
    // Força a ativação imediata da nova versão (deploy = troca de VERSAO_CACHE).
    await self.skipWaiting();
  })());
});

/* -----------------------------------------------------------------------------
 * Ativação: remove SOMENTE caches antigos DESTE app (prefixo "cg-")
 * --------------------------------------------------------------------------- */
self.addEventListener('activate', (evento) => {
  evento.waitUntil((async () => {
    const nomes = await caches.keys();
    await Promise.all(nomes
      .filter((nome) => nome.startsWith('cg-') && nome !== VERSAO_CACHE)
      .map((nome) => caches.delete(nome)));
    await self.clients.claim();
  })());
});

/* -----------------------------------------------------------------------------
 * Fetch: política por ORIGEM + MÉTODO + NATUREZA do recurso
 * --------------------------------------------------------------------------- */
self.addEventListener('fetch', (evento) => {
  const requisicao = evento.request;

  // 1) SÓ GET da PRÓPRIA origem é considerado. Qualquer outra coisa
  //    (POST/PUT/PATCH/DELETE, Supabase, CDNs, realtime) vai direto à rede.
  if (requisicao.method !== 'GET') return;
  const url = new URL(requisicao.url);
  if (url.origin !== self.location.origin) return;

  // 2) Navegação HTML: rede-first → offline.html como fallback.
  //    Páginas autenticadas NUNCA são servidas do cache.
  if (requisicao.mode === 'navigate') {
    evento.respondWith((async () => {
      try {
        const resposta = await fetch(requisicao);
        // Redes com proxy (e erros de gateway) respondem 502/503/504 em vez de
        // rejeitar: tratar como "sem conexão" e cair no offline.html.
        if (resposta.status >= 500) {
          const cache = await caches.open(VERSAO_CACHE);
          const offline = await cache.match(CAMINHO_OFFLINE);
          if (offline) return offline;
        }
        return resposta; // online: resposta fresca da rede, sem cache de HTML
      } catch (erro) {
        const cache = await caches.open(VERSAO_CACHE);
        const offline = await cache.match(CAMINHO_OFFLINE);
        if (offline) return offline;
        return new Response(
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
          '<title>Sem conexão — Controle de Gastos</title>' +
          '<p style="font-family:system-ui,sans-serif;text-align:center;padding:24px">' +
          'Sem conexão e página offline indisponível. Reconecte-se para usar o Controle de Gastos.</p>',
          { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      }
    })());
    return;
  }

  // 3) Estáticos da lista: cache-first (origem própria, GET, sem Authorization).
  if (requisicao.headers.has('Authorization')) return; // segurança extra: nunca tocar
  const caminhoRelativo = './' + url.pathname.replace(/^\//, '');
  const ehEstatico = ARQUIVOS_ESTATICOS.includes(caminhoRelativo) ||
    ARQUIVOS_ESTATICOS.includes('.' + url.pathname);
  if (ehEstatico) {
    evento.respondWith((async () => {
      const cache = await caches.open(VERSAO_CACHE);
      const emCache = await cache.match(requisicao);
      if (emCache) return emCache;
      try {
        const resposta = await fetch(requisicao);
        if (resposta.ok && resposta.type === 'basic') {
          await cache.put(requisicao, resposta.clone());
        }
        return resposta;
      } catch (erro) {
        return Response.error();
      }
    })());
    return;
  }

  // 4) Qualquer outro recurso da própria origem: repasse à rede, sem cache.
  //    (Não cachear nada fora da lista explícita — política fechada.)
});
