// Solo lee los comentarios que ya se ven en la pantalla del live. No escribe, no comenta, no toca nada.
(function () {
  let visto = new WeakSet(), cola = [], enviados = 0, estado = "Esperando comentarios…", badge = null, ultimaUrl = "";
  const esLive = () => /\/live(\/|$|\?)/.test(location.pathname);
  function leer(e) {
    const u = e.querySelector('[data-e2e="message-owner-name"]');
    const partes = e.innerText.split("\n").map((s) => s.trim()).filter(Boolean);
    const autor = u ? u.innerText.trim() : partes[0] || "";
    const texto = partes.length ? partes[partes.length - 1] : "";
    return texto && texto !== autor ? { autor, texto } : null;
  }
  function pintar() {
    if (!esLive()) { if (badge) badge.remove(); badge = null; return; }
    if (!badge) {
      badge = document.createElement("div");
      badge.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:2147483647;background:#0f7a43;color:#fff;font:700 13px system-ui,sans-serif;padding:8px 12px;border-radius:999px;box-shadow:0 4px 14px rgba(0,0,0,.3);pointer-events:none";
      document.documentElement.append(badge);
    }
    badge.textContent = `Cuantito · ${enviados} comentarios · ${estado}`;
  }
  function escanear() {
    if (location.href !== ultimaUrl) { ultimaUrl = location.href; visto = new WeakSet(); document.querySelectorAll('[data-e2e="chat-message"]').forEach((e) => visto.add(e)); }
    if (!esLive()) { pintar(); return; }
    document.querySelectorAll('[data-e2e="chat-message"]').forEach((e) => { if (visto.has(e)) return; visto.add(e); const c = leer(e); if (c) cola.push(c); });
    pintar();
  }
  function enviar() {
    if (!cola.length) return;
    const items = cola.splice(0, 50);
    try {
      chrome.runtime.sendMessage({ tipo: "enviar", items }, (r) => {
        if (chrome.runtime.lastError || !r) { estado = "Recarga la página"; pintar(); return; }
        if (r.ok) { enviados += items.length; estado = "conectado ✓"; } else { estado = r.error; cola.unshift(...items.slice(0, 20)); }
        pintar();
      });
    } catch (e) { estado = "Recarga la página"; pintar(); }
  }
  setInterval(escanear, 400);
  setInterval(enviar, 1000);
})();
