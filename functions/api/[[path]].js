// Servidor de Cuantito (Cloudflare Pages Functions + D1 + R2).
// Bindings: DB (D1). Los archivos (comprobantes, QR, datos de cada cuenta) también van en D1, en partes de 900 KB. Variables: ADMIN_WA. Secreto opcional: ANTHROPIC_API_KEY (sin ella la IA queda apagada).
const DIA = 864e5;
const PLANES = {
  prueba: { n: "Prueba gratis", precio: 0, lim: 50, dias: 3 },
  cot: { n: "Cotizador", precio: 50, lim: 50, dias: 30 },
  emp: { n: "Emprendedor", precio: 150, lim: 150, dias: 30 },
  neg: { n: "Negocio", precio: 0, lim: 500, dias: 30 },
};
const AFILIADO_BS = 50;
const TIPOS = { personal: "cot", emprendimiento: "emp", negocio: "neg" };
const emailOk = (e) => /^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[a-z]{2,}$/i.test(e);

const json = (d, s = 200, h = {}) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...h } });
const err = (m, s = 400) => json({ error: m }, s);
const enc = new TextEncoder();
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const rid = (n = 16) => hex(crypto.getRandomValues(new Uint8Array(n)));
const soloDig = (s) => String(s || "").replace(/\D/g, "").slice(-12);
const limpio = (s, n = 60) => String(s || "").replace(/[<>]/g, "").trim().slice(0, n);

