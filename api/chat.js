const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const { searchProperties } = require('./property-source');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const MCP_URL = process.env.KITEPROP_MCP_URL || 'https://mcp.kiteprop.com/mcp';
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.CHAT_TIMEOUT_MS || '25000', 10);
const PROFILE_META_PREFIX = '__kitesearch_profile__:';
const SHOWN_META_PREFIX = '__kitesearch_shown_ids__:';
const CONTACT_PREF_META_PREFIX = '__kitesearch_contact_pref__:';

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
    .filter((item) =>
      (item.role === 'user' || item.role === 'assistant') &&
      typeof item.content === 'string' &&
      item.content.trim() &&
      !String(item.content).startsWith(PROFILE_META_PREFIX) &&
      !String(item.content).startsWith(SHOWN_META_PREFIX) &&
      !String(item.content).startsWith(CONTACT_PREF_META_PREFIX)
    )
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
  const compact = text.replace(/[\n\r,;]+/g, ' ').replace(/\s+/g, ' ').trim();
  const bedroomsMatch = text.match(/(\d+)\s*(dorm|dormitorio|habit)/);
  const ambientesMatch = text.match(/(\d+)\s*(amb|ambiente)/);
  const priceMatch = compact.match(/(?:hasta|tope|max(?:imo)?|de|por|presupuesto)\s*\$?\s*([\d\.\,]+)\s*(k|mil|m)?/i);
  const standalonePriceMatch = compact.match(/\b(\d{3,7})\s*(k|mil|m)\b/i) || compact.match(/\b(\d{5,9})\b/);
  const zoneMatch = compact.match(/zona\s+([a-záéíóúñ0-9 ]{3,40})/i);
  const enMatch = compact.match(/\ben\s+([a-záéíóúñ0-9 ]{3,40})/i);
  const rawLines = String(message || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const cityWords = [];
  const knownLocalities = [
    'rosario', 'funes', 'roldan', 'caba', 'buenos aires', 'cordoba', 'mendoza',
    'montevideo', 'punta del este', 'santiago', 'las condes', 'vitacura', 'nunoa'
  ];
  if (text.includes('rosario')) cityWords.push('rosario');
  if (text.includes('funes')) cityWords.push('funes');
  if (text.includes('caba')) cityWords.push('caba');
  if (text.includes('buenos aires')) cityWords.push('buenos aires');
  if (text.includes('cordoba')) cityWords.push('cordoba');
  if (text.includes('mendoza')) cityWords.push('mendoza');
  const isValidLocationPhrase = (v) => {
    const s = String(v || '').trim().toLowerCase();
    if (!s) return false;
    if (/(alquiler|venta|depto|departamento|casa|ph|oficina|terreno|presupuesto|dormitorio|ambiente)/i.test(s)) return false;
    if (/^\d+$/.test(s)) return false;
    return true;
  };

  if (zoneMatch && isValidLocationPhrase(zoneMatch[1])) cityWords.push(zoneMatch[1].trim());
  if (enMatch && isValidLocationPhrase(enMatch[1])) cityWords.push(enMatch[1].trim());
  if (cityWords.length === 0) {
    for (const line of rawLines) {
      const lowerLine = line.toLowerCase();
      const known = knownLocalities.find((loc) => lowerLine.includes(loc));
      if (known) {
        cityWords.push(known);
        break;
      }
      if (
        isValidLocationPhrase(lowerLine) &&
        !/(alquiler|venta|depto|departamento|casa|ph|oficina|terreno|presupuesto|dormitorio|ambiente|\d)/i.test(lowerLine)
      ) {
        cityWords.push(lowerLine);
        break;
      }
    }
  }
  const q = cityWords.join(' ').trim() || undefined;

  const normalizePrice = (raw, suffix) => {
    if (!raw) return undefined;
    const digits = raw.replace(/[^\d]/g, '');
    if (!digits) return undefined;
    let n = Number(digits);
    const s = String(suffix || '').toLowerCase();
    if (s === 'k' || s === 'mil') n *= 1000;
    if (s === 'm') n *= 1000000;
    return Number.isFinite(n) ? n : undefined;
  };
  const parsedBudget =
    normalizePrice(priceMatch?.[1], priceMatch?.[2]) ||
    normalizePrice(standalonePriceMatch?.[1], standalonePriceMatch?.[2]);

  const detectType = () => {
    if (/(depto|departamento)/i.test(text)) return 'apartments';
    if (/\bcasa(s)?\b/i.test(text)) return 'house';
    if (/\bph\b/i.test(text)) return 'ph';
    if (/(oficina|local|consultorio)/i.test(text)) return 'office';
    if (/(terreno|lote)/i.test(text)) return 'land';
    return undefined;
  };

  return {
    q,
    op_type: /(alquiler|alquilar|arriendo|arrendar|rent)/i.test(text) ? 'rental' : (/(venta|vender|sale)/i.test(text) ? 'sale' : undefined),
    type: detectType(),
    bedrooms: text.includes('monoambiente') ? 0 : (bedroomsMatch ? Number(bedroomsMatch[1]) : (ambientesMatch ? Math.max(0, Number(ambientesMatch[1]) - 1) : undefined)),
    price_max: parsedBudget,
    currency_id: 2,
    status: 'active',
    limit: 5
  };
}

