const BASE_URL = 'https://www.kiteprop.com/api/v1/properties';
const TIMEOUT_MS = 10000;

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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.KITEPROP_API_KEY) {
    return res.status(500).json({ ok: false, error: 'Missing KITEPROP_API_KEY' });
  }

  try {
    const [all, rental, sale] = await Promise.all([
      getTotal(null),
      getTotal('rental'),
      getTotal('sale')
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
      }
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || 'Unknown error'
    });
  }
};
