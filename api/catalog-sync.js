const { syncCatalogSnapshot } = require('./property-source');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const expectedToken = process.env.CATALOG_SYNC_TOKEN || '';
  if (expectedToken) {
    const auth = req.headers.authorization || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
    const queryToken = req.query?.token || '';
    const provided = bearer || queryToken;
    if (!provided || provided !== expectedToken) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    const result = await syncCatalogSnapshot();
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || 'Snapshot sync failed' });
  }
};
