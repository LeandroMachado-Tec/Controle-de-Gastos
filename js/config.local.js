/**
 * js/config.local.js — MODELO DE CONFIGURAÇÃO LOCAL
 * =============================================================================
 * Preencha com as credenciais PÚBLICAS do SEU projeto Supabase.
 *
 * ONDE OBTER (docs/INSTALACAO.md, Parte 5):
 *   Supabase → Project Settings → API
 *     • Project URL                → SUPABASE_URL
 *     • anon / public              → SUPABASE_ANON_KEY
 *       (em painéis novos: "Publishable key", começa com sb_publishable_)
 *
 * ATENÇÃO — NUNCA coloque aqui a chave "service_role" / "secret": ela é
 *    administrativa, dá acesso TOTAL ao banco e é proibida no front-end.
 *    O js/config.js detecta e RECUSA esse tipo de chave automaticamente.
 *
 * A chave pública pode ficar visível no navegador por design: quem pode ler
 *    e escrever seus dados é definido pelas políticas RLS (database/rls.sql),
 *    usando a identidade autenticada do Supabase Auth.
 * =============================================================================
 */
window.__APP_CONFIG__ = {
  SUPABASE_URL: 'https://pxsbyfpjetcwidxcoxze.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_4fFPkJKYawiIx0Ecdz69EA_FbEgm1TQ'
};
