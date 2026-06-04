// Surti Listing Forge — Keyword Backend (v2 - Smart)
// Fetches REAL autocomplete keywords from Google, Amazon, Walmart
// Tries full term first, then core words for more results

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const query = (req.query.q || '').trim();
  if (!query) {
    return res.status(400).json({ error: 'Please provide a search term using ?q=your+product' });
  }

  // Build smart search variants:
  // 1. Full term  2. First 4 words  3. First 2-3 "core" words
  const words = query.split(/\s+/).filter(Boolean);
  const variants = [];
  variants.push(query);                              // full
  if (words.length > 4) variants.push(words.slice(0, 4).join(' '));  // first 4
  if (words.length > 2) variants.push(words.slice(0, 3).join(' '));  // first 3
  if (words.length > 1) variants.push(words.slice(0, 2).join(' '));  // first 2
  // Dedupe variants
  const uniqVariants = [...new Set(variants)];

  // Fetch all sources across all variants, merge + dedupe
  const [google, amazon, walmart] = await Promise.all([
    fetchMultiple(uniqVariants, fetchGoogle),
    fetchMultiple(uniqVariants, fetchAmazon),
    fetchMultiple(uniqVariants, fetchWalmart),
  ]);

  return res.status(200).json({
    query: query,
    variantsTried: uniqVariants,
    google: google,
    amazon: amazon,
    walmart: walmart,
    fetchedAt: new Date().toISOString(),
  });
}

// Run a fetcher across multiple variants, merge unique results up to 10
async function fetchMultiple(variants, fetcher) {
  const seen = new Set();
  const merged = [];
  for (const v of variants) {
    if (merged.length >= 10) break;
    try {
      const results = await fetcher(v);
      for (const kw of results) {
        const key = kw.toLowerCase().trim();
        if (key.length > 2 && !seen.has(key)) {
          seen.add(key);
          merged.push(kw);
          if (merged.length >= 10) break;
        }
      }
    } catch (e) { /* skip */ }
  }
  return merged;
}

// ─── Google Suggest ───────────────────────────────
async function fetchGoogle(q) {
  try {
    const url = 'https://suggestqueries.google.com/complete/search?client=firefox&q=' + encodeURIComponent(q);
    const r = await fetch(url);
    const data = await r.json();
    if (data && data[1]) return data[1];
  } catch (e) {
    console.error('Google error:', e.message);
  }
  return [];
}

// ─── Amazon Autocomplete ──────────────────────────
async function fetchAmazon(q) {
  try {
    const url = 'https://completion.amazon.com/api/2017/suggestions?mid=ATVPDKIKX0DER&alias=aps&prefix=' + encodeURIComponent(q);
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const data = await r.json();
    if (data && data.suggestions) {
      return data.suggestions.map(s => s.value).filter(Boolean);
    }
  } catch (e) {
    console.error('Amazon error:', e.message);
  }
  return [];
}

// ─── Walmart Autocomplete ─────────────────────────
async function fetchWalmart(q) {
  // Try multiple Walmart endpoints
  const endpoints = [
    'https://www.walmart.com/typeahead/v2/complete?term=' + encodeURIComponent(q),
    'https://search.walmart.com/typeahead?term=' + encodeURIComponent(q),
  ];
  for (const url of endpoints) {
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          'Accept': 'application/json',
        }
      });
      const data = await r.json();
      if (Array.isArray(data)) {
        const out = data.map(s => (typeof s === 'string' ? s : s.displayName || s.term || s.query || '')).filter(Boolean);
        if (out.length > 0) return out;
      }
      if (data && data.results) {
        const out = data.results.map(s => s.displayName || s.term || s).filter(Boolean);
        if (out.length > 0) return out;
      }
      if (data && data.data && data.data.search) {
        const out = data.data.search.map(s => s.suggestion || s.term || '').filter(Boolean);
        if (out.length > 0) return out;
      }
    } catch (e) { /* try next */ }
  }
  return [];
}
