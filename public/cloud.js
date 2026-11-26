/* Cuantito en la web: cuentas reales, guardado en el servidor, cobro por QR, lector del live y app instalable.
   Se carga antes que la app. La app guarda todo en localStorage con el prefijo "altoque.v2."; aquí se sincroniza. */
(function () {
  "use strict";
  const PFX = "altoque.v2.";
  const LS = window.localStorage;
  const api = async (ruta, opt = {}) => {
    const r = await fetch("/api" + ruta, { credentials: "same-origin", ...opt, headers: opt.body && !(opt.body instanceof FormData) ? { "content-type": "application/json", ...(opt.headers || {}) } : opt.headers });
    let d = null; try { d = await r.json(); } catch (e) { d = {}; }
    if (!r.ok) { const e = new Error(d.error || "Error " + r.status); e.status = r.status; throw e; }
    return d;
  };
  const C = window.CQ = { me: null, conf: null, listo: false };
  const confP = fetch("/api/config").then((r) => r.json()).catch(() => ({}));

  /* ---------- IA y descargas (reemplaza las herramientas de Claude) ---------- */
  const aData = (b) => new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(f.result); f.onerror = rej; f.readAsDataURL(b); });
  window.claude = {
    async use(cap) {
      if (cap === "downloads") return { async save({ filename, data }) { const u = URL.createObjectURL(data); const a = document.createElement("a"); a.href = u; a.download = filename; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000); } };
      if (cap !== "sample") return null;
      const conf = await confP; if (!conf.ia) return null;
      const fn = async (prompt, opts = {}) => {
        const images = opts.images ? await Promise.all(opts.images.map(aData)) : [];
        return api("/ia", { method: "POST", body: JSON.stringify({ prompt, images, alta: opts.modelTier === "default" }), signal: opts.signal });
      };
      fn.limits = async () => ({ images: { maxCount: 5 } });
      return fn;
    },
  };

  /* ---------- guardar en el servidor ---------- */
  let sube = null, pausa = true;
  const setItem = Storage.prototype.setItem, removeItem = Storage.prototype.removeItem;
  function marcar(k) { if (pausa || this !== LS || !String(k).startsWith(PFX)) return; clearTimeout(sube); sube = setTimeout(subir, 2500); }
  Storage.prototype.setItem = function (k, v) { setItem.call(this, k, v); marcar.call(this, k); };
  Storage.prototype.removeItem = function (k) { removeItem.call(this, k); marcar.call(this, k); };
  async function subir() {
    if (!C.me) return;
    const data = {};
    for (let i = 0; i < LS.length; i++) { const k = LS.key(i); if (k.startsWith(PFX) && k !== PFX + "cuenta") data[k] = LS.getItem(k); }
    const v = Date.now();
    try { await api("/state", { method: "PUT", body: JSON.stringify({ v, data }) }); setItem.call(LS, "cq.v", String(v)); estadoGuardado("ok"); }
    catch (e) { estadoGuardado("error"); clearTimeout(sube); sube = setTimeout(subir, 15000); }
  }
  window.addEventListener("pagehide", () => { if (sube) { clearTimeout(sube); subir(); } });

  function cuentaDesdeMe(me) {
    const prev = (() => { try { return JSON.parse(LS.getItem(PFX + "cuenta")); } catch (e) { return null; } })() || {};
    const d = new Date();
    return { ...prev, negocio: me.negocio, wa: me.wa, plan: me.plan, desde: me.desde, usadas: Math.max(prev.usadas || 0, me.usadas || 0), mes: d.getFullYear() + "-" + (d.getMonth() + 1) };
  }

  async function arrancar() {
    let r;
    try { r = await api("/me"); }
    catch (e) {
      if (e.status === 401 && LS.getItem("cq.uid")) { // salió o venció la sesión: limpiar este aparato
        Object.keys(LS).filter((k) => k.startsWith(PFX) || k.startsWith("cq.")).forEach((k) => removeItem.call(LS, k)); location.reload(); return;
      }
      C.listo = true; pintarBarra(); return;
    }
    C.me = r.me; C.pend = r.pagoPendiente;
    const nuevoAparato = LS.getItem("cq.uid") !== r.me.wa;
    const st = await api("/state").catch(() => ({ v: 0, data: {} }));
    const local = Number(LS.getItem("cq.v") || 0);
    let recargar = false;
    if (nuevoAparato || (st.v && st.v > local)) {
      if (nuevoAparato) Object.keys(LS).filter((k) => k.startsWith(PFX)).forEach((k) => removeItem.call(LS, k));
      Object.entries(st.data || {}).forEach(([k, v]) => { if (k.startsWith(PFX)) setItem.call(LS, k, v); });
      setItem.call(LS, "cq.v", String(st.v || Date.now())); setItem.call(LS, "cq.uid", r.me.wa); recargar = true;
    }
    const cu = JSON.stringify(cuentaDesdeMe(r.me));
    if (LS.getItem(PFX + "cuenta") !== cu) {
      const viejo = (() => { try { return JSON.parse(LS.getItem(PFX + "cuenta")); } catch (e) { return null; } })();
      setItem.call(LS, PFX + "cuenta", cu);
      if (!viejo || viejo.plan !== r.me.plan) recargar = true;
      if (!viejo) { // primera vez en este aparato: el negocio y WhatsApp de la cuenta van a la app
        let cf = {}; try { cf = JSON.parse(LS.getItem(PFX + "conf")) || {}; } catch (e) {}
        cf.negocio = r.me.negocio; cf.wa = r.me.wa; setItem.call(LS, PFX + "conf", JSON.stringify(cf));
      }
    }
    if (recargar) { location.reload(); return; }
    pausa = false; C.listo = true; pintarBarra();
    if (!r.me.email) pedirCorreo();
    const h0 = location.hash.slice(1);
    if (!h0 || h0 === "cotizar" || h0 === "inicio" || LS.getItem("cq.home")) { removeItem.call(LS, "cq.home"); abrirInicio(); }
    if (!st.v) subir();
    setInterval(leerLive, 1500);
  }

  /* ---------- registro y entrada ---------- */
  const css = `
  .cq-ov{position:fixed;inset:0;background:rgba(10,20,15,.55);display:flex;align-items:flex-end;justify-content:center;z-index:9999;font-family:Figtree,system-ui,sans-serif}
  @media(min-width:640px){.cq-ov{align-items:center}}
  .cq-box{background:#fff;color:#14231b;width:100%;max-width:420px;border-radius:20px 20px 0 0;padding:22px 18px 26px;max-height:92vh;overflow:auto}
  @media(min-width:640px){.cq-box{border-radius:20px}}
  .cq-box h2{margin:0 0 6px;font-size:22px}.cq-box p{margin:6px 0;color:#41524a;font-size:15px;line-height:1.4}
  .cq-box label{display:block;font-weight:700;font-size:14px;margin:12px 0 4px}
  .cq-box input,.cq-box select{width:100%;box-sizing:border-box;font:inherit;font-size:17px;padding:12px;border:1.5px solid #c9d6cf;border-radius:12px;background:#fff;color:#14231b}
  .cq-b{display:block;width:100%;margin-top:14px;padding:14px;border:0;border-radius:14px;font:inherit;font-weight:800;font-size:17px;background:#0f7a43;color:#fff;cursor:pointer}
  .cq-b.sec{background:#eef4f0;color:#14231b}.cq-err{color:#b3261e;font-weight:700;min-height:1.2em}
  .cq-x{float:right;border:0;background:none;font-size:26px;line-height:1;cursor:pointer;color:#41524a}
  .cq-bar{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(76px + env(safe-area-inset-bottom));z-index:9000;display:flex;gap:8px;align-items:center;background:#14231b;color:#fff;padding:8px 8px 8px 14px;border-radius:999px;font:600 14px Figtree,system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:calc(100vw - 24px)}
  .cq-bar button{border:0;border-radius:999px;padding:8px 12px;font:inherit;font-weight:800;background:#2fd27a;color:#0b2416;cursor:pointer;white-space:nowrap}
  .cq-bar .g{background:#2a3b33;color:#fff}.cq-bar span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cq-qr{display:block;width:100%;max-width:280px;margin:10px auto;border-radius:12px;border:1px solid #dde6e1}
  .cq-code{font:700 15px "JetBrains Mono",monospace;background:#eef4f0;padding:12px;border-radius:10px;word-break:break-all;user-select:all}
  .cq-ok{color:#0f7a43;font-weight:800}
  .cq-mut{font-size:13px!important;color:#5a6b62!important}
  .cq-tipos{display:grid;gap:10px;margin:12px 0}
  .cq-tipo{display:grid;gap:3px;text-align:left;border:2px solid #dbe5df;background:#fff;border-radius:16px;padding:14px;font:inherit;color:#14231b;cursor:pointer}
  .cq-tipo b{font-size:18px}.cq-tipo span{color:#41524a;font-size:14px;line-height:1.35}.cq-tipo em{font-style:normal;font-weight:800;color:#c2410c;font-size:14px}
  .cq-tipo.on,.cq-tipo:focus-visible{border-color:#ff6a1a;background:#fff6f0;outline:none}
  .cq-home{position:fixed;inset:0;z-index:8500;color:#fff;font-family:Figtree,system-ui,sans-serif;display:flex;flex-direction:column;
    background:radial-gradient(120% 70% at 50% 100%,rgba(255,106,26,.28),transparent 60%),radial-gradient(80% 50% at 0% 0%,rgba(47,210,122,.12),transparent 60%),#0f1626}
  .cq-home-top{display:flex;align-items:center;gap:12px;padding:calc(14px + env(safe-area-inset-top)) 16px 8px}
  .cq-ic{width:48px;height:48px;border-radius:14px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#fff;display:grid;place-items:center;cursor:pointer}
  .cq-logo{font:900 26px "Big Shoulders Display",Figtree,sans-serif;letter-spacing:.02em}
  .cq-home-mid{flex:1;display:flex;flex-direction:column;justify-content:center;padding:0 24px;gap:10px}
  .cq-home-mid h1{margin:0;font:900 44px/1 "Big Shoulders Display",Figtree,sans-serif;text-transform:uppercase}
  .cq-home-mid p{margin:0;color:#c6d0e0;font-size:17px;line-height:1.4}
  .cq-chip{align-self:flex-start;margin-top:6px;padding:6px 12px;border-radius:999px;background:rgba(255,255,255,.08);font-weight:700;font-size:14px;color:#e6ecf5}
  .cq-home-bot{display:flex;flex-direction:column;align-items:center;gap:12px;padding:0 16px calc(28px + env(safe-area-inset-bottom))}
  .cq-cam{width:92px;height:92px;border-radius:50%;border:0;background:#ff6a1a;color:#fff;display:grid;place-items:center;cursor:pointer;box-shadow:0 0 0 8px rgba(255,106,26,.22),0 12px 30px rgba(0,0,0,.4)}
  .cq-cam:active{transform:scale(.96)}
  .cq-home-bot b{font-size:17px}.cq-gal{border:0;background:none;color:#c6d0e0;font:inherit;font-weight:700;text-decoration:underline;cursor:pointer;padding:8px}
  .cq-dr{position:fixed;inset:0;z-index:8600;background:rgba(0,0,0,.5);display:flex}
  .cq-dr nav{width:min(300px,82vw);height:100%;background:#fff;color:#14231b;padding:calc(18px + env(safe-area-inset-top)) 12px 18px;display:flex;flex-direction:column;gap:4px;overflow:auto;box-shadow:8px 0 30px rgba(0,0,0,.3);font-family:Figtree,system-ui,sans-serif}
  .cq-dr nav h3{margin:4px 10px 2px;font-size:20px}.cq-dr nav small{margin:0 10px 12px;color:#5a6b62}
  .cq-dr nav button{display:flex;align-items:center;gap:12px;border:0;background:none;text-align:left;padding:13px 10px;border-radius:12px;font:600 17px Figtree,system-ui,sans-serif;color:#14231b;cursor:pointer}
  .cq-dr nav button:hover,.cq-dr nav button:focus-visible{background:#f1f4f2;outline:none}
  .cq-dr nav hr{border:0;border-top:1px solid #e3e9e5;margin:8px 0}
  body.cq-en-home .cq-bar{display:none}`;
  const st = document.createElement("style"); st.textContent = css;
  document.addEventListener("DOMContentLoaded", () => document.head.append(st));
  const el = (t, a = {}, ...k) => { const e = document.createElement(t); for (const [n, v] of Object.entries(a)) { if (n.startsWith("on")) e.addEventListener(n.slice(2), v); else if (n === "text") e.textContent = v; else e.setAttribute(n, v); } k.flat().forEach((x) => x != null && e.append(x)); return e; };
  function modal(...hijos) {
    const box = el("div", { class: "cq-box", role: "dialog", "aria-modal": "true" }, el("button", { class: "cq-x", type: "button", "aria-label": "Cerrar", onclick: () => ov.remove() }, "×"), ...hijos);
    const ov = el("div", { class: "cq-ov", onclick: (e) => { if (e.target === ov) ov.remove(); } }, box);
    document.body.append(ov); return ov;
  }
  const refGuardado = (() => { const m = location.search.match(/[?&]ref=([\w-]{3,20})/); if (m) try { setItem.call(LS, "cq.ref", m[1].toUpperCase()); } catch (e) {} return LS.getItem("cq.ref") || ""; })();

  /* ---------- tipos de uso y planes ---------- */
  const TIPOS = [
    { k: "personal", plan: "cot", t: "Uso personal", d: "Para saber si te están cobrando de más antes de comprar. Solo cotizar.", p: "50 Bs al mes" },
    { k: "emprendimiento", plan: "emp", t: "Emprendimiento", d: "Vendes en lives, Marketplace o cajas: cotizar, inventario, catálogo y live.", p: "150 Bs al mes" },
    { k: "negocio", plan: "neg", t: "Negocio", d: "Tienda con vendedores: todo lo anterior más equipo, ranking y reportes.", p: "Precio a medida" },
  ];
  const tipoDe = (plan) => TIPOS.find((x) => x.plan === plan);
  function tarjetasTipo(sel, alElegir, actual) {
    return el("div", { class: "cq-tipos" }, TIPOS.map((x) => el("button", { type: "button", class: "cq-tipo" + (x.k === sel ? " on" : ""), onclick: () => alElegir(x) },
      el("b", { text: x.t }), el("span", { text: x.d }), el("em", { text: x.p + (actual === x.plan ? " · tu plan" : "") }))));
  }

  // La app llama a esto al tocar «Crear cuenta» o un plan en la página de inicio.
  window.cloudAbrirReg = function (plan) { if (C.me) { abrirPlanes(); return; } abrirRegistro({ tipo: (tipoDe(plan) || {}).k }); };
  window.cloudReg = function () { if (C.me) return true; abrirRegistro({}); return false; };
  function abrirRegistro(pre = {}) {
    const ov = modal(el("h2", { text: "Crea tu cuenta" }), el("p", { text: "Paso 1 de 2 · ¿Para qué vas a usar Cuantito?" }),
      tarjetasTipo(pre.tipo, (x) => { ov.remove(); abrirDatos({ ...pre, tipo: x.k }); }),
      el("p", { class: "cq-mut", text: "Cualquiera empieza con 3 días gratis y 50 cotizaciones. Después puedes cambiar de plan cuando quieras, sin perder nada." }),
      el("button", { class: "cq-b sec", type: "button", onclick: () => { ov.remove(); abrirLogin(); } }, "Ya tengo cuenta"));
  }
  function abrirDatos(pre) {
    const T = TIPOS.find((x) => x.k === pre.tipo);
    const e = el("p", { class: "cq-err" });
    const n = el("input", { maxlength: "40", value: pre.negocio || "", autocomplete: T.k === "personal" ? "name" : "organization" });
    const m = el("input", { type: "email", inputmode: "email", maxlength: "254", value: pre.email || "", autocomplete: "email", placeholder: "tunombre@gmail.com" });
    const w = el("input", { inputmode: "tel", maxlength: "16", value: pre.wa || "", autocomplete: "tel", placeholder: "70000000" });
    const p = el("input", { type: "password", minlength: "6", autocomplete: "new-password" });
    const ref = el("input", { maxlength: "20", value: refGuardado, placeholder: "Opcional", autocapitalize: "characters" });
    const go = el("button", { class: "cq-b", type: "submit" }, "Crear mi cuenta");
    const ov = modal(el("h2", { text: "Tus datos" }), el("p", { text: `Paso 2 de 2 · ${T.t}` }),
      el("form", { onsubmit: async (ev) => {
        ev.preventDefault(); e.textContent = ""; go.disabled = true; go.textContent = "Creando…";
        try { await api("/signup", { method: "POST", body: JSON.stringify({ tipo: T.k, negocio: n.value, email: m.value, wa: w.value, pass: p.value, ref: ref.value }) }); setItem.call(LS, "cq.uid", ""); setItem.call(LS, "cq.home", "1"); location.hash = ""; location.reload(); }
        catch (er) { e.textContent = er.message; go.disabled = false; go.textContent = "Crear mi cuenta"; }
      } }, el("label", { text: T.k === "personal" ? "Tu nombre" : "Nombre de tu negocio" }), n, el("label", { text: "Tu correo (Gmail)" }), m,
        el("label", { text: "Tu WhatsApp" }), w, el("label", { text: "Crea una contraseña (mínimo 6)" }), p,
        el("label", { text: "Código de tu paquetería" }), ref, e, go),
      el("button", { class: "cq-b sec", type: "button", onclick: () => { ov.remove(); abrirRegistro(pre); } }, "Volver"));
  }
  function abrirPlanes() {
    const me = C.me, actual = me.plan === "prueba" ? null : me.plan;
    const ov = modal(el("h2", { text: "Cambiar de plan" }),
      el("p", { text: me.plan === "prueba" ? `Estás en la prueba gratis (${me.dias} día${me.dias === 1 ? "" : "s"}). Elige cómo seguir:` : `Tu plan ahora: ${me.planNombre}. Tus datos, inventario y ventas se quedan igual al cambiar.` }),
      tarjetasTipo(me.tipo, async (x) => {
        ov.remove();
        try { const r = await api("/perfil", { method: "POST", body: JSON.stringify({ tipo: me.plan === "prueba" ? x.k : undefined, pedido: x.plan }) }); C.me = r.me; } catch (e) {}
        if (x.plan === "neg") { const conf = await confP; modal(el("h2", { text: "Plan Negocio" }), el("p", { text: "El precio depende de cuántos vendedores y sucursales tengas. Escríbenos y lo armamos contigo." }), el("a", { class: "cq-b", href: `https://wa.me/591${conf.wa}?text=${encodeURIComponent("Hola, quiero el plan Negocio de Cuantito para " + me.negocio)}`, target: "_blank", rel: "noopener", style: "text-align:center;text-decoration:none" }, "Escribir por WhatsApp")); return; }
        abrirPago(x.plan);
      }, actual));
  }
  function pedirCorreo() {
    const e = el("p", { class: "cq-err" });
    const m = el("input", { type: "email", inputmode: "email", maxlength: "254", autocomplete: "email", placeholder: "tunombre@gmail.com" });
    const go = el("button", { class: "cq-b", type: "submit" }, "Guardar");
    const ov = modal(el("h2", { text: "Falta tu correo" }), el("p", { text: "Lo usamos para que puedas recuperar tu cuenta. No te mandamos publicidad." }),
      el("form", { onsubmit: async (ev) => { ev.preventDefault(); go.disabled = true; try { const r = await api("/perfil", { method: "POST", body: JSON.stringify({ email: m.value }) }); C.me = r.me; ov.remove(); aviso("Correo guardado"); } catch (er) { e.textContent = er.message; go.disabled = false; } } },
        el("label", { text: "Tu correo (Gmail)" }), m, e, go));
  }
  function abrirLogin(wa0 = "") {
    const e = el("p", { class: "cq-err" });
    const w = el("input", { maxlength: "254", value: wa0, autocomplete: "username", placeholder: "70000000 o tunombre@gmail.com" });
    const p = el("input", { type: "password", autocomplete: "current-password" });
    const go = el("button", { class: "cq-b", type: "submit" }, "Entrar");
    modal(el("h2", { text: "Entrar a Cuantito" }), el("form", { onsubmit: async (ev) => {
      ev.preventDefault(); e.textContent = ""; go.disabled = true;
      try { await api("/login", { method: "POST", body: JSON.stringify({ wa: w.value, pass: p.value }) }); setItem.call(LS, "cq.uid", ""); setItem.call(LS, "cq.home", "1"); location.hash = ""; location.reload(); }
      catch (er) { e.textContent = er.message; go.disabled = false; }
    } }, el("label", { text: "Tu WhatsApp o tu correo" }), w, el("label", { text: "Contraseña" }), p, e, go),
      el("p", { text: "¿Olvidaste tu contraseña? Escribe al WhatsApp de Cuantito y te la cambiamos." }),
      el("button", { class: "cq-b sec", type: "button", onclick: (ev) => { ev.target.closest(".cq-ov").remove(); abrirRegistro({}); } }, "Crear cuenta nueva"));
  }

  /* ---------- pagar por QR ---------- */
  async function abrirPago(planIni) {
    const conf = await confP, P = conf.planes || {};
    const pagables = Object.entries(P).filter(([, v]) => v.precio > 0);
    const sel = el("select", {}, pagables.map(([k, v]) => el("option", { value: k, text: `${v.n} · ${v.precio} Bs al mes` })));
    sel.value = planIni && P[planIni] && P[planIni].precio ? planIni : (C.me && C.me.planPedido) || "cot";
    const monto = el("p", { class: "cq-ok" }); const pint = () => { monto.textContent = `Paga ${P[sel.value].precio} Bs con el QR`; }; sel.addEventListener("change", pint); pint();
    const foto = el("input", { type: "file", accept: "image/*" });
    const e = el("p", { class: "cq-err" });
    const go = el("button", { class: "cq-b", type: "submit" }, "Enviar comprobante");
    modal(el("h2", { text: "Pagar tu plan" }),
      el("label", { text: "Plan" }), sel, monto,
      conf.qr ? el("img", { class: "cq-qr", src: "/api/qr", alt: "QR para pagar" }) : el("p", { text: `Pide el QR por WhatsApp al ${conf.wa}.` }),
      el("p", { text: "1. Escanea el QR desde la app de tu banco. 2. Saca captura del comprobante. 3. Súbela aquí. Tu plan se activa cuando confirmemos el pago, normalmente en menos de 1 hora." }),
      el("form", { onsubmit: async (ev) => {
        ev.preventDefault(); e.textContent = "";
        if (!foto.files[0]) { e.textContent = "Sube la captura del comprobante."; return; }
        go.disabled = true; go.textContent = "Enviando…";
        const fd = new FormData(); fd.append("plan", sel.value); fd.append("foto", foto.files[0]);
        try { await api("/pago", { method: "POST", body: fd }); ev.target.closest(".cq-ov").remove(); C.pend = { plan: sel.value }; pintarBarra(); aviso("Comprobante enviado. Te avisamos al activar tu plan."); }
        catch (er) { e.textContent = er.message; go.disabled = false; go.textContent = "Enviar comprobante"; }
      } }, el("label", { text: "Captura del comprobante" }), foto, e, go));
  }
  function aviso(t) { const a = el("div", { class: "cq-bar", style: "bottom:auto;top:16px" }, el("span", { text: t })); document.body.append(a); setTimeout(() => a.remove(), 4200); }

  /* ---------- menú de cuenta ---------- */
  let promptInstalar = null;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); promptInstalar = e; pintarBarra(); });
  function abrirCuenta() {
    const me = C.me;
    const hijos = [el("h2", { text: me.negocio }), el("p", { text: `WhatsApp ${me.wa}${me.email ? " · " + me.email : ""} · Plan ${me.planNombre}` }),
      el("p", { text: me.activo ? `Activo por ${me.dias} día${me.dias === 1 ? "" : "s"} más · ${me.usadas} de ${me.limite} cotizaciones con IA` : "Tu plan venció" })];
    hijos.push(el("button", { class: "cq-b", type: "button", onclick: (ev) => { ev.target.closest(".cq-ov").remove(); abrirPlanes(); } }, me.plan === "prueba" || !me.activo ? "Elegir plan y pagar" : "Cambiar de plan"));
    if (me.plan !== "cot") hijos.push(el("button", { class: "cq-b sec", type: "button", onclick: (ev) => { ev.target.closest(".cq-ov").remove(); abrirLector(); } }, "Conectar lector del live"));
    hijos.push(el("button", { class: "cq-b sec", type: "button", onclick: instalar }, "Instalar en este celular"));
    if (me.admin) hijos.push(el("button", { class: "cq-b sec", type: "button", onclick: () => { location.href = "/admin"; } }, "Panel del dueño"));
    hijos.push(el("button", { class: "cq-b sec", type: "button", onclick: async () => { await api("/logout", { method: "POST" }).catch(() => {}); location.reload(); } }, "Salir de mi cuenta"));
    modal(...hijos);
  }
  async function instalar() {
    if (promptInstalar) { promptInstalar.prompt(); promptInstalar = null; return; }
    const ios = /iphone|ipad/i.test(navigator.userAgent);
    modal(el("h2", { text: "Instalar Cuantito" }), el("p", { text: ios ? "En Safari toca el botón Compartir (el cuadrito con flecha) y luego «Agregar a inicio»." : "En Chrome toca los 3 puntitos de arriba a la derecha y luego «Instalar app» o «Agregar a la pantalla principal»." }),
      el("p", { text: "Queda con su ícono como cualquier app y se abre sin la barra del navegador." }));
  }
  async function abrirLector() {
    let t; try { t = (await api("/live/token", { method: "POST" })).token; } catch (e) { aviso(e.message); return; }
    const codigo = location.origin + "#" + t;
    modal(el("h2", { text: "Lector del live de TikTok" }),
      el("p", { text: "1. En tu compu, instala la extensión «Cuantito Live» en Brave o Chrome." }),
      el("p", { text: "2. Toca el ícono de la extensión y pega este código:" }), el("div", { class: "cq-code", text: codigo }),
      el("button", { class: "cq-b sec", type: "button", onclick: () => navigator.clipboard.writeText(codigo).then(() => aviso("Código copiado")) }, "Copiar código"),
      el("p", { text: "3. Abre tu live en tiktok.com con la cuenta que va a mirar. Los «mío» aparecen en Live › TikTok LIVE para que los apartes con un toque." }),
      el("p", { text: "Si generas un código nuevo, el anterior deja de funcionar." }));
  }
  let barra = null, guardado = "";
  function estadoGuardado(s) { guardado = s; pintarBarra(); }
  function pintarBarra() {
    if (!document.body) { document.addEventListener("DOMContentLoaded", pintarBarra, { once: true }); return; }
    if (barra) barra.remove(); barra = null;
    const me = C.me;
    if (!me) {
      if (!C.listo) return;
      barra = el("div", { class: "cq-bar" }, el("span", { text: "¿Ya tienes cuenta?" }), el("button", { type: "button", onclick: () => abrirLogin() }, "Entrar"));
    } else {
      let txt = me.plan === "prueba" ? `Prueba: ${me.dias} día${me.dias === 1 ? "" : "s"}` : me.activo ? `${me.planNombre} · ${me.dias} días` : "Plan vencido";
      if (C.pend) txt = "Pago en revisión";
      if (guardado === "error") txt = "Sin conexión, guardando luego";
      const pagar = !C.pend && (me.plan === "prueba" || !me.activo || me.dias <= 3);
      barra = el("div", { class: "cq-bar" }, el("span", { text: txt }),
        pagar ? el("button", { type: "button", onclick: () => abrirPlanes() }, "Pagar") : null,
        el("button", { class: "g", type: "button", onclick: abrirCuenta }, "Cuenta"));
      if (!pagar && !promptInstalar && me.activo && guardado !== "error") barra.style.opacity = ".92";
    }
    document.body.append(barra);
  }


  /* ---------- inicio simple: fondo, menú a la izquierda y cámara abajo ---------- */
  const SVG = {
    menu: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
    cam: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.6"/></svg>',
  };
  const ico = (k) => { const s = document.createElement("span"); s.innerHTML = SVG[k]; s.style.display = "grid"; return s; };
  let home = null;
  function cerrarInicio() { if (home) home.remove(); home = null; document.body.classList.remove("cq-en-home"); pintarBarra(); }
  function irA(v) { cerrarInicio(); if (location.hash.slice(1) === v) window.dispatchEvent(new HashChangeEvent("hashchange")); else location.hash = v; window.scrollTo(0, 0); }
  function secciones() {
    const me = C.me, plan = me.plan === "prueba" ? ((TIPOS.find((x) => x.k === me.tipo) || {}).plan || "neg") : me.plan;
    const oculta = { cot: ["inventario", "live", "equipo"], emp: ["equipo"] }[plan] || [];
    return [["cotizar", "Cotizar"], ["inventario", "Mi inventario y catálogo"], ["live", "Vender en live"], ["equipo", "Mi equipo"]].filter(([k]) => !oculta.includes(k));
  }
  function abrirMenu() {
    const me = C.me;
    const it = (t, fn) => el("button", { type: "button", onclick: () => { dr.remove(); fn(); } }, t);
    const nav = el("nav", { "aria-label": "Menú" }, el("h3", { text: me.negocio }), el("small", { text: `${me.planNombre}${me.activo ? ` · ${me.dias} día${me.dias === 1 ? "" : "s"}` : " · vencido"}` }),
      it("Inicio", () => abrirInicio()), ...secciones().map(([k, t]) => it(t, () => irA(k))), el("hr"),
      it(me.plan === "prueba" || !me.activo ? "Elegir plan y pagar" : "Cambiar de plan", () => { cerrarInicio(); abrirPlanes(); }),
      it("Mi cuenta", () => { cerrarInicio(); abrirCuenta(); }),
      ...(me.admin ? [it("Panel del dueño", () => { location.href = "/admin"; })] : []));
    const dr = el("div", { class: "cq-dr", onclick: (e) => { if (e.target === dr) dr.remove(); } }, nav);
    document.body.append(dr);
    const b = nav.querySelector("button"); if (b) b.focus();
  }
  function abrirInicio() {
    if (!document.body) { document.addEventListener("DOMContentLoaded", abrirInicio, { once: true }); return; }
    if (home) home.remove();
    const me = C.me, nombre = String(me.negocio).split(/\s+/)[0];
    const quedan = Math.max(0, me.limite - me.usadas);
    const foto = (cual) => { cerrarInicio(); location.hash = "cotizar"; const i = document.getElementById(cual); if (i) i.click(); };
    home = el("section", { class: "cq-home", "aria-label": "Inicio" },
      el("div", { class: "cq-home-top" }, el("button", { class: "cq-ic", type: "button", "aria-label": "Abrir menú", onclick: abrirMenu }, ico("menu")), el("span", { class: "cq-logo", text: "CUANTITO" })),
      el("div", { class: "cq-home-mid" }, el("h1", { text: `Hola, ${nombre}` }), el("p", { text: "Sácale una foto a lo que quieres cotizar y Cuantito te dice su precio justo." }),
        el("span", { class: "cq-chip", text: me.activo ? `${me.planNombre} · te quedan ${quedan} cotizaciones` : "Tu plan venció · toca el menú para pagar" })),
      el("div", { class: "cq-home-bot" },
        el("button", { class: "cq-cam", type: "button", "aria-label": "Tomar foto para cotizar", onclick: () => foto("inCam") }, ico("cam")),
        el("b", { text: "Tomar foto" }),
        el("button", { class: "cq-gal", type: "button", onclick: () => foto("inGal") }, "o elegir de la galería")));
    document.body.append(home); document.body.classList.add("cq-en-home");
  }

  /* ---------- comentarios del live que manda la extensión ---------- */
  let desde = 0;
  window.__ttQ = window.__ttQ || [];
  async function leerLive() {
    if (document.hidden || !C.me) return;
    let on = false; on = !!(window.__TT && window.__TT.on);
    if (!on) { desde = 0; return; }
    try {
      const r = await api("/live/feed" + (desde ? "?since=" + desde : ""));
      if (!desde) { desde = r.items.length ? r.items[0].id : 0.5; return; } // al conectar, solo lo nuevo
      r.items.forEach((i) => { desde = Math.max(desde, i.id); window.__ttQ.push([i.autor, i.texto]); });
    } catch (e) {}
  }

  /* ---------- app instalable ---------- */
  if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
  arrancar();
})();
