// Shared page chrome for the Checkout v3 mock: the top bar with the Acme DS Stepper,
// and query-string states (?empty=1 → <html class="state-empty">) so capture.mjs can
// drive each designed state with a "query" driver.
(function () {
  var q = new URLSearchParams(location.search);
  q.forEach(function (_, key) { document.documentElement.classList.add('state-' + key); });

  // [data-when="empty"] shows only in that state; [data-unless="empty"] hides in it.
  var KEYS = ['empty', 'error', 'promo', 'processing', 'removed'];
  var style = document.createElement('style');
  style.textContent = KEYS.map(function (k) {
    return 'html:not(.state-' + k + ') [data-when="' + k + '"]{display:none !important}' +
      'html.state-' + k + ' [data-unless="' + k + '"]{display:none !important}';
  }).join('');
  document.head.appendChild(style);

  var steps = ['Cart', 'Shipping', 'Payment', 'Review', 'Done'];
  document.querySelectorAll('[data-topbar]').forEach(function (bar) {
    var current = Number(bar.getAttribute('data-topbar'));
    bar.className = 'topbar';
    bar.setAttribute('data-testid', 'topbar');
    bar.innerHTML =
      '<div class="topbar-inner">' +
      '<div class="brand"><span class="brand-mark" aria-hidden="true"></span>acme<span class="brand-sub">Secure checkout</span></div>' +
      '<ol class="ads-stepper" data-component="Stepper" aria-label="Checkout progress">' +
      steps.map(function (s, i) {
        var n = i + 1, cls = n < current ? 'done' : '';
        var mark = n < current ? '&#10003;' : String(n);
        return '<li class="' + cls + '"' + (n === current ? ' aria-current="step"' : '') + '><span class="dot">' + mark + '</span>' + s + '</li>';
      }).join('') +
      '</ol></div>';
  });
})();
