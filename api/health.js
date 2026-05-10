module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'KITEPROP_API_KEY'];
  const missingEnv = required.filter((key) => !process.env[key]);

  const whatsappReady = Boolean(
    process.env.WHATSAPP_VERIFY_TOKEN &&
      process.env.WHATSAPP_ACCESS_TOKEN &&
      process.env.WHATSAPP_PHONE_NUMBER_ID
  );

  return res.status(missingEnv.length ? 500 : 200).json({
    ok: missingEnv.length === 0,
    service: 'kitesearch',
    timestamp: new Date().toISOString(),
    missingEnv,
    whatsapp: {
      configured: whatsappReady,
      missingForWebhook: ['WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'].filter(
        (k) => !process.env[k]
      )
    }
  });
};
