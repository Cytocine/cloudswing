// Cytocine Cloud: one Cloudflare Worker that
//   1) proxies Alpaca market data (keys stay on the server),
//   2) stores chart drawings in Supabase,
//   3) checks price alerts every minute (cron) and posts to Discord.
// Secrets: APP_TOKEN, ALPACA_KEY, ALPACA_SECRET, SUPABASE_URL, SUPABASE_KEY, DISCORD_WEBHOOK

const SYM = /^[A-Z][A-Z0-9.\-]{0,9}$/;

const cors = (env) => ({
  'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
  'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-App-Token',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin',
});
const json = (env, obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors(env) } });

async function sb(env, path, method = 'GET', body, prefer) {
  const h = { apikey: env.SUPABASE_KEY, 'Content-Type': 'application/json' };
  if (env.SUPABASE_KEY.startsWith('eyJ')) h.Authorization = `Bearer ${env.SUPABASE_KEY}`; // legacy JWT keys only
  if (prefer) h.Prefer = prefer;
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

async function discord(env, embed) {
  if (!env.DISCORD_WEBHOOK) return;
  await fetch(env.DISCORD_WEBHOOK, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'Cytocine Levels', embeds: [{ color: 0x2962ff, timestamp: new Date().toISOString(), ...embed }] }),
  });
}

// alerts are horizontal-line drawings flagged alert:true; the Worker derives them from the drawing JSON
const alertsOf = (data) => data.filter(d => d && d.alert && d.type === 'hline' && d.pts && d.pts[0] && isFinite(d.pts[0].p))
  .map(d => ({ id: String(d.id), price: +d.pts[0].p, dir: d.dir === 'below' ? 'below' : 'above' }));

async function syncAlerts(env, symbol, data) {
  const want = alertsOf(data);
  const have = await sb(env, `alerts?symbol=eq.${symbol}&select=id,price,dir`);
  const hv = new Map(have.map(r => [r.id, r]));
  for (const a of want) {
    const r = hv.get(a.id);
    if (!r) await sb(env, 'alerts', 'POST', { ...a, symbol }, 'return=minimal');
    else if (+r.price !== a.price || r.dir !== a.dir)   // moved: re-arm
      await sb(env, `alerts?id=eq.${encodeURIComponent(a.id)}`, 'PATCH', { price: a.price, dir: a.dir, active: true, triggered_at: null }, 'return=minimal');
  }
  const keep = new Set(want.map(a => a.id));
  for (const r of have) if (!keep.has(r.id)) await sb(env, `alerts?id=eq.${encodeURIComponent(r.id)}`, 'DELETE');
}

async function api(req, env, url) {
  if (!env.APP_TOKEN || req.headers.get('X-App-Token') !== env.APP_TOKEN) return json(env, { error: 'unauthorized' }, 401);
  const p = url.pathname, symbol = (url.searchParams.get('symbol') || '').toUpperCase();

  if (p === '/api/sync' && req.method === 'GET') {
    if (!SYM.test(symbol)) return json(env, { error: 'bad symbol' }, 400);
    const [d, a] = await Promise.all([
      sb(env, `drawings?symbol=eq.${symbol}&select=data,updated_at`),
      sb(env, `alerts?symbol=eq.${symbol}&select=id,price,dir,active,triggered_at`),
    ]);
    return json(env, { drawing: d[0] || null, alerts: a });
  }
  if (p === '/api/drawings' && req.method === 'PUT') {
    if (!SYM.test(symbol)) return json(env, { error: 'bad symbol' }, 400);
    const raw = await req.text();
    if (raw.length > 400000) return json(env, { error: 'too large' }, 413);
    const b = JSON.parse(raw);
    if (!Array.isArray(b.data)) return json(env, { error: 'data must be an array' }, 400);
    const at = new Date(b.updated_at); const updated_at = isNaN(at) ? new Date().toISOString() : at.toISOString();
    await sb(env, 'drawings?on_conflict=symbol', 'POST', { symbol, data: b.data, updated_at }, 'resolution=merge-duplicates,return=minimal');
    await syncAlerts(env, symbol, b.data);
    return json(env, { ok: true, updated_at });
  }
  if (p === '/api/notify' && req.method === 'POST') {   // lets the browser send Discord messages without holding the webhook
    const b = await req.json();
    await discord(env, { title: 'Cytocine Alert', description: String(b.text || '').slice(0, 1000) });
    return json(env, { ok: true });
  }
  return json(env, { error: 'not found' }, 404);
}

async function proxyAlpaca(req, env, url) {
  if (!env.APP_TOKEN || req.headers.get('X-App-Token') !== env.APP_TOKEN) return json(env, { error: 'unauthorized' }, 401);
  if (req.method !== 'GET' || !url.pathname.startsWith('/v2/')) return json(env, { error: 'not allowed' }, 403);
  const r = await fetch('https://data.alpaca.markets' + url.pathname + url.search, {
    headers: { 'APCA-API-KEY-ID': env.ALPACA_KEY, 'APCA-API-SECRET-KEY': env.ALPACA_SECRET },
  });
  return new Response(r.body, { status: r.status, headers: { 'Content-Type': r.headers.get('Content-Type') || 'application/json', ...cors(env) } });
}

function marketWindow() {   // Mon-Fri, 04:00-20:00 America/New_York (pre-market to after-hours)
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hourCycle: 'h23', hour: '2-digit' })
    .formatToParts(new Date()).forEach(x => p[x.type] = x.value);
  const h = +p.hour;
  return !['Sat', 'Sun'].includes(p.weekday) && h >= 4 && h < 20;
}

async function checkAlerts(env) {
  if (!marketWindow()) return;
  const act = await sb(env, 'alerts?active=eq.true&select=id,symbol,price,dir,note');
  if (!act.length) return;
  const syms = [...new Set(act.map(a => a.symbol))];
  const r = await fetch(`https://data.alpaca.markets/v2/stocks/snapshots?symbols=${syms.join(',')}&feed=${env.FEED || 'iex'}`, {
    headers: { 'APCA-API-KEY-ID': env.ALPACA_KEY, 'APCA-API-SECRET-KEY': env.ALPACA_SECRET },
  });
  if (!r.ok) throw new Error('alpaca ' + r.status);
  const snap = await r.json();
  for (const a of act) {
    const px = snap[a.symbol]?.latestTrade?.p;
    if (px == null) continue;
    const hit = a.dir === 'above' ? px >= a.price : px <= a.price;
    if (!hit) continue;
    // claim the alert first so overlapping runs can't double-send
    const got = await sb(env, `alerts?id=eq.${encodeURIComponent(a.id)}&active=eq.true`, 'PATCH',
      { active: false, triggered_at: new Date().toISOString() }, 'return=representation');
    if (!got.length) continue;
    await discord(env, {
      title: `🔔 ${a.symbol} ${a.dir === 'above' ? 'rose to' : 'fell to'} ${a.price}`,
      description: `Last trade **${px}**${a.note ? `\n${a.note}` : ''}`,
      url: env.APP_URL || undefined,
    });
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, env, url);
      return await proxyAlpaca(req, env, url);
    } catch (e) {
      return json(env, { error: String(e.message || e) }, 500);
    }
  },
  async scheduled(_evt, env, ctx) {
    ctx.waitUntil(checkAlerts(env).catch(e => console.error('alert check failed', e)));
  },
};
