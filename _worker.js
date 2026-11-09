// PopDEX Toolkit backend, by @iamlogtun. No secrets, no user data stored.
// 1) /api/megapop  : reads PopDEX's MegaPop precompile (0x1013) through PopDEX's public Web3 RPC and decodes it.
// 2) /api/board    : PopDEX public market data (funding rates + tickers), merged.
// 3) /api/config   : PopDEX public symbol config + futures margin tiers + fee rates.
// 4) /api/wallet   : one wallet's MegaPop tickets (PopDEX public MegaPop API), ticket counts cross-checked on 0x1013.
// 5) /api/funding-history : PopDEX public funding-rate history (default window: last 7 days).
// 6) /api/btc-draw?t=<unix s> : first Bitcoin block at/after a draw time (mempool.space, blockstream.info backup), final results kept in R2.
// PopDEX's REST/RPC answer without CORS headers, so the browser reads them through here (short cache).
const API = "https://api.popdex.xyz";
const RPC = API + "/api/v1/web3/rpc";            // docs: /api/domain (Web3 RPC)
const MEGAPOP = "0x0000000000000000000000000000000000001013"; // docs: /smart-contract/MegaPop
const SEL = { latest: "0x3d537fb1", info: "0xd6e45940", pool: "0x04ebb693", tickets: "0xb9ee7bac" }; // keccak selectors (tickets = getAccountTicketCount(uint16,address))
const USDT_DP = 6n; // settlement-token qty_decimals: checked against fixed tiers (100 USDT = 100000000)

const mem = new Map(); // per-isolate cache
function memGet(k, ttl) { const v = mem.get(k); return v && (Date.now() - v.t) < ttl ? v.v : null; }
function memSet(k, v) { mem.set(k, { t: Date.now(), v }); return v; }

const J = (obj, status = 200, maxAge = 15) => new Response(JSON.stringify(obj), { status, headers: {
  "content-type": "application/json; charset=utf-8",
  "cache-control": status === 200 ? `public, max-age=${maxAge}` : "no-store",
  "x-content-type-options": "nosniff" } });

// ---------- ABI decoding (only what MegaPop returns) ----------
function words(hex) {
  hex = hex.startsWith("0x") ? hex.slice(2) : hex;
  const w = [];
  for (let i = 0; i + 64 <= hex.length; i += 64) w.push(hex.slice(i, i + 64));
  return w;
}
const U = (h) => BigInt("0x" + h);
const N = (h) => Number(U(h));
function amt(b) { // token units -> decimal string
  const neg = b < 0n; if (neg) b = -b;
  const d = 10n ** USDT_DP, i = b / d, f = (b % d).toString().padStart(Number(USDT_DP), "0");
  return (neg ? "-" : "") + i.toString() + "." + f;
}
function pct18(b) { return Number(b) / 1e18; }           // 1e18 = 100%
function fixed18(b) { return amt(b / (10n ** (18n - USDT_DP))); } // 18dp human amount -> string
const STATUS = ["Accumulating", "PendingDraw", "Drawing", "PayingOut"];