function evaluateSearchReadiness(filters) {
  const missing = [];
  if (!filters?.op_type) missing.push('operacion');
  if (!filters?.q) missing.push('localidad_zona');
  if (!filters?.type) missing.push('tipo_propiedad');
  if (!filters?.price_max) missing.push('presupuesto');
  return missing;
}

function buildQualificationReply(missing, filters) {
  const labels = {
    operacion: 'operación (*alquiler* o *venta*)',
    localidad_zona: 'localidad y/o zona',
    tipo_propiedad: 'tipo de propiedad',
    presupuesto: 'presupuesto aproximado'
  };

  const missingText = missing.map((k) => `- ${labels[k]}`).join('\n');
  const base = [
    'Para que la búsqueda sea precisa en Argentina, Chile o Uruguay, necesito completar estos datos antes de buscar:',
    missingText,
    '',
    'Si querés, también sumemos *dormitorios/ambientes* para agilizar resultados.'
  ];

  if (filters?.op_type || filters?.type || filters?.price_max) {
    const quick = [
      '',
      'Con lo que ya me pasaste, podés responder así:',
      `"${filters?.type === 'house' ? 'casa' : 'depto'} ${filters?.op_type === 'sale' ? 'en venta' : 'en alquiler'} en [localidad] zona [barrio] ${filters?.price_max ? `hasta ${filters.price_max}` : ''} ${filters?.bedrooms ? `${filters.bedrooms} dormitorios` : ''}"`.replace(/\s+/g, ' ').trim()
    ];
    return [...base, ...quick].join('\n');
  }

  return base.join('\n');
}

function isSearchIntent(message, filters) {
  const text = String(message || '').toLowerCase().trim();
  const greetingOnly = /^(hola|buenas|buen día|buen dia|ok|dale|gracias)$/i.test(text);
  if (greetingOnly) return false;
  const hasFilter =
    Boolean(filters?.q) ||
    Boolean(filters?.type) ||
    Boolean(filters?.op_type) ||
    Boolean(filters?.bedrooms) ||
    Boolean(filters?.price_max);
  const searchVerb = /(busco|buscar|quiero|necesito|mostrame|mostrar|filtr|venta|alquiler|zona|dormitorio|ambiente)/i.test(text);
  return hasFilter || searchVerb;
}

function mergeFilters(base, next) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(next || {})) {
    if (value !== undefined && value !== null && value !== '') merged[key] = value;
  }
  return merged;
}

