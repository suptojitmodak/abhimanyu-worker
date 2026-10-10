(function () {
  var box = document.getElementById("live");
  var out = document.getElementById("count");
  var fmt = new Intl.NumberFormat("bn-BD");
  var shown = 0;

  function show(n) {
    var from = shown, start = null;
    shown = n;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || from === n) { out.textContent = fmt.format(n); return; }
    function step(t) {
      if (start === null) start = t;
      var p = Math.min((t - start) / 700, 1);
      out.textContent = fmt.format(Math.round(from + (n - from) * p));
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function load() {
    fetch("/count", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && Number.isSafeInteger(d.count) && d.count > 0) { box.hidden = false; show(d.count); }
      })
      .catch(function () {});
  }

  load();
  setInterval(function () { if (!document.hidden) load(); }, 20000);
  document.getElementById("dl").addEventListener("click", function () { setTimeout(load, 12000); });
})();