function decodeEpochInfo(hex) {
  const w = words(hex);
  if (w.length < 20) throw new Error("short epoch info");
  const base = N(w[0]) / 32;        // offset of the tuple
  const f = (i) => w[base + i];
  const cfg = {
    settlementToken: "0x" + f(2).slice(24),
    poolInjectionRate: pct18(U(f(3))),
    ticketThreshold: fixed18(U(f(4))),
    ticketCap: N(f(5)),
    fixedPrizeCapPct: pct18(U(f(6)))
  };
  const arr = (off, size, map) => {
    const at = base + N(off) / 32, len = N(w[at]), out = [];
    for (let k = 0; k < len; k++) out.push(map(w.slice(at + 1 + k * size, at + 1 + (k + 1) * size)));
    return out;
  };
  const tierCfg = (r) => {
    const type = N(r[2]);
    return { tier: N(r[0]), matchCount: N(r[1]), payoutType: type ? "FloatingPct" : "Fixed",
      payoutValue: type ? pct18(U(r[3])) : fixed18(U(r[3])), boostWhenMegaMiss: pct18(U(r[4])) };
  };
  const tierRes = (r) => {
    const type = N(r[2]);
    return { tier: N(r[0]), matchCount: N(r[1]), payoutType: type ? "FloatingPct" : "Fixed",
      payoutValue: type ? pct18(U(r[3])) : fixed18(U(r[3])),
      perTicket: amt(U(r[5])), total: amt(U(r[6])), tickets: N(r[7]), users: N(r[8]) };
  };
  const wn = N(f(12));
  const hash = f(13);
  return {
    epoch: N(f(0)), status: STATUS[N(f(1))] || String(N(f(1))), statusCode: N(f(1)), config: cfg,
    startAtMs: N(f(9)), endAtMs: N(f(10)), drawAtMs: N(f(11)),
    winningNumber: wn, popHash: N(f(11)) ? String(wn).padStart(6, "0") : null,
    btcBlockHash: /^0+$/.test(hash) ? null : hash,
    winningTicketCount: N(f(14)), winningUserCount: N(f(15)),
    tiersConfig: arr(f(16), 5, tierCfg), tiersResult: arr(f(17), 9, tierRes)
  };
}
function decodePool(hex) {
  const w = words(hex); if (!w.length) return [];
  const at = N(w[0]) / 32, len = N(w[at]), out = [];
  for (let k = 0; k < len; k++) {
    const r = w.slice(at + 1 + k * 6, at + 1 + (k + 1) * 6);
    out.push({ token: "0x" + r[0].slice(24), total: amt(U(r[1])), injected: amt(U(r[2])),
      rolloverFromPrev: amt(U(r[3])), rolloverToNext: amt(U(r[4])), totalPayout: amt(U(r[5])) });
  }
  return out;
}
const enc16 = (n) => n.toString(16).padStart(64, "0");

// ---------- upstream ----------
async function rpcBatch(calls) {
  const body = calls.map((data, i) => ({ jsonrpc: "2.0", id: i + 1, method: "eth_call", params: [{ to: MEGAPOP, data }, "latest"] }));
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error("rpc http " + r.status);
  let j = await r.json();
  if (!Array.isArray(j)) j = [j];
  const byId = new Map(j.map((x) => [x.id, x]));
  return calls.map((_, i) => { const x = byId.get(i + 1); if (!x || x.error || !x.result) throw new Error("rpc error " + JSON.stringify(x && x.error || "")); return x.result; });
}
async function rpcEach(calls) { // fallback when batching is not accepted
  const out = [];
  for (const c of calls) out.push((await rpcBatchSingle(c)));
  return out;
}
async function rpcBatchSingle(data) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: MEGAPOP, data }, "latest"] }) });
  if (!r.ok) throw new Error("rpc http " + r.status);
  const j = await r.json(); if (j.error || !j.result) throw new Error("rpc error " + JSON.stringify(j.error || ""));
  return j.result;
}
async function rpc(calls) { try { return await rpcBatch(calls); } catch (e) { return await rpcEach(calls); } }

async function megapop() {
  const hit = memGet("megapop", 60000); if (hit) return hit;
  const [latestHex] = await rpc([SEL.latest]);
  const latest = N(words(latestHex)[0]);
  const epochs = [], need = [];
  for (let e = 1; e <= latest; e++) {
    const done = memGet("ep" + e, 864e5); // drawn epochs never change
    if (done) epochs[e] = done; else need.push(e);
  }
  const calls = [];
  for (const e of need) { calls.push(SEL.info + enc16(e)); calls.push(SEL.pool + enc16(e)); }
  const res = calls.length ? await rpc(calls) : [];
  need.forEach((e, i) => {
    const info = decodeEpochInfo(res[i * 2]);
    info.pool = decodePool(res[i * 2 + 1]);
    epochs[e] = info;
    if (info.statusCode === 3) memSet("ep" + e, info);
  });
  return memSet("megapop", { source: "PopDEX MegaPop precompile 0x1013 via " + RPC, fetchedAt: Date.now(), latestEpochId: latest, epochs: epochs.filter(Boolean) });
}

