// Surti Listing Forge — Keyword Backend
// Fetches REAL autocomplete keywords from Google, Amazon, Walmart
// Runs on a server, so no CORS issues (unlike browser)

export default async function handler(req, res) {
  // Allow your tool (any origin) to call this backend
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Get the search term from query (?q=duck dog treats)
  const query = (req.query.q || '').trim();

  if (!query) {
    return res.status(400).json({ error: 'Please provide a search term using ?q=your+product' });
  }

  // Fetch from all 3 sources in parallel
  const [google, amazon, walmart] = await Promise.all([
    fetchGoogle(query),
    fetchAmazon(query),
    fetchWalmart(query),
  ]);

  return res.status(200).json({
    query: query,
    google: google,
    amazon: amazon,
    walmart: walmart,
    fetchedAt: new Date().toISOString(),
  });
}

// ─── Google Suggest ───────────────────────────────
async function fetchGoogle(q) {
  try {
    const url = 'https://suggestqueries.google.com/complete/search?client=firefox&q=' + encodeURIComponent(q);
    const r = await fetch(url);
    const data = await r.json();
    if (data && data[1]) return data[1].slice(0, 10);
  } catch (e) {
    console.error('Google error:', e.message);
  }
  return [];
}

// ─── Amazon Autocomplete ──────────────────────────
async function fetchAmazon(q) {
  try {
    const url = 'https://completion.amazon.com/api/2017/suggestions?mid=ATVPDKIKX0DER&alias=aps&prefix=' + encodeURIComponent(q);
    const r = await fetch(url);
    const data = await r.json();
    if (data && data.suggestions) {
      return data.suggestions.map(s => s.value).filter(Boolean).slice(0, 10);
    }
  } catch (e) {
    console.error('Amazon error:', e.message);
  }
  return [];
}

// ─── Walmart Autocomplete ─────────────────────────
async function fetchWalmart(q) {
  try {
    const url = 'https://www.walmart.com/orchestra/snb/graphql/Browse/search?term=' + encodeURIComponent(q);
    // Walmart's simple typeahead endpoint
    const taUrl = 'https://www.walmart.com/typeahead/v2/complete?term=' + encodeURIComponent(q);
    const r = await fetch(taUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const data = await r.json();
    if (Array.isArray(data)) {
      return data.map(s => (typeof s === 'string' ? s : s.displayName || s.term || '')).filter(Boolean).slice(0, 10);
    }
    if (data && data.results) {
      return data.results.map(s => s.displayName || s.term || s).filter(Boolean).slice(0, 10);
    }
  } catch (e) {
    console.error('Walmart error:', e.message);
  }
  return [];
}
