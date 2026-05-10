const BASE_URL = 'https://www.kiteprop.com/api/v1/properties';
const TIMEOUT_MS = 10000;
const SNAPSHOT_PHONE = '__catalog_snapshot__';
const SNAPSHOT_ROLE = 'assistant';
const SNAPSHOT_PREFIX = '__catalog_snapshot_v1__:';
const { createClient } = require('@supabase/supabase-js');
const hasSupabase = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
const supabase = hasSupabase ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY) : null;

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getTotal(opType) {
  const params = new URLSearchParams({ limit: '15' });
  if (opType) params.set('op_type', opType);
  const url = `${BASE_URL}?${params.toString()}`;
  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        'x-api-key': process.env.KITEPROP_API_KEY
      }
    },
    TIMEOUT_MS
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`KiteProp API error ${response.status}: ${body}`);
  }

  const json = await response.json();
  return {
    total: Number(json?.pagination?.total || 0),
    sampleCount: Array.isArray(json?.data) ? json.data.length : 0
  };
}

async function getPropieyaUniverseTotal() {
  const payload = { q: 'a' };
  const input = encodeURIComponent(JSON.stringify({ json: payload }));
  const url = `https://www.propieya.com/api/trpc/listing.search?input=${input}`;
  const response = await fetchWithTimeout(url, { headers: { accept: 'application/json' } }, TIMEOUT_MS);
  if (!response.ok) return null;
  const json = await response.json();
  const data = json?.result?.data?.json || {};
  return Number(data.total || 0);
}

async function getSnapshotMeta() {
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
    return {
      generatedAt: parsed.generatedAt || data.created_at,
      source: parsed.source || null,
      total: Number(parsed.total || (Array.isArray(parsed.items) ? parsed.items.length : 0))
    };
  } catch {
    return null;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.KITEPROP_API_KEY) {
    return res.status(500).json({ ok: false, error: 'Missing KITEPROP_API_KEY' });
  }

  try {
    const [all, rental, sale, snapshot, propieyaUniverseTotal] = await Promise.all([
      getTotal(null),
      getTotal('rental'),
      getTotal('sale'),
      getSnapshotMeta(),
      getPropieyaUniverseTotal()
    ]);

    return res.status(200).json({
      ok: true,
      timestamp: new Date().toISOString(),
      totals: {
        all: all.total,
        rental: rental.total,
        sale: sale.total
      },
      samples: {
        all: all.sampleCount,
        rental: rental.sampleCount,
        sale: sale.sampleCount
      },
      snapshot,
      propieyaUniverseTotal,
      snapshotCoveragePct: snapshot?.total && propieyaUniverseTotal
        ? Number(((snapshot.total / propieyaUniverseTotal) * 100).toFixed(2))
        : null
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || 'Unknown error'
    });
  }
};