async function apiAll(path, ttl) { // follows PopDEX cursor pagination (limit 100)
  const hit = memGet(path, ttl); if (hit) return hit;
  let cursor = "0", all = [], meta = {};
  for (let page = 0; page < 6; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const r = await fetch(API + path + sep + "limit=100&cursor=" + cursor, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(path + " http " + r.status);
    const j = await r.json();
    if (String(j.code) !== "200" || !Array.isArray(j.data)) throw new Error(path + " code " + j.code);
    all = all.concat(j.data); meta = j;
    const total = Number(j.total || 0);
    if (!total || all.length >= total || !j.data.length || !j.cursor || j.cursor === cursor) break;
    cursor = j.cursor;
  }
  return memSet(path, { data: all, updatedTime: meta.updatedTime || meta.blockTime || null });
}

async function board() {
  const [fr, tk] = await Promise.all([apiAll("/api/v1/market/funding-rate", 15000), apiAll("/api/v1/market/tickers?category=Futures", 10000)]);
  const t = new Map(tk.data.map((x) => [x.symbol, x]));
  const markets = fr.data.map((f) => {
    const x = t.get(f.symbol) || {};
    return { symbol: f.symbol, fundingRate: f.fundingRate, intervalH: f.fundingRateInterval, nextUpdate: f.nextUpdate,
      minFundingRate: f.minFundingRate, maxFundingRate: f.maxFundingRate, markPrice: x.markPrice || null, indexPrice: x.indexPrice || null,
      lastPrice: x.lastPrice || null, change24h: x.price24hPcnt || null, turnover24h: x.turnover24h || null, openInterest: x.openInterest || null, status: x.status || null };
  });
  return { source: API + "/api/v1/market/funding-rate + /api/v1/market/tickers", updatedTime: fr.updatedTime, fetchedAt: Date.now(), markets };
}
async function config() {
  const [sy, ti, fe] = await Promise.all([apiAll("/api/v1/config/symbols", 600000), apiAll("/api/v1/config/futures-tier", 600000), apiAll("/api/v1/config/fee-rate?category=Futures", 600000)]);
  const tiers = new Map(ti.data.map((x) => [x.symbol, x.tiers]));
  const fees = new Map(fe.data.map((x) => [x.symbol, x.feeRates]));
  const symbols = sy.data.filter((s) => s.category === "Futures").map((s) => ({
    symbol: s.symbol, base: s.baseToken, assetClass: s.assetClass, status: s.status, tickSize: s.tickSize, lotSize: s.lotSize,
    minQty: s.minQty, maxQty: s.maxQty, minNotional: s.minNotional, maxNotional: s.maxNotional, pricePrecision: s.pricePrecision,
    qtyPrecision: s.baseTokenPrecision, fundingInterval: s.fundingInterval, fundingCap: s.fundingCap,
    tiers: tiers.get(s.symbol) || [], fees: fees.get(s.symbol) || [] }));
  return { source: API + "/api/v1/config/symbols + /futures-tier + /fee-rate", fetchedAt: Date.now(), symbols };
}

// ---------- wallet lookup ----------
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const MAXU64 = (1n << 64n) - 1n;
let wBudget = { t: 0, n: 0 };            // per-isolate cap on uncached wallet lookups (abuse limit)
function budgetOk() { const now = Date.now(); if (now - wBudget.t > 60000) wBudget = { t: now, n: 0 }; return ++wBudget.n <= 40; }
async function apiGet(path, retried) {
  const r = await fetch(API + path, { headers: { accept: "application/json" } });
  if ((r.status === 429 || r.status >= 500) && !retried) { await new Promise((ok) => setTimeout(ok, 600)); return apiGet(path, true); }
  if (!r.ok) throw new Error(path.split("?")[0] + " http " + r.status);
  const j = await r.json();
  if (String(j.code) !== "200") throw new Error(path.split("?")[0] + " code " + j.code);
  return j;
}
async function apiPaged(path, maxPages) {     // PopDEX cursor pagination, 100 per page
  let cursor = "", all = [], total = 0;
  for (let p = 0; p < maxPages; p++) {
    const j = await apiGet(path + (path.includes("?") ? "&" : "?") + "limit=100" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
    const data = Array.isArray(j.data) ? j.data : [];
    total = Number(j.total || 0); all = all.concat(data);
    if (!j.cursor || !data.length || (total && all.length >= total) || j.cursor === cursor) break;
    cursor = j.cursor;
  }
  return { data: all, total: total || all.length, truncated: total > all.length };
}
const slimTicket = (t) => ({ n: String(t.number), tier: Number(t.prizeTier) || 0, st: t.status, src: t.source, won: t.winningAmount, seq: Number(t.ticketSeq) });
async function wallet(addr, wantEpoch) {
  const a = addr.toLowerCase();
  const mp = await megapop();
  const latest = mp.latestEpochId;
  const key = "w:" + a + ":" + wantEpoch;
  const hit = memGet(key, 60000); if (hit) return hit;
  if (!budgetOk()) { const e = new Error("busy"); e.busy = true; throw e; }
  const eps = []; for (let e = 1; e <= latest; e++) eps.push(e);
  const [details, chain] = await Promise.all([
    Promise.all(eps.map((e) => apiGet("/api/v1/megapop/account/" + a + "/draws/detail?epoch=" + e).then((j) => j.data || null).catch(() => null))),
    rpc(eps.map((e) => SEL.tickets + enc16(e) + a.slice(2).padStart(64, "0"))).catch(() => null)
  ]);
  const summary = eps.map((e, i) => {
    const d = details[i] || {};
    let oc = null;
    if (chain && chain[i]) { const v = U(words(chain[i])[0] || "0"); oc = v === MAXU64 ? null : Number(v); }
    return { epoch: e, epochStatus: d.epochStatus || null, status: d.status || null, tickets: d.ticketCount != null ? Number(d.ticketCount) : null,
      onchainTickets: oc, bestTier: d.bestPrizeTier != null ? Number(d.bestPrizeTier) : null, won: d.winningAmount != null ? d.winningAmount : null,
      winningTickets: d.winningTicketCount != null ? Number(d.winningTicketCount) : null, volume: d.volume || null, popHash: d.winningNumber || null,
      startAtMs: Number(d.roundStartAt) || null, endAtMs: Number(d.roundEndAt) || null };
  });
  let sel = Number(wantEpoch);
  if (!(sel >= 1 && sel <= latest)) {
    const drawn = summary.filter((s) => s.epochStatus === "PayingOut");
    const withT = drawn.filter((s) => s.tickets > 0);
    sel = (withT.length ? withT[withT.length - 1] : drawn.length ? drawn[drawn.length - 1] : summary[summary.length - 1] || { epoch: latest }).epoch;
  }
  const s = summary.find((x) => x.epoch === sel);
  let tickets = [], total = 0, truncated = false;
  if (s && s.tickets) {
    const base = "/api/v1/megapop/account/" + a + "/draws/tickets?epoch=" + sel + "&sort=SeqDesc";
    const all = await apiPaged(base, 30);                 // up to 3,000 tickets
    tickets = all.data.map(slimTicket); total = all.total; truncated = all.truncated;
    if (truncated) {                                     // make sure every winning ticket is included
      const seen = new Set(tickets.map((t) => t.seq));
      for (let tier = 1; tier <= 5; tier++) {
        const w = await apiPaged(base + "&prizeTier=" + tier, 5);
        for (const t of w.data) { const x = slimTicket(t); if (!seen.has(x.seq)) { seen.add(x.seq); tickets.push(x); } }
      }
    }
  }
  return memSet(key, { source: "PopDEX public MegaPop API (" + API + "/api/v1/megapop/account/…) + getAccountTicketCount on 0x1013",
    fetchedAt: Date.now(), address: a, latestEpochId: latest, epoch: sel, summary, tickets, ticketsTotal: total, truncated });
}
// Is ticket <n> held by wallet <addr> in epoch <ep>? Asks PopDEX's MegaPop API for that exact number (works for any wallet size).
async function heldTicket(addr, ep, n) {
  const a = addr.toLowerCase(), key = "h:" + a + ":" + ep + ":" + n;
  const hit = memGet(key, 60000); if (hit) return hit;
  const w = memGet("w:" + a + ":" + ep, 60000);          // a wallet lookup this isolate just served
  if (w && !w.truncated && w.epoch === ep) { const t = w.tickets.find((x) => String(x.n).padStart(6, "0") === n); return memSet(key, { held: !!t, ticket: t || null }); }
  if (!budgetOk()) { const e = new Error("busy"); e.busy = true; throw e; }
  const j = await apiGet("/api/v1/megapop/account/" + a + "/draws/tickets?epoch=" + ep + "&number=" + n + "&limit=100");
  const t = (Array.isArray(j.data) ? j.data : []).map(slimTicket).find((x) => String(x.n).padStart(6, "0") === n) || null;
  return memSet(key, { held: !!t, ticket: t });
}

// ---------- funding history ----------
async function fundingHistory(sym) {
  const key = "fh:" + sym; const hit = memGet(key, 300000); if (hit) return hit;
  const j = await apiGet("/api/v1/market/history/funding-rate?symbol=" + encodeURIComponent(sym) + "&limit=1000");
  const pts = (j.data || []).map((x) => ({ t: Number(x.fundingRateTimestamp), r: Number(x.fundingRate) }))
    .filter((x) => isFinite(x.t) && isFinite(x.r)).sort((a, b) => a.t - b.t);
  return memSet(key, { source: API + "/api/v1/market/history/funding-rate", symbol: sym, fetchedAt: Date.now(), points: pts });
}


// ---------- share cards: POST /api/card stores the rendered PNG in R2; /s/<id> is a link whose preview IS the card ----------
const ORIGIN = "https://popdex-tools.sites.tab.bot";
const CARD_MAX = 1536 * 1024, CARD_W = 1200, CARD_H = 675, CARD_RATE = 30; // per IP per hour
const ID_RE = /^[A-Za-z0-9]{8,10}$/;
const ID_ABC = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
function newId(n = 9) { const b = new Uint8Array(n); crypto.getRandomValues(b); let s = ""; for (const x of b) s += ID_ABC[x % ID_ABC.length]; return s; }
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// small key/value notes kept in the same R2 bucket (dedupe map + hourly per-IP counters)
const note = {
  async get(env, k) { const o = await env.CARDS.get("n/" + k); return o ? await o.text() : null; },
  async put(env, k, v) { await env.CARDS.put("n/" + k, String(v), { httpMetadata: { contentType: "text/plain" } }); },
};
function cardMeta(u) { // only validated numbers reach the page text
  const e = u.searchParams.get("e"), b = u.searchParams.get("b"), p = u.searchParams.get("p");
  return { e: /^\d{1,5}$/.test(e || "") ? e : "", b: /^[0-6]$/.test(b || "") ? b : "", p: /^\d{6}$/.test(p || "") ? p : "" };
}
async function cardUpload(req, env, url) {
  if (!env.CARDS) return J({ error: "storage_unavailable" }, 503);
  const len = Number(req.headers.get("content-length") || 0);
  if (len > CARD_MAX) return J({ error: "too_large" }, 413);
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.length > CARD_MAX) return J({ error: "too_large" }, 413);
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 33 || SIG.some((v, i) => buf[i] !== v) || String.fromCharCode(...buf.slice(12, 16)) !== "IHDR") return J({ error: "not_png" }, 415);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(16) !== CARD_W || dv.getUint32(20) !== CARD_H) return J({ error: "bad_dimensions" }, 422);
  const m = cardMeta(url);
  // Cards only for a real ticket: the wallet (w) must hold ticket (t) in epoch (e). Typed-in numbers never get a card.
  const w = (url.searchParams.get("w") || "").trim(), t = (url.searchParams.get("t") || "").trim();
  if (!ADDR_RE.test(w) || !/^\d{6}$/.test(t) || !m.e) return J({ error: "wallet_ticket_required" }, 422);
  let held;
  try { held = await heldTicket(w, Number(m.e), t); } catch (e) { return J({ error: e.busy ? "busy" : "verify_failed" }, e.busy ? 429 : 502); }
  if (!held.held) return J({ error: "ticket_not_in_wallet" }, 403);
  try { // the match count on the link preview comes from the official Pop Hash, not from the browser
    const ep = (await megapop()).epochs.find((x) => x.epoch === Number(m.e));
    if (ep && /^\d{6}$/.test(String(ep.popHash || ""))) { const ph = String(ep.popHash); let c = 0; for (let i = 0; i < 6; i++) if (ph[i] === t[i]) c++; m.b = String(c); m.p = ph; }
  } catch (e) { /* keep validated client values */ }
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))].map((x) => x.toString(16).padStart(2, "0")).join("");
  const known = await note.get(env, "h/" + hash);
  if (known && ID_RE.test(known)) return J({ id: known, url: ORIGIN + "/s/" + known, dedupe: true }, 200, 0);
  const ip = req.headers.get("cf-connecting-ip") || "unknown", hr = Math.floor(Date.now() / 3600000), rk = "rl/" + hr + "/" + ip.replace(/[^0-9a-fA-F:.]/g, "_");
  const used = Number(await note.get(env, rk) || 0);
  if (used >= CARD_RATE) return J({ error: "rate_limited" }, 429);
  await note.put(env, rk, used + 1);
  let id = newId();
  for (let i = 0; i < 3 && await env.CARDS.head(id + ".png"); i++) id = newId(10);
  await env.CARDS.put(id + ".png", buf, { httpMetadata: { contentType: "image/png", cacheControl: "public, max-age=31536000, immutable" },
    customMetadata: { e: m.e, b: m.b, p: m.p, sha256: hash, created: new Date().toISOString() } });
  await note.put(env, "h/" + hash, id);
  return J({ id, url: ORIGIN + "/s/" + id }, 200, 0);
}
const PUB = "https://popdex-toolkit.site"; // public address used in shared links
const toMegapop = () => new Response(null, { status: 302, headers: { location: PUB + "/#megapop", "cache-control": "no-store" } });
async function cardServe(req, env, url) {
  const m = url.pathname.match(/^\/s\/([A-Za-z0-9]{8,10})(\.png)?$/);
  if (!m || !env.CARDS) return toMegapop();
  const id = m[1];
  if (m[2]) {
    const obj = await env.CARDS.get(id + ".png");
    if (!obj) return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
    return new Response(req.method === "HEAD" ? null : obj.body, { headers: { "content-type": "image/png", "content-length": String(obj.size),
      "cache-control": "public, max-age=31536000, immutable", etag: obj.httpEtag, "x-content-type-options": "nosniff" } });
  }
  const head = await env.CARDS.head(id + ".png");
  if (!head) return toMegapop();
  const md = head.customMetadata || {};
  const title = md.e ? (Number(md.b) >= 2 ? "Hit " + md.b + "/6 on PopDEX MegaPop Epoch #" + md.e : "PopDEX MegaPop Epoch #" + md.e + " result") : "PopDEX MegaPop result";
  const desc = (md.p ? "Pop Hash " + md.p + ". " : "") + "Check your MegaPop tickets on PopDEX Toolkit.";
  const img = PUB + "/s/" + id + ".png", page = PUB + "/s/" + id, dest = PUB + "/#megapop";
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>" + esc(title) + "</title>" +
    '<meta name="description" content="' + esc(desc) + '">' +
    '<meta property="og:type" content="website"><meta property="og:site_name" content="PopDEX Toolkit">' +
    '<meta property="og:title" content="' + esc(title) + '"><meta property="og:description" content="' + esc(desc) + '">' +
    '<meta property="og:url" content="' + page + '"><meta property="og:image" content="' + img + '">' +
    '<meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="675">' +
    '<meta property="og:image:alt" content="' + esc(title) + '">' +
    '<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="' + esc(title) + '">' +
    '<meta name="twitter:description" content="' + esc(desc) + '"><meta name="twitter:image" content="' + img + '">' +
    '<meta name="twitter:image:alt" content="' + esc(title) + '">' +
    '<meta http-equiv="refresh" content="0;url=' + dest + '">' +
    '<style>body{background:#0E0E0E;color:#fff;font:16px system-ui,sans-serif;text-align:center;padding:40px 16px}a{color:#BDB9FF}</style>' +
    '</head><body><p>Opening PopDEX Toolkit… <a href="' + dest + '">Continue</a></p>' +
    '<script>location.replace(' + JSON.stringify(dest) + ');</script></body></html>';
  return new Response(req.method === "HEAD" ? null : html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600" } });
}

// ---------- /api/btc-draw : first Bitcoin block (by height) with timestamp >= t ----------
// Same rule as the page's own lookup: mempool.space first, blockstream.info as backup.
// A FINAL result (block found with >= 3 confirmations) never changes, so it is kept in R2 (btc/<t>.json) and edge cache.
const BTC_PROVIDERS = [
  { name: "mempool.space", base: "https://mempool.space/api", page: "https://mempool.space/block/" },
  { name: "blockstream.info", base: "https://blockstream.info/api", page: "https://blockstream.info/block/" }
];
const BTC_MIN_T = 1735689600; // 2025-01-01, before MegaPop existed
let btcBudget = { t: 0, n: 0 };
function btcBudgetOk() { const now = Date.now(); if (now - btcBudget.t > 60000) btcBudget = { t: now, n: 0 }; return ++btcBudget.n <= 60; }
async function btcGet(url, ms, text) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms || 8000), headers: { accept: text ? "text/plain" : "application/json", "user-agent": "popdex-tools (unofficial community site)" } });
  if (!r.ok) throw new Error(url.replace(/^https:\/\//, "") + " " + r.status);
  return text ? await r.text() : await r.json();
}
function pickDrawBlock(blocks, T) { // identical to core.js
  const asc = blocks.slice().sort((a, b) => a.height - b.height);
  for (let i = 0; i < asc.length; i++) if (asc[i].timestamp >= T) return { block: asc[i], prev: asc[i - 1] || null, index: i };
  return null;
}
function popHash(hash) { // identical to core.js: last 6 numeric digits, in order
  hash = String(hash || "").toLowerCase().replace(/^0x/, "");
  const pos = [];
  for (let i = hash.length - 1; i >= 0 && pos.length < 6; i--) if (hash[i] >= "0" && hash[i] <= "9") pos.unshift(i);
  return pos.length < 6 ? null : { pop: pos.map((i) => hash[i]).join(""), positions: pos };
}
async function btcTip(p) {
  const k = "tip:" + p.name, c = memGet(k, 20000); if (c) return c;
  const tip = Number(await btcGet(p.base + "/blocks/tip/height", 6000, true));
  if (!Number.isFinite(tip) || tip < 800000) throw new Error(p.name + " bad tip");
  return memSet(k, tip);
}
async function btcFind(T) {
  let lastErr;
  for (const p of BTC_PROVIDERS) {
    try {
      const tip = await btcTip(p);
      let h0 = null;
      if (p.name === "mempool.space") { try { h0 = (await btcGet(p.base + "/v1/mining/blocks/timestamp/" + T, 8000)).height; } catch (e) { h0 = null; } }
      if (!h0) h0 = tip - Math.round((Date.now() / 1000 - T) / 600);
      let start = Math.min(tip, h0 + 8);
      for (let k = 0; k < 12; k++) {
        const arr = await btcGet(p.base + "/blocks/" + start, 8000);
        const blocks = arr.map((b) => ({ height: b.height, id: b.id, timestamp: b.timestamp }));
        const asc = blocks.slice().sort((a, b) => a.height - b.height);
        const hit = pickDrawBlock(blocks, T);
        if (hit && hit.index > 0) return { provider: p, block: hit.block, prev: hit.prev, tip };
        if (hit && hit.index === 0) { start = asc[0].height - 1 + 5; continue; }
        if (!hit) { if (asc[asc.length - 1].height >= tip) return { provider: p, pending: true, tip }; start = Math.min(tip, start + 9); }
      }
      throw new Error("could not locate block");
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("bitcoin providers unavailable");
}
const btcResp = (obj, maxAge, status = 200) => new Response(JSON.stringify(obj), { status, headers: {
  "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff",
  "cache-control": status === 200 ? (maxAge > 86400 ? "public, max-age=" + maxAge + ", immutable" : "public, max-age=" + maxAge) : "no-store" } });
async function btcDraw(req, env, ctx, url) {
  const raw = url.searchParams.get("t") || "";
  if (!/^\d{9,11}$/.test(raw)) return J({ error: "bad_t" }, 400);
  const T = Number(raw), nowS = Math.floor(Date.now() / 1000);
  if (T < BTC_MIN_T || T > nowS + 40 * 86400) return J({ error: "t_out_of_range" }, 400);
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const ckey = new Request(url.origin + "/api/btc-draw?t=" + T, { method: "GET" });
  if (cache) { try { const hit = await cache.match(ckey); if (hit) return hit; } catch (e) {} }
  const r2key = "btc/" + T + ".json";
  if (env.CARDS) {
    try {
      const o = await env.CARDS.get(r2key);
      if (o) { const res = btcResp(JSON.parse(await o.text()), 31536000); if (cache) ctx.waitUntil(cache.put(ckey, res.clone()).catch(() => {})); return res; }
    } catch (e) {}
  }
  const mk = "btc:" + T, m = memGet(mk, 30000); if (m) return btcResp(m, 30);
  if (T > nowS) return btcResp(memSet(mk, { status: "pending", t: T, tip: await btcTip(BTC_PROVIDERS[0]), reason: "draw_in_future" }), 60);
  if (!btcBudgetOk()) return J({ error: "busy" }, 429);
  let f;
  try { f = await btcFind(T); } catch (e) { return J({ error: "upstream", detail: String(e && e.message || e).slice(0, 200) }, 502); }
  if (f.pending) return btcResp(memSet(mk, { status: "pending", t: T, tip: f.tip, provider: f.provider.name }), 30);
  const conf = f.tip - f.block.height + 1, pp = popHash(f.block.id);
  const out = { status: conf >= 3 ? "final" : "confirming", t: T, provider: f.provider.name, explorerUrl: f.provider.page + f.block.id,
    block: f.block, prev: f.prev ? { height: f.prev.height, id: f.prev.id, timestamp: f.prev.timestamp } : null,
    tip: f.tip, confirmations: conf, popHash: pp ? pp.pop : null, popPositions: pp ? pp.positions : null,
    rule: "first Bitcoin block by height whose timestamp >= t; Pop Hash = last 6 numeric digits of its hash, in order" };
  if (out.status !== "final") return btcResp(memSet(mk, out), 30);
  out.finalizedAt = new Date().toISOString();
  if (env.CARDS) { try { await env.CARDS.put(r2key, JSON.stringify(out), { httpMetadata: { contentType: "application/json" } }); } catch (e) {} }
  const res = btcResp(out, 31536000);
  if (cache) ctx.waitUntil(cache.put(ckey, res.clone()).catch(() => {}));
  return res;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/api/btc-draw") {
      if (req.method !== "GET") return J({ error: "method" }, 405);
      try { return await btcDraw(req, env, ctx, url); }
      catch (e) { return J({ error: "upstream", detail: String(e && e.message || e).slice(0, 200) }, 502); }
    }
    if (url.pathname === "/api/card") {
      if (req.method !== "POST") return J({ error: "method" }, 405);
      try { return await cardUpload(req, env, url); }
      catch (e) { return J({ error: "store_failed", detail: String(e && e.message || e).slice(0, 200) }, 500); }
    }
    if (url.pathname.startsWith("/s/")) {
      try { return await cardServe(req, env, url); } catch (e) { return toMegapop(); }
    }
    if (url.pathname.startsWith("/api/")) {
      if (req.method !== "GET") return J({ error: "method" }, 405);
      try {
        if (url.pathname === "/api/megapop") return J(await megapop(), 200, 30);
        if (url.pathname === "/api/board") return J(await board(), 200, 10);
        if (url.pathname === "/api/config") return J(await config(), 200, 300);
        if (url.pathname === "/api/wallet") {
          const addr = (url.searchParams.get("addr") || "").trim();
          if (!ADDR_RE.test(addr)) return J({ error: "bad_address" }, 400);
          const ep = url.searchParams.get("epoch");
          try { return J(await wallet(addr, ep ? Number(ep) : 0), 200, 30); }
          catch (e) { if (e.busy) return J({ error: "busy" }, 429); throw e; }
        }
        if (url.pathname === "/api/wallet-ticket") {
          const addr = (url.searchParams.get("addr") || "").trim(), n = (url.searchParams.get("n") || "").trim(), ep = Number(url.searchParams.get("epoch"));
          if (!ADDR_RE.test(addr)) return J({ error: "bad_address" }, 400);
          if (!/^\d{6}$/.test(n) || !(ep >= 1 && ep <= 65535)) return J({ error: "bad_ticket" }, 400);
          try { return J(Object.assign({ address: addr.toLowerCase(), epoch: ep, number: n }, await heldTicket(addr, ep, n)), 200, 30); }
          catch (e) { if (e.busy) return J({ error: "busy" }, 429); throw e; }
        }
        if (url.pathname === "/api/funding-history") {
          const sym = (url.searchParams.get("symbol") || "").trim().toUpperCase();
          if (!/^[A-Z0-9]{2,24}$/.test(sym)) return J({ error: "bad_symbol" }, 400);
          return J(await fundingHistory(sym), 200, 120);
        }
        return J({ error: "not found" }, 404);
      } catch (e) {
        return J({ error: "upstream", detail: String(e && e.message || e).slice(0, 200) }, 502);
      }
    }
    return env.ASSETS.fetch(req);
  }
};
