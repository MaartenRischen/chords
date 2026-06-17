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

function ugHeaders() {
  return {
    'X-UG-CLIENT-ID': ugClientId(),
    'X-UG-API-KEY': ugApiKey(),
    'Accept-Charset': 'utf-8',
    'Accept': 'application/json',
    'User-Agent': 'UGT_ANDROID/4.11.1 (Pixel; Android 11)',
  };
}

function ugError(status, what) {
  // UG serves 451 (and sometimes 403/429) to datacenter IPs — incl. Cloudflare
  // Workers — for licensed catalogs (e.g. Michael Jackson), even when the tab is
  // public on the website. Callers treat this as a signal to fall back to the
  // Wayback archive. The status is preserved so they can tell blocks from 404s.
  const err = new Error(`UG API ${status} for ${what}`);
  err.status = status;
  return err;
}

async function ugTabInfo(tabId) {
  const url = `https://api.ultimate-guitar.com/api/v1/tab/info?tab_id=${tabId}&tab_access_type=public`;
  const res = await fetch(url, { headers: ugHeaders() });
  if (!res.ok) throw ugError(res.status, `tab ${tabId}`);
  return res.json();
}

// All tabs of a song across every type (Chords, Tabs, Bass, Ukulele, ...).
async function ugSongTabs(songId) {
  const url = `https://api.ultimate-guitar.com/api/v1/song/tabs?song_id=${songId}`;
  const res = await fetch(url, { headers: ugHeaders() });
  if (!res.ok) throw ugError(res.status, `song ${songId}`);
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

// Query iTunes and Deezer in parallel and interleave the results — they rank
// differently, so the union surfaces songs either would bury (and it keeps
// suggestions alive when iTunes rate-limits shared datacenter IPs).
export async function musicSearch(query, limit) {
  const [it, dz] = await Promise.all([
    itunesSearch(query, limit).catch(() => []),
    deezerSearch(query, limit).catch(() => []),
  ]);
  const seen = new Set();
  const out = [];
  for (let i = 0; i < Math.max(it.length, dz.length) && out.length < limit; i++) {
    for (const s of [it[i], dz[i]]) {
      if (!s || out.length >= limit) continue;
      const key = slugify(s.artist) + '/' + slugify(s.title);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  return out;
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

// Any tab ID of the right song works as a seed — UG's tab/info returns the
// song's full version list (incl. Chords) regardless of which type we hit.
// So match every tab type, preferring IDs that came from a -chords- URL.
const TAB_TYPES = 'chords|tabs|tab|ukulele|bass|drums|power|guitar-pro|official|chord';

async function cdxFetch(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(12000) });
      if (!res.ok) return null;
      return await res.text();
    } catch (e) {
      console.error(`[cdx] ${e.message} (try ${attempt + 1})`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return null;
}

// Exact-slug lookup: archived snapshot rows for tab/<artist>/<song>-...
async function cdxExact(artistSlug, songSlug) {
  const text = await cdxFetch(
    `http://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(
      `tabs.ultimate-guitar.com/tab/${artistSlug}/${songSlug}`
    )}&matchType=prefix&fl=timestamp,original,statuscode&limit=600`
  );
  if (text === null) return null;
  const re = new RegExp(`tab/${artistSlug}/${songSlug}[-_](?:(${TAB_TYPES})[-_])?(\\d{3,})`);
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const [ts, orig, status] = line.split(' ');
    const m = orig && orig.match(re);
    if (!m) continue;
    rows.push({ ts, orig, status, type: m[1] || '', id: Number(m[2]) });
  }
  return rows;
}

// Punctuation-insensitive fallback: pull the artist's whole archived catalog and
// match by normalized slug. Recovers songs UG slugs differently than we do —
// e.g. "P.Y.T. (Pretty Young Thing)" → our "p-y-t" vs UG's "pyt-pretty-young-thing".
async function cdxFuzzy(artistSlug, songSlug) {
  const norm = (s) => s.replace(/-/g, '');
  const target = norm(songSlug);
  if (target.length < 3) return [];
  const text = await cdxFetch(
    `http://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(
      `tabs.ultimate-guitar.com/tab/${artistSlug}/`
    )}&matchType=prefix&fl=timestamp,original,statuscode&limit=4000`
  );
  if (!text) return [];
  const re = new RegExp(`tab/${artistSlug}/([a-z0-9-]+?)[-_](?:(${TAB_TYPES})[-_])?(\\d{3,})`);
  const bySong = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue;
    const [ts, orig, status] = line.split(' ');
    const m = orig && orig.match(re);
    if (!m) continue;
    const arr = bySong.get(m[1]) || [];
    arr.push({ ts, orig, status, type: m[2] || '', id: Number(m[3]) });
    bySong.set(m[1], arr);
  }
  let best = null, bestScore = 49; // require a strong match
  for (const [slug, rows] of bySong) {
    const n = norm(slug);
    let s = -1;
    if (n === target) s = 100;
    else if (n.startsWith(target)) s = 80 - (n.length - target.length);   // acronym → expansion
    else if (target.startsWith(n)) s = 70 - (target.length - n.length);
    if (s > bestScore) { bestScore = s; best = rows; }
  }
  return best || [];
}

// Returns every archived snapshot row {ts, orig, status, type, id} for the first
// artist/song slug that matches, plus the {artist, title} that resolved it. The
// rows are reused by the Wayback fallback so it never re-queries the index.
async function cdxFind(songs) {
  for (const song of songs) {
    const songSlug = slugify(song.title);
    if (!songSlug) continue;
    for (const artistSlug of artistSlugVariants(song.artist)) {
      const rows = await cdxExact(artistSlug, songSlug);
      if (rows && rows.length) return { rows, resolved: song };
    }
  }
  // Exact slug missed everywhere — try the fuzzy catalog match for the primary song.
  const primary = songs[0];
  if (primary) {
    const songSlug = slugify(primary.title);
    for (const artistSlug of artistSlugVariants(primary.artist)) {
      const rows = await cdxFuzzy(artistSlug, songSlug);
      if (rows.length) return { rows, resolved: primary };
    }
  }
  return { rows: [], resolved: null };
}

// Prefer IDs that came from a -chords- URL; any tab type still seeds the song.
function idsFromRows(rows) {
  const chordIds = new Set(), otherIds = new Set();
  for (const r of rows) {
    if (r.type === 'chords' || r.type === 'chord') chordIds.add(r.id);
    else otherIds.add(r.id);
  }
  return [...chordIds, ...[...otherIds].filter((i) => !chordIds.has(i))];
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
// skips the iTunes guess entirely. Returns live-API seed `ids`, the CDX `rows`
// (for the Wayback fallback), and the `resolved` song for labelling.
async function discover(query, picked) {
  const songs = picked ? [picked] : await musicSearch(query, 3).catch(() => []);
  const { rows, resolved } = await cdxFind(songs).catch((e) => {
    console.error(`[cdx] ${e.message}`);
    return { rows: [], resolved: null };
  });
  const ids = idsFromRows(rows);
  if (ids.length) return { ids, rows, resolved: resolved || songs[0] || null };
  const bingQuery = picked ? `${picked.artist} ${picked.title}` : query;
  const bingIds = await bingFindIds(bingQuery).catch(() => []);
  return { ids: bingIds, rows: [], resolved: picked || songs[0] || null };
}

// ---------------------------------------------------------------------------
// Wayback archive fallback (when UG blocks the live API for the worker's IP)
// ---------------------------------------------------------------------------

// UG embeds the full page state — tab metadata, the cross-type version list with
// ratings, and the chord content — in the archived HTML. Modern snapshots use a
// <div class="js-store" data-content="...escaped json..."> blob; older ones a
// `window.UGAPP.store.page = {...}` assignment. Return store.page.data from
// whichever is present.
function parseUgStore(html) {
  const re = /data-content="([^"]*)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const json = m[1]
      .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x27;/gi, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    let obj;
    try { obj = JSON.parse(json); } catch { continue; }
    const data = obj?.store?.page?.data;
    if (data?.tab) return data;
  }
  const w = html.match(/window\.UGAPP\.store\.page\s*=\s*(\{[\s\S]*?\});\s*window\.UGAPP/);
  if (w) { try { const p = JSON.parse(w[1]); if (p?.data?.tab) return p.data; } catch {} }
  return null;
}

