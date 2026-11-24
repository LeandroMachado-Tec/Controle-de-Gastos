/**
 * js/navegacao.js — comportamento compartilhado de navegação (3.2)
 * -----------------------------------------------------------------------------
 * • Folha inferior "Mais" no celular (abre/fecha, Escape, foco e fundo).
 * • Estado ativo consistente da navegação em todas as páginas.
 * • Rótulo acessível do botão de tema sincronizado com o tema efetivo.
 * • Link de Administração injetado SOMENTE para perfis com papel "admin"
 *   (o papel vem do banco, via requireAuth() dos módulos de página).
 *
 * Não lê nem grava dados financeiros. Não interfere nos módulos de página:
 * apenas complementa a marcação estática e o mesmo mecanismo de tema
 * (data-theme + localStorage('theme')) usado por theme-preload.js.
 */
(function () {
  'use strict';

  const PAGINAS_NO_MENU_MAIS = ['calendario', 'historico', 'configuracoes', 'admin'];
  const pagina = document.body ? document.body.dataset.pagina || '' : '';

  /* ---------------------------------------------------------------------------
   * Folha "Mais"
   * ------------------------------------------------------------------------- */
  const botaoMais = document.getElementById('btn-mais');
  const fundo = document.getElementById('menu-mais');
  const botaoFechar = document.getElementById('btn-fechar-mais');
  let focoAnterior = null;

  function elementosFocaveis() {
    if (!fundo) return [];
    return Array.from(fundo.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ));
  }

  function abrirMenu() {
    if (!fundo || !botaoMais) return;
    focoAnterior = document.activeElement;
    fundo.hidden = false;
    botaoMais.setAttribute('aria-expanded', 'true');
    document.body.dataset.menuAberto = 'true';
    const focaveis = elementosFocaveis();
    if (focaveis.length) focaveis[0].focus();
  }

  function fecharMenu() {
    if (!fundo || !botaoMais) return;
    fundo.hidden = true;
    botaoMais.setAttribute('aria-expanded', 'false');
    delete document.body.dataset.menuAberto;
    if (focoAnterior && typeof focoAnterior.focus === 'function') focoAnterior.focus();
    focoAnterior = null;
  }

  if (botaoMais && fundo) {
    botaoMais.addEventListener('click', abrirMenu);
    if (botaoFechar) botaoFechar.addEventListener('click', fecharMenu);

    fundo.addEventListener('click', (evento) => {
      if (evento.target === fundo) fecharMenu();
    });

    fundo.addEventListener('keydown', (evento) => {
      if (evento.key === 'Escape') {
        evento.preventDefault();
        fecharMenu();
        return;
      }
      if (evento.key !== 'Tab') return;

      // Mantém o foco dentro da folha enquanto ela está aberta.
      const focaveis = elementosFocaveis();
      if (!focaveis.length) return;
      const primeiro = focaveis[0];
      const ultimo = focaveis[focaveis.length - 1];
      if (evento.shiftKey && document.activeElement === primeiro) {
        evento.preventDefault();
        ultimo.focus();
      } else if (!evento.shiftKey && document.activeElement === ultimo) {
        evento.preventDefault();
        primeiro.focus();
      }
    });

    // Escape fecha a folha mesmo quando o foco está fora dela (navegação
    // por teclado que escapou da folha ou clique no documento).
    document.addEventListener('keydown', (evento) => {
      if (evento.key !== 'Escape') return;
      if (!fundo || fundo.hidden) return;
      evento.preventDefault();
      fecharMenu();
    });

    if (window.matchMedia) {
      const desktop = window.matchMedia('(min-width: 901px)');
      const aoMudar = (evento) => { if (evento.matches) fecharMenu(); };
      if (desktop.addEventListener) desktop.addEventListener('change', aoMudar);
      else if (desktop.addListener) desktop.addListener(aoMudar);
    }
  }

  /* ---------------------------------------------------------------------------
   * Estado ativo
   * ------------------------------------------------------------------------- */
  if (botaoMais && PAGINAS_NO_MENU_MAIS.includes(pagina)) {
    botaoMais.classList.add('ativo');
    botaoMais.setAttribute('aria-current', 'page');
  }

  document.querySelectorAll('.menu-mais-lista a[href]').forEach((link) => {
    const href = (link.getAttribute('href') || '').split('?')[0].replace(/^\.\//, '');
    if (href === pagina + '.html') {
      link.classList.add('ativo');
      link.setAttribute('aria-current', 'page');
    }
  });

  /* ---------------------------------------------------------------------------
   * Botão de tema: rótulo acessível sempre coerente com o tema efetivo
   * ------------------------------------------------------------------------- */
  const consultaEscuro = window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

  function temaEfetivo() {
    const explicito = document.documentElement.dataset.theme;
    if (explicito === 'claro' || explicito === 'escuro') return explicito;
    return consultaEscuro && consultaEscuro.matches ? 'escuro' : 'claro';
  }

  function atualizarBotoesTema() {
    const escuro = temaEfetivo() === 'escuro';
    document.querySelectorAll('#btn-tema').forEach((botao) => {
      botao.setAttribute('aria-label', escuro ? 'Mudar para tema claro' : 'Mudar para tema escuro');
      botao.setAttribute('title', escuro ? 'Mudar para tema claro' : 'Mudar para tema escuro');
      botao.dataset.temaAtual = escuro ? 'escuro' : 'claro';
    });
  }

  atualizarBotoesTema();

  // O próprio botão altera o tema nos módulos de página; observamos o <html>.
  if (window.MutationObserver) {
    new MutationObserver(atualizarBotoesTema).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    });
  }
  if (consultaEscuro) {
    if (consultaEscuro.addEventListener) consultaEscuro.addEventListener('change', atualizarBotoesTema);
    else if (consultaEscuro.addListener) consultaEscuro.addListener(atualizarBotoesTema);
  }
  document.addEventListener('click', (evento) => {
    if (evento.target.closest && evento.target.closest('#btn-tema')) {
      // Atualiza depois do handler do módulo (que troca data-theme).
      window.setTimeout(atualizarBotoesTema, 0);
    }
  });

  /* ---------------------------------------------------------------------------
   * Link de Administração
   * ---------------------------------------------------------------------------
   * Exibição condicional ao PAPEL REAL lido no banco (profiles.role).
   * A autorização efetiva continua nas RPCs admin_* e nas policies is_admin();
   * aqui é apenas a camada de interface.
   */
  window.cgAdicionarLinkAdmin = function adicionarLinkAdmin(perfil) {
    if (!perfil || perfil.role !== 'admin') return; // comum/ausente/erro: oculto

    const paginaAtual = document.body ? document.body.dataset.pagina || '' : '';

    const montarLink = () => {
      const link = document.createElement('a');
      link.className = 'item-nav';
      link.href = 'admin.html';

      const icone = document.createElement('span');
      icone.className = 'icone icone-admin';
      icone.setAttribute('aria-hidden', 'true');
      link.appendChild(icone);
      link.appendChild(document.createTextNode('Admin'));

      if (paginaAtual === 'admin') {
        link.classList.add('ativo');
        link.setAttribute('aria-current', 'page');
      }
      return link;
    };

    const lateral = document.getElementById('nav-admin-lateral');
    if (lateral && !lateral.querySelector('a[href="admin.html"]')) {
      lateral.appendChild(montarLink());
    }

    const menuMais = document.getElementById('menu-mais-admin');
    if (menuMais && !menuMais.querySelector('a[href="admin.html"]')) {
      menuMais.appendChild(montarLink());
    }
  };
})();