/* ---------- base de datos ---------- */
let listo = false;
async function esquema(env) {
  if (listo) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS usuarios (id TEXT PRIMARY KEY, wa TEXT UNIQUE, negocio TEXT, sal TEXT, hash TEXT, plan TEXT, plan_pedido TEXT, desde INTEGER, vence INTEGER, usadas INTEGER DEFAULT 0, mes TEXT, ref TEXT, admin INTEGER DEFAULT 0, live_token TEXT, creado INTEGER, intentos INTEGER DEFAULT 0, bloqueo INTEGER DEFAULT 0)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sesiones (token TEXT PRIMARY KEY, uid TEXT, exp INTEGER)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS pagos (id TEXT PRIMARY KEY, uid TEXT, plan TEXT, monto REAL, foto TEXT, estado TEXT, nota TEXT, creado INTEGER, revisado INTEGER)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS afiliados (codigo TEXT PRIMARY KEY, nombre TEXT, wa TEXT, creado INTEGER)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS comisiones (uid TEXT PRIMARY KEY, codigo TEXT, monto REAL, pago_id TEXT, creado INTEGER, pagada INTEGER DEFAULT 0)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS live (id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT, ts INTEGER, autor TEXT, texto TEXT)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS live_uid ON live(uid, id)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS archivos (k TEXT, parte INTEGER, tipo TEXT, data BLOB, PRIMARY KEY (k, parte))`),
  ]);
  for (const c of ["email TEXT", "tipo TEXT"]) { try { await env.DB.prepare("ALTER TABLE usuarios ADD COLUMN " + c).run(); } catch (e) { /* ya existe */ } }
  listo = true;
}
const uno = (env, q, ...a) => env.DB.prepare(q).bind(...a).first();
const todos = async (env, q, ...a) => (await env.DB.prepare(q).bind(...a).all()).results || [];
const run = (env, q, ...a) => env.DB.prepare(q).bind(...a).run();


/* ---------- archivos guardados en D1 ---------- */
const PARTE = 900 * 1024;
async function guardar(env, k, cuerpo, tipo) {
  const buf = new Uint8Array(typeof cuerpo === "string" ? enc.encode(cuerpo) : cuerpo instanceof ArrayBuffer ? cuerpo : await new Response(cuerpo).arrayBuffer());
  const st = [env.DB.prepare("DELETE FROM archivos WHERE k=?").bind(k)];
  for (let i = 0, n = 0; i < Math.max(buf.length, 1); i += PARTE, n++) st.push(env.DB.prepare("INSERT INTO archivos VALUES (?,?,?,?)").bind(k, n, tipo || "application/octet-stream", buf.slice(i, i + PARTE)));
  await env.DB.batch(st);
}
async function leer(env, k) {
  const rows = await todos(env, "SELECT tipo, data FROM archivos WHERE k=? ORDER BY parte", k);
  if (!rows.length) return null;
  const partes = rows.map((r) => new Uint8Array(r.data)); const out = new Uint8Array(partes.reduce((a, p) => a + p.length, 0));
  let o = 0; for (const p of partes) { out.set(p, o); o += p.length; }
  return { body: out, tipo: rows[0].tipo };
}
const existe = async (env, k) => !!(await uno(env, "SELECT 1 AS x FROM archivos WHERE k=? LIMIT 1", k));
const archivoResp = (f) => new Response(f.body, { headers: { "content-type": f.tipo, "cache-control": "no-store" } });

/* ---------- contraseñas y sesiones ---------- */
async function hashPass(pass, sal) {
  const k = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(sal), iterations: 100000 }, k, 256));
}
function igual(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
async function crearSesion(env, uid) {
  const t = rid(24), exp = Date.now() + 180 * DIA;
  await run(env, "INSERT INTO sesiones VALUES (?,?,?)", t, uid, exp);
  return { "set-cookie": `cq=${t}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${180 * 86400}` };
}
async function usuario(env, req) {
  const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)cq=([0-9a-f]{48})/);
  if (!m) return null;
  const s = await uno(env, "SELECT uid, exp FROM sesiones WHERE token=?", m[1]);
  if (!s || s.exp < Date.now()) return null;
  return uno(env, "SELECT * FROM usuarios WHERE id=?", s.uid);
}
const mesKey = () => { const d = new Date(); return d.getUTCFullYear() + "-" + (d.getUTCMonth() + 1); };
function estado(u) {
  const ahora = Date.now();
  const activo = u.vence > ahora;
  return { activo, dias: Math.max(0, Math.ceil((u.vence - ahora) / DIA)) };
}
function publico(u) {
  const e = estado(u), p = PLANES[u.plan] || PLANES.prueba;
  return { negocio: u.negocio, wa: u.wa, email: u.email || "", tipo: u.tipo || "", plan: u.plan, planNombre: p.n, planPedido: u.plan_pedido, desde: u.desde, vence: u.vence, activo: e.activo, dias: e.dias, usadas: u.mes === mesKey() || u.plan === "prueba" ? u.usadas : 0, limite: p.lim, admin: !!u.admin };
}

/* ---------- IA (solo si hay ANTHROPIC_API_KEY) ---------- */
async function ia(env, u, body) {
  if (!env.ANTHROPIC_API_KEY) return err("La IA no está activada en este servidor.", 503);
  const e = estado(u), p = PLANES[u.plan] || PLANES.prueba;
  if (!e.activo) return err("Tu plan venció. Paga para seguir cotizando.", 402);
  const usadas = u.mes === mesKey() || u.plan === "prueba" ? u.usadas : 0;
  if (usadas >= p.lim) return err(`Llegaste a tus ${p.lim} cotizaciones de este mes.`, 429);
  const imgs = Array.isArray(body.images) ? body.images.slice(0, 5) : [];
  const content = [...imgs.map((d) => { const m = String(d).match(/^data:(image\/\w+);base64,(.+)$/); return m ? { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } } : null; }).filter(Boolean), { type: "text", text: limpio(body.prompt, 20000) }];
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: body.alta ? "claude-sonnet-5-5" : "claude-haiku-5-5", max_tokens: 2500, messages: [{ role: "user", content }] }),
  });
  if (!r.ok) return err("La IA no respondió, intenta de nuevo.", 502);
  const d = await r.json();
  await run(env, "UPDATE usuarios SET usadas=?, mes=? WHERE id=?", usadas + 1, mesKey(), u.id);
  return json({ text: (d.content || []).filter((c) => c.type === "text").map((c) => c.text).join("") });
}

/* ---------- rutas ---------- */
export async function onRequest({ request, env, params }) {
  await esquema(env);
  const ruta = "/" + (params.path || []).join("/");
  const M = request.method;
  const url = new URL(request.url);
  const body = async () => { try { return await request.json(); } catch { return {}; } };

  // El lector del live (extensión en TikTok) manda comentarios con su código de enlace.
  if (ruta === "/live/push") {
    const cors = { "access-control-allow-origin": "https://www.tiktok.com", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST" };
    if (M === "OPTIONS") return new Response(null, { headers: cors });
    const b = await body();
    const u = b.token && /^[0-9a-f]{20}$/.test(b.token) ? await uno(env, "SELECT id FROM usuarios WHERE live_token=?", b.token) : null;
    if (!u) return json({ error: "Código de enlace inválido" }, 401, cors);
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 50);
    for (const it of items) await run(env, "INSERT INTO live (uid, ts, autor, texto) VALUES (?,?,?,?)", u.id, Date.now(), limpio(it.autor, 40), limpio(it.texto, 200));
    await run(env, "DELETE FROM live WHERE uid=? AND id < (SELECT COALESCE(MAX(id),0)-1000 FROM live WHERE uid=?)", u.id, u.id);
    return json({ ok: true, n: items.length }, 200, cors);
  }

  if (ruta === "/config" && M === "GET") {
    const qr = await existe(env, "config/qr");
    return json({ planes: PLANES, afiliado: AFILIADO_BS, qr: !!qr, wa: env.ADMIN_WA, ia: !!env.ANTHROPIC_API_KEY });
  }
  if (ruta === "/qr" && M === "GET") {
    const o = await leer(env, "config/qr");
    return o ? archivoResp(o) : err("Sin QR", 404);
  }

  if (ruta === "/signup" && M === "POST") {
    const b = await body();
    const wa = soloDig(b.wa), negocio = limpio(b.negocio, 40), pass = String(b.pass || ""), email = limpio(b.email, 254).toLowerCase(), tipo = TIPOS[b.tipo] ? b.tipo : "";
    if (!tipo) return err("Elige para qué vas a usar Cuantito.");
    if (!negocio) return err(tipo === "personal" ? "Escribe tu nombre." : "Escribe el nombre de tu negocio.");
    if (!emailOk(email)) return err("Escribe tu correo (Gmail) completo.");
    if (wa.length < 7) return err("Escribe tu WhatsApp (mínimo 7 dígitos).");
    if (pass.length < 6) return err("La contraseña debe tener al menos 6 letras o números.");
    if (await uno(env, "SELECT id FROM usuarios WHERE wa=?", wa)) return err("Ese WhatsApp ya tiene cuenta. Toca «Ya tengo cuenta».", 409);
    if (await uno(env, "SELECT id FROM usuarios WHERE email=?", email)) return err("Ese correo ya tiene cuenta. Toca «Ya tengo cuenta».", 409);
    const pedido = TIPOS[tipo];
    const ref = b.ref ? limpio(b.ref, 20).toUpperCase() : null;
    const refOk = ref ? await uno(env, "SELECT codigo FROM afiliados WHERE codigo=?", ref) : null;
    const id = rid(8), sal = rid(8), ahora = Date.now();
    const admin = soloDig(env.ADMIN_WA) === wa ? 1 : 0;
    await run(env, "INSERT INTO usuarios (id, wa, negocio, email, tipo, sal, hash, plan, plan_pedido, desde, vence, usadas, mes, ref, admin, creado) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id, wa, negocio, email, tipo, sal, await hashPass(pass, sal), admin ? "neg" : "prueba", pedido, ahora, ahora + (admin ? 3650 : PLANES.prueba.dias) * DIA, 0, mesKey(), refOk ? ref : null, admin, ahora);
    return json({ ok: true, me: publico(await uno(env, "SELECT * FROM usuarios WHERE id=?", id)) }, 200, await crearSesion(env, id));
  }
  if (ruta === "/login" && M === "POST") {
    const b = await body();
    const quien = String(b.wa || "").trim();
    const u = quien.includes("@") ? await uno(env, "SELECT * FROM usuarios WHERE email=?", quien.toLowerCase()) : await uno(env, "SELECT * FROM usuarios WHERE wa=?", soloDig(quien));
    if (!u) return err("No hay cuenta con ese WhatsApp o correo.", 404);
    if (u.bloqueo > Date.now()) return err("Muchos intentos. Espera 15 minutos.", 429);
    if (!igual(await hashPass(String(b.pass || ""), u.sal), u.hash)) {
      const n = (u.intentos || 0) + 1;
      await run(env, "UPDATE usuarios SET intentos=?, bloqueo=? WHERE id=?", n >= 5 ? 0 : n, n >= 5 ? Date.now() + 15 * 6e4 : 0, u.id);
      return err("Contraseña incorrecta.", 401);
    }
    await run(env, "UPDATE usuarios SET intentos=0, bloqueo=0 WHERE id=?", u.id);
    return json({ ok: true, me: publico(u) }, 200, await crearSesion(env, u.id));
  }

  const u = await usuario(env, request);
  if (!u) return err("Entra a tu cuenta.", 401);

  if (ruta === "/logout" && M === "POST") {
    const m = (request.headers.get("cookie") || "").match(/cq=([0-9a-f]{48})/);
    if (m) await run(env, "DELETE FROM sesiones WHERE token=?", m[1]);
    return json({ ok: true }, 200, { "set-cookie": "cq=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax" });
  }
  if (ruta === "/me" && M === "GET") {
    const pend = await uno(env, "SELECT id, plan, monto, creado FROM pagos WHERE uid=? AND estado='pendiente' ORDER BY creado DESC", u.id);
    return json({ me: publico(u), pagoPendiente: pend || null });
  }
  if (ruta === "/state") {
    const k = "state/" + u.id + ".json";
    if (M === "GET") { const o = await leer(env, k); return o ? archivoResp(o) : json({ v: 0, data: {} }); }
    if (M === "PUT") {
      const t = await request.text();
      if (t.length > 15e6) return err("Tus datos son muy grandes para guardar (más de 15 MB).", 413);
      await guardar(env, k, t, "application/json");
      return json({ ok: true });
    }
  }
  if (ruta === "/perfil" && M === "POST") {
    const b = await body();
    const email = limpio(b.email, 254).toLowerCase();
    if (b.email !== undefined) { if (!emailOk(email)) return err("Escribe tu correo completo."); const otro = await uno(env, "SELECT id FROM usuarios WHERE email=? AND id<>?", email, u.id); if (otro) return err("Ese correo ya lo usa otra cuenta."); await run(env, "UPDATE usuarios SET email=? WHERE id=?", email, u.id); }
    if (b.tipo !== undefined && TIPOS[b.tipo]) await run(env, "UPDATE usuarios SET tipo=? WHERE id=?", b.tipo, u.id);
    if (b.pedido !== undefined && PLANES[b.pedido]) await run(env, "UPDATE usuarios SET plan_pedido=? WHERE id=?", b.pedido, u.id);
    return json({ ok: true, me: publico(await uno(env, "SELECT * FROM usuarios WHERE id=?", u.id)) });
  }
  if (ruta === "/ia/status") return json({ on: !!env.ANTHROPIC_API_KEY });
  if (ruta === "/ia" && M === "POST") return ia(env, u, await body());

  if (ruta === "/pago" && M === "POST") {
    const f = await request.formData();
    const plan = String(f.get("plan") || "");
    if (!PLANES[plan] || !PLANES[plan].precio) return err("Elige un plan para pagar.");
    const foto = f.get("foto");
    if (!foto || typeof foto === "string" || foto.size > 8e6) return err("Sube la foto del comprobante (máximo 8 MB).");
    const id = rid(8);
    await guardar(env, "comprobantes/" + id, await foto.arrayBuffer(), foto.type || "image/jpeg");
    await run(env, "INSERT INTO pagos VALUES (?,?,?,?,?,?,?,?,?)", id, u.id, plan, PLANES[plan].precio, "comprobantes/" + id, "pendiente", "", Date.now(), null);
    return json({ ok: true, id });
  }
  if (ruta === "/live/token" && M === "POST") {
    const t = rid(10);
    await run(env, "UPDATE usuarios SET live_token=? WHERE id=?", t, u.id);
    return json({ token: t });
  }
  if (ruta === "/live/feed" && M === "GET") {
    const since = Number(url.searchParams.get("since") || 0);
    const rows = since ? await todos(env, "SELECT id, ts, autor, texto FROM live WHERE uid=? AND id>? ORDER BY id LIMIT 200", u.id, since)
      : await todos(env, "SELECT id, ts, autor, texto FROM live WHERE uid=? ORDER BY id DESC LIMIT 1", u.id);
    return json({ items: rows, conectado: !!u.live_token });
  }

  /* ---------- panel del dueño ---------- */
  if (ruta.startsWith("/admin")) {
    if (!u.admin) return err("Solo el dueño de Cuantito.", 403);
    if (ruta === "/admin/resumen") {
      const usuarios = await todos(env, "SELECT id, wa, negocio, email, tipo, plan, plan_pedido, vence, usadas, ref, creado FROM usuarios ORDER BY creado DESC LIMIT 500");
      const pagos = await todos(env, "SELECT p.*, u.negocio, u.wa FROM pagos p JOIN usuarios u ON u.id=p.uid ORDER BY p.creado DESC LIMIT 200");
      const afiliados = await todos(env, "SELECT a.*, (SELECT COUNT(*) FROM usuarios WHERE ref=a.codigo) AS referidos, (SELECT COALESCE(SUM(monto),0) FROM comisiones WHERE codigo=a.codigo AND pagada=0) AS debe FROM afiliados a ORDER BY creado DESC");
      const ingresos = await uno(env, "SELECT COALESCE(SUM(monto),0) AS t FROM pagos WHERE estado='aprobado'");
      return json({ usuarios, pagos, afiliados, ingresos: ingresos.t, qr: await existe(env, "config/qr") });
    }
    const m = ruta.match(/^\/admin\/comprobante\/([0-9a-f]{16})$/);
    if (m) { const o = await leer(env, "comprobantes/" + m[1]); return o ? archivoResp(o) : err("No existe", 404); }
    if (ruta === "/admin/pago" && M === "POST") {
      const b = await body();
      const p = await uno(env, "SELECT * FROM pagos WHERE id=?", String(b.id));
      if (!p || p.estado !== "pendiente") return err("Ese pago ya fue revisado.");
      if (b.accion === "aprobar") {
        const c = await uno(env, "SELECT * FROM usuarios WHERE id=?", p.uid);
        const base = c.plan === p.plan ? Math.max(Date.now(), c.vence) : Date.now();
        const tipo = Object.keys(TIPOS).find((t) => TIPOS[t] === p.plan) || c.tipo;
        await run(env, "UPDATE usuarios SET plan=?, tipo=?, plan_pedido=NULL, vence=?, usadas=0, mes=? WHERE id=?", p.plan, tipo, base + PLANES[p.plan].dias * DIA, mesKey(), c.id);
        await run(env, "UPDATE pagos SET estado='aprobado', revisado=? WHERE id=?", Date.now(), p.id);
        if (c.ref) await run(env, "INSERT OR IGNORE INTO comisiones VALUES (?,?,?,?,?,0)", c.id, c.ref, AFILIADO_BS, p.id, Date.now());
      } else await run(env, "UPDATE pagos SET estado='rechazado', nota=?, revisado=? WHERE id=?", limpio(b.nota, 120), Date.now(), p.id);
      return json({ ok: true });
    }
    if (ruta === "/admin/afiliado" && M === "POST") {
      const b = await body();
      const codigo = limpio(b.codigo, 20).toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (codigo.length < 3) return err("El código necesita al menos 3 letras o números.");
      await run(env, "INSERT OR REPLACE INTO afiliados VALUES (?,?,?,?)", codigo, limpio(b.nombre, 40), soloDig(b.wa), Date.now());
      return json({ ok: true });
    }
    if (ruta === "/admin/comision-pagada" && M === "POST") { const b = await body(); await run(env, "UPDATE comisiones SET pagada=1 WHERE codigo=?", limpio(b.codigo, 20)); return json({ ok: true }); }
    if (ruta === "/admin/qr" && M === "POST") {
      const f = await request.formData(), foto = f.get("foto");
      if (!foto || typeof foto === "string" || foto.size > 5e6) return err("Sube la foto del QR (máximo 5 MB).");
      await guardar(env, "config/qr", await foto.arrayBuffer(), foto.type || "image/jpeg");
      return json({ ok: true });
    }
    if (ruta === "/admin/usuario" && M === "POST") {
      const b = await body();
      if (b.dias) await run(env, "UPDATE usuarios SET vence=MAX(vence, ?)+? WHERE id=?", Date.now(), Number(b.dias) * DIA, String(b.id));
      if (b.plan && PLANES[b.plan]) await run(env, "UPDATE usuarios SET plan=? WHERE id=?", b.plan, String(b.id));
      return json({ ok: true });
    }
  }
  return err("No encontrado", 404);
}
