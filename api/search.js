const { searchProperties } = require('./property-source');

function toNum(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.KITEPROP_API_KEY) {
    return res.status(500).json({ error: 'Missing KITEPROP_API_KEY' });
  }

  const filters = {
    q: req.query?.q || '',
    op_type: req.query?.op_type || '',
    type: req.query?.type || '',
    price_max: toNum(req.query?.price_max),
    bedrooms: toNum(req.query?.bedrooms),
    currency_id: toNum(req.query?.currency_id),
    status: req.query?.status || 'active',
    limit: toNum(req.query?.limit) || 15
  };

  try {
    const result = await searchProperties(filters);
    return res.status(200).json({
      ok: true,
      source: result.source,
      total: result.total,
      data: result.items.slice(0, filters.limit)
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || 'Unknown error' });
  }
};
