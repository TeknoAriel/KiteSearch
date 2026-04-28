const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

  const { message, phone = 'demo-user' } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });

  try {
    const user = await getOrCreateUser(phone);
    const FREE_LIMIT = parseInt(process.env.FREE_SEARCH_LIMIT || '5');

    if (user.search_count >= FREE_LIMIT && !user.premium) {
      return res.status(200).json({
        response: `⚠️ *Agotaste tus ${FREE_LIMIT} búsquedas gratuitas*\n\nPara seguir usando KiteSearch escribinos a hola@kiteprop.com 🏠`,
        limitReached: true
      });
    }

    const history = await getHistory(phone);
    await saveMessage(phone, 'user', message);

    const response = await anthropic.beta.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [...history, { role: 'user', content: message }],
      mcp_servers: [{
        type: 'url',
        url: 'https://mcp.kiteprop.com/mcp',
        name: 'kiteprop',
        authorization_token: process.env.KITEPROP_API_KEY
      }],
      betas: ['mcp-client-2025-04-04']
    });

    const reply = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    await saveMessage(phone, 'assistant', reply);
    const newCount = await incrementSearchCount(phone);

    return res.status(200).json({
      response: reply,
      searchCount: newCount,
      searchLimit: FREE_LIMIT,
      remaining: Math.max(0, FREE_LIMIT - newCount)
    });

  } catch (error) {
    console.error('ERROR:', error.message);
    return res.status(500).json({ error: 'Error procesando tu consulta', detail: error.message });
  }
};
