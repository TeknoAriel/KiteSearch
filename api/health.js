module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'ANTHROPIC_API_KEY', 'KITEPROP_API_KEY'];
  const missingEnv = required.filter((key) => !process.env[key]);

  return res.status(missingEnv.length ? 500 : 200).json({
    ok: missingEnv.length === 0,
    service: 'kitesearch',
    timestamp: new Date().toISOString(),
    missingEnv
  });
};
