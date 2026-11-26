# Cuantito (página + app instalable)

Cloudflare Pages + D1 (cuentas, pagos, live). Los archivos (datos de cada cuenta, comprobantes, QR) también se guardan en D1, sin R2.

## Publicar (Windows, desde esta carpeta)
```
npm install
npx wrangler login
npx wrangler d1 create cuantito            # ya hecho: el database_id está en wrangler.toml
npx wrangler pages project create cuantito --production-branch main
npm run deploy
```
La primera cuenta que se registre con el WhatsApp de ADMIN_WA (wrangler.toml) es la del dueño y ve el Panel del dueño (/admin).

IA opcional: `npx wrangler pages secret put ANTHROPIC_API_KEY --project-name cuantito`. Sin ella la app funciona en "Modo ejemplo" y todo lo demás anda.

## Lector del live
Carpeta `extension/` (también se descarga desde la página: /cuantito-live.zip). En Brave: brave://extensions › Modo desarrollador › Cargar descomprimida › elegir la carpeta `extension`.

`tools/build.py` arma `public/index.html` desde `../cuantito/app/index.html`. El zip ya trae `public/index.html` armado: `npm run deploy` publica tal cual.

## GitHub (se publica solo)
- Rama `main` → https://cuantito.pages.dev (la de los clientes).
- Rama `pruebas` → https://pruebas.cuantito.pages.dev (copia para probar, con base de datos aparte `cuantito-pruebas`).
Cada cambio que se guarda en GitHub se publica solo con `.github/workflows/publicar.yml`. Necesita en GitHub › Settings › Secrets and variables › Actions: `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID`.
`app/` es el código de la app; `npm run build` arma `public/index.html` desde ahí.
