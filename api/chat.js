import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SYSTEM_PROMPT = `Sos KiteSearch, el asistente inmobiliario inteligente de KiteProp. Tu misión es ayudar a las personas a encontrar propiedades en Argentina usando lenguaje natural, de forma clara, amigable y profesional.

PERSONALIDAD:
- Hablás en español rioplatense (vos, tenés, etc.)
- Sos cálido, directo y eficiente
- Nunca sos robótico ni genérico
- Siempre mostrás empatía con lo que el usuario busca

CAPACIDADES:
- Podés buscar propiedades por tipo, zona, precio, ambientes, amenities
- Podés dar análisis de precios de mercado por zona
- Podés mostrar detalles completos de una propiedad
- Podés buscar dentro de una inmobiliaria puntual o en toda la red KiteProp

FLUJO DE BÚSQUEDA:
1. Si el usuario describe lo que busca, usá search_properties con los parámetros que menciona
2. Mostrá los resultados de forma clara con emoji, negrita (con *asteriscos*) y saltos de línea
3. Ofrecé más información o búsquedas relacionadas
4. Si no encontrás resultados exactos, sugerí alternativas cercanas

FORMATO DE RESPUESTA:
- Usá *texto* para negrita
- Usá emojis relevantes (🏠🛏️💰📍✅)
- Máximo 3-4 propiedades por respuesta
- Para cada propiedad mostrá: tipo, zona, precio, ambientes
- Siempre terminá con una pregunta para continuar la conversación`;

async function getOrCreateUser(phoneNumber) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('phone', phoneNumber)
    .single();

  if (error || !data) {
    const { data: newUser } = await supabase
      .from('users')
      .insert({ phone: phoneNumber, search_count: 0, created_at: new Date().toISOString() })
      .select()
      .single();
    return newUser;
  }
  return data;
}

async function incrementSearchCount(phoneNumber) {
  const { data: user } = await supabase
    .from('users')
    .select('search_count')
    .eq('phone', phoneNumber)
    .single();

  const newCount = (user?.search_count || 0) + 1;
  await supabase
    .from('users')
    .update({ search_count: newCount, last_search: new Date().toISOString() })
    .eq('phone', phoneNumber);

  return newCount;
}

async function getConversationHistory(phoneNumber) {
  const { data } = await supabase
    .from('messages')
    .select('role, content')
    .eq('phone', phoneNumber)
    .order('created_at', { ascending: true })
    .limit(20);

  return data || [];
}

async function saveMessage(phoneNumber, role, content) {
  await supabase
    .from('messages')
    .insert({
      phone: phoneNumber,
      role,
      content,
      created_at: new Date().toISOString()
    });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { message, phone = 'demo-user' } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  try {
    const user = await getOrCreateUser(phone);
    const FREE_LIMIT = parseInt(process.env.FREE_SEARCH_LIMIT || '5');

    if (user.search_count >= FREE_LIMIT && !user.premium) {
      return res.status(200).json({
        response: `⚠️ *Agotaste tus ${FREE_LIMIT} búsquedas gratuitas*\n\nPara seguir usando KiteSearch activá tu cuenta premium.\n\n📩 Escribinos a hola@kiteprop.com`,
        limitReached: true
      });
    }

    const history = await getConversationHistory(phone);
    await saveMessage(phone, 'user', message);

    const messages = [
      ...history,
      { role: 'user', content: message }
    ];

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
      mcp_servers: [
        {
          type: 'url',
          url: 'https://mcp.kiteprop.com/mcp',
          name: 'kiteprop',
          authorization_token: process.env.KITEPROP_API_KEY
        }
      ]
    });

    const assistantMessage = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    await saveMessage(phone, 'assistant', assistantMessage);
    const newCount = await incrementSearchCount(phone);

    return res.status(200).json({
      response: assistantMessage,
      searchCount: newCount,
      searchLimit: FREE_LIMIT,
      remaining: Math.max(0, FREE_LIMIT - newCount)
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({
      error: 'Error procesando tu consulta',
      detail: error.message
    });
  }
}
