/* PopDEX Toolkit core math (pure functions, no DOM). Rules from popdex.xyz/docs. */
(function (root) {
  "use strict";
  // ---------- MegaPop ----------
  // docs /product-docs/rewards/megapop: "extracts the last 6 numeric digits from the selected Bitcoin block hash"
  function popHashFromBlockHash(hash) {
    hash = String(hash || "").toLowerCase().replace(/^0x/, "");
    const pos = [];
    for (let i = hash.length - 1; i >= 0 && pos.length < 6; i--) if (hash[i] >= "0" && hash[i] <= "9") pos.unshift(i);
    if (pos.length < 6) return null;
    return { pop: pos.map((i) => hash[i]).join(""), positions: pos };
  }
  // tickets: 6 digits 0-9, leading zeros valid
  function parseTickets(text) {
    const tokens = String(text || "").split(/[^0-9A-Za-z]+/).filter(Boolean);
    const valid = [], invalid = [];
    for (const t of tokens) (/^\d{6}$/.test(t) ? valid : invalid).push(t);
    return { valid, invalid };
  }
  // "a digit only counts as a match if both the digit and its position are the same"
  function matchTicket(ticket, pop) {
    const pos = [];
    for (let i = 0; i < 6; i++) if (ticket[i] === pop[i]) pos.push(i);
    return { count: pos.length, positions: pos };
  }
  const DEFAULT_TIERS = [ // docs table
    { matchCount: 6, name: "Mega Prize", payoutType: "FloatingPct", payoutValue: 0.42 },
    { matchCount: 5, name: "Super Prize", payoutType: "FloatingPct", payoutValue: 0.08 },
    { matchCount: 4, name: "3rd Prize", payoutType: "Fixed", payoutValue: "100" },
    { matchCount: 3, name: "4th Prize", payoutType: "Fixed", payoutValue: "10" },
    { matchCount: 2, name: "5th Prize", payoutType: "Fixed", payoutValue: "5" }
  ];
  const TIER_NAMES = { 6: "Mega Prize", 5: "Super Prize", 4: "3rd Prize", 3: "4th Prize", 2: "5th Prize" };
  // first block (by height) whose timestamp is at or after the draw time. blocks: [{height,id,timestamp(sec)}]
  function pickDrawBlock(blocks, drawSec) {
    const asc = blocks.slice().sort((a, b) => a.height - b.height);
    for (let i = 0; i < asc.length; i++) {
      if (asc[i].timestamp >= drawSec) return { block: asc[i], prev: asc[i - 1] || null, index: i };
    }
    return null;
  }
  function nextMondayDraw(nowMs) { // Monday 03:00 UTC
    const d = new Date(nowMs);
    const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 3, 0, 0);
    const dow = new Date(t).getUTCDay(); // 1 = Monday
    let add = (1 - dow + 7) % 7;
    let cand = t + add * 864e5;
    if (cand <= nowMs) cand += 7 * 864e5;
    return cand;
  }

  // ---------- margin math ----------
  const num = (x) => (x === null || x === undefined || x === "" ? NaN : Number(x));
  function tierRows(tiers) {
    return (tiers || []).map((t) => ({ min: num(t.tierMinAmount), max: num(t.tierMaxAmount), lev: num(t.leverage), mmr: num(t.mmr) }))
      .filter((t) => isFinite(t.min) && isFinite(t.mmr)).sort((a, b) => a.min - b.min);
  }
  // docs /product-docs/trading/margining: progressive tiers, summed
  function mmRateSum(notional, tiers) {
    const rows = tierRows(tiers); if (!rows.length) return NaN;
    let mm = 0;
    for (let i = 0; i < rows.length; i++) {
      const lo = rows[i].min, hi = i === rows.length - 1 ? Infinity : rows[i].max;
      if (notional <= lo) break;
      mm += (Math.min(notional, hi) - lo) * rows[i].mmr;
    }
    return mm;
  }
  // MM = size x (MMR_rate + takerFeeRate) x mark price
  function maintenanceMargin(notional, tiers, takerRate) { return mmRateSum(notional, tiers) + notional * takerRate; }
  function maxLeverageFor(notional, tiers) {
    const rows = tierRows(tiers); if (!rows.length) return NaN;
    for (const r of rows) if (notional >= r.min && notional < r.max) return r.lev;
    return notional < rows[0].min ? rows[0].lev : rows[rows.length - 1].lev;
  }
  // liquidation estimate: mark price P where equity = MM.  equity = C + side*Q*(P-E)
  function liqPrice(o) {
    const { side, entry: E, qty: Q, collateral: C, tiers, taker } = o;
    const f = (P) => C + side * Q * (P - E) - maintenanceMargin(Q * P, tiers, taker);
    if (!(Q > 0) || !(E > 0)) return { price: NaN, status: "invalid" };
    if (f(E) <= 0) return { price: E, status: "immediate" };
    let lo, hi;
    if (side > 0) { lo = 0; hi = E; if (f(lo) > 0) return { price: NaN, status: "none" }; }
    else { lo = E; hi = E * 2; let k = 0; while (f(hi) > 0 && k++ < 40) hi *= 2; if (f(hi) > 0) return { price: NaN, status: "none" }; }
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2, v = f(mid);
      if (side > 0) { if (v > 0) hi = mid; else lo = mid; } else { if (v > 0) lo = mid; else hi = mid; }
      if (Math.abs(hi - lo) <= E * 1e-12) break;
    }
    return { price: (lo + hi) / 2, status: "ok" };
  }
  function floorStep(x, step) { if (!(step > 0)) return x; const k = Math.floor(x / step + 1e-9); return +(k * step).toFixed(12); }
  function calc(i) {
    // i: side(+1/-1), entry, exit, size, unit('usdt'|'qty'), lev, extra, makerRate, takerRate, inMaker, outMaker, tiers, lotSize
    const out = { errors: [] };
    const E = i.entry, X = i.exit, side = i.side;
    if (!(E > 0)) out.errors.push("Enter an entry price.");
    if (!(i.size > 0)) out.errors.push("Enter a size.");
    if (!(i.lev >= 1)) out.errors.push("Leverage must be at least 1x.");
    if (out.errors.length) return out;
    let Q = i.unit === "qty" ? i.size : i.size / E;
    const rawQ = Q;
    if (i.lotSize > 0) Q = floorStep(Q, i.lotSize);
    out.qty = Q; out.rawQty = rawQ; out.rounded = Math.abs(Q - rawQ) > 1e-12;
    if (!(Q > 0)) { out.errors.push("Size is below one lot for this market."); return out; }
    const N0 = Q * E;
    out.notional = N0;
    out.im = N0 / i.lev;
    out.maxLev = maxLeverageFor(N0, i.tiers);
    const rIn = i.inMaker ? i.makerRate : i.takerRate, rOut = i.outMaker ? i.makerRate : i.takerRate;
    out.rateIn = rIn; out.rateOut = rOut;
    out.feeIn = N0 * rIn;                                   // Fee = qty x price x rate
    out.collateral = out.im + (i.extra || 0) - out.feeIn;   // entry fee is deducted at fill
    out.mmEntry = maintenanceMargin(N0, i.tiers, i.takerRate);
    const lq = liqPrice({ side, entry: E, qty: Q, collateral: out.collateral, tiers: i.tiers, taker: i.takerRate });
    out.liq = lq.price; out.liqStatus = lq.status;
    if (X > 0) {
      out.feeOut = Q * X * rOut;
      out.gross = side * (X - E) * Q;
      out.net = out.gross - out.feeIn - out.feeOut;
      out.roe = out.net / out.im;
      out.exitValue = Q * X;
      if (lq.status === "ok") out.exitPastLiq = side > 0 ? X <= lq.price : X >= lq.price;
    }
    if (i.lev > out.maxLev) out.errors.push("For a position of this size PopDEX allows up to " + out.maxLev + "x.");
    return out;
  }

  // ---------- portfolio (cross margin) estimate ----------
  // docs /product-docs/trading/margining: Equity = Total Collateral Value + Unrealized PnL; IMR = ΣIM / Equity; MMR = ΣMM / Equity (liquidation begins at 100%)
  // p: { collateral, positions: [{ side, qty, entry, mark, lev, tiers, taker }] }
  function portfolio(p) {
    const C = Number(p.collateral) || 0;
    const rows = (p.positions || []).map((x) => {
      const n = x.qty * x.mark;
      return Object.assign({}, x, { notional: n, upnl: x.side * x.qty * (x.mark - x.entry), im: n / x.lev,
        mm: maintenanceMargin(n, x.tiers, x.taker), maxLev: maxLeverageFor(n, x.tiers) });
    });
    const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
    const upnl = sum("upnl"), im = sum("im"), mm = sum("mm"), equity = C + upnl;
    const out = { collateral: C, rows, upnl, im, mm, equity, imr: equity > 0 ? im / equity : Infinity, mmr: equity > 0 ? mm / equity : Infinity,
      free: equity - im, buffer: equity - mm };
    // each position's liquidation price with every other position held at its current mark price
    rows.forEach((r, i) => {
      let coll = C;
      rows.forEach((o, j) => { if (j !== i) coll += o.upnl - o.mm; });
      const lq = liqPrice({ side: r.side, entry: r.entry, qty: r.qty, collateral: coll, tiers: r.tiers, taker: r.taker });
      r.liq = lq.price; r.liqStatus = lq.status;
      if (lq.status === "ok") r.liqPast = r.side > 0 ? r.mark <= lq.price : r.mark >= lq.price;
    });
    // one uniform % move against every position at once (longs down, shorts up) that brings equity to total MM
    const g = (x) => {
      let eq = C, need = 0;
      for (const r of rows) { const P = r.mark * (1 - r.side * x); eq += r.side * r.qty * (P - r.entry); need += maintenanceMargin(r.qty * P, r.tiers, r.taker); }
      return eq - need;
    };
    if (!rows.length) out.moveStatus = "invalid";
    else if (g(0) <= 0) { out.move = 0; out.moveStatus = "immediate"; }
    else {
      const onlyLongs = rows.every((r) => r.side > 0);
      let hi = onlyLongs ? 1 : 1, k = 0;
      if (!onlyLongs) while (g(hi) > 0 && k++ < 12) hi *= 2;
      if (g(hi) > 0) out.moveStatus = "none";
      else {
        let lo = 0;
        for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (g(mid) > 0) lo = mid; else hi = mid; if (hi - lo < 1e-12) break; }
        out.move = (lo + hi) / 2; out.moveStatus = "ok";
      }
    }
    return out;
  }

  const api = { popHashFromBlockHash, parseTickets, matchTicket, pickDrawBlock, nextMondayDraw, DEFAULT_TIERS, TIER_NAMES,
    mmRateSum, maintenanceMargin, maxLeverageFor, liqPrice, calc, floorStep, portfolio };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.PDCore = api;
})(typeof self !== "undefined" ? self : this);
