// Manda los comentarios a Cuantito desde aquí (la página de TikTok no puede llamar a otro sitio).
chrome.runtime.onMessage.addListener((m, _s, responder) => {
  if (m.tipo !== "enviar") return;
  chrome.storage.local.get(["servidor", "token"], async ({ servidor, token }) => {
    if (!servidor || !token) { responder({ ok: false, error: "Falta el código. Toca el ícono de Cuantito Live." }); return; }
    try {
      const r = await fetch(servidor + "/api/live/push", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, items: m.items }) });
      const d = await r.json().catch(() => ({}));
      responder(r.ok ? { ok: true } : { ok: false, error: d.error || "Error " + r.status });
    } catch (e) { responder({ ok: false, error: "Sin conexión con Cuantito" }); }
  });
  return true;
});
