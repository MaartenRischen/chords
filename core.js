// Shared API core — used by both server.js (local Node) and worker.js
// (Cloudflare Worker behind the GitHub Pages frontend).
//
// How it works:
//   1. song(q) → iTunes Search API canonicalizes the query to artist/title
//      (or a picked suggestion skips that), then the Wayback CDX index is
//      queried with the exact UG URL prefix tab/<artist>/<song>-chords- to
//      recover real tab IDs (UG itself is Cloudflare-walled). Bing RSS is the
//      fallback.
//   2. UG's mobile API tab/info is open with signed app headers; one tab ID
//      returns the song's full version list with ratings AND chord content.
//      The highest-rated public (non-Pro) Chords version wins.

import crypto from 'node:crypto';

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Ultimate Guitar mobile API client
// ---------------------------------------------------------------------------

let UG_CLIENT_ID = null;
function ugClientId() {
  // lazy: Workers disallow generating random values at module scope
  if (!UG_CLIENT_ID) UG_CLIENT_ID = crypto.randomBytes(8).toString('hex');
  return UG_CLIENT_ID;
}

function ugApiKey() {
  // Key scheme used by the official mobile apps: md5(clientId + "YYYY-MM-DD:HH" + "createLog()")
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}:${pad(d.getUTCHours())}`;
  return crypto.createHash('md5').update(ugClientId() + stamp + 'createLog()').digest('hex');
}

async function ugTabInfo(tabId) {
  const url = `https://api.ultimate-guitar.com/api/v1/tab/info?tab_id=${tabId}&tab_access_type=public`;
  const res = await fetch(url, {
    headers: {
      'X-UG-CLIENT-ID': ugClientId(),
      'X-UG-API-KEY': ugApiKey(),
      'Accept-Charset': 'utf-8',
      'Accept': 'application/json',
      'User-Agent': 'UGT_ANDROID/4.11.1 (Pixel; Android 11)',
    },
  });
  if (!res.ok) throw new Error(`UG API ${res.status} for tab ${tabId}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Song discovery (iTunes → Wayback CDX, Bing RSS fallback)
// ---------------------------------------------------------------------------

function slugify(s) {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ'’`]/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, '')      // drop "(Live ...)" qualifiers
    .split(' - ')[0]
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export async function itunesSearch(query, limit) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=${limit * 3}`;
  const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(6000) });
  if (!res.ok) return [];
  const data = await res.json();
  const seen = new Set();
  const out = [];
  for (const r of data.results || []) {
    const key = slugify(r.artistName) + '/' + slugify(r.trackName);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ artist: r.artistName, title: r.trackName, art: r.artworkUrl60 || '' });
    if (out.length === limit) break;
  }
  return out;
}

async function deezerSearch(query, limit) {
  const url = `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=${limit * 3}`;
  const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(6000) });
  if (!res.ok) return [];
  const data = await res.json();
  const seen = new Set();
  const out = [];
  for (const r of data.data || []) {
    const key = slugify(r.artist?.name || '') + '/' + slugify(r.title || '');
    if (key === '/' || seen.has(key)) continue;
    seen.add(key);
    out.push({ artist: r.artist.name, title: r.title, art: r.album?.cover_small || '' });
    if (out.length === limit) break;
  }
  return out;
}

// iTunes rate-limits shared datacenter IPs (e.g. Cloudflare egress); Deezer
// is the fallback so suggestions keep working from the Worker.
export async function musicSearch(query, limit) {
  let r = await itunesSearch(query, limit).catch(() => []);
  if (!r.length) r = await deezerSearch(query, limit).catch(() => []);
  return r;
}

function artistSlugVariants(artist) {
  const variants = new Set();
  variants.add(slugify(artist));
  // "Bob Marley & The Wailers" → "bob-marley"; "X feat. Y" → "x"
  const lead = artist.split(/\s*(?:&|,|feat\.?|ft\.?|featuring)\s/i)[0];
  variants.add(slugify(lead));
  for (const v of [...variants]) {
    if (v.startsWith('the-')) variants.add(v.slice(4));
    else variants.add('the-' + v);
  }
  return [...variants].filter(Boolean);
}

async function cdxFindIds(songs) {
  for (const song of songs) {
    const songSlug = slugify(song.title);
    if (!songSlug) continue;
    for (const artistSlug of artistSlugVariants(song.artist)) {
      const cdxUrl =
        `http://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(
          `tabs.ultimate-guitar.com/tab/${artistSlug}/${songSlug}-chords-`
        )}&matchType=prefix&collapse=urlkey&fl=original&limit=50`;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch(cdxUrl, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(10000) });
          if (!res.ok) break;
          const text = await res.text();
          const ids = [...new Set([...text.matchAll(/-chords-(\d+)/g)].map((m) => Number(m[1])))];
          if (ids.length) return ids;
          break; // empty result is a real answer; try next variant
        } catch (e) {
          console.error(`[cdx] ${artistSlug}/${songSlug} (try ${attempt + 1}): ${e.message}`);
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    }
  }
  return [];
}

async function bingFindIds(query) {
  const variants = [
    `${query} chords site:tabs.ultimate-guitar.com`,
    `${query} chords ultimate guitar`,
  ];
  for (const v of variants) {
    const url = `https://www.bing.com/search?format=rss&count=30&q=${encodeURIComponent(v)}`;
    const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA } });
    if (!res.ok) continue;
    const xml = await res.text();
    const ids = [];
    const re = /tabs\.ultimate-guitar\.com\/tab\/[^<"\s]*?-(\d+)/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const id = Number(m[1]);
      if (!ids.includes(id)) ids.push(id);
    }
    if (ids.length) return ids;
  }
  return [];
}

