# KiteSearch

Asistente inmobiliario para web y WhatsApp: Vercel Functions, Supabase y API KiteProp.

Listado completo de variables y checklist Meta/WhatsApp: ver **`REGlas_Y_ENV.txt`** en la raíz del repo.

## Requisitos

- Node.js 18+
- Proyecto Vercel vinculado

### Variables obligatorias

- `KITEPROP_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

### Opcionales (frecuentes)

- `FREE_SEARCH_LIMIT` (ej. `5`)
- `KITESEARCH_SNAPSHOT_FIRST` (`1` para priorizar snapshot en Supabase)
- WhatsApp: `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` (ver `REGlas_Y_ENV.txt`)

## Desarrollo local

```bash
npm install
vercel link --project kite-search --yes
vercel env pull .env.local --environment=production --yes
set -a && source .env.local && set +a
```

Prueba rápida:

```bash
npm run test:smoke
```

## Endpoints

- `POST /api/chat` — consulta al asistente (JSON: `response`, y `suggestions` con `previewImages` si hay resultados)
- `GET /api/health` — salud y env faltantes; incluye `whatsapp.configured`
- `GET/POST /api/whatsapp-webhook` — verificación y eventos de WhatsApp Cloud API (Meta)

## Deploy

```bash
git add -A
git commit -m "tu mensaje"
git push origin main
```

Producción típica: `https://kitesearch.vercel.app` (ajustar según tu proyecto Vercel).
