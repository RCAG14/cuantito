const st = document.getElementById("st"), cod = document.getElementById("cod");
chrome.storage.local.get(["servidor", "token"], (d) => { if (d.servidor && d.token) { cod.value = d.servidor + "#" + d.token; st.textContent = "Conectado a " + new URL(d.servidor).host; } });
document.getElementById("ok").onclick = () => {
  const m = cod.value.trim().match(/^(https:\/\/[\w.-]+)\/?#([0-9a-f]{20})$/);
  if (!m) { st.textContent = "Ese código no sirve. Cópialo de nuevo desde Cuantito."; return; }
  chrome.storage.local.set({ servidor: m[1], token: m[2] }, () => { st.textContent = "Listo. Recarga la página del live."; });
};
