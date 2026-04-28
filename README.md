# KiteSearch

Asistente inmobiliario para web y WhatsApp basado en Vercel Functions, Supabase, Anthropic y MCP de KiteProp.

## Requisitos

- Node.js 18+
- Proyecto Vercel vinculado
- Variables de entorno:
  - `ANTHROPIC_API_KEY`
  - `KITEPROP_API_KEY`
  - `SUPABASE_URL`
  - `SUPABASE_ANON_KEY`
  - `FREE_SEARCH_LIMIT` (ej. `5`)
  - opcional: `ANTHROPIC_MODEL` (default `claude-sonnet-4-6`)
  - opcional: `KITEPROP_MCP_URL` (default `https://mcp.kiteprop.com/mcp`)
  - opcional: `CHAT_TIMEOUT_MS` (default `25000`)

## Desarrollo local

```bash
npm install
vercel link --project kite-search --yes
vercel env pull .env.local --environment=production --yes
set -a && source .env.local && set +a
```

Ejecutar prueba rápida del handler:

```bash
node -e "
const handler = require('./api/chat.js');
const req = { method: 'POST', body: { message: 'depto alquiler rosario', phone: 'test' } };
const res = {
  status: (c) => ({ json: (d) => console.log('STATUS:', c, JSON.stringify(d, null, 2)) }),
  setHeader: () => {},
  end: () => {}
};
handler(req, res).catch((e) => console.error('ERROR:', e.message));
"
```

## Endpoints

- `POST /api/chat` -> consulta al asistente
- `GET /api/health` -> chequeo de salud y variables requeridas

## Deploy

```bash
git add -A
git commit -m "feat: hardening de estabilidad"
git push origin main
```

El deploy de producción se publica en Vercel y queda accesible por `https://kitesearch.vercel.app`.
