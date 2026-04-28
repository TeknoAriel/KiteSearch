const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const { searchProperties } = require('./property-source');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const MCP_URL = process.env.KITEPROP_MCP_URL || 'https://mcp.kiteprop.com/mcp';
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.CHAT_TIMEOUT_MS || '25000', 10);

const SYSTEM_PROMPT = `Sos KiteSearch, el asistente inmobiliario inteligente de KiteProp.

PERSONALIDAD:
- Hablás en español rioplatense (vos, tenés, etc.)
- Sos cálido, directo y eficiente
- Usás emojis relevantes: 🏠🛏️💰📍✅

CAPACIDADES:
- Buscar propiedades por tipo, zona, precio, ambientes, amenities
- Dar análisis de precios de mercado por zona
- Mostrar detalles completos de propiedades
- Buscar en toda la red KiteProp

FORMATO DE RESPUESTA (para WhatsApp):
- Usá *texto* para negrita
- Máximo 3-4 propiedades por respuesta
- Para cada propiedad: tipo, zona, precio, ambientes
- Siempre terminá con una pregunta para continuar

Si no encontrás resultados exactos, sugerí alternativas cercanas.`;

function getMissingEnv() {
  const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'ANTHROPIC_API_KEY', 'KITEPROP_API_KEY'];
  return required.filter((key) => !process.env[key]);
}

function normalizeHistory(history) {
  return history
    .filter((item) => (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string' && item.content.trim())
    .map((item) => ({ role: item.role, content: item.content }));
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms))
  ]);
}

function extractFilters(message) {
  const text = String(message || '').toLowerCase();
  const bedroomsMatch = text.match(/(\d+)\s*(dorm|dormitorio|habit)/);
  const priceMatch = text.match(/(?:hasta|tope|max(?:imo)?)\s*\$?\s*([\d\.\,]+)/);
  const qWords = [];
  if (text.includes('rosario')) qWords.push('rosario');
  if (text.includes('caba')) qWords.push('caba');
  if (text.includes('buenos aires')) qWords.push('buenos aires');
  const q = qWords.join(' ').trim() || undefined;

  const normalizePrice = (raw) => {
    if (!raw) return undefined;
    const digits = raw.replace(/[^\d]/g, '');
    if (!digits) return undefined;
    const n = Number(digits);
    return Number.isFinite(n) ? n : undefined;
  };

  return {
    q,
    op_type: text.includes('alquiler') ? 'rental' : (text.includes('venta') ? 'sale' : undefined),
    type: text.includes('depto') || text.includes('departamento') ? 'apartments' : undefined,
    bedrooms: bedroomsMatch ? Number(bedroomsMatch[1]) : undefined,
    price_max: normalizePrice(priceMatch?.[1]),
    currency_id: 2,
    status: 'active',
    limit: 5
  };
}

function formatPropertiesReply(items) {
  const lines = ['Encontré estas opciones reales para tu búsqueda:'];
  items.slice(0, 4).forEach((p, i) => {
    const price = p.price != null ? `${p.currency || '$'}${p.price}` : 'consultar';
    lines.push(`${i + 1}. 🏠 *${p.type || 'Propiedad'}* en *${p.zone || 'zona no especificada'}*`);
    lines.push(`   💰 ${price} | 🛏️ ${p.bedrooms ?? 'N/D'} amb`);
    lines.push(`   🧾 ${p.title || 'Sin título'}`);
  });
  lines.push('');
  lines.push('¿Querés que filtre por otra zona, precio o cantidad de dormitorios?');
  return lines.join('\n');
}

async function getOrCreateUser(phone) {
  const { data, error } = await supabase.from('users').select('*').eq('phone', phone).single();
  if (error || !data) {
    const { data: u } = await supabase
      .from('users')
      .insert({ phone, search_count: 0, created_at: new Date().toISOString() })
      .select().single();
    return u;
  }
  return data;
}

async function incrementSearchCount(phone) {
  const { data: u } = await supabase.from('users').select('search_count').eq('phone', phone).single();
  const n = (u?.search_count || 0) + 1;
  await supabase.from('users').update({ search_count: n, last_search: new Date().toISOString() }).eq('phone', phone);
  return n;
}

async function getHistory(phone) {
  const { data } = await supabase
    .from('messages')
    .select('role, content')
    .eq('phone', phone)
    .order('created_at', { ascending: true })
    .limit(20);
  return data || [];
}

async function saveMessage(phone, role, content) {
  await supabase.from('messages').insert({ phone, role, content, created_at: new Date().toISOString() });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const missingEnv = getMissingEnv();
  if (missingEnv.length) {
    console.error('ERROR: Missing required env vars:', missingEnv.join(', '));
    return res.status(500).json({ error: 'Server misconfiguration', missingEnv });
  }

  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const { message, phone = 'demo-user' } = req.body;
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Message required' });
  }
  if (typeof phone !== 'string' || !phone.trim() || phone.length > 64) {
    return res.status(400).json({ error: 'Phone must be a non-empty string up to 64 chars' });
  }

  try {
    const user = await getOrCreateUser(phone);
    const FREE_LIMIT = parseInt(process.env.FREE_SEARCH_LIMIT || '5');

    if (user.search_count >= FREE_LIMIT && !user.premium) {
      return res.status(200).json({
        response: `⚠️ *Agotaste tus ${FREE_LIMIT} búsquedas gratuitas*\n\nPara seguir usando KiteSearch escribinos a hola@kiteprop.com 🏠`,
        limitReached: true
      });
    }

    const history = normalizeHistory(await getHistory(phone));
    await saveMessage(phone, 'user', message.trim());

    const extracted = extractFilters(message);
    if (extracted.op_type || extracted.q || extracted.type) {
      try {
        const direct = await searchProperties(extracted);
        if (direct.items.length > 0) {
          const directReply = formatPropertiesReply(direct.items);
          await saveMessage(phone, 'assistant', directReply);
          const newCount = await incrementSearchCount(phone);
          return res.status(200).json({
            response: directReply,
            source: direct.source,
            searchCount: newCount,
            searchLimit: FREE_LIMIT,
            remaining: Math.max(0, FREE_LIMIT - newCount)
          });
        }
      } catch (err) {
        console.error('Direct search fallback failed:', err?.message || err);
      }
    }

    const response = await withTimeout(
      anthropic.beta.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [...history, { role: 'user', content: message.trim() }],
        mcp_servers: [{
          type: 'url',
          url: MCP_URL,
          name: 'kiteprop',
          authorization_token: process.env.KITEPROP_API_KEY
        }],
        betas: ['mcp-client-2025-04-04']
      }),
      REQUEST_TIMEOUT_MS
    );

    const reply = (response.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    const safeReply = reply || 'No encontré una respuesta útil en este momento. ¿Querés que reformule la búsqueda con más detalle?';

    await saveMessage(phone, 'assistant', safeReply);
    const newCount = await incrementSearchCount(phone);

    return res.status(200).json({
      response: safeReply,
      searchCount: newCount,
      searchLimit: FREE_LIMIT,
      remaining: Math.max(0, FREE_LIMIT - newCount)
    });

  } catch (error) {
    const detail = error?.error?.message || error?.message || 'Unknown error';
    const requestId = error?.request_id || error?.error?.request_id || null;
    console.error('ERROR:', detail, requestId ? `request_id=${requestId}` : '');
    return res.status(500).json({ error: 'Error procesando tu consulta', detail, requestId });
  }
};
