const { createClient } = require('@supabase/supabase-js');

const QUALITY_META_PREFIX = '__kitesearch_quality__:';
const TERM_MEMORY_META_PREFIX = '__kitesearch_term_memory__:';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { data, error } = await supabase
      .from('messages')
      .select('content, created_at')
      .eq('role', 'assistant')
      .order('created_at', { ascending: false })
      .limit(1000);
    if (error) throw error;

    const qualityRows = [];
    let latestTermMemory = {};
    for (const row of data || []) {
      const content = String(row.content || '');
      if (content.startsWith(QUALITY_META_PREFIX)) {
        try {
          qualityRows.push(JSON.parse(content.slice(QUALITY_META_PREFIX.length)));
        } catch {
          // Ignore malformed entries.
        }
      } else if (!Object.keys(latestTermMemory).length && content.startsWith(TERM_MEMORY_META_PREFIX)) {
        try {
          latestTermMemory = JSON.parse(content.slice(TERM_MEMORY_META_PREFIX.length));
        } catch {
          latestTermMemory = {};
        }
      }
    }

    const counts = qualityRows.reduce((acc, row) => {
      const stage = String(row.stage || 'unknown');
      acc[stage] = Number(acc[stage] || 0) + 1;
      return acc;
    }, {});

    const topTerms = Object.entries(latestTermMemory || {})
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, 20)
      .map(([term, score]) => ({ term, score }));

    return res.status(200).json({
      ok: true,
      totalEvents: qualityRows.length,
      byStage: counts,
      topTerms
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || 'search quality failed' });
  }
};
