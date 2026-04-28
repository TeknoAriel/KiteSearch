const DEFAULT_REST_URL = 'https://www.kiteprop.com/api/v1/properties';

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
    raw: item
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

function applyFilters(items, filters) {
  return items.filter((p) => {
    if (filters.q && !containsInsensitive(`${p.title} ${p.zone}`, filters.q)) return false;
    if (filters.op_type) {
      const op = pick(p.raw, ['op_type', 'operation_type', 'operation', 'operations.0.type'], '');
      if (!containsInsensitive(op, filters.op_type)) return false;
    }
    if (filters.type && !containsInsensitive(p.type, filters.type)) return false;
    if (filters.price_max && typeof p.price === 'number' && p.price > filters.price_max) return false;
    if (filters.bedrooms && typeof p.bedrooms === 'number' && p.bedrooms < filters.bedrooms) return false;
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

async function searchProperties(filters) {
  const rest = await searchFromRest(filters);
  if (rest.items.length > 0) return rest;
  const fallback = await searchFromStatic(filters);
  if (fallback.items.length > 0) return fallback;
  return rest;
}

module.exports = { searchProperties };