function extractProfileContext(text) {
  const lower = String(text || '').toLowerCase();
  const isAgency = /(inmobiliaria|soy de la inmobiliaria|somos de|corredora|broker inmobiliario)/i.test(lower);
  const agencyMatch =
    text.match(/inmobiliaria\s+([a-z0-9 .&-]{3,60})/i) ||
    text.match(/somos\s+de\s+([a-z0-9 .&-]{3,60})/i) ||
    text.match(/agencia\s+([a-z0-9 .&-]{3,60})/i);
  const phoneMatch = text.match(/(\+?\d[\d\s()-]{7,}\d)/);
  return {
    isAgency,
    agencyName: agencyMatch ? agencyMatch[1].trim() : undefined,
    agencyPhone: phoneMatch ? phoneMatch[1].replace(/\s+/g, ' ').trim() : undefined
  };
}

function buildConversationContext(history, message) {
  const userTexts = history
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .slice(-6);
  userTexts.push(message);

  let filters = { currency_id: 2, status: 'active', limit: 5 };
  let profile = { clientType: 'individual' };

  for (const text of userTexts) {
    filters = mergeFilters(filters, extractFilters(text));
    const extractedProfile = extractProfileContext(text);
    if (extractedProfile.isAgency) profile.clientType = 'agency';
    if (extractedProfile.agencyName) profile.agencyName = extractedProfile.agencyName;
    if (extractedProfile.agencyPhone) profile.agencyPhone = extractedProfile.agencyPhone;
  }

  return { filters, profile };
}

function readPersistedProfile(history) {
  const metadata = [...history]
    .reverse()
    .find((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.startsWith(PROFILE_META_PREFIX));
  if (!metadata) return null;

  try {
    const parsed = JSON.parse(metadata.content.slice(PROFILE_META_PREFIX.length));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      clientType: parsed.clientType === 'agency' ? 'agency' : 'individual',
      agencyName: parsed.agencyName || undefined,
      agencyPhone: parsed.agencyPhone || undefined
    };
  } catch {
    return null;
  }
}

function mergeProfile(base, override) {
  return {
    clientType: override?.clientType || base?.clientType || 'individual',
    agencyName: override?.agencyName || base?.agencyName,
    agencyPhone: override?.agencyPhone || base?.agencyPhone
  };
}

async function persistProfile(phone, profile) {
  const payload = {
    clientType: profile?.clientType === 'agency' ? 'agency' : 'individual',
    agencyName: profile?.agencyName || null,
    agencyPhone: profile?.agencyPhone || null
  };
  await saveMessage(phone, 'assistant', `${PROFILE_META_PREFIX}${JSON.stringify(payload)}`);
}

function readShownIds(history) {
  const metadata = [...history]
    .reverse()
    .find((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.startsWith(SHOWN_META_PREFIX));
  if (!metadata) return [];
  try {
    const parsed = JSON.parse(metadata.content.slice(SHOWN_META_PREFIX.length));
    return Array.isArray(parsed?.ids) ? parsed.ids.map(String) : [];
  } catch {
    return [];
  }
}

async function persistShownIds(phone, ids) {
  const unique = [...new Set((ids || []).map(String))].slice(-40);
  await saveMessage(phone, 'assistant', `${SHOWN_META_PREFIX}${JSON.stringify({ ids: unique })}`);
}

function readContactPreference(history) {
  const metadata = [...history]
    .reverse()
    .find((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.startsWith(CONTACT_PREF_META_PREFIX));
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata.content.slice(CONTACT_PREF_META_PREFIX.length));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed.preference === 'own' || parsed.preference === 'publisher' ? parsed.preference : null;
  } catch {
    return null;
  }
}

async function persistContactPreference(phone, preference) {
  if (preference !== 'own' && preference !== 'publisher') return;
  await saveMessage(phone, 'assistant', `${CONTACT_PREF_META_PREFIX}${JSON.stringify({ preference })}`);
}

function extractContactPreference(message) {
  const text = String(message || '').toLowerCase();
  if (/(mis datos|nuestros datos|datos propios|mi inmobiliaria|nuestro contacto)/i.test(text)) return 'own';
  if (/(publicante|de la inmobiliaria publicante|sus datos|datos de origen)/i.test(text)) return 'publisher';
  return null;
}

