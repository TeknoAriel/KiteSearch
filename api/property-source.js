const DEFAULT_REST_URL = 'https://www.kiteprop.com/api/v1/properties';
const DEFAULT_PROPIEYA_TRPC_URL = 'https://www.propieya.com/api/trpc/listing.search';
const { createClient } = require('@supabase/supabase-js');

const SNAPSHOT_PHONE = '__catalog_snapshot__';
const SNAPSHOT_ROLE = 'assistant';
const SNAPSHOT_PREFIX = '__catalog_snapshot_v1__:';
const SNAPSHOT_MAX_AGE_HOURS = Number.parseInt(process.env.CATALOG_SNAPSHOT_MAX_AGE_HOURS || '26', 10);

const hasSupabaseConfig = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
const supabase = hasSupabaseConfig ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY) : null;

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function pick(obj, paths, fallback = null) {
  for (const path of paths) {
    const parts = path.split('.');
    let current = obj;
    let found = true;
    for (const part of parts) {
      if (!current || !(part in current)) {
        found = false;
        break;
      }
      current = current[part];
    }
    if (found && current != null) return current;
  }
  return fallback;
}

function normalizeProperty(item) {
  return {
    id: pick(item, ['id', 'property_id', 'propertyId']),
    title: pick(item, ['title', 'publication_title', 'name'], 'Propiedad'),
    type: pick(item, ['type', 'property_type', 'propertyType'], 'N/D'),
    zone: pick(item, ['zone', 'location.short', 'city', 'address.locality', 'address.city'], 'N/D'),
    price: pick(item, ['price', 'price_value', 'prices.main', 'operations.0.price']),
    currency: pick(item, ['currency', 'currency_symbol', 'prices.currency', 'operations.0.currency'], ''),
    bedrooms: pick(item, ['bedrooms', 'rooms', 'room_amount', 'features.bedrooms']),
    agencyName: pick(item, ['agency_name', 'features.kitepropAgency.name', 'publisher.name']),
    agencyPhone: pick(item, ['agency_phone', 'features.kitepropAssignedContact.phone_whatsapp', 'features.kitepropAssignedContact.phone']),
    agencyContactName: pick(item, ['agency_contact_name', 'features.kitepropAssignedContact.full_name']),
    raw: item
  };
}

function compactProperty(item) {
  return {
    id: item.id,
    title: item.title,
    type: item.type,
    zone: item.zone,
    price: item.price,
    currency: item.currency,
    bedrooms: item.bedrooms,
    agencyName: item.agencyName,
    agencyPhone: item.agencyPhone,
    op_type: item.op_type || pick(item.raw, ['operationType', 'operation_type', 'operation', 'operations.0.type'], '')
  };
}

function parseFeedItems(feed) {
  if (Array.isArray(feed)) return feed;
  if (!feed || typeof feed !== 'object') return [];
  return normalizeArray(feed.data.length ? feed.data : feed.properties || feed.items || []);
}