// `picked` (optional {artist, title}) comes from a chosen search suggestion and
// skips the iTunes guess entirely.
async function findTabIds(query, picked) {
  const songs = picked ? [picked] : await musicSearch(query, 3).catch(() => []);
  const ids = await cdxFindIds(songs).catch((e) => {
    console.error(`[cdx] ${e.message}`);
    return [];
  });
  if (ids.length) return ids;
  const bingQuery = picked ? `${picked.artist} ${picked.title}` : query;
  return bingFindIds(bingQuery);
}

// ---------------------------------------------------------------------------
// Version selection
// ---------------------------------------------------------------------------

function versionSummary(v) {
  return {
    id: v.id,
    version: v.version,
    rating: Math.round((v.rating || 0) * 100) / 100,
    votes: v.votes || 0,
    type: v.type,
  };
}

// Bayesian-ish shrinkage so a 5.0 with 2 votes doesn't beat a 4.9 with 10k votes.
function score(v) {
  const PRIOR_RATING = 3.5, PRIOR_WEIGHT = 25;
  return ((v.rating || 0) * (v.votes || 0) + PRIOR_RATING * PRIOR_WEIGHT) / ((v.votes || 0) + PRIOR_WEIGHT);
}

function isUserChords(v) {
  return v.type === 'Chords' && v.tab_access_type === 'public';
}

function tabPayload(info, versions) {
  return {
    id: info.id,
    artist: info.artist_name,
    song: info.song_name,
    version: info.version,
    rating: Math.round((info.rating || 0) * 100) / 100,
    votes: info.votes,
    capo: info.capo || 0,
    tuning: info.tuning?.value || '',
    tonality: info.tonality_name || '',
    content: info.content || '',
    versions,
  };
}

// ---------------------------------------------------------------------------
// Public handlers (with a small in-memory cache)
// ---------------------------------------------------------------------------

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const cache = new Map();
const CACHE_TTL = 1000 * 60 * 30;

function cached(key, fn, skipEmpty = false) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL) return Promise.resolve(hit.v);
  return fn().then((v) => {
    if (!(skipEmpty && Array.isArray(v) && !v.length)) cache.set(key, { t: Date.now(), v });
    return v;
  });
}

export async function handleSong(query, picked) {
  const key = picked
    ? `song:${picked.artist.toLowerCase()}|${picked.title.toLowerCase()}`
    : `song:${query.toLowerCase()}`;
  return cached(key, async () => {
    const ids = await findTabIds(query, picked);
    const label = picked ? `${picked.artist} — ${picked.title}` : query;
    if (!ids.length) throw new HttpError(404, `No Ultimate Guitar results found for "${label}"`);

    // tab/info on any version returns the song's full version list.
    const seed = await ugTabInfo(ids[0]);
    const all = [seed, ...(seed.versions || [])];
    const candidates = all.filter(isUserChords);
    if (!candidates.length) {
      throw new HttpError(404, `Found "${seed.song_name}" by ${seed.artist_name}, but it has no user-submitted chord versions`);
    }
    candidates.sort((a, b) => score(b) - score(a));
    const best = candidates[0];
    const info = best.id === seed.id ? seed : await ugTabInfo(best.id);
    return tabPayload(info, candidates.map(versionSummary));
  });
}

export async function handleTab(id) {
  return cached(`tab:${id}`, async () => {
    const info = await ugTabInfo(id);
    return tabPayload(info, []);
  });
}

export function handleSuggest(q) {
  if (q.length < 2) return Promise.resolve([]);
  return cached(`suggest:${q.toLowerCase()}`, () => musicSearch(q, 8), true);
}

// Shared request router: returns {status, body} for /api/* paths, or null.
export async function apiRoute(pathname, params) {
  try {
    if (pathname === '/api/song') {
      const q = (params.get('q') || '').trim();
      const artist = (params.get('artist') || '').trim();
      const title = (params.get('title') || '').trim();
      const picked = artist && title ? { artist, title } : null;
      if (!q && !picked) return { status: 400, body: { error: 'Missing query' } };
      return { status: 200, body: await handleSong(q, picked) };
    }
    if (pathname === '/api/tab') {
      const id = Number(params.get('id'));
      if (!id) return { status: 400, body: { error: 'Missing tab id' } };
      return { status: 200, body: await handleTab(id) };
    }
    if (pathname === '/api/suggest') {
      const q = (params.get('q') || '').trim();
      return { status: 200, body: await handleSuggest(q) };
    }
    return null;
  } catch (err) {
    console.error(`[error] ${pathname}: ${err.message}`);
    return { status: err.status || 502, body: { error: err.message } };
  }
}
