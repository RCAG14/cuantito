"""Arma public/index.html desde la app de Cuantito (cuantito/app/index.html) con los cambios para la web propia."""
import pathlib, re, shutil, sys
raiz = pathlib.Path(__file__).resolve().parent.parent
src = raiz / "app" if (raiz / "app" / "index.html").exists() else raiz.parent / "cuantito" / "app"
html = (src / "index.html").read_text(encoding="utf-8")

def cambiar(viejo, nuevo, n=1):
    global html
    if html.count(viejo) != n:
        sys.exit(f"No encontré exactamente {n} vez/veces: {viejo[:70]!r} (hay {html.count(viejo)})")
    html = html.replace(viejo, nuevo)

# 1) registro: crea la cuenta real en el servidor
cambiar('if (w.replace(/\\D/g, "").length < 7) { g("rgE").textContent = "Escribe tu número de WhatsApp (mínimo 7 dígitos)."; g("rgW").focus(); return; }',
        'if (w.replace(/\\D/g, "").length < 7) { g("rgE").textContent = "Escribe tu número de WhatsApp (mínimo 7 dígitos)."; g("rgW").focus(); return; }\n    if (window.cloudReg && !window.cloudReg(n, w, planSel)) { cerrar(); return; }')

cambiar('  function abrirReg(p) {\n', '  function abrirReg(p) {\n    if (window.cloudAbrirReg) { window.cloudAbrirReg(p); return; }\n')

# 2) TikTok LIVE real: los comentarios llegan del lector (extensión) a window.__ttQ
i = html.index("function leerMio(txt, libres) {"); j = html.index("function ttAceptar(s, conPrecio) {")
html = html[:i] + r'''function leerMio(txt, libres) {
  const t = String(txt).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (!/(^|[^a-z])(mi+o+|mia|yo|lo quiero|la quiero|me lo llevo|me la llevo|aparta(me)?|separa(me)?)([^a-z]|$)/.test(t)) return null;
  const r = t.match(/(?:#|\bel\s+|\bnro\.?\s*|\bnumero\s+)(\d{1,3})\b/);
  const it = r ? libres.find((i) => i.n === Number(r[1])) : libres[0];
  if (!it) return null;
  const sinNum = r ? t.replace(r[0], " ") : t;
  const p = sinNum.match(/(\d{1,5}(?:[.,]\d{1,2})?)/);
  return { it, precio: p ? Number(p[1].replace(",", ".")) : null };
}
function ttTick() {
  if (!TT.on) return;
  const q = (window.__ttQ || []).splice(0);
  for (const [u0, txt] of q) {
    TT.leidos++;
    const u = String(u0 || "?").replace(/^@/, "");
    const libres = LIVE.items.filter((i) => i.st === "libre" && !TT.sugs.some((s) => s.itId === i.id)).sort((a, b) => a.n - b.n);
    const r = leerMio(txt, libres);
    if (r && !TT.sugs.some((s) => s.u === u && s.itId === r.it.id)) { TT.sugs.unshift({ id: uid(), u, txt, itId: r.it.id, precio: r.precio }); TT.sugs.length = Math.min(TT.sugs.length, 8); haptic(); }
  }
  if (q.length && cur === "live") renderTT();
}
''' + html[j:]
cambiar('const TT = { user: store.get("tt.user", ""), on: false, leidos: 0, sugs: [], timer: null, k: 0 };', 'const TT = { user: store.get("tt.user", ""), on: false, leidos: 0, sugs: [], timer: null, k: 0 }; window.__TT = TT;')
cambiar('TT.timer = setInterval(ttTick, RM.matches ? 2500 : 3200);', 'TT.timer = setInterval(ttTick, 1000);')
cambiar('toast("Conectado (simulación). Mira los comentarios");', 'toast("Conectado. Abre tu live en la compu con el lector de Cuantito");')
cambiar('h("span", { class: "pill warn", text: "Simulación" })', 'h("span", { class: "pill ok", text: "En vivo" })')
cambiar('text: "Conecta tu cuenta y la app lee los comentarios del live. Cuando alguien escribe «mío» o «mío 80», te aparece aquí con su usuario y su precio, y lo apartas con un toque."',
        'text: "Pon tu usuario y toca Conectar. En tu compu abre el live con el lector de Cuantito (Cuenta › Conectar lector del live). Cuando alguien escribe «mío», «mío 80» o «yo 150», te aparece aquí con su nombre y su precio, y lo apartas con un toque."')

# 3) cabecera de página web + app instalable
cab = '''<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0f7a43">
<meta name="description" content="Cuantito: antes de pagar, pregúntale a Cuantito. Cotiza con foto el precio justo de lo que vendes.">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icons/icon-192.png">
<link rel="apple-touch-icon" href="/icons/icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<script src="/cloud.js"></script>
'''
html = html.replace('<meta name="claude:viewport-fit-sides" content="cover">\n', '')
i = html.index("</style>") + len("</style>")
html = cab + html[:i] + "\n</head>\n<body>\n" + html[i:] + "\n</body>\n</html>\n"

pub = raiz / "public"
(pub / "index.html").write_text(html, encoding="utf-8")
if (pub / "img").exists(): shutil.rmtree(pub / "img")
shutil.copytree(src / "img", pub / "img")
print("public/index.html listo:", len(html), "bytes")
