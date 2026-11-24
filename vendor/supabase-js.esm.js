/**
 * vendor/supabase-js.esm.js — Wrapper ESM do SDK oficial do Supabase.
 * =============================================================================
 * Este módulo resolve a dependência do SDK SEM depender de CDN em tempo de
 * execução (requisito do projeto: origem local estável para o service worker).
 *
 * COMO FUNCIONA
 *   - O código oficial (build UMD autossuficiente, v2.118.0) está no arquivo
 *     irmão "supabase-js.umd.js". O build UMD não possui imports externos:
 *     todas as dependências (auth-js, postgrest-js, realtime-js, etc.) estão
 *     embutidas no próprio arquivo.
 *   - Este wrapper injeta o <script> do UMD uma única vez, aguarda a
 *     disponibilidade de window.supabase.createClient e reexporta a função
 *     como API ESM assíncrona.
 *
 * ATENÇÃO
 *   - createClient() aqui é ASSÍNCRONA (retorna Promise<SupabaseClient>).
 *     js/config.js já a consome com "await".
 *
 * ATUALIZAÇÃO DO SDK (manual, raramente necessária):
 *   1. Baixe a nova versão UMD em
 *      https://cdn.jsdelivr.net/npm/@supabase/supabase-js@<versão>/dist/umd/supabase.js
 *   2. Substitua vendor/supabase-js.umd.js.
 *   3. Confira com o projeto aberto: o console deve mostrar
 *      "[config] Cliente Supabase iniciado: <URL>".
 * =============================================================================
 */

let readyPromise = null;

function sdkAlreadyLoaded() {
  return Boolean(
    typeof window !== 'undefined' &&
    window.supabase &&
    typeof window.supabase.createClient === 'function'
  );
}

function loadUmdOnce() {
  if (sdkAlreadyLoaded()) return Promise.resolve(window.supabase);
  if (readyPromise) return readyPromise;

  readyPromise = new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('Ambiente sem DOM: o SDK do Supabase precisa de navegador.'));
      return;
    }

    const script = document.createElement('script');
    // Caminho resolvido a partir DESTE módulo (funciona em qualquer página).
    script.src = new URL('./supabase-js.umd.js', import.meta.url).href;
    script.async = true;

    script.onload = () => {
      if (sdkAlreadyLoaded()) {
        resolve(window.supabase);
      } else {
        reject(new Error(
          'vendor/supabase-js.umd.js carregado, mas window.supabase.createClient ' +
          'não ficou disponível. Verifique se o arquivo é o build UMD oficial.'
        ));
      }
    };

    script.onerror = () => {
      readyPromise = null; // permite nova tentativa em recarregamento
      reject(new Error(
        'Falha ao carregar vendor/supabase-js.umd.js. Confira se o arquivo existe ' +
        'na pasta vendor/ e se o site está sendo servido por HTTP (docs/INSTALACAO.md, Parte 7).'
      ));
    };

    document.head.appendChild(script);
  });

  return readyPromise;
}

/**
 * Cria o client Supabase (API idêntica ao SDK oficial, porém assíncrona).
 * @param {string} supabaseUrl  URL do projeto (ex.: https://xxxx.supabase.co)
 * @param {string} supabaseKey  Chave pública anon/publishable
 * @param {object} options      Opções do SDK (auth.persistSession, flowType, ...)
 * @returns {Promise<object>}   Instância do SupabaseClient
 */
export async function createClient(supabaseUrl, supabaseKey, options) {
  const lib = await loadUmdOnce();
  return lib.createClient(supabaseUrl, supabaseKey, options);
}

/** Objeto completo do SDK carregado (uso avançado; evite na aplicação). */
export async function getSdk() {
  return loadUmdOnce();
}

export default { createClient, getSdk };