function isFichaIntent(message) {
  return /(enviar ficha|pasar ficha|compartir ficha|mandar ficha|armar ficha)/i.test(String(message || '').toLowerCase());
}

function isOwnStock(property, profile) {
  if (profile.clientType !== 'agency') return true;
  if (!profile.agencyName) return false;
  const owner = String(property.agencyName || '').toLowerCase();
  return owner.includes(String(profile.agencyName).toLowerCase());
}

function formatPropertiesReply(items, profile) {
  const typeLabel = (rawType) => {
    const type = String(rawType || '').toLowerCase();
    const map = {
      apartment: 'Departamento',
      apartments: 'Departamento',
      house: 'Casa',
      ph: 'PH',
      land: 'Terreno',
      office: 'Oficina',
      warehouse: 'Depósito',
      development_unit: 'Unidad en desarrollo'
    };
    return map[type] || 'Propiedad';
  };

  const roomsLabel = (bedrooms) => {
    if (typeof bedrooms !== 'number') return 'N/D';
    if (bedrooms <= 0) return 'Monoambiente';
    if (bedrooms === 1) return '1 dormitorio';
    return `${bedrooms} dormitorios`;
  };

  const lines = ['Encontré estas opciones reales para tu búsqueda:'];
  let hasExternalStock = false;
  let firstExternal = null;

  items.slice(0, 4).forEach((p, i) => {
    const price = p.price != null ? `${p.currency || '$'}${p.price}` : 'consultar';
    const own = isOwnStock(p, profile);
    if (!own) {
      hasExternalStock = true;
      if (!firstExternal) firstExternal = p;
    }
    lines.push(`${i + 1}. 🏠 *${typeLabel(p.type)}* en *${p.zone || 'zona no especificada'}*`);
    lines.push(`   💰 ${price} | 🛏️ ${roomsLabel(p.bedrooms)}`);
    lines.push(`   🧾 ${p.title || 'Sin título'}`);
    if (!own && p.agencyName) {
      lines.push(`   🤝 Publica: *${p.agencyName}*${p.agencyPhone ? ` (${p.agencyPhone})` : ''}`);
    }
  });

  if (profile.clientType === 'agency' && hasExternalStock && firstExternal) {
    lines.push('');
    lines.push('⚠️ Esta opción no es de stock propio.');
    if (firstExternal.agencyName) {
      lines.push(`Corresponde a *${firstExternal.agencyName}*${firstExternal.agencyPhone ? ` (${firstExternal.agencyPhone})` : ''}.`);
    }
    lines.push(`Si envío la ficha al cliente, ¿querés que ponga tus datos (${profile.agencyName || 'tu inmobiliaria'}${profile.agencyPhone ? ` - ${profile.agencyPhone}` : ''}) o los de la inmobiliaria publicante?`);
  }

  lines.push('');
  lines.push('¿Querés que siga afinando por zona, precio, dormitorios o amenities?');
  return lines.join('\n');
}

