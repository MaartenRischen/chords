// Chords API — Cloudflare Worker. Serves /api/* for the GitHub Pages frontend.
// Same logic as the local server via core.js.

import { apiRoute } from './core.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const result = await apiRoute(url.pathname, url.searchParams);
    const status = result ? result.status : 404;
    const body = result ? result.body : { error: 'Not found' };
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
    });
  },
};
