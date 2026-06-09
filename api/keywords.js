// Surti Listing Forge — Keyword Backend (v3 - with eBay Browse API)
// Real keywords from Google, Amazon, Walmart + eBay real listings & competitor data
// eBay keys are read from environment variables (never hardcoded)

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

  // Build smart search variants for autocomplete sources
  const words = query.split(/\s+/).filter(Boolean);
  const variants = [];
  variants.push(query);
  if (words.length > 4) variants.push(words.slice(0, 4).join(' '));
  if (words.length > 2) variants.push(words.slice(0, 3).join(' '));
  if (words.length > 1) variants.push(words.slice(0, 2).join(' '));
  const uniqVariants = [...new Set(variants)];

  // Fetch everything in parallel
  const [google, amazon, walmart, ebayData] = await Promise.all([
    fetchMultiple(uniqVariants, fetchGoogle),
    fetchMultiple(uniqVariants, fetchAmazon),
    fetchMultiple(uniqVariants, fetchWalmart),
    fetchEbay(query),
  ]);

  return res.status(200).json({
    query: query,
    variantsTried: uniqVariants,
    google: google,
    amazon: amazon,
    walmart: walmart,
    ebay: ebayData.keywords,
    competitors: ebayData.competitors,
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
  } catch (e) { console.error('Google error:', e.message); }
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
  } catch (e) { console.error('Amazon error:', e.message); }
  return [];
}

// ─── Walmart Autocomplete ─────────────────────────
async function fetchWalmart(q) {
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
    } catch (e) { /* try next */ }
  }
  return [];
}

// ─── eBay Browse API ──────────────────────────────
// Gets a token using App ID + Cert ID, then searches real listings.
// Extracts keywords from real titles + returns competitor data.
async function fetchEbay(q) {
  const result = { keywords: [], competitors: [] };
  try {
    const appId = process.env.EBAY_APP_ID;
    const certId = process.env.EBAY_CERT_ID;
    if (!appId || !certId) {
      console.error('eBay keys not set in environment');
      return result;
    }

    // Step 1: Get OAuth token (client credentials flow)
    const credentials = Buffer.from(appId + ':' + certId).toString('base64');
    const tokenRes = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + credentials,
      },
      body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
    });
    const tokenData = await tokenRes.json();
    const token = tokenData.access_token;
    if (!token) {
      console.error('eBay token failed:', JSON.stringify(tokenData));
      return result;
    }

    // Step 2: Search real listings with Browse API
    const searchRes = await fetch(
      'https://api.ebay.com/buy/browse/v1/item_summary/search?q=' + encodeURIComponent(q) + '&limit=20',
      {
        headers: {
          'Authorization': 'Bearer ' + token,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        },
      }
    );
    const searchData = await searchRes.json();
    const items = searchData.itemSummaries || [];

    // Extract competitor data (top 6 real listings)
    result.competitors = items.slice(0, 6).map(item => ({
      title: item.title || '',
      price: item.price ? (item.price.value + ' ' + item.price.currency) : 'N/A',
      condition: item.condition || 'N/A',
      seller: item.seller ? item.seller.username : 'N/A',
    }));

    // Extract keywords from real titles
    // Count word frequency across all titles, pick the most common meaningful phrases
    const titles = items.map(i => (i.title || '').toLowerCase());
    const stopWords = new Set(['the','for','and','with','new','a','an','of','to','in','on','x','pcs','pc','set','pack','us','free','ship','shipping','lot','size','color','oem']);
    const wordFreq = {};
    titles.forEach(t => {
      const cleaned = t.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
      // Build 2-word and 3-word phrases
      for (let i = 0; i < cleaned.length; i++) {
        if (cleaned[i].length < 3 || stopWords.has(cleaned[i])) continue;
        // single meaningful words
        wordFreq[cleaned[i]] = (wordFreq[cleaned[i]] || 0) + 1;
        // 2-word phrase
        if (i + 1 < cleaned.length && !stopWords.has(cleaned[i+1]) && cleaned[i+1].length > 2) {
          const ph2 = cleaned[i] + ' ' + cleaned[i+1];
          wordFreq[ph2] = (wordFreq[ph2] || 0) + 2; // weight phrases higher
        }
      }
    });
    // Sort by frequency, prefer multi-word phrases
    const sorted = Object.keys(wordFreq)
      .filter(k => wordFreq[k] >= 2) // appears at least twice
      .sort((a, b) => {
        const aw = a.split(' ').length, bw = b.split(' ').length;
        if (wordFreq[b] !== wordFreq[a]) return wordFreq[b] - wordFreq[a];
        return bw - aw; // prefer longer phrases
      });
    result.keywords = sorted.slice(0, 10);
  } catch (e) {
    console.error('eBay error:', e.message);
  }
  return result;
}