async function getOrCreateUser(phone) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('phone', phone)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!error && data) return data;

  const { data: inserted, error: insertError } = await supabase
    .from('users')
    .insert({ phone, search_count: 0, created_at: new Date().toISOString() })
    .select()
    .maybeSingle();

  if (!insertError && inserted) return inserted;

  const { data: fallback } = await supabase
    .from('users')
    .select('*')
    .eq('phone', phone)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (fallback) return fallback;

  return { phone, search_count: 0, premium: false };
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

    const rawHistory = await getHistory(phone);
    const history = normalizeHistory(rawHistory);
    await saveMessage(phone, 'user', message.trim());

    const context = buildConversationContext(history, message.trim());
    const extracted = context.filters;
    const persistedProfile = readPersistedProfile(rawHistory);
    const profile = mergeProfile(persistedProfile, context.profile);
    await persistProfile(phone, profile);
    const explicitPreference = extractContactPreference(message.trim());
    if (explicitPreference) {
      await persistContactPreference(phone, explicitPreference);
      const prefReply = explicitPreference === 'publisher'
        ? 'Perfecto, tomo *datos de la inmobiliaria publicante* para compartir fichas externas.'
        : 'Perfecto, tomo *tus datos de inmobiliaria* para compartir fichas.';
      await saveMessage(phone, 'assistant', prefReply);
      return res.status(200).json({ response: prefReply, profile, contactPreference: explicitPreference });
    }
    const contactPreference = explicitPreference || readContactPreference(rawHistory);
    const searchIntent = isSearchIntent(message.trim(), extracted);

    if (isFichaIntent(message.trim())) {
      const fichaReply = profile.clientType === 'agency'
        ? `Perfecto. Para enviar la ficha voy a usar *${contactPreference === 'publisher' ? 'los datos de la inmobiliaria publicante' : 'tus datos de inmobiliaria'}*.\n\nSi querés cambiarlo en cualquier momento, decime: "*usar mis datos*" o "*usar datos de la publicante*".`
        : 'Perfecto. Si querés, te preparo una ficha breve para WhatsApp con título, zona, precio, dormitorios y link.';
      await saveMessage(phone, 'assistant', fichaReply);
      return res.status(200).json({ response: fichaReply, profile, contactPreference: contactPreference || 'own' });
    }

    if (!searchIntent) {
      const softReply = '¡Dale! Contame qué querés ajustar (zona, tipo de propiedad, operación, precio o dormitorios) y te afino la búsqueda.';
      await saveMessage(phone, 'assistant', softReply);
      return res.status(200).json({ response: softReply, profile });
    }

    const missingCriteria = evaluateSearchReadiness(extracted);
    if (missingCriteria.length > 0) {
      const qualificationReply = buildQualificationReply(missingCriteria, extracted);
      await saveMessage(phone, 'assistant', qualificationReply);
      return res.status(200).json({
        response: qualificationReply,
        profile,
        pendingCriteria: missingCriteria
      });
    }

    if (searchIntent) {
      try {
        const direct = await searchProperties(extracted);
        if (direct.items.length > 0) {
          const seenIds = new Set(readShownIds(rawHistory));
          const freshItems = direct.items.filter((item) => item?.id && !seenIds.has(String(item.id)));
          const selectedItems = (freshItems.length > 0 ? freshItems : direct.items).slice(0, 4);
          const updatedShown = [...seenIds, ...selectedItems.map((item) => String(item.id)).filter(Boolean)];
          await persistShownIds(phone, updatedShown);

          const directReply = formatPropertiesReply(selectedItems, profile);
          await saveMessage(phone, 'assistant', directReply);
          const newCount = await incrementSearchCount(phone);
          return res.status(200).json({
            response: directReply,
            source: direct.source,
            profile,
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
        system: `${SYSTEM_PROMPT}

CONTEXTO DE CLIENTE:
- tipo_cliente: ${profile.clientType}
- inmobiliaria: ${profile.agencyName || 'no informada'}
- telefono_inmobiliaria: ${profile.agencyPhone || 'no informado'}

REGLA COMERCIAL:
- Si tipo_cliente es inmobiliaria y la propiedad no es stock propio, indicá inmobiliaria publicante y contacto.
- Si se va a enviar ficha al cliente final para una propiedad externa, preguntá si usar datos de la inmobiliaria del usuario o de la publicante.`,
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

    if (/Timeout after \d+ms/i.test(detail)) {
      return res.status(200).json({
        response: 'La búsqueda tardó demasiado y se cortó. ¿Querés que pruebe con un filtro más acotado (zona exacta + tipo + precio)?',
        transientError: 'timeout'
      });
    }

    if (/rate limit/i.test(detail)) {
      return res.status(200).json({
        response: 'Estamos con mucho tráfico en este momento. Probemos de nuevo en unos segundos o con una búsqueda más concreta.',
        transientError: 'rate_limit'
      });
    }

    return res.status(500).json({ error: 'Error procesando tu consulta', detail, requestId });
  }
};
