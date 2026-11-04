// Runs before the first paint so the page never flashes the wrong theme: the saved choice, else the computer's setting.
(function () {
  var saved = null;
  try {
    saved = localStorage.getItem('veloq-theme');
  } catch (error) {
    // Storage blocked: fall back to the computer's setting.
  }
  var dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
})();