function containsInsensitive(haystack, needle) {
  return String(haystack || '').toLowerCase().includes(String(needle || '').toLowerCase());
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function queryMatchesProperty(property, rawQuery) {
  const query = normalizeText(rawQuery).trim();
  if (!query) return true;
  const hay = normalizeText([
    property.title,
    property.zone,
    pick(property.raw, ['address.neighborhood', 'address.locality', 'address.city'], '')
  ].join(' '));
  if (hay.includes(query)) return true;
  const terms = query.split(/\s+/).filter((t) => t.length >= 3);
  if (terms.length === 0) return true;
  const matches = terms.filter((term) => hay.includes(term));
  const required = terms.length >= 3 ? 2 : 1;
  return matches.length >= required;
}

function applyFilters(items, filters) {
  const normalizeOperation = (value) => {
    const v = String(value || '').toLowerCase();
    if (!v) return '';
    if (/(rental|rent|alquiler|arriendo)/.test(v)) return 'rental';
    if (/(sale|venta)/.test(v)) return 'sale';
    return v;
  };
  const normalizeCurrency = (value) => {
    const v = String(value || '').toLowerCase();
    if (!v) return '';
    if (/(ars|peso)/.test(v)) return 'ARS';
    if (/(usd|u\$d|d[oó]lar)/.test(v)) return 'USD';
    return '';
  };
  const normalizedOp = normalizeOperation(filters.op_type);
  const normalizedType = filters.type === 'apartments' ? 'apartment' : filters.type;
  return items.filter((p) => {
    if (filters.q && !queryMatchesProperty(p, filters.q)) return false;
    if (normalizedOp) {
      const op = normalizeOperation(p.op_type || pick(p.raw, ['op_type', 'operation_type', 'operation', 'operations.0.type'], ''));
      if (!op || op !== normalizedOp) return false;
    }
    if (normalizedType && !containsInsensitive(p.type, normalizedType)) return false;
    if (filters.price_max && typeof p.price === 'number' && p.price > filters.price_max) return false;
    if (filters.currency_hint) {
      const itemCurrency = normalizeCurrency(p.currency || pick(p.raw, ['currency', 'priceCurrency', 'currency_id'], ''));
      const wantedCurrency = normalizeCurrency(filters.currency_hint);
      if (wantedCurrency && itemCurrency && itemCurrency !== wantedCurrency) return false;
    }
    if (filters.bedrooms && typeof p.bedrooms === 'number' && p.bedrooms < filters.bedrooms) return false;
    return true;
  });
}

function scoreByIntent(property, filters) {
  let score = 0;
  const pType = String(property.type || '').toLowerCase();
  const pZone = String(property.zone || '').toLowerCase();
  const pNeighborhood = String(pick(property.raw, ['address.neighborhood'], '') || '').toLowerCase();
  const pTitle = String(property.title || '').toLowerCase();
  const targetType = filters.type === 'apartments' ? 'apartment' : String(filters.type || '').toLowerCase();

  if (targetType) {
    if (pType === targetType) score += 100;
    else if (pType.includes(targetType)) score += 60;
    else score -= 40;
  }

  if (filters.q) {
    const q = String(filters.q).toLowerCase();
    if (pZone.includes(q)) score += 35;
    if (pNeighborhood.includes(q)) score += 45;
    if (pTitle.includes(q)) score += 20;
    const qTerms = q.split(/\s+/).filter(Boolean);
    qTerms.forEach((term) => {
      if (term.length >= 3 && (pZone.includes(term) || pNeighborhood.includes(term))) score += 8;
    });
  }

  if (filters.price_max && typeof property.price === 'number') {
    if (property.price <= filters.price_max) score += 15;
    else score -= 50;
  }

  return score;
}

function sortByIntent(items, filters) {
  return [...items].sort((a, b) => {
    const scoreDiff = scoreByIntent(b, filters) - scoreByIntent(a, filters);
    if (scoreDiff !== 0) return scoreDiff;

    const aPrice = typeof a.price === 'number' ? a.price : Number.POSITIVE_INFINITY;
    const bPrice = typeof b.price === 'number' ? b.price : Number.POSITIVE_INFINITY;
    return aPrice - bPrice;
  });
}

function dedupeListings(items) {
  const seen = new Set();
  return normalizeArray(items).filter((item) => {
    const key = [
      normalizeText(item.type),
      normalizeText(item.zone),
      normalizeText(item.title),
      Number(item.price || 0),
      normalizeText(item.currency),
      normalizeText(item.op_type || pick(item.raw, ['operationType', 'operation_type', 'operation'], ''))
    ].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function searchFromRest(filters) {
  const run = async (currentFilters) => {
    const params = new URLSearchParams({ limit: String(currentFilters.limit || 15) });
    for (const key of ['q', 'op_type', 'type', 'price_max', 'bedrooms', 'currency_id', 'status']) {
      if (currentFilters[key] !== undefined && currentFilters[key] !== null && currentFilters[key] !== '') {
        params.set(key, String(currentFilters[key]));
      }
    }
    const url = `${process.env.KITEPROP_REST_URL || DEFAULT_REST_URL}?${params.toString()}`;
    const response = await fetch(url, { headers: { 'x-api-key': process.env.KITEPROP_API_KEY || '' } });
    const text = await response.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }

    // KiteProp puede responder 500 con payload JSON de negocio; intentamos igualmente parsear data.
    const items = normalizeArray(json?.data).map(normalizeProperty);
    const total = Number(json?.pagination?.total || items.length);
    if (response.ok || items.length > 0 || total >= 0) {
      return { source: 'rest', items, total, status: response.status, rawError: json?.errorMessage || null };
    }
    throw new Error(`REST source error ${response.status}`);
  };

  try {
    const first = await run(filters);
    if (first.items.length > 0) return first;
    if (filters.status) {
      const retryFilters = { ...filters };
      delete retryFilters.status;
      const second = await run(retryFilters);
      return second;
    }
    return first;
  } catch (error) {
    if (filters.status) {
      const retryFilters = { ...filters };
      delete retryFilters.status;
      return run(retryFilters);
    }
    throw error;
  }
}

async function searchFromStatic(filters) {
  if (!process.env.STATIC_FEED_URL) return { source: 'static', items: [], total: 0 };
  const response = await fetch(process.env.STATIC_FEED_URL);
  if (!response.ok) throw new Error(`Static source error ${response.status}`);
  const json = await response.json();
  const items = parseFeedItems(json).map(normalizeProperty);
  const filtered = applyFilters(items, filters);
  return { source: 'static', items: filtered, total: filtered.length };
}

async function searchFromPropieYa(filters) {
  const payload = {};
  if (filters.q) payload.q = filters.q;
  if (filters.op_type) payload.operationType = filters.op_type === 'rental' ? 'rent' : (filters.op_type === 'sale' ? 'sale' : filters.op_type);
  if (filters.type) payload.propertyType = filters.type === 'apartments' ? 'apartment' : filters.type;

  const encoded = encodeURIComponent(JSON.stringify({ json: payload }));
  const url = `${process.env.PROPIEYA_TRPC_URL || DEFAULT_PROPIEYA_TRPC_URL}?input=${encoded}`;
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`PropieYa source error ${response.status}`);

  const json = await response.json();
  const data = json?.result?.data?.json || {};
  const rawItems = normalizeArray(data.items);
  const normalized = rawItems.map((item) => normalizeProperty({
    ...item,
    type: item.propertyType,
    city: item?.address?.city,
    zone: item?.address?.neighborhood,
    price: item.priceAmount,
    currency: item.priceCurrency,
    bedrooms: item.bedrooms,
    op_type: item.operationType
  }));
  const filtered = dedupeListings(sortByIntent(applyFilters(normalized, filters), filters));
  return { source: 'propieya_trpc', items: filtered, total: Number(data.total || filtered.length) };
}

async function readCatalogSnapshot() {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('messages')
    .select('content, created_at')
    .eq('phone', SNAPSHOT_PHONE)
    .eq('role', SNAPSHOT_ROLE)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data?.content || !String(data.content).startsWith(SNAPSHOT_PREFIX)) return null;
  try {
    const parsed = JSON.parse(String(data.content).slice(SNAPSHOT_PREFIX.length));
    const generatedAt = new Date(parsed.generatedAt || data.created_at);
    if (Number.isNaN(generatedAt.getTime())) return null;
    const ageMs = Date.now() - generatedAt.getTime();
    if (ageMs > SNAPSHOT_MAX_AGE_HOURS * 60 * 60 * 1000) return null;
    return {
      generatedAt: generatedAt.toISOString(),
      items: normalizeArray(parsed.items).map((item) => ({
        ...item,
        raw: item.raw || {}
      }))
    };
  } catch {
    return null;
  }
}

async function searchFromSnapshot(filters) {
  const snapshot = await readCatalogSnapshot();
  if (!snapshot || snapshot.items.length === 0) {
    return { source: 'snapshot_cache', items: [], total: 0, generatedAt: null };
  }
  const filtered = dedupeListings(sortByIntent(applyFilters(snapshot.items, filters), filters));
  return {
    source: 'snapshot_cache',
    items: filtered,
    total: filtered.length,
    generatedAt: snapshot.generatedAt
  };
}

async function syncCatalogSnapshot() {
  if (!supabase) throw new Error('Missing Supabase config');
  const syncLimit = Number.parseInt(process.env.CATALOG_SNAPSHOT_SYNC_LIMIT || '1500', 10);
  const bucket = [];
  let source = 'rest+propieya';

  try {
    const rest = await searchFromRest({ limit: syncLimit, status: 'active' });
    bucket.push(...normalizeArray(rest.items));
    source = rest.source;
  } catch {
    // Continue with PropieYa if REST is unavailable.
  }

  const presets = [
    { op_type: 'rental', type: 'apartments', q: 'rosario' },
    { op_type: 'rental', type: 'house', q: 'funes' },
    { op_type: 'rental', type: 'apartments', q: 'funes' },
    { op_type: 'sale', type: 'apartments', q: 'rosario' },
    { op_type: 'sale', type: 'house', q: 'rosario' },
    { op_type: 'sale', type: 'apartments', q: 'funes' },
    { op_type: 'rental', type: 'apartments', q: 'centro' },
    { op_type: 'sale', type: 'apartments', q: 'centro' }
  ];
  for (const preset of presets) {
    try {
      const r = await searchFromPropieYa({ ...preset, limit: Math.min(50, syncLimit) });
      bucket.push(...normalizeArray(r.items));
      source = source.includes('propieya') ? source : `${source}+propieya`;
    } catch {
      // Keep collecting from other presets.
    }
  }

  const compactItems = dedupeListings(bucket).map(compactProperty);
  if (!compactItems.length) throw new Error('No live data available for snapshot');
  const payload = {
    generatedAt: new Date().toISOString(),
    source,
    total: compactItems.length,
    items: compactItems
  };
  const { error } = await supabase.from('messages').insert({
    phone: SNAPSHOT_PHONE,
    role: SNAPSHOT_ROLE,
    content: `${SNAPSHOT_PREFIX}${JSON.stringify(payload)}`,
    created_at: new Date().toISOString()
  });
  if (error) throw error;
  return {
    ok: true,
    source,
    total: compactItems.length,
    generatedAt: payload.generatedAt
  };
}

async function searchProperties(filters) {
  try {
    const snapshot = await searchFromSnapshot(filters);
    if (snapshot.items.length > 0) return snapshot;
  } catch {
    // Ignore snapshot read issues and continue with live sources.
  }

  try {
    const propieya = await searchFromPropieYa(filters);
    if (propieya.items.length > 0) return propieya;
  } catch {
    // Ignore and continue with secondary sources.
  }

  const rest = await searchFromRest(filters);
  if (rest.items.length > 0) return rest;
  const fallback = await searchFromStatic(filters);
  if (fallback.items.length > 0) return fallback;
  return rest;
}

module.exports = { searchProperties, syncCatalogSnapshot };
