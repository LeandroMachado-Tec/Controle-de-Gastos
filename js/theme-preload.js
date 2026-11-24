/* Preferência visual carregada antes do primeiro paint em TODAS as páginas. */
(function () {
  try {
    var saved = localStorage.getItem('theme');
    var root = document.documentElement;
    if (saved === 'claro' || saved === 'escuro') {
      root.dataset.theme = saved;
    } else {
      root.removeAttribute('data-theme');
    }
  } catch (_) {
    /* Se o armazenamento estiver indisponível, mantém o tema do sistema. */
  }
})();