async function wbFetchData(ts, orig) {
  // id_ → raw archived response (no Wayback toolbar injected into the HTML).
  // Returns null on any failure (timeout, 404, network) so callers can just try
  // the next snapshot — a single flaky archive fetch must not abort the fallback.
  const url = `http://web.archive.org/web/${ts}id_/${orig}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    return parseUgStore(await res.text());
  } catch (e) {
    console.error(`[wayback] fetch ${ts}: ${e.message}`);
    return null;
  }
}

// Compact archive reference passed to the client and back (for version switching)
// — `<timestamp>~<original-url>`. Validated before re-fetch to prevent SSRF.
function wbRef(row) { return `${row.ts}~${row.orig}`; }

async function wbFetchFromRef(wb) {
  const i = wb.indexOf('~');
  if (i < 0) return null;
  const ts = wb.slice(0, i), orig = wb.slice(i + 1);
  if (!/^\d{8,}$/.test(ts)) return null;
  if (!/^https?:\/\/tabs\.ultimate-guitar\.com\//.test(orig)) return null;
  return wbFetchData(ts, orig);
}

function capoFrom(data) {
  if (data.tab?.capo) return data.tab.capo;
  const c = data.tab_view?.meta?.capo;
  if (c) return Number(c) || 0;
  const m = (data.tab_view?.wiki_tab?.content || '').match(/capo:?\s*(\d{1,2})/i);
  return m ? Number(m[1]) : 0;
}

function wbPayload(data, versions) {
  const t = data.tab;
  return {
    id: t.id,
    artist: t.artist_name,
    song: t.song_name,
    version: t.version,
    rating: Math.round((t.rating || 0) * 100) / 100,
    votes: t.votes || 0,
    capo: capoFrom(data),
    tuning: data.tab_view?.meta?.tuning?.value || '',
    tonality: t.tonality_name || '',
    content: data.tab_view?.wiki_tab?.content || '',
    versions,
  };
}

// Archived `tab_access_type` is sometimes absent on older snapshots; treat
// anything not explicitly Pro/private as a public user version.
function isWbChords(v) {
  return v.type === 'Chords' && v.tab_access_type !== 'private';
}

// Build a full song payload purely from archived snapshots: a seed fetch yields
// the cross-type version list (with ratings) for ranking; a second fetches the
// winning version's content. Every returned version carries a `wb` ref so the
// picker can switch versions without ever touching the blocked live API.
//
// CDX lists snapshots whose raw `id_` capture sometimes 404s, so we try several
// (newest first, chords pages preferred) rather than committing to one.
async function waybackSong(rows, resolved) {
  const ok = rows.filter((r) => r.status === '200' || r.status === '-');
  if (!ok.length) return null;
  const byId = new Map(); // newest servable snapshot per tab id
  for (const r of ok) {
    const cur = byId.get(r.id);
    if (!cur || r.ts > cur.ts) byId.set(r.id, r);
  }
  const byTs = (a, b) => b.ts.localeCompare(a.ts);
  const isChords = (r) => r.type === 'chords' || r.type === 'chord';
  const seedRows = [
    ...[...byId.values()].filter(isChords).sort(byTs),
    ...[...byId.values()].filter((r) => !isChords(r)).sort(byTs),
  ].slice(0, 8);

  let seed = null, seedRow = null;
  for (const r of seedRows) {
    const d = await wbFetchData(r.ts, r.orig);
    if (d?.tab && (d.tab_view?.versions?.length || d.tab_view?.wiki_tab?.content)) { seed = d; seedRow = r; break; }
  }
  if (!seed) return null;

  // Candidates = the parsed seed's own tab (content already in hand) unioned with
  // every other public chords version the archive can actually serve. The seed
  // must be included directly: UG's archived version list sometimes omits the very
  // tab the page belongs to, so relying on the list alone can drop a working pick.
  const candMap = new Map();
  if (isWbChords(seed.tab)) candMap.set(seed.tab.id, seed.tab);
  for (const v of seed.tab_view?.versions || []) {
    if (isWbChords(v) && (v.id === seed.tab.id || byId.has(v.id)) && !candMap.has(v.id)) {
      candMap.set(v.id, v);
    }
  }
  const candidates = [...candMap.values()];
  if (!candidates.length) return null;
  candidates.sort((a, b) => score(b) - score(a));

  let bestData = null;
  for (const v of candidates.slice(0, 6)) {
    if (v.id === seed.tab.id && seed.tab_view?.wiki_tab?.content) { bestData = seed; break; }
    const row = byId.get(v.id);
    if (!row) continue;
    const d = await wbFetchData(row.ts, row.orig);
    if (d?.tab_view?.wiki_tab?.content) { bestData = d; break; }
  }
  if (!bestData) return null;

  const versions = candidates.map((v) => {
    // Prefer the snapshot we know parsed for the seed's own version.
    const row = v.id === seed.tab.id ? seedRow : byId.get(v.id);
    return { ...versionSummary(v), wb: row ? wbRef(row) : undefined };
  });
  return wbPayload(bestData, versions);
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

// Live UG mobile API path: any tab of the song gives us its song_id; song/tabs
// then lists every version across all types. (tab/info's own `versions` array is
// per-type, so a non-chords seed would otherwise dead-end.)
async function apiSong(ids) {
  const seed = await ugTabInfo(ids[0]);
  let candidates = [];
  if (seed.song_id) {
    try {
      const all = await ugSongTabs(seed.song_id);
      candidates = (all.tabs || []).filter(isUserChords);
    } catch (e) {
      console.error(`[song/tabs] ${seed.song_id}: ${e.message}`);
    }
  }
  if (!candidates.length) candidates = [seed, ...(seed.versions || [])].filter(isUserChords);
  if (!candidates.length) {
    throw new HttpError(404, `Found "${seed.song_name}" by ${seed.artist_name}, but it has no user-submitted chord versions`);
  }
  candidates.sort((a, b) => score(b) - score(a));
  const best = candidates[0];
  const info = best.id === seed.id ? seed : await ugTabInfo(best.id);
  return tabPayload(info, candidates.map(versionSummary));
}

export async function handleSong(query, picked) {
  const key = picked
    ? `song:${picked.artist.toLowerCase()}|${picked.title.toLowerCase()}`
    : `song:${query.toLowerCase()}`;
  return cached(key, async () => {
    const { ids, rows, resolved } = await discover(query, picked);
    const label = picked
      ? `${picked.artist} — ${picked.title}`
      : (resolved ? `${resolved.artist} — ${resolved.title}` : query);
    if (!ids.length && !rows.length) throw new HttpError(404, `No Ultimate Guitar results found for "${label}"`);

    // Primary: live UG API (freshest ratings). On a block (451/403/429) or any
    // failure, fall back to the Wayback archive, which serves the same content
    // from an IP UG never blocks.
    let apiErr = null;
    if (ids.length) {
      try {
        return await apiSong(ids);
      } catch (e) {
        apiErr = e;
        if (!rows.length) throw e;
        console.error(`[song] live API failed (${e.status || e.message}); trying Wayback for "${label}"`);
      }
    }
    const wb = await waybackSong(rows, resolved).catch((e) => {
      console.error(`[wayback] ${e.message}`);
      return null;
    });
    if (wb) return wb;
    if (apiErr) throw apiErr;
    throw new HttpError(404, `No Ultimate Guitar results found for "${label}"`);
  });
}

export async function handleTab(id, wb) {
  return cached(wb ? `tab:wb:${wb}` : `tab:${id}`, async () => {
    if (wb) {
      const data = await wbFetchFromRef(wb).catch(() => null);
      if (data?.tab_view?.wiki_tab?.content) return wbPayload(data, []);
      // archive ref stale/unavailable → fall through to the live API
    }
    const info = await ugTabInfo(id);
    return tabPayload(info, []);
  });
}

export function handleSuggest(q) {
  if (q.length < 2) return Promise.resolve([]);
  return cached(`suggest:${q.toLowerCase()}`, () => musicSearch(q, 12), true);
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
      const wb = (params.get('wb') || '').trim() || null;
      if (!id) return { status: 400, body: { error: 'Missing tab id' } };
      return { status: 200, body: await handleTab(id, wb) };
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
