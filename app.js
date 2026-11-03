/* PopDEX Toolkit UI, by @iamlogtun. */
(function () {
  "use strict";
  const C = window.PDCore;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const DOCS = "https://popdex.xyz/docs";
  const ANNOUNCED = { // official @popdex_ posts announcing each draw (also compared against the chain)
    1: { url: "https://x.com/popdex_/status/2114558738157957323", pop: "631548" },
    2: { url: "https://x.com/popdex_/status/2117096995823419517", pop: "428799" }
  };
  const FIRST_DRAW_MS = Date.UTC(2026, 9, 26, 3, 0, 0); // Epoch #1 draw (on-chain endAtMs), fallback schedule only

  function fmtNum(x, dp) {
    if (!isFinite(x)) return "–";
    return Number(x).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  }
  function fmtUSD(x, dp) { if (!isFinite(x)) return "–"; const s = fmtNum(Math.abs(x), dp == null ? 2 : dp); return (x < 0 ? "−" : "") + s + " USDT"; }
  function fmtSigned(x, dp) { if (!isFinite(x)) return "–"; return (x > 0 ? "+" : x < 0 ? "−" : "") + fmtNum(Math.abs(x), dp == null ? 2 : dp); }
  function fmtPrice(x, prec) { if (!isFinite(x)) return "–"; const p = prec == null ? autoPrec(x) : prec; return fmtNum(x, p); }
  function autoPrec(x) { x = Math.abs(x); return x >= 1000 ? 1 : x >= 10 ? 2 : x >= 1 ? 4 : x >= 0.01 ? 5 : 8; }
  function fmtPct(x, dp) { if (!isFinite(x)) return "–"; return fmtSigned(x * 100, dp == null ? 2 : dp) + "%"; }
  function utc(ms, withSec) {
    const d = new Date(ms);
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], mons = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const p = (n) => String(n).padStart(2, "0");
    return days[d.getUTCDay()] + ", " + mons[d.getUTCMonth()] + " " + d.getUTCDate() + ", " + d.getUTCFullYear() + " " + (d.getUTCHours() % 12 || 12) + ":" + p(d.getUTCMinutes()) + (withSec ? ":" + p(d.getUTCSeconds()) : "") + (d.getUTCHours() < 12 ? " AM" : " PM") + " UTC";
  }
  function shortDate(ms) { const d = new Date(ms); return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()] + " " + d.getUTCDate(); }
  function dur(ms) {
    if (ms < 0) ms = 0;
    const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60;
    const p = (n) => String(n).padStart(2, "0");
    return (d ? d + "d " : "") + p(h) + ":" + p(m) + ":" + p(ss);
  }
  function mmss(ms) { if (ms < 0) ms = 0; const s = Math.floor(ms / 1000); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60; const p = (n) => String(n).padStart(2, "0"); return (h ? h + ":" : "") + p(m) + ":" + p(ss); }
  async function getJSON(url, ms) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms || 12000);
    try { const r = await fetch(url, { signal: ctl.signal, headers: { accept: "application/json" } }); if (!r.ok) throw new Error(url + " " + r.status); return await r.json(); }
    finally { clearTimeout(t); }
  }

  // ================= tabs =================
  const TABS = ["megapop", "calc", "funding"];
  function showTab() {
    const id = (location.hash || "#megapop").slice(1).split("?")[0];
    const cur = TABS.includes(id) ? id : "megapop";
    for (const t of TABS) {
      $("#" + t).hidden = t !== cur;
      $("#tab-" + t).setAttribute("aria-selected", String(t === cur));
    }
    if (cur === "calc") { initCalc(); const cm = new URLSearchParams(location.hash.split("?")[1] || "").get("mode"); let sv = null; try { sv = localStorage.getItem("pdx_cmode"); } catch (e) {} setCalcMode(cm === "portfolio" || cm === "single" ? cm : (sv || "single")); }
    if (cur === "funding") initFunding();
  }
  window.addEventListener("hashchange", () => { showTab(); window.scrollTo(0, 0); });

  // ================= shared live data =================
  let boardP = null, configP = null, board = null, config = null;
  function loadBoard(force) {
    if (!boardP || force) boardP = getJSON("/api/board", 15000).then((j) => { board = j; return j; }).catch((e) => { boardP = null; throw e; });
    return boardP;
  }
  function loadConfig() {
    if (!configP) configP = getJSON("/api/config", 15000).then((j) => { config = j; return j; }).catch((e) => { configP = null; throw e; });
    return configP;
  }
  const marketOf = (sym) => board && board.markets.find((m) => m.symbol === sym);
  const symOf = (sym) => config && config.symbols.find((s) => s.symbol === sym);

  // ================= MEGAPOP =================
  const mp = { epochs: [], current: null, sel: null, btc: {}, offline: false, mode: "tickets", wdata: null, waddr: "", last: null, fromLink: false };
  async function loadMegapop() {
    try {
      const j = await getJSON("/api/megapop", 15000);
      if (!j.epochs || !j.epochs.length) throw new Error("empty");
      mp.epochs = j.epochs;
    } catch (e) {
      mp.offline = true;  // fall back to the docs schedule + Bitcoin only
      const now = Date.now(), list = [];
      for (let k = 1, end = FIRST_DRAW_MS; k < 520; k++, end += 7 * 864e5) {
        list.push({ epoch: k, endAtMs: end, startAtMs: end - 7 * 864e5, status: "Unknown", popHash: null, btcBlockHash: null, tiersResult: [], tiersConfig: [], pool: [] });
        if (end > now) break;
      }
      mp.epochs = list;
    }
    const now = Date.now();
    mp.current = mp.epochs.filter((e) => e.endAtMs > now).sort((a, b) => a.endAtMs - b.endAtMs)[0] || null;
    const past = mp.epochs.filter((e) => e.endAtMs <= now).sort((a, b) => b.endAtMs - a.endAtMs);
    const sel = $("#mp-draw");
    sel.innerHTML = past.map((e) => '<option value="' + e.epoch + '">Epoch #' + e.epoch + " · Mon " + shortDate(e.endAtMs) + (e.popHash ? "" : " (awaiting result)") + "</option>").join("") ||
      '<option value="">No draws yet</option>';
    const hp = new URLSearchParams(location.hash.split("?")[1] || "");
    const want = Number(hp.get("e") || hp.get("epoch"));
    if (want && past.some((e) => e.epoch === want)) sel.value = String(want);
    renderNext();
    applyLink(hp);
    selectDraw();
  }
  function epochBy(n) { return mp.epochs.find((e) => e.epoch === n); }
  function poolTotal(e) { return e && e.pool && e.pool[0] ? Number(e.pool[0].total) : NaN; }

  function renderNext() {
    const e = mp.current;
    const target = e ? e.endAtMs : C.nextMondayDraw(Date.now());
    $("#mp-next-when").textContent = (e ? "Epoch #" + e.epoch + " · " : "") + utc(target);
    const pool = poolTotal(e);
    $("#mp-next-pool").innerHTML = isFinite(pool)
      ? stat(fmtNum(pool, 0) + " USDT", "Prize pool now") + stat(fmtNum(pool * 0.42, 0) + " USDT", "Mega Prize (42%)") + stat(fmtNum(pool * 0.08, 0) + " USDT", "Super Prize (8%)")
      : '<div class="small">Pool size unavailable right now.</div>';
    mp.nextTarget = target;
    tickCountdown();
  }
  const stat = (b, s) => '<div class="stat"><b>' + esc(b) + "</b><span>" + esc(s) + "</span></div>";
  function tickCountdown() {
    const left = mp.nextTarget - Date.now();
    $("#mp-countdown").textContent = left > 0 ? dur(left) : "Drawing";
    if (left <= 0 && !mp.reloadAt) { mp.reloadAt = Date.now(); setTimeout(() => { mp.reloadAt = 0; loadMegapop(); }, 120000); }
  }

  // ---- Bitcoin: find the first block at/after the draw time ----
  const PROVIDERS = [
    { name: "mempool.space", base: "https://mempool.space/api", page: (h) => "https://mempool.space/block/" + h },
    { name: "blockstream.info", base: "https://blockstream.info/api", page: (h) => "https://blockstream.info/block/" + h }
  ];
  async function blocksFrom(p, h) { // 10 blocks, h downwards
    const arr = await getJSON(p.base + "/blocks/" + h, 12000);
    return arr.map((b) => ({ height: b.height, id: b.id, timestamp: b.timestamp }));
  }
  async function findDrawBlock(drawMs) {
    const T = Math.floor(drawMs / 1000);
    let lastErr;
    for (const p of PROVIDERS) {
      try {
        const tip = Number(await (await fetch(p.base + "/blocks/tip/height")).text());
        let h0;
        if (p.name === "mempool.space") {
          try { h0 = (await getJSON(p.base + "/v1/mining/blocks/timestamp/" + T, 12000)).height; } catch (e) { h0 = null; }
        }
        if (!h0) h0 = tip - Math.round((Date.now() / 1000 - T) / 600);
        let start = Math.min(tip, h0 + 8);
        for (let k = 0; k < 12; k++) {
          const blocks = await blocksFrom(p, start);
          const asc = blocks.slice().sort((a, b) => a.height - b.height);
          const hit = C.pickDrawBlock(blocks, T);
          if (hit && hit.index > 0) return { provider: p, block: hit.block, prev: hit.prev, tip };
          if (hit && hit.index === 0) { start = asc[0].height - 1 + 5; continue; }   // first block of window already after: look lower
          if (!hit) { if (asc[asc.length - 1].height >= tip) return { provider: p, pending: true, tip }; start = Math.min(tip, start + 9); }
        }
        throw new Error("could not locate block");
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error("bitcoin providers unavailable");
  }

  // One request to the site's own server (result cached there once final); the direct lookup above is the fallback.
  async function drawBlockViaSite(drawMs) {
    const j = await getJSON("/api/btc-draw?t=" + Math.floor(drawMs / 1000), 8000);
    const p = PROVIDERS.find((x) => x.name === j.provider) || PROVIDERS[0];
    if (j.status === "pending") return { provider: p, pending: true, tip: j.tip };
    if (!j.block || !/^[0-9a-f]{64}$/i.test(j.block.id || "") || !Number.isFinite(j.block.height) || !Number.isFinite(j.block.timestamp)) throw new Error("bad btc-draw answer");
    return { provider: p, block: j.block, prev: j.prev || null, tip: j.tip };
  }

  async function selectDraw() {
    const n = Number($("#mp-draw").value);
    const e = epochBy(n);
    mp.sel = e;
    const box = $("#mp-result");
    if (!e) { box.innerHTML = '<div class="loading">No finished draw yet. The first one is on ' + utc(FIRST_DRAW_MS) + ".</div>"; return; }
    renderResult(e);
    runCheck(true);
    if (!mp.btc[n]) {
      mp.btc[n] = { loading: true };
      renderProof(e);
      try { mp.btc[n] = await drawBlockViaSite(e.endAtMs).catch(() => findDrawBlock(e.endAtMs)); } catch (err) { mp.btc[n] = { error: String(err.message || err) }; }
      if (mp.sel === e) { renderResult(e); renderProof(e); if (mp.mode === "tickets") checkTickets(true); else if (mp.wdata) renderWallet(); }
    } else renderProof(e);
  }
  function btcPop(n) { const b = mp.btc[n]; return b && b.block ? C.popHashFromBlockHash(b.block.id) : null; }
  function verdictOf(e) {
    const b = mp.btc[e.epoch], bp = btcPop(e.epoch);
    if (!e.popHash) {
      if (bp) return { cls: "warn", text: "Preview from Bitcoin, not official yet" };
      if (b && b.pending) return { cls: "wait", text: "Waiting for the first block after the draw" };
      return { cls: "wait", text: mp.offline ? "Official result unavailable" : "Awaiting official result" };
    }
    if (!b || b.loading) return { cls: "wait", text: "Checking against Bitcoin…" };
    if (b.error || !bp) return { cls: "wait", text: "Official result (Bitcoin check unavailable)" };
    const same = bp.pop === e.popHash && (!e.btcBlockHash || e.btcBlockHash.toLowerCase() === b.block.id.toLowerCase());
    return same ? { cls: "ok", text: "Matches official result" } : { cls: "bad", text: "Does not match official result" };
  }
  function activePop(e) { if (e.popHash) return e.popHash; const bp = btcPop(e.epoch); return bp ? bp.pop : null; }
  function renderResult(e) {
    const pop = activePop(e), v = verdictOf(e);
    const digits = pop ? pop.split("").map((d) => "<i>" + d + "</i>").join("") : "<i>?</i><i>?</i><i>?</i><i>?</i><i>?</i><i>?</i>";
    let html = '<div class="ph-row"><div><div class="eyebrow">Pop Hash · Epoch #' + e.epoch + '</div><div class="digits" aria-label="Pop Hash ' + (pop || "unknown") + '">' + digits + "</div></div>" +
      '<span class="verdict ' + v.cls + '">' + esc(v.text) + "</span></div>";
    html += '<div class="res-meta">Draw time ' + utc(e.endAtMs) + "</div>";
    const pool = poolTotal(e);
    if (e.tiersResult && e.tiersResult.length) {
      html += '<table class="tiers"><thead><tr><th>Match</th><th>Prize per ticket</th><th>Winning tickets</th></tr></thead><tbody>' +
        e.tiersResult.slice().sort((a, b) => b.matchCount - a.matchCount).map((t) => "<tr><td>" + t.matchCount + "/6 · " + C.TIER_NAMES[t.matchCount] + "</td><td>" +
          (t.tickets ? fmtNum(Number(t.perTicket), 2) + " USDT" : '<span class="small">no winner</span>') + "</td><td>" + fmtNum(t.tickets, 0) + "</td></tr>").join("") + "</tbody></table>";
      const p = e.pool && e.pool[0];
      if (p) html += '<div class="res-meta">Pool ' + fmtNum(pool, 2) + " USDT · paid out " + fmtNum(Number(p.totalPayout), 2) + " USDT · rolled into next draw " + fmtNum(Number(p.rolloverToNext), 2) + " USDT</div>";
    } else if (isFinite(pool)) {
      html += '<div class="res-meta">Pool for this draw: ' + fmtNum(pool, 2) + " USDT</div>";
    }
    $("#mp-result").innerHTML = html;
  }
  function renderProof(e) {
    const b = mp.btc[e.epoch], el = $("#mp-proof");
    el.className = "card proof";
    let h = "<h2>Verify it yourself</h2>";
    if (!b || b.loading) { el.innerHTML = h + '<div class="loading">Finding the first Bitcoin block at or after ' + utc(e.endAtMs) + "…</div>"; return; }
    if (b.error) { el.innerHTML = h + '<div class="small">Could not reach mempool.space or blockstream.info right now (' + esc(b.error) + "). The official result above is still read from PopDEX's chain.</div>" + offLinks(e); return; }
    if (b.pending) { el.innerHTML = h + '<div class="small">No Bitcoin block has been produced since the draw time yet (tip #' + b.tip + "). The Pop Hash appears when it is. Results may take 10–15 minutes while PopDEX waits for confirmations.</div>"; return; }
    const pp = C.popHashFromBlockHash(b.block.id);
    const hashHtml = b.block.id.split("").map((ch, i) => pp.positions.includes(i) ? "<mark>" + ch + "</mark>" : ch).join("");
    h += '<dl class="kv">' +
      "<dt>Bitcoin block</dt><dd>#" + b.block.height + "</dd>" +
      "<dt>Block time</dt><dd>" + utc(b.block.timestamp * 1000, true) + "</dd>" +
      "<dt>Draw time</dt><dd>" + utc(e.endAtMs, true) + "</dd>" +
      (b.prev ? "<dt>Block before</dt><dd>#" + b.prev.height + " at " + utc(b.prev.timestamp * 1000, true) + " (before the draw)</dd>" : "") +
      '<dt>Block hash</dt><dd class="hash">' + hashHtml + "</dd>" +
      "<dt>Last 6 digits</dt><dd><b>" + pp.pop + "</b> (highlighted, letters skipped)</dd>" +
      "<dt>Official</dt><dd>" + (e.popHash ? "<b>" + e.popHash + "</b> from PopDEX's MegaPop contract" + (e.btcBlockHash ? (e.btcBlockHash.toLowerCase() === b.block.id.toLowerCase() ? ", same block" : ", <b>different block</b>: " + esc(e.btcBlockHash)) : "") : "not published yet") + "</dd>" +
      "</dl>";
    h += '<div class="links"><a href="' + b.provider.page(b.block.id) + '" target="_blank" rel="noopener">Block on ' + b.provider.name + ' &rarr;</a><a href="https://www.blockchain.com/explorer/blocks/btc/' + b.block.id + '" target="_blank" rel="noopener">blockchain.com &rarr;</a>' +
      (ANNOUNCED[e.epoch] ? '<a href="' + ANNOUNCED[e.epoch].url + '" target="_blank" rel="noopener">@popdex_ announcement &rarr;</a>' : "") + "</div>";
    el.innerHTML = h;
  }
  function offLinks(e) { return ANNOUNCED[e.epoch] ? '<div class="links"><a href="' + ANNOUNCED[e.epoch].url + '" target="_blank" rel="noopener">@popdex_ announcement &rarr;</a></div>' : ""; }

  function prizeFor(e, count) {
    // returns {text, amount (number or NaN), exact}
    if (count < 2) return { text: "No prize", amount: 0, exact: true };
    const res = (e.tiersResult || []).find((t) => t.matchCount === count);
    if (res) {
      if (res.tickets > 0) return { text: fmtNum(Number(res.perTicket), 2) + " USDT", amount: Number(res.perTicket), exact: true };
      return { text: "No " + count + "/6 ticket in this draw", amount: 0, exact: true, note: "PopDEX's chain shows no " + count + "/6 winner, so this ticket was not entered" };
    }
    const cfg = ((e.tiersConfig && e.tiersConfig.length) ? e.tiersConfig : C.DEFAULT_TIERS).find((t) => t.matchCount === count);
    const pool = poolTotal(e);
    if (!cfg) return { text: "–", amount: NaN };
    if (cfg.payoutType === "FloatingPct") {
      const share = Math.round(cfg.payoutValue * 100);
      return isFinite(pool) ? { text: "≈ " + fmtNum(pool * cfg.payoutValue, 0) + " USDT", amount: pool * cfg.payoutValue, exact: false, note: share + "% of pool, shared by all " + count + "/6 tickets" }
        : { text: share + "% of pool", amount: NaN, exact: false, note: "shared by all " + count + "/6 tickets" };
    }
    return { text: fmtNum(Number(cfg.payoutValue), 0) + " USDT", amount: Number(cfg.payoutValue), exact: false, note: "fixed prize; capped at 40% of pool in total" };
  }
  function checkTickets(silent) {
    const out = $("#mp-out"), txt = $("#mp-tickets").value;
    if (!mp.fromLink) { try { localStorage.setItem("pdx_tickets", txt.slice(0, 200000)); } catch (e) {} }
    mp.last = null; hideShare();
    const e = mp.sel;
    const { valid, invalid } = C.parseTickets(txt);
    if (!valid.length && !invalid.length) { if (!silent) out.innerHTML = '<div class="small">Paste at least one 6-digit ticket number.</div>'; else out.innerHTML = ""; return; }
    if (!e) { out.innerHTML = ""; return; }
    const pop = activePop(e);
    if (!pop) { out.innerHTML = '<div class="small">This draw has no Pop Hash yet, so tickets cannot be checked.</div>'; return; }
    const rows = valid.slice(0, 20000).map((t) => { const m = C.matchTicket(t, pop); return { t, m, p: prizeFor(e, m.count) }; });
    const wins = rows.filter((r) => r.m.count >= 2 && r.p.amount !== 0).sort((a, b) => b.m.count - a.m.count);
    let total = 0, anyEst = false;
    for (const r of wins) { if (isFinite(r.p.amount)) total += r.p.amount; if (!r.p.exact) anyEst = true; }
    const official = !!e.popHash;
    let h = '<div class="sum">' + stat(fmtNum(rows.length, 0), "tickets checked") + stat(fmtNum(wins.length, 0), "winning tickets") +
      stat((anyEst ? "≈ " : "") + fmtNum(total, 2) + " USDT", official && !anyEst ? "total prize" : "estimated total") + "</div>";
    if (!official) h += '<p class="small">This uses the Bitcoin preview. Official prizes are set when PopDEX publishes the draw.</p>';
    const show = wins.concat(rows.filter((r) => !wins.includes(r)).sort((a, b) => b.m.count - a.m.count)).slice(0, 200);
    h += '<div class="tk-list">' + show.map((r) => {
      const digits = r.t.split("").map((d, i) => '<span class="' + (r.m.positions.includes(i) ? "m" : "") + '">' + d + "</span>").join("");
      const cls = r.p.amount === 0 && r.m.count >= 2 ? "tk none" : r.m.count >= 6 ? "tk win mega" : r.m.count >= 2 ? "tk win" : "tk";
      const tier = r.m.count >= 2 ? r.m.count + "/6 · " + C.TIER_NAMES[r.m.count] : r.m.count + "/6 match";
      return '<div class="' + cls + '"><div class="tk-num" aria-label="ticket ' + r.t + '">' + digits + '</div><div class="tk-info"><b>' + esc(r.p.text) + "</b><small>" + esc(tier) + (r.p.note ? " · " + esc(r.p.note) : "") + "</small></div></div>";
    }).join("") + "</div>";
    if (rows.length > show.length) h += '<div class="more">+' + fmtNum(rows.length - show.length, 0) + " more tickets with no prize</div>";
    if (valid.length > 20000) h += '<div class="more">Only the first 20,000 tickets were checked.</div>';
    if (rows.length) {
      const best = rows.slice().sort((a, b) => b.m.count - a.m.count)[0];
      mp.last = { mode: "tickets", epoch: e.epoch, drawMs: e.endAtMs, pop, official, best: best.t, bestPos: best.m.positions, bestCount: best.m.count,
        prize: total, prizeEst: anyEst, count: rows.length, wins: wins.length, tickets: valid.slice(0, 300), more: valid.length > 300 };
      h += shareBar();
    }
    if (invalid.length) h += '<div class="errs"><p>Skipped ' + invalid.length + " entr" + (invalid.length === 1 ? "y" : "ies") + " that are not 6 digits: " + esc(invalid.slice(0, 8).join(", ")) + (invalid.length > 8 ? "…" : "") + "</p></div>";
    out.innerHTML = h;
  }
  $("#mp-draw").addEventListener("change", selectDraw);
  $("#mp-check").addEventListener("click", () => { checkTickets(false); const o = $("#mp-out"); if (o.firstChild) o.scrollIntoView({ behavior: "smooth", block: "start" }); });
  $("#mp-clear").addEventListener("click", () => { $("#mp-tickets").value = ""; mp.fromLink = false; checkTickets(true); });
  $("#mp-tickets").addEventListener("input", () => { mp.fromLink = false; });
  try { const saved = localStorage.getItem("pdx_tickets"); if (saved) $("#mp-tickets").value = saved; } catch (e) {}
  try { const sw = localStorage.getItem("pdx_wallet"); if (sw) $("#mp-wallet").value = sw; if (localStorage.getItem("pdx_mode") === "wallet") setMode("wallet", true); } catch (e) {}

  // ---------- check mode: ticket numbers | wallet ----------
  function setMode(m, silent) {
    mp.mode = m === "wallet" ? "wallet" : "tickets";
    $$("#mp-mode .seg-b").forEach((b) => { const on = b.dataset.v === mp.mode; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); });
    $("#mp-by-tickets").hidden = mp.mode !== "tickets";
    $("#mp-by-wallet").hidden = mp.mode !== "wallet";
    try { localStorage.setItem("pdx_mode", mp.mode); } catch (e) {}
    if (!silent) { $("#mp-out").innerHTML = ""; mp.last = null; hideShare(); runCheck(true); }
  }
  function runCheck(silent) {
    if (mp.mode === "wallet") { if (mp.waddr || ($("#mp-wallet").value || "").trim()) lookupWallet(silent); else { $("#mp-out").innerHTML = ""; mp.last = null; hideShare(); } }
    else checkTickets(silent);
  }
  $("#mp-mode").addEventListener("click", (ev) => { const b = ev.target.closest(".seg-b"); if (b && b.dataset.v !== mp.mode) setMode(b.dataset.v); });
  const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
  const shortAddr = (a) => a.slice(0, 6) + "…" + a.slice(-4);
  function tierToCount(e) { // tier id -> match count, from the epoch's frozen tiers (docs order as fallback)
    const map = {}; const src = (e && e.tiersConfig && e.tiersConfig.length) ? e.tiersConfig : [{ tier: 1, matchCount: 6 }, { tier: 2, matchCount: 5 }, { tier: 3, matchCount: 4 }, { tier: 4, matchCount: 3 }, { tier: 5, matchCount: 2 }];
    for (const t of src) map[Number(t.tier)] = Number(t.matchCount);
    return map;
  }
  async function lookupWallet(silent) {
    const out = $("#mp-out");
    const raw = ($("#mp-wallet").value || "").trim();
    mp.last = null; hideShare();
    if (!raw) { if (!silent) out.innerHTML = '<div class="errs"><p>Paste a wallet address (0x followed by 40 letters/numbers).</p></div>'; return; }
    if (!ADDR_RE.test(raw)) { out.innerHTML = '<div class="errs"><p>That is not a valid EVM wallet address. It should be 0x followed by 40 characters (0–9, a–f), e.g. 0x1234…abcd.</p></div>'; return; }
    const a = raw.toLowerCase();
    if (!mp.fromLink) { try { localStorage.setItem("pdx_wallet", raw); } catch (e) {} }
    const e = mp.sel; const ep = e ? e.epoch : 0;
    mp.waddr = a;
    out.innerHTML = '<div class="loading">Reading tickets for ' + esc(shortAddr(a)) + (ep ? " in Epoch #" + ep : "") + " from PopDEX…</div>";
    const reqId = (mp.wreq = (mp.wreq || 0) + 1);
    try {
      const r = await fetch("/api/wallet?addr=" + a + (ep ? "&epoch=" + ep : ""), { headers: { accept: "application/json" } });
      const j = await r.json().catch(() => ({}));
      if (reqId !== mp.wreq) return;
      if (r.status === 429) throw new Error("Too many lookups right now. Try again in a minute.");
      if (!r.ok) throw new Error(j.error === "bad_address" ? "That is not a valid wallet address." : "PopDEX's API did not answer. Try again in a minute.");
      mp.wdata = j; renderWallet();
    } catch (err) {
      if (reqId !== mp.wreq) return;
      out.innerHTML = '<div class="errs"><p>' + esc(err.message || String(err)) + '</p></div><div class="btn-row"><button class="btn ghost" type="button" id="mp-wretry">Retry</button></div>';
      const b = $("#mp-wretry"); if (b) b.addEventListener("click", () => lookupWallet(false));
    }
  }
  function renderWallet() {
    const j = mp.wdata, out = $("#mp-out"); if (!j) return;
    const e = epochBy(j.epoch) || mp.sel;
    const pop = e ? activePop(e) : null;
    const t2c = tierToCount(e);
    let h = '<div class="w-head"><span>Wallet <b class="mono">' + esc(shortAddr(j.address)) + '</b></span><span class="tag ok">Read-only</span></div>';
    const any = j.summary.some((s) => s.tickets > 0);
    // all epochs
    h += '<table class="tiers w-eps"><thead><tr><th>Epoch</th><th>Tickets</th><th>Best</th><th>Won</th></tr></thead><tbody>' +
      j.summary.slice().reverse().map((s) => {
        const drawn = s.epochStatus === "PayingOut";
        const best = drawn ? (s.bestTier ? (t2c[s.bestTier] || "?") + "/6" : (s.tickets ? "no prize" : "–")) : "draw " + (s.endAtMs ? shortDate(s.endAtMs) : "pending");
        const won = drawn ? (Number(s.won) > 0 ? fmtNum(Number(s.won), 2) + " USDT" : "0") : "–";
        const cur = s.epoch === j.epoch;
        const click = drawn && Array.from($("#mp-draw").options).some((o) => Number(o.value) === s.epoch);
        return '<tr class="' + (cur ? "cur " : "") + (click ? "click" : "") + '"' + (click ? ' data-ep="' + s.epoch + '" tabindex="0"' : "") + "><td>#" + s.epoch + "" + "</td><td>" + (s.tickets == null ? "?" : fmtNum(s.tickets, 0)) + "</td><td>" + best + "</td><td>" + won + "</td></tr>";
      }).join("") + "</tbody></table>";
    if (!any) {
      h += '<div class="small">No MegaPop tickets for this wallet in any epoch. Tickets are issued to the main wallet you trade with on PopDEX; an Agent/API key or sub-account address holds none.</div>';
      out.innerHTML = h; return;
    }
    const s = j.summary.find((x) => x.epoch === j.epoch) || {};
    h += '<h3 class="w-sub">Epoch #' + j.epoch + (pop ? " · Pop Hash " + pop : "") + "</h3>";
    if (!s.tickets) { h += '<div class="small">This wallet has no tickets in Epoch #' + j.epoch + ". Tap another epoch above.</div>"; out.innerHTML = h; return; }
    const rows = j.tickets.map((t) => {
      const m = pop ? C.matchTicket(t.n, pop) : { count: 0, positions: [] };
      const apiCount = t.tier ? t2c[t.tier] || 0 : 0;
      return { t, m, apiCount, mismatch: pop && t.tier && apiCount !== m.count || (pop && !t.tier && m.count >= 2 && t.st !== "Pending" && t.st !== "Lost" ? false : false) };
    });
    const mism = rows.filter((r) => pop && ((r.t.tier && r.apiCount !== r.m.count) || (!r.t.tier && r.t.st === "Lost" && r.m.count >= 2 && prizeFor(e, r.m.count).amount > 0))).length;
    const wins = rows.filter((r) => Number(r.t.won) > 0 || r.t.tier > 0).sort((a, b) => (b.apiCount - a.apiCount) || (Number(b.t.won) - Number(a.t.won)));
    const won = Number(s.won) || wins.reduce((x, r) => x + Number(r.t.won || 0), 0);
    h += '<div class="sum">' + stat(fmtNum(s.tickets, 0), "tickets") + stat(fmtNum(s.winningTickets != null ? s.winningTickets : wins.length, 0), "winning tickets") + stat(fmtNum(won, 2) + " USDT", "won (official)") + "</div>";
    const checks = [];
    if (s.onchainTickets != null) checks.push(s.onchainTickets === s.tickets ? "Ticket count matches PopDEX's MegaPop contract (" + fmtNum(s.onchainTickets, 0) + ")." : "Heads up: PopDEX's contract shows " + fmtNum(s.onchainTickets, 0) + " tickets, the API " + fmtNum(s.tickets, 0) + ".");
    if (pop) checks.push(mism ? mism + " ticket" + (mism === 1 ? "" : "s") + " did not match this page's own check against Pop Hash " + pop + "." : "Every ticket re-checked against Pop Hash " + pop + ": all tiers match.");
    if (j.truncated) checks.push("Showing " + fmtNum(j.tickets.length, 0) + " of " + fmtNum(j.ticketsTotal, 0) + " tickets (every winning ticket included).");
    h += '<p class="small ok-line">' + checks.map(esc).join(" ") + "</p>";
    const rest = rows.filter((r) => !wins.includes(r)).sort((a, b) => b.m.count - a.m.count);
    const show = wins.concat(rest).slice(0, 200);
    h += '<div class="tk-list">' + show.map((r) => {
      const digits = r.t.n.split("").map((d, i) => '<span class="' + (r.m.positions.includes(i) ? "m" : "") + '">' + d + "</span>").join("");
      const amt = Number(r.t.won);
      const isWin = r.t.tier > 0 || amt > 0;
      const cnt = r.t.tier ? r.apiCount : r.m.count;
      const cls = isWin ? (cnt >= 6 ? "tk win mega" : "tk win") : "tk";
      const tier = isWin ? cnt + "/6 · " + C.TIER_NAMES[cnt] : r.m.count + "/6 match";
      const st = r.t.st && r.t.st !== "Lost" ? " · " + r.t.st : "";
      return '<div class="' + cls + '"><div class="tk-num" aria-label="ticket ' + r.t.n + '">' + digits + '</div><div class="tk-info"><b>' + (isWin ? fmtNum(amt, 2) + " USDT" : "No prize") + "</b><small>" + esc(tier + st) + "</small></div></div>";
    }).join("") + "</div>";
    if (rows.length > show.length) h += '<div class="more">+' + fmtNum(rows.length - show.length, 0) + " more tickets with no prize</div>";
    if (pop) {
      const best = rows.slice().sort((a, b) => b.m.count - a.m.count)[0];
      mp.last = { mode: "wallet", epoch: j.epoch, drawMs: e ? e.endAtMs : s.endAtMs, pop, official: !!(e && e.popHash), best: best.t.n, bestPos: best.m.positions, bestCount: best.m.count,
        prize: won, prizeEst: false, count: s.tickets, wins: s.winningTickets != null ? s.winningTickets : wins.length, wallet: j.address };
      h += shareBar();
    }
    out.innerHTML = h;
  }
  $("#mp-wcheck").addEventListener("click", () => { mp.fromLink = false; lookupWallet(false).then(() => { const o = $("#mp-out"); if (o.firstChild) o.scrollIntoView({ behavior: "smooth", block: "start" }); }); });
  $("#mp-wallet").addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); $("#mp-wcheck").click(); } });
  $("#mp-wallet").addEventListener("input", () => { mp.fromLink = false; });
  $("#mp-wclear").addEventListener("click", () => { $("#mp-wallet").value = ""; mp.waddr = ""; mp.wdata = null; mp.last = null; hideShare(); $("#mp-out").innerHTML = ""; try { localStorage.removeItem("pdx_wallet"); } catch (e) {} });
  $("#mp-out").addEventListener("click", (ev) => {
    const tr = ev.target.closest("tr[data-ep]");
    if (tr) { $("#mp-draw").value = tr.dataset.ep; selectDraw(); return; }
    const b = ev.target.closest("[data-act]"); if (!b) return;
    if (b.dataset.act === "share") openShare();
    if (b.dataset.act === "link") copyLink(b);
  });
  $("#mp-out").addEventListener("keydown", (ev) => { const tr = ev.target.closest("tr[data-ep]"); if (tr && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); tr.click(); } });

  // ---------- share link ----------
  function applyLink(hp) {
    const w = (hp.get("w") || "").trim(), t = (hp.get("t") || "").trim();
    if (w && ADDR_RE.test(w)) { mp.fromLink = true; $("#mp-wallet").value = w; setMode("wallet", true); }
    else if (t) {
      const list = t.split(/[^0-9]+/).filter((x) => /^\d{6}$/.test(x)).slice(0, 2000);
      if (list.length) { mp.fromLink = true; $("#mp-tickets").value = list.join(" "); setMode("tickets", true); }
    }
  }
  function shareURL() {
    const L = mp.last; if (!L) return location.origin + "/#megapop";
    const base = location.origin + location.pathname + "#megapop?e=" + L.epoch;
    return L.mode === "wallet" ? base + "&w=" + L.wallet : base + "&t=" + L.tickets.join(",");
  }
  async function copyText(s) {
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(s); return true; } } catch (e) {}
    const ta = document.createElement("textarea"); ta.value = s; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.top = "-1000px"; document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch (e) {} ta.remove(); return ok;
  }
  async function copyLink(btn) {
    const url = shareURL(); const ok = await copyText(url);
    const old = btn.dataset.label || btn.textContent; btn.dataset.label = old;
    btn.textContent = ok ? "Link copied" : "Copy failed"; setTimeout(() => { btn.textContent = old; }, 1800);
    if (!ok) window.prompt("Copy this link:", url);
    
  }
  function shareBar() {
    return '<div class="btn-row share-bar"><button type="button" class="btn primary" data-act="share">Share result</button></div>';
  }

  // ---------- share card (1200 × 675, drawn in the browser) ----------
  const SITE = "popdex-tools.sites.tab.bot";
  const CARD_SITE = "popdex-toolkit.vercel.app"; // URL printed on share cards
  let avatarImg = null;
  function loadAvatar() {
    if (avatarImg) return avatarImg;
    avatarImg = new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = "avatar-192.png?v=4"; });
    return avatarImg;
  }
  function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function fitText(ctx, text, maxW, size, weight, family) {
    let s = size; do { ctx.font = weight + " " + s + "px " + family; if (ctx.measureText(text).width <= maxW) break; s -= 2; } while (s > 12);
    return s;
  }
  const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif';
  const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace';
  function longDate(ms) { const d = new Date(ms); return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()] + ", " + ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()] + " " + d.getUTCDate() + ", " + d.getUTCFullYear(); }
  async function drawCardClassic(L, showWallet) {
    const W = 1200, Hh = 675, cv = document.createElement("canvas"); cv.width = W; cv.height = Hh;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#0E0E0E"; ctx.fillRect(0, 0, W, Hh);
    let g = ctx.createRadialGradient(160, -40, 20, 160, -40, 760); g.addColorStop(0, "rgba(72,61,243,0.62)"); g.addColorStop(1, "rgba(72,61,243,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, Hh);
    g = ctx.createRadialGradient(1120, 700, 10, 1120, 700, 520); g.addColorStop(0, "rgba(100,90,255,0.30)"); g.addColorStop(1, "rgba(100,90,255,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, Hh);
    ctx.strokeStyle = "rgba(128,119,255,0.35)"; ctx.lineWidth = 2; rr(ctx, 14, 14, W - 28, Hh - 28, 28); ctx.stroke();
    // header
    const av = await loadAvatar();
    if (av) { ctx.save(); ctx.beginPath(); ctx.arc(96, 92, 36, 0, Math.PI * 2); ctx.clip(); ctx.drawImage(av, 60, 56, 72, 72); ctx.restore();
      ctx.strokeStyle = "rgba(100,90,255,0.7)"; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(96, 92, 37.5, 0, Math.PI * 2); ctx.stroke(); }
    ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
    ctx.fillStyle = "#FFFFFF"; ctx.font = "800 34px " + SANS; ctx.fillText("PopDEX Toolkit", 150, 88);
    ctx.fillStyle = "#B8B8B8"; ctx.font = "500 21px " + SANS; ctx.fillText("MegaPop Draw Checker", 150, 118);
    // epoch pill
    ctx.textAlign = "right";
    const pill = "EPOCH #" + L.epoch; ctx.font = "800 24px " + SANS; const pw = ctx.measureText(pill).width + 40;
    ctx.fillStyle = "#483DF3"; rr(ctx, W - 60 - pw, 58, pw, 46, 23); ctx.fill();
    ctx.fillStyle = "#FFFFFF"; ctx.fillText(pill, W - 80, 90);
    ctx.fillStyle = "#B8B8B8"; ctx.font = "500 20px " + SANS; ctx.fillText("Pop Draw · " + longDate(L.drawMs), W - 60, 134);
    // Pop Hash boxes
    ctx.textAlign = "left"; ctx.fillStyle = "#8A8A90"; ctx.font = "700 19px " + SANS;
    ctx.fillText("POP HASH" + (L.official ? "" : " (PREVIEW)"), 64, 204);
    const bw = 92, bh = 112, gap = 14, x0 = 64, y0 = 220;
    for (let i = 0; i < 6; i++) {
      const hit = L.bestPos.includes(i), x = x0 + i * (bw + gap);
      ctx.fillStyle = hit ? "#483DF3" : "#1E1F22"; rr(ctx, x, y0, bw, bh, 16); ctx.fill();
      ctx.strokeStyle = hit ? "#8077FF" : "#2A2B31"; ctx.lineWidth = 2; rr(ctx, x, y0, bw, bh, 16); ctx.stroke();
      ctx.fillStyle = "#FFFFFF"; ctx.font = "800 68px " + MONO; ctx.textAlign = "center"; ctx.fillText(L.pop[i], x + bw / 2, y0 + 80);
    }
    // best ticket
    ctx.textAlign = "left"; ctx.fillStyle = "#8A8A90"; ctx.font = "700 19px " + SANS;
    ctx.fillText(L.mode === "wallet" || L.count > 1 ? "BEST TICKET" : "TICKET", 64, 398);
    const tw = 62, th = 74, tg = 10, ty = 414;
    for (let i = 0; i < 6; i++) {
      const hit = L.bestPos.includes(i), x = x0 + i * (tw + tg);
      ctx.fillStyle = hit ? "rgba(174,240,97,0.14)" : "#171819"; rr(ctx, x, ty, tw, th, 12); ctx.fill();
      ctx.strokeStyle = hit ? "#AEF061" : "#2A2B31"; ctx.lineWidth = 2; rr(ctx, x, ty, tw, th, 12); ctx.stroke();
      ctx.fillStyle = hit ? "#AEF061" : "#B8B8B8"; ctx.font = "800 44px " + MONO; ctx.textAlign = "center"; ctx.fillText(L.best[i], x + tw / 2, ty + 53);
    }
    ctx.textAlign = "left"; ctx.fillStyle = "#8A8A90"; ctx.font = "500 20px " + SANS;
    ctx.fillText("Matching digits highlighted (same digit, same position)", 64, 530);
    // headline (right column)
    const rx = 760, rw = W - 64 - rx; ctx.textAlign = "left";
    const won = L.bestCount >= 2 && (L.prize > 0 || L.mode === "tickets");
    ctx.fillStyle = won ? "#AEF061" : "#FFFFFF";
    fitText(ctx, L.bestCount + "/6", rw, 170, "900", SANS); ctx.fillText(L.bestCount + "/6", rx, 372);
    ctx.fillStyle = "#FFFFFF"; fitText(ctx, "on Epoch #" + L.epoch, rw, 44, "800", SANS); ctx.fillText("on Epoch #" + L.epoch, rx, 428);
    let prizeLine = L.prize > 0 ? (L.mode === "wallet" ? "Won " : L.official && !L.prizeEst ? "Prize " : "Prize ≈ ") + fmtNum(L.prize, 2) + " USDT" : (L.bestCount >= 2 ? "Prize per official result" : "No prize this time");
    ctx.fillStyle = L.prize > 0 ? "#BDB9FF" : "#B8B8B8"; fitText(ctx, prizeLine, rw, 38, "800", SANS); ctx.fillText(prizeLine, rx, 484);
    const sub = fmtNum(L.count, 0) + " ticket" + (L.count === 1 ? "" : "s") + " checked · " + fmtNum(L.wins, 0) + " winning";
    ctx.fillStyle = "#8A8A90"; fitText(ctx, sub, rw, 22, "500", SANS); ctx.fillText(sub, rx, 524);
    if (showWallet && L.wallet) { const ws = "Wallet " + shortAddr(L.wallet); ctx.fillStyle = "#8A8A90"; fitText(ctx, ws, rw, 22, "500", MONO); ctx.fillText(ws, rx, 556); }
    // footer
    ctx.strokeStyle = "#2A2B31"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(64, 584); ctx.lineTo(W - 64, 584); ctx.stroke();
    ctx.textAlign = "left"; ctx.fillStyle = "#BDB9FF"; ctx.font = "700 24px " + SANS; ctx.fillText(CARD_SITE, 64, 626);
    ctx.textAlign = "right"; ctx.fillStyle = "#8A8A90"; ctx.font = "500 18px " + SANS; ctx.fillText("The trader-first perp DEX", W - 64, 625);
    return cv;
  }
  // ---------- rotating card designs (Epoch 1-2: classic; Epoch 3+: designs 1-5 by (epoch - 3) mod 5) ----------
  const CARD_FORCE = (() => { try { const m = /[?&]card=([0-5])(?:&|$)/.exec(location.search || ""); return m ? Number(m[1]) : -1; } catch (e) { return -1; } })();
  function cardDesign(epoch) {
    if (CARD_FORCE >= 0) return CARD_FORCE; // hidden test hook (?card=0..5); never set by the site itself
    const e = Number(epoch);
    if (!(e >= 3) || !isFinite(e)) return 0;
    return ((Math.floor(e) - 3) % 5) + 1;
  }
  function cardTexts(L, showWallet) {
    const won = L.bestCount >= 2 && (L.prize > 0 || L.mode === "tickets");
    const hasPrize = L.prize > 0;
    const prefix = hasPrize ? (L.mode === "wallet" ? "Won" : L.official && !L.prizeEst ? "Prize" : "Prize ≈") : "";
    const amount = hasPrize ? fmtNum(L.prize, 2) + " USDT" : "";
    const prizeLine = hasPrize ? prefix + " " + amount : (L.bestCount >= 2 ? "Prize per official result" : "No prize this time");
    return {
      won, hasPrize, prefix, amount, prizeLine,
      sub: fmtNum(L.count, 0) + " ticket" + (L.count === 1 ? "" : "s") + " checked · " + fmtNum(L.wins, 0) + " winning",
      wallet: showWallet && L.wallet ? "Wallet " + shortAddr(L.wallet) : "",
      hashLabel: "POP HASH" + (L.official ? "" : " (PREVIEW)"),
      tLabel: L.mode === "wallet" || L.count > 1 ? "BEST TICKET" : "TICKET",
      big: L.bestCount + "/6", onEp: "on Epoch #" + L.epoch, pill: "EPOCH #" + L.epoch,
      date: "Pop Draw · " + longDate(L.drawMs),
      note: "Matching digits highlighted (same digit, same position)",
      bigColor: won ? "#AEF061" : "#FFFFFF"
    };
  }
  function cvText(ctx, text, x, y, opt) {
    ctx.textAlign = opt.align || "left"; ctx.fillStyle = opt.color || "#FFFFFF";
    if (opt.maxW) fitText(ctx, text, opt.maxW, opt.size, opt.weight || "700", opt.family || SANS);
    else ctx.font = (opt.weight || "700") + " " + opt.size + "px " + (opt.family || SANS);
    ctx.fillText(text, x, y);
  }
  function glowAt(ctx, x, y, r, rgb, a) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, "rgba(" + rgb + "," + a + ")"); g.addColorStop(1, "rgba(" + rgb + ",0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, 1200, 675);
  }
  function avatarAt(ctx, av, cx, cy, r, ring) {
    if (!av) return;
    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip(); ctx.drawImage(av, cx - r, cy - r, r * 2, r * 2); ctx.restore();
    ctx.strokeStyle = ring || "rgba(100,90,255,0.7)"; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(cx, cy, r + 1.5, 0, Math.PI * 2); ctx.stroke();
  }
  function headerAt(ctx, av, x, cy, r, tSize, sSize, tColor, sColor) {
    avatarAt(ctx, av, x + r, cy, r);
    const tx = av ? x + r * 2 + 18 : x;
    cvText(ctx, "PopDEX Toolkit", tx, cy - 2, { size: tSize, weight: "800", color: tColor || "#FFFFFF" });
    cvText(ctx, "MegaPop Draw Checker", tx, cy + sSize + 6, { size: sSize, weight: "500", color: sColor || "#B8B8B8" });
  }
  function pillAt(ctx, text, xRight, y, h, size, fill, color) {
    ctx.font = "800 " + size + "px " + SANS; const w = ctx.measureText(text).width + h * 0.9;
    ctx.fillStyle = fill; rr(ctx, xRight - w, y, w, h, h / 2); ctx.fill();
    ctx.textAlign = "center"; ctx.fillStyle = color || "#FFFFFF"; ctx.fillText(text, xRight - w / 2, y + h / 2 + size * 0.36);
    return w;
  }
  function wrapLines(ctx, text, maxW) {
    const words = text.split(" "), out = []; let cur = "";
    for (const w of words) { const t = cur ? cur + " " + w : w; if (cur && ctx.measureText(t).width > maxW) { out.push(cur); cur = w; } else cur = t; }
    if (cur) out.push(cur); return out;
  }
  function footerAt(ctx, y, siteColor, tagColor, x0, x1) {
    cvText(ctx, CARD_SITE, x0 == null ? 64 : x0, y, { size: 24, weight: "700", color: siteColor || "#BDB9FF" });
    cvText(ctx, "The trader-first perp DEX", x1 == null ? 1136 : x1, y, { size: 21, weight: "600", color: tagColor || "#8A8A90", align: "right" });
  }
  function digitCells(ctx, digits, pos, x0, y0, w, h, gap, size, style) {
    for (let i = 0; i < 6; i++) {
      const hit = pos.includes(i), x = x0 + i * (w + gap), s = style(hit);
      ctx.fillStyle = s.fill; rr(ctx, x, y0, w, h, s.r || 12); ctx.fill();
      if (s.stroke) { ctx.strokeStyle = s.stroke; ctx.lineWidth = s.lw || 2; rr(ctx, x, y0, w, h, s.r || 12); ctx.stroke(); }
      ctx.textAlign = "center"; ctx.fillStyle = s.color; ctx.font = "800 " + size + "px " + MONO;
      ctx.fillText(digits[i], x + w / 2, y0 + h / 2 + size * 0.36);
    }
  }
  function prng(seed) { let s = 0; for (const c of String(seed)) s = (s * 31 + c.charCodeAt(0)) >>> 0; s = s || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

  // Design 1 · Hero: giant result number, concentric rings, digits in a side panel
  function drawD1(ctx, L, T, av) {
    ctx.fillStyle = "#0E0E0E"; ctx.fillRect(0, 0, 1200, 675);
    glowAt(ctx, 300, 380, 560, "72,61,243", 0.55); glowAt(ctx, 1150, -40, 520, "100,90,255", 0.28);
    for (const [r, a] of [[200, 0.22], [270, 0.15], [345, 0.10], [425, 0.06]]) { ctx.strokeStyle = "rgba(128,119,255," + a + ")"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(250, 340, r, 0, Math.PI * 2); ctx.stroke(); }
    headerAt(ctx, av, 64, 84, 32, 30, 19);
    pillAt(ctx, T.pill, 1136, 52, 46, 24, "#483DF3");
    cvText(ctx, T.date, 1136, 132, { size: 20, weight: "500", color: "#B8B8B8", align: "right" });
    ctx.save(); ctx.shadowColor = T.won ? "rgba(174,240,97,0.35)" : "rgba(100,90,255,0.6)"; ctx.shadowBlur = 40;
    cvText(ctx, T.big, 58, 376, { size: 236, weight: "900", color: T.bigColor, maxW: 600 }); ctx.restore();
    cvText(ctx, T.onEp, 64, 452, { size: 46, weight: "800", maxW: 620 });
    cvText(ctx, T.prizeLine, 64, 506, { size: 40, weight: "800", color: T.hasPrize ? "#BDB9FF" : "#B8B8B8", maxW: 620 });
    cvText(ctx, T.sub + (T.wallet ? "  ·  " + T.wallet : ""), 64, 548, { size: 22, weight: "500", color: "#8A8A90", maxW: 640 });
    // side panel
    const px = 736, py = 176, pw = 400, ph = 372;
    ctx.fillStyle = "rgba(23,24,25,0.88)"; rr(ctx, px, py, pw, ph, 24); ctx.fill();
    ctx.strokeStyle = "rgba(128,119,255,0.35)"; ctx.lineWidth = 2; rr(ctx, px, py, pw, ph, 24); ctx.stroke();
    cvText(ctx, T.hashLabel, px + 24, py + 44, { size: 18, weight: "700", color: "#8A8A90", maxW: pw - 48 });
    digitCells(ctx, L.pop, L.bestPos, px + 24, py + 60, 52, 76, 9.6, 46, (hit) => ({ fill: hit ? "#483DF3" : "#1E1F22", stroke: hit ? "#8077FF" : "#2A2B31", color: "#FFFFFF" }));
    cvText(ctx, T.tLabel, px + 24, py + 178, { size: 18, weight: "700", color: "#8A8A90" });
    digitCells(ctx, L.best, L.bestPos, px + 24, py + 194, 52, 70, 9.6, 40, (hit) => ({ fill: hit ? "rgba(174,240,97,0.14)" : "#121314", stroke: hit ? "#AEF061" : "#2A2B31", color: hit ? "#AEF061" : "#B8B8B8" }));
    ctx.font = "500 18px " + SANS; const nl = wrapLines(ctx, T.note, pw - 48);
    nl.forEach((t, i) => cvText(ctx, t, px + 24, py + 304 + i * 25, { size: 18, weight: "500", color: "#8A8A90" }));
    ctx.strokeStyle = "#2A2B31"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(64, 588); ctx.lineTo(1136, 588); ctx.stroke();
    footerAt(ctx, 632);
  }

  // Design 2 · Lottery ticket: purple ticket with ball digits and a dark result stub
  function drawD2(ctx, L, T, av) {
    ctx.fillStyle = "#0E0E0E"; ctx.fillRect(0, 0, 1200, 675);
    ctx.fillStyle = "rgba(255,255,255,0.05)"; for (let y = 12; y < 675; y += 26) for (let x = 12; x < 1200; x += 26) ctx.fillRect(x, y, 2, 2);
    glowAt(ctx, 200, 60, 620, "72,61,243", 0.35);
    const tx = 48, ty = 36, tw = 1104, th = 524, perf = 806, nr = 22;
    const oc = document.createElement("canvas"); oc.width = 1200; oc.height = 675; const o = oc.getContext("2d");
    let g = o.createLinearGradient(tx, ty, perf, ty + th); g.addColorStop(0, "#5656F5"); g.addColorStop(0.55, "#483DF3"); g.addColorStop(1, "#3B30D9");
    o.save(); rr(o, tx, ty, perf - tx, th, 26); o.clip(); o.fillStyle = g; o.fillRect(tx, ty, perf - tx + 30, th);
    o.strokeStyle = "rgba(255,255,255,0.05)"; o.lineWidth = 18; for (let x = -400; x < 900; x += 56) { o.beginPath(); o.moveTo(x, ty + th); o.lineTo(x + th, ty); o.stroke(); }
    o.restore();
    o.save(); rr(o, perf - 26, ty, tx + tw - perf + 26, th, 26); o.clip(); o.fillStyle = "#171819"; o.fillRect(perf, ty, tx + tw - perf, th); o.restore();
    o.globalCompositeOperation = "destination-out";
    for (const cy of [ty, ty + th]) { o.beginPath(); o.arc(perf, cy, nr, 0, Math.PI * 2); o.fill(); }
    o.globalCompositeOperation = "source-over";
    o.strokeStyle = "rgba(255,255,255,0.35)"; o.lineWidth = 3; o.setLineDash([10, 10]); o.beginPath(); o.moveTo(perf, ty + nr + 10); o.lineTo(perf, ty + th - nr - 10); o.stroke(); o.setLineDash([]);
    ctx.save(); ctx.shadowColor = "rgba(0,0,0,0.5)"; ctx.shadowBlur = 40; ctx.shadowOffsetY = 12; ctx.drawImage(oc, 0, 0); ctx.restore();
    // main part
    headerAt(ctx, av, 88, 106, 30, 30, 19, "#FFFFFF", "rgba(255,255,255,0.78)");
    cvText(ctx, T.date, perf - 40, 112, { size: 19, weight: "600", color: "rgba(255,255,255,0.85)", align: "right", maxW: 300 });
    cvText(ctx, T.hashLabel, 88, 204, { size: 18, weight: "700", color: "rgba(255,255,255,0.78)" });
    for (let i = 0; i < 6; i++) {
      const hit = L.bestPos.includes(i), cx = 136 + i * 110, cy = 274;
      ctx.fillStyle = hit ? "#FFFFFF" : "rgba(14,14,14,0.30)"; ctx.beginPath(); ctx.arc(cx, cy, 46, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = hit ? "#AEF061" : "rgba(255,255,255,0.32)"; ctx.lineWidth = hit ? 5 : 2; ctx.beginPath(); ctx.arc(cx, cy, hit ? 49 : 46, 0, Math.PI * 2); ctx.stroke();
      ctx.textAlign = "center"; ctx.fillStyle = hit ? "#483DF3" : "#FFFFFF"; ctx.font = "800 54px " + MONO; ctx.fillText(L.pop[i], cx, cy + 19);
    }
    cvText(ctx, T.tLabel, 88, 372, { size: 18, weight: "700", color: "rgba(255,255,255,0.78)" });
    digitCells(ctx, L.best, L.bestPos, 90, 388, 92, 72, 18, 44, (hit) => ({ fill: hit ? "#0E0E0E" : "rgba(14,14,14,0.28)", stroke: hit ? "#AEF061" : "rgba(255,255,255,0.25)", color: hit ? "#AEF061" : "rgba(255,255,255,0.85)" }));
    cvText(ctx, T.note, 88, 508, { size: 19, weight: "500", color: "rgba(255,255,255,0.75)", maxW: perf - 128 });
    // stub
    const sc = perf + (tx + tw - perf) / 2, sw = tx + tw - perf - 60;
    ctx.font = "800 22px " + SANS; const pw = ctx.measureText(T.pill).width + 40;
    ctx.fillStyle = "#483DF3"; rr(ctx, sc - pw / 2, 76, pw, 42, 21); ctx.fill();
    cvText(ctx, T.pill, sc, 105, { size: 22, weight: "800", align: "center" });
    cvText(ctx, T.big, sc, 262, { size: 140, weight: "900", color: T.bigColor, align: "center", maxW: sw });
    cvText(ctx, T.onEp, sc, 312, { size: 30, weight: "800", align: "center", maxW: sw });
    if (T.hasPrize) {
      cvText(ctx, T.prefix, sc, 370, { size: 22, weight: "700", color: "#8A8A90", align: "center", maxW: sw });
      cvText(ctx, T.amount, sc, 414, { size: 38, weight: "800", color: "#BDB9FF", align: "center", maxW: sw });
    } else {
      ctx.font = "800 28px " + SANS; const pl = wrapLines(ctx, T.prizeLine, sw);
      pl.forEach((t, i) => cvText(ctx, t, sc, 378 + i * 36 - (pl.length - 1) * 8, { size: 28, weight: "800", color: "#B8B8B8", align: "center", maxW: sw }));
    }
    cvText(ctx, T.sub, sc, 466, { size: 19, weight: "500", color: "#8A8A90", align: "center", maxW: sw });
    if (T.wallet) cvText(ctx, T.wallet, sc, 498, { size: 18, weight: "500", color: "#8A8A90", align: "center", maxW: sw, family: MONO });
    footerAt(ctx, 626, "#BDB9FF", "#8A8A90", 52, 1148);
  }

  // Design 3 · Bitcoin block: hex-grid background, Pop Hash digits as chained blocks
  function drawD3(ctx, L, T, av) {
    ctx.fillStyle = "#0E0E0E"; ctx.fillRect(0, 0, 1200, 675);
    const rnd = prng("e" + L.epoch + L.pop), hex = "0123456789abcdef";
    ctx.font = "500 15px " + MONO; ctx.textAlign = "left"; ctx.fillStyle = "rgba(128,119,255,0.10)";
    for (let y = 22; y < 690; y += 24) { let s = ""; for (let k = 0; k < 140; k++) s += hex[Math.floor(rnd() * 16)]; ctx.fillText(s, -6, y); }
    let g = ctx.createLinearGradient(0, 0, 0, 675); g.addColorStop(0, "rgba(14,14,14,0.55)"); g.addColorStop(0.5, "rgba(14,14,14,0.25)"); g.addColorStop(1, "rgba(14,14,14,0.75)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, 1200, 675);
    glowAt(ctx, 420, 300, 520, "72,61,243", 0.42); glowAt(ctx, 1000, 380, 380, "100,90,255", 0.22);
    headerAt(ctx, av, 64, 82, 30, 30, 19);
    pillAt(ctx, T.pill, 1136, 52, 46, 24, "#483DF3");
    cvText(ctx, T.date, 1136, 132, { size: 20, weight: "500", color: "#B8B8B8", align: "right" });
    cvText(ctx, T.hashLabel, 64, 200, { size: 19, weight: "700", color: "#9A9AA2" });
    const bw = 92, d = 16, step = 122, by = 234;
    for (let i = 0; i < 6; i++) {
      const hit = L.bestPos.includes(i), x = 64 + i * step;
      if (i < 5) { // chain link to next block
        const lx = x + bw + d - 2, ly = by + bw / 2 - 4;
        ctx.strokeStyle = hit && L.bestPos.includes(i + 1) ? "#8077FF" : "#4A4B55"; ctx.lineWidth = 4; rr(ctx, lx, ly, step - bw - d + 6, 12, 6); ctx.stroke();
      }
      ctx.fillStyle = hit ? "#645AFF" : "#2A2B31"; ctx.beginPath(); ctx.moveTo(x, by); ctx.lineTo(x + d, by - d); ctx.lineTo(x + bw + d, by - d); ctx.lineTo(x + bw, by); ctx.closePath(); ctx.fill();
      ctx.fillStyle = hit ? "#3328C9" : "#141518"; ctx.beginPath(); ctx.moveTo(x + bw, by); ctx.lineTo(x + bw + d, by - d); ctx.lineTo(x + bw + d, by + bw - d); ctx.lineTo(x + bw, by + bw); ctx.closePath(); ctx.fill();
      ctx.fillStyle = hit ? "#483DF3" : "#1E1F22"; ctx.fillRect(x, by, bw, bw);
      ctx.strokeStyle = hit ? "#8077FF" : "#2A2B31"; ctx.lineWidth = 2; ctx.strokeRect(x + 1, by + 1, bw - 2, bw - 2);
      ctx.textAlign = "center"; ctx.fillStyle = "#FFFFFF"; ctx.font = "800 60px " + MONO; ctx.fillText(L.pop[i], x + bw / 2, by + bw / 2 + 22);
    }
    cvText(ctx, T.tLabel, 64, 384, { size: 19, weight: "700", color: "#9A9AA2" });
    digitCells(ctx, L.best, L.bestPos, 64, 400, 92, 68, 30, 42, (hit) => ({ r: 6, fill: hit ? "rgba(174,240,97,0.14)" : "rgba(23,24,25,0.9)", stroke: hit ? "#AEF061" : "#2A2B31", color: hit ? "#AEF061" : "#B8B8B8" }));
    cvText(ctx, T.note, 64, 510, { size: 19, weight: "500", color: "#8A8A90", maxW: 720 });
    // result block
    const px = 838, py = 172, pw = 298, ph = 372, cx = px + pw / 2, iw = pw - 44;
    ctx.fillStyle = "rgba(23,24,25,0.94)"; rr(ctx, px, py, pw, ph, 14); ctx.fill();
    ctx.strokeStyle = "#2A2B31"; ctx.lineWidth = 2; rr(ctx, px, py, pw, ph, 14); ctx.stroke();
    ctx.save(); rr(ctx, px, py, pw, ph, 14); ctx.clip(); ctx.fillStyle = "#483DF3"; ctx.fillRect(px, py, pw, 8); ctx.restore();
    cvText(ctx, T.big, cx, 312, { size: 140, weight: "900", color: T.bigColor, align: "center", maxW: iw });
    cvText(ctx, T.onEp, cx, 362, { size: 30, weight: "800", align: "center", maxW: iw });
    if (T.hasPrize) {
      cvText(ctx, T.prefix, cx, 414, { size: 22, weight: "700", color: "#8A8A90", align: "center", maxW: iw });
      cvText(ctx, T.amount, cx, 456, { size: 36, weight: "800", color: "#BDB9FF", align: "center", maxW: iw });
    } else {
      ctx.font = "800 26px " + SANS; const pl = wrapLines(ctx, T.prizeLine, iw);
      pl.forEach((t, i) => cvText(ctx, t, cx, 428 + i * 34 - (pl.length - 1) * 8, { size: 26, weight: "800", color: "#B8B8B8", align: "center", maxW: iw }));
    }
    cvText(ctx, T.sub, cx, 500, { size: 18, weight: "500", color: "#8A8A90", align: "center", maxW: iw });
    if (T.wallet) cvText(ctx, T.wallet, cx, 528, { size: 17, weight: "500", color: "#8A8A90", align: "center", maxW: iw, family: MONO });
    ctx.strokeStyle = "#2A2B31"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(64, 584); ctx.lineTo(1136, 584); ctx.stroke();
    footerAt(ctx, 628);
  }

  // Design 4 · Split panel: purple result panel left, digit match tiles right
  function drawD4(ctx, L, T, av) {
    ctx.fillStyle = "#0E0E0E"; ctx.fillRect(0, 0, 1200, 675);
    glowAt(ctx, 900, 330, 520, "72,61,243", 0.22);
    const sx = 520;
    let g = ctx.createLinearGradient(0, 0, sx, 675); g.addColorStop(0, "#5656F5"); g.addColorStop(0.5, "#483DF3"); g.addColorStop(1, "#3328C9");
    ctx.fillStyle = g; ctx.fillRect(0, 0, sx, 675);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, sx, 675); ctx.clip();
    for (const [r, a] of [[180, 0.10], [260, 0.08], [340, 0.06], [420, 0.045]]) { ctx.strokeStyle = "rgba(255,255,255," + a + ")"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(sx, 675, r, 0, Math.PI * 2); ctx.stroke(); }
    ctx.restore();
    ctx.fillStyle = "#AEF061"; ctx.fillRect(sx - 4, 0, 4, 675);
    headerAt(ctx, av, 52, 78, 28, 28, 18, "#FFFFFF", "rgba(255,255,255,0.8)");
    ctx.font = "800 22px " + SANS; const pw = ctx.measureText(T.pill).width + 40;
    ctx.fillStyle = "rgba(14,14,14,0.35)"; rr(ctx, 52, 150, pw, 42, 21); ctx.fill();
    cvText(ctx, T.pill, 52 + pw / 2, 179, { size: 22, weight: "800", align: "center" });
    cvText(ctx, T.big, 46, 384, { size: 196, weight: "900", color: T.bigColor, maxW: sx - 96 });
    cvText(ctx, T.onEp, 52, 440, { size: 40, weight: "800", maxW: sx - 96 });
    cvText(ctx, T.prizeLine, 52, 492, { size: 34, weight: "800", color: T.hasPrize ? "#FFFFFF" : "rgba(255,255,255,0.78)", maxW: sx - 96 });
    cvText(ctx, T.sub, 52, 530, { size: 20, weight: "500", color: "rgba(255,255,255,0.78)", maxW: sx - 96 });
    if (T.wallet) cvText(ctx, T.wallet, 52, 560, { size: 19, weight: "500", color: "rgba(255,255,255,0.78)", maxW: sx - 96, family: MONO });
    cvText(ctx, CARD_SITE, 52, 630, { size: 22, weight: "700", color: "#FFFFFF", maxW: sx - 80 });
    // right side
    const rx = 578, tw = 78, gp = 14;
    cvText(ctx, T.date, 1140, 84, { size: 20, weight: "500", color: "#B8B8B8", align: "right", maxW: 540 });
    cvText(ctx, T.hashLabel, rx, 168, { size: 19, weight: "700", color: "#8A8A90" });
    digitCells(ctx, L.pop, L.bestPos, rx, 184, tw, 98, gp, 60, (hit) => ({ r: 16, fill: hit ? "#483DF3" : "#1E1F22", stroke: hit ? "#8077FF" : "#2A2B31", color: "#FFFFFF" }));
    for (let i = 0; i < 6; i++) {
      const hit = L.bestPos.includes(i), cx = rx + i * (tw + gp) + tw / 2;
      if (hit) { ctx.strokeStyle = "#AEF061"; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(cx, 288); ctx.lineTo(cx, 336); ctx.stroke();
        ctx.fillStyle = "#AEF061"; ctx.beginPath(); ctx.arc(cx, 312, 9, 0, Math.PI * 2); ctx.fill(); }
      else { ctx.fillStyle = "#3A3B44"; ctx.beginPath(); ctx.arc(cx, 312, 4, 0, Math.PI * 2); ctx.fill(); }
    }
    digitCells(ctx, L.best, L.bestPos, rx, 342, tw, 98, gp, 60, (hit) => ({ r: 16, fill: hit ? "rgba(174,240,97,0.14)" : "#171819", stroke: hit ? "#AEF061" : "#2A2B31", color: hit ? "#AEF061" : "#B8B8B8" }));
    cvText(ctx, T.tLabel, rx, 474, { size: 19, weight: "700", color: "#8A8A90" });
    cvText(ctx, T.note, rx, 512, { size: 18, weight: "500", color: "#8A8A90", maxW: 1140 - rx });
    ctx.strokeStyle = "#2A2B31"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(rx, 586); ctx.lineTo(1140, 586); ctx.stroke();
    cvText(ctx, "The trader-first perp DEX", 1140, 630, { size: 21, weight: "600", color: "#8A8A90", align: "right" });
  }

  // Design 5 · Minimal glow: centered result over a soft purple glow
  function drawD5(ctx, L, T, av) {
    ctx.fillStyle = "#0E0E0E"; ctx.fillRect(0, 0, 1200, 675);
    glowAt(ctx, 600, 230, 560, "72,61,243", 0.62); glowAt(ctx, 600, 230, 260, "100,90,255", 0.30);
    ctx.strokeStyle = "rgba(128,119,255,0.18)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.ellipse(600, 212, 440, 112, 0, 0, Math.PI * 2); ctx.stroke();
    let g = ctx.createLinearGradient(140, 0, 1060, 0); g.addColorStop(0, "rgba(128,119,255,0)"); g.addColorStop(0.5, "rgba(128,119,255,0.55)"); g.addColorStop(1, "rgba(128,119,255,0)");
    ctx.fillStyle = g; ctx.fillRect(140, 456, 920, 2);
    headerAt(ctx, av, 56, 70, 26, 26, 18);
    cvText(ctx, T.pill, 1144, 68, { size: 26, weight: "800", color: "#BDB9FF", align: "right" });
    cvText(ctx, T.date, 1144, 98, { size: 18, weight: "500", color: "#8A8A90", align: "right" });
    ctx.save(); ctx.shadowColor = T.won ? "rgba(174,240,97,0.55)" : "rgba(160,150,255,0.8)"; ctx.shadowBlur = 50;
    cvText(ctx, T.big, 600, 280, { size: 180, weight: "900", color: T.bigColor, align: "center", maxW: 700 }); ctx.restore();
    cvText(ctx, T.onEp, 600, 340, { size: 38, weight: "800", align: "center", maxW: 900 });
    cvText(ctx, T.prizeLine, 600, 390, { size: 36, weight: "800", color: T.hasPrize ? "#BDB9FF" : "#B8B8B8", align: "center", maxW: 900 });
    cvText(ctx, T.sub + (T.wallet ? "  ·  " + T.wallet : ""), 600, 428, { size: 20, weight: "500", color: "#8A8A90", align: "center", maxW: 900 });
    const rows = [[T.hashLabel, L.pop, 330, "#FFFFFF"], [T.tLabel, L.best, 870, "#9A9AA2"]];
    for (const [lab, dig, cx, base] of rows) {
      cvText(ctx, lab, cx, 494, { size: 17, weight: "700", color: "#8A8A90", align: "center" });
      for (let i = 0; i < 6; i++) {
        const hit = L.bestPos.includes(i), x = cx + (i - 2.5) * 52;
        if (hit) { ctx.save(); ctx.shadowColor = "rgba(174,240,97,0.8)"; ctx.shadowBlur = 12; ctx.fillStyle = "#AEF061"; rr(ctx, x - 17, 562, 34, 4, 2); ctx.fill(); ctx.restore(); }
        cvText(ctx, dig[i], x, 548, { size: 46, weight: "800", color: hit ? "#AEF061" : base, align: "center", family: MONO });
      }
    }
    ctx.fillStyle = "rgba(128,119,255,0.25)"; ctx.fillRect(599, 486, 2, 84);
    cvText(ctx, T.note, 600, 600, { size: 17, weight: "500", color: "#6F6F76", align: "center", maxW: 900 });
    footerAt(ctx, 644, "#BDB9FF", "#8A8A90", 56, 1144);
  }
  const CARD_DESIGNS = [null, drawD1, drawD2, drawD3, drawD4, drawD5];
  async function drawCard(L, showWallet) {
    const d = cardDesign(L.epoch);
    if (!d) return drawCardClassic(L, showWallet);
    const cv = document.createElement("canvas"); cv.width = 1200; cv.height = 675;
    const ctx = cv.getContext("2d"); ctx.textBaseline = "alphabetic";
    const av = await loadAvatar();
    CARD_DESIGNS[d](ctx, L, cardTexts(L, showWallet), av);
    return cv;
  }
  if (/[?&]cardtest=1(?:&|$)/.test(location.search || "")) window.__pdxCard = { drawCard, cardDesign };
  const CAPTIONS = [
    (L, s) => (L.bestCount >= 2 ? "Hit " + L.bestCount + "/6 on @popdex_ MegaPop Epoch #" + L.epoch + s.prize + "." : "No prize for me on @popdex_ MegaPop Epoch #" + L.epoch + " (best " + L.bestCount + "/6).") + "\n\nPop Hash " + L.pop + ".\n\nCheck your tickets: " + s.url
  ];
  function caption(L, link) {
    let k = 0; try { k = Number(localStorage.getItem("pdx_cap") || 0) % CAPTIONS.length; } catch (e) {}
    const s = { url: link || ("https://" + CARD_SITE + "/#megapop"), prize: L.prize > 0 ? " (" + (L.mode === "wallet" ? "won " : L.prizeEst ? "≈ " : "") + fmtNum(L.prize, 2) + " USDT)" : "" };
    return { text: CAPTIONS[k](L, s), next: (k + 1) % CAPTIONS.length };
  }
  function xIntent(text) { return "https://x.com/intent/post?text=" + encodeURIComponent(text); }
  const sh = { blob: null, url: null, file: null, card: null, tok: 0 };
  function setXLink(L) { const c = caption(L, sh.card); sh.caption = c; const xa = $("#sh-x"); if (xa) xa.href = xIntent(c.text); }
  // Upload the rendered card so the caption link (/s/<id>) previews AS the card on X. The #megapop link is in the X button until the id returns (a tap before then, or any error, posts that link); the upload gives up after 25 s.
  async function uploadCard(L, blob) {
    const tok = ++sh.tok;
    if (!blob || !window.fetch) return;
    const ctl = window.AbortController ? new AbortController() : null;
    const timer = setTimeout(() => { if (ctl) ctl.abort(); }, 25000);
    try {
      const q = "?e=" + encodeURIComponent(L.epoch) + "&b=" + encodeURIComponent(L.bestCount) + "&p=" + encodeURIComponent(L.pop || "");
      const r = await fetch("/api/card" + q, { method: "POST", headers: { "content-type": "image/png" }, body: blob, signal: ctl ? ctl.signal : undefined });
      const j = r.ok ? await r.json() : null;
      if (tok !== sh.tok) return;
      if (j && j.id && /^[A-Za-z0-9]{8,10}$/.test(j.id)) { sh.card = "https://" + CARD_SITE + "/s/" + j.id; setXLink(L); }
    } catch (e) { /* keep the #megapop fallback */ }
    finally { clearTimeout(timer); }
  }
  function hideShare() { sh.tok++; const p = $("#mp-share"); if (p) p.hidden = true; }
  async function renderShare() {
    const L = mp.last; if (!L) return;
    const showW = L.mode === "wallet" && $("#sh-wallet").checked;
    const cv = await drawCard(L, showW);
    const blob = await new Promise((res) => cv.toBlob(res, "image/png"));
    if (sh.url) URL.revokeObjectURL(sh.url);
    sh.blob = blob; sh.url = URL.createObjectURL(blob);
    sh.name = "popdex-megapop-epoch" + L.epoch + "-" + L.bestCount + "of6.png";
    sh.file = (typeof File === "function") ? new File([blob], sh.name, { type: "image/png" }) : null;
    $("#sh-img").src = sh.url;
    sh.card = null; sh.L = L; setXLink(L);
    sh.up = uploadCard(L, blob);
    const canFile = !!(sh.file && navigator.canShare && navigator.share && (() => { try { return navigator.canShare({ files: [sh.file] }); } catch (e) { return false; } })());
    const nb = $("#sh-native"); sh.toX = IS_PC || !canFile; // phones with file share: native sheet with card image
    nb.hidden = false; nb.textContent = "Share on X";
  }
  const IS_PC = !!(window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches);
  async function openShare() {
    const p = $("#mp-share"); if (!mp.last) return;
    $("#sh-wallet-wrap").hidden = mp.last.mode !== "wallet";
    p.hidden = false;
    await renderShare();
    p.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  $("#sh-close").addEventListener("click", hideShare);
  $("#sh-wallet").addEventListener("change", renderShare);
  $("#sh-dl").addEventListener("click", () => {
    if (!sh.url) return;
    const a = document.createElement("a"); a.href = sh.url; a.download = sh.name || "popdex-megapop.png"; document.body.appendChild(a); a.click(); a.remove();
  });
  $("#sh-x") && $("#sh-x").addEventListener("click", () => {
    if (sh.caption) { try { localStorage.setItem("pdx_cap", String(sh.caption.next)); } catch (e) {} setTimeout(() => { if (sh.L) setXLink(sh.L); }, 300); }
  });
  $("#sh-native").addEventListener("click", async () => {
    if (sh.toX) {
      // PC (or no file sharing): open X's compose page in a new tab with the caption + card link.
      if (sh.card && sh.caption) { window.open(xIntent(sh.caption.text), "_blank", "noopener"); return; }
      const w = window.open("about:blank", "_blank");
      try { await Promise.race([sh.up, new Promise((r) => setTimeout(r, 8000))]); } catch (e) {}
      if (sh.L) setXLink(sh.L);
      const u = xIntent(sh.caption ? sh.caption.text : "");
      if (w) { try { w.opener = null; } catch (e) {} w.location.href = u; } else window.location.href = u;
      return;
    }
    if (!sh.file) return;
    try { await navigator.share({ files: [sh.file], title: "PopDEX MegaPop Epoch #" + mp.last.epoch, text: sh.caption ? sh.caption.text : "" }); } catch (e) {}
  });
  $("#sh-link") && $("#sh-link").addEventListener("click", (ev) => copyLink(ev.currentTarget));


  // ================= CALCULATOR =================
  const cs = { side: 1, inMaker: false, outMaker: false, inited: false, sym: null };
  const DOC_FEES = [["0.0001", "0.00032"], ["0.00008", "0.0003"], ["0.00004", "0.00028"], ["0", "0.00024"], ["0", "0.00022"], ["0", "0.0002"], ["-0.00001", "0.00018"]]; // docs VIP table
  const parseNum = (s) => { const v = Number(String(s || "").replace(/[, _]/g, "")); return isFinite(v) ? v : NaN; };
  function initCalc() {
    if (cs.inited) return; cs.inited = true;
    const VOL = ["<3M", "≥3M", "≥15M", "≥50M", "≥100M", "≥500M", "≥2B"];
    $("#c-vip").innerHTML = DOC_FEES.map((f, i) => '<option value="' + i + '">VIP ' + i + " (" + VOL[i] + ")</option>").join("");
    Promise.all([loadConfig(), loadBoard().catch(() => null)]).then(() => {
      const syms = config.symbols.filter((s) => s.status === "Trading");
      const group = (cls, label) => { const g = syms.filter((s) => (s.assetClass || "").toLowerCase() === cls).sort((a, b) => a.symbol.localeCompare(b.symbol)); return g.length ? '<optgroup label="' + label + '">' + g.map(opt).join("") + "</optgroup>" : ""; };
      const opt = (s) => '<option value="' + s.symbol + '">' + s.symbol + " · max " + (s.tiers[0] ? s.tiers[0].leverage + "x" : "?") + "</option>";
      $("#c-market").innerHTML = group("crypto", "Crypto") + group("rwa", "RWA (gold, oil, stocks, indices)");
      const want = new URLSearchParams(location.hash.split("?")[1] || "").get("m");
      $("#c-market").value = want && symOf(want) ? want : (symOf("BTCUSDT") ? "BTCUSDT" : syms[0].symbol);
      $("#c-live").textContent = "Live from PopDEX"; $("#c-live").className = "tag ok";
      onMarket(true);
    }).catch(() => {
      $("#c-live").textContent = "PopDEX data unavailable"; $("#c-live").className = "tag bad";
      $("#c-out").innerHTML = '<div class="small">Could not load the market list, margin tiers and fee tables from PopDEX\'s public API right now. Try again in a minute.</div><div class="btn-row"><button class="btn ghost" type="button" id="c-retry">Retry</button></div>';
      $("#c-retry").addEventListener("click", () => { cs.inited = false; initCalc(); });
    });
    $("#c-market").addEventListener("change", () => onMarket(true));
    $$("#calc .seg-b[data-side]").forEach((b) => b.addEventListener("click", () => { cs.side = Number(b.dataset.side); $$("#calc .seg-b[data-side]").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", String(x === b)); }); prefillExit(); compute(); }));
    $$("#calc .seg[data-for]").forEach((seg) => seg.addEventListener("click", (ev) => {
      const b = ev.target.closest(".seg-b"); if (!b) return;
      $$(".seg-b", seg).forEach((x) => x.classList.toggle("on", x === b));
      cs[seg.dataset.for === "in" ? "inMaker" : "outMaker"] = b.dataset.v === "maker"; compute();
    }));
    ["#c-entry", "#c-exit", "#c-size", "#c-extra", "#c-vip", "#c-unit"].forEach((s) => $(s).addEventListener("input", compute));
    $("#c-lev").addEventListener("input", () => { const v = parseNum($("#c-lev").value); if (isFinite(v)) $("#c-levr").value = Math.round(v); compute(); });
    $("#c-levr").addEventListener("input", () => { $("#c-lev").value = $("#c-levr").value; compute(); });
  }
  function markPrice(sym) { const m = marketOf(sym); return m && m.markPrice ? Number(m.markPrice) : NaN; }
  function onMarket(prefill) {
    const s = symOf($("#c-market").value); cs.sym = s; if (!s) return;
    const maxLev = Number(s.tiers[0] ? s.tiers[0].leverage : 100);
    $("#c-levr").max = String(maxLev);
    $("#c-levmax").textContent = "(max " + maxLev + "x)";
    if (parseNum($("#c-lev").value) > maxLev) { $("#c-lev").value = String(Math.min(10, maxLev)); }
    $("#c-levr").value = String(Math.round(parseNum($("#c-lev").value) || 1));
    const mk = markPrice(s.symbol), prec = Number(s.pricePrecision);
    if (prefill && isFinite(mk)) { $("#c-entry").value = mk.toFixed(prec); prefillExit(); }
    $("#c-markhint").innerHTML = isFinite(mk) ? 'Mark price now: <b>' + fmtPrice(mk, prec) + '</b> (PopDEX, live). <a href="#calc" id="c-usemark">Use as entry</a>' : "Live mark price unavailable: enter prices by hand.";
    const u = $("#c-usemark"); if (u) u.addEventListener("click", (ev) => { ev.preventDefault(); $("#c-entry").value = mk.toFixed(prec); prefillExit(); compute(); });
    compute();
  }
  function prefillExit() {
    const s = cs.sym, E = parseNum($("#c-entry").value); if (!s || !(E > 0)) return;
    $("#c-exit").value = (E * (1 + 0.05 * cs.side)).toFixed(Number(s.pricePrecision));
  }
  function compute() {
    const s = cs.sym; if (!s) return;
    const vip = Number($("#c-vip").value || 0);
    const fr = (s.fees || []).find((f) => Number(f.vipLevel) === vip);
    const maker = fr ? Number(fr.makerFeeRate) : Number(DOC_FEES[vip][0]), taker = fr ? Number(fr.takerFeeRate) : Number(DOC_FEES[vip][1]);
    const inp = { side: cs.side, entry: parseNum($("#c-entry").value), exit: parseNum($("#c-exit").value), size: parseNum($("#c-size").value), unit: $("#c-unit").value,
      lev: parseNum($("#c-lev").value), extra: parseNum($("#c-extra").value) || 0, makerRate: maker, takerRate: taker, inMaker: cs.inMaker, outMaker: cs.outMaker,
      tiers: s.tiers, lotSize: Number(s.lotSize) };
    const r = C.calc(inp), prec = Number(s.pricePrecision), qp = Number(s.qtyPrecision);
    const out = $("#c-out");
    if (r.errors.length && !isFinite(r.im)) { out.innerHTML = '<div class="errs">' + r.errors.map((x) => "<p>" + esc(x) + "</p>").join("") + "</div>"; return; }
    const mk = markPrice(s.symbol), ref = inp.entry;
    let liqTxt, liqSub;
    if (r.liqStatus === "ok") { liqTxt = fmtPrice(r.liq, prec); liqSub = fmtPct((r.liq - ref) / ref, 2) + " from entry"; }
    else if (r.liqStatus === "none") { liqTxt = "None"; liqSub = "margin covers a move to " + (cs.side > 0 ? "zero" : "far above"); }
    else if (r.liqStatus === "immediate") { liqTxt = "At entry"; liqSub = "margin is below maintenance"; }
    else { liqTxt = "–"; liqSub = ""; }
    const pnlCls = r.net > 0 ? "pos" : r.net < 0 ? "neg" : "";
    let h = '<div class="res-grid">' +
      '<div class="big liq"><span>Est. liquidation price</span><b>' + liqTxt + "</b><small>" + esc(liqSub) + "</small></div>" +
      '<div class="big"><span>Initial margin</span><b>' + fmtNum(r.im, 2) + "</b><small>USDT at " + fmtNum(inp.lev, inp.lev % 1 ? 1 : 0) + "x</small></div>" +
      '<div class="big"><span>Net PnL at exit</span><b class="' + pnlCls + '">' + (isFinite(r.net) ? fmtSigned(r.net, 2) : "–") + "</b><small>USDT after fees</small></div>" +
      '<div class="big"><span>ROE</span><b class="' + pnlCls + '">' + (isFinite(r.roe) ? fmtPct(r.roe, 2) : "–") + "</b><small>net PnL ÷ margin</small></div></div>";
    const side = cs.side > 0 ? "Long" : "Short";
    h += '<div class="rows">' +
      "<div><span>Position</span><span>" + side + " " + fmtNum(r.qty, qp) + " " + esc(s.base) + (r.rounded ? " (rounded to lot " + s.lotSize + ")" : "") + "</span></div>" +
      "<div><span>Notional at entry</span><span>" + fmtUSD(r.notional) + "</span></div>" +
      "<div><span>Entry fee (" + (cs.inMaker ? "maker" : "taker") + " " + (r.rateIn * 100).toFixed(4).replace(/0+$/, "").replace(/\.$/, "") + "%)</span><span>" + fmtUSD(r.feeIn, 4) + "</span></div>" +
      "<div><span>Exit fee (" + (cs.outMaker ? "maker" : "taker") + " " + (r.rateOut * 100).toFixed(4).replace(/0+$/, "").replace(/\.$/, "") + "%)</span><span>" + (isFinite(r.feeOut) ? fmtUSD(r.feeOut, 4) : "–") + "</span></div>" +
      "<div><span>Gross PnL</span><span>" + (isFinite(r.gross) ? fmtSigned(r.gross, 2) + " USDT" : "–") + "</span></div>" +
      "<div><span>Maintenance margin at entry</span><span>" + fmtUSD(r.mmEntry) + "</span></div>" +
      "<div><span>Max leverage at this size</span><span>" + r.maxLev + "x</span></div>";
    const m = marketOf(s.symbol);
    if (m && isFinite(Number(m.fundingRate))) {
      const rate = Number(m.fundingRate), pay = r.qty * (isFinite(mk) ? mk : ref) * rate * cs.side; // positive = you pay
      h += "<div><span>Funding now (every " + m.intervalH + "h)</span><span>" + (pay > 0 ? "you pay " : pay < 0 ? "you receive " : "") + fmtNum(Math.abs(pay), 4) + " USDT</span></div>";
    }
    h += "</div>";
    if (r.errors.length) h += '<div class="errs">' + r.errors.map((x) => "<p>" + esc(x) + "</p>").join("") + "</div>";
    if (r.notional < Number(s.minNotional)) h += '<div class="errs"><p>PopDEX\'s minimum order value for ' + esc(s.symbol) + " is " + s.minNotional + " USDT.</p></div>";
    if (r.qty > Number(s.maxQty) || r.notional > Number(s.maxNotional)) h += '<div class="errs"><p>Above PopDEX\'s per-order limit for ' + esc(s.symbol) + " (" + s.maxQty + " " + esc(s.base) + " / " + fmtNum(Number(s.maxNotional), 0) + " USDT).</p></div>";
    // risk line
    if (r.liqStatus === "ok") {
      const move = Math.abs(r.liq - ref) / ref;
      const cls = move < 0.03 ? "" : move < 0.1 ? "mid" : "low";
      h += '<div class="risk ' + cls + '"><b>Risk:</b> a ' + fmtNum(move * 100, 2) + "% move " + (cs.side > 0 ? "down" : "up") + " from your entry, to about " + fmtPrice(r.liq, prec) + " (mark price), could get this position liquidated" +
        (r.exitPastLiq ? ", and your exit price is past that point, so this PnL would not be reached" : "") + ". If liquidated, PopDEX first closes part of it at market (taker fees apply); if the insurance fund takes over, the remaining margin is lost.</div>";
    } else if (r.liqStatus === "immediate") {
      h += '<div class="risk"><b>Risk:</b> with this leverage and size the margin is already at or below maintenance, so the position would be liquidatable straight away.</div>';
    } else if (r.liqStatus === "none") {
      h += '<div class="risk low"><b>Risk:</b> at this leverage the margin covers the full move, so no liquidation price exists on this single-position estimate. Funding and fees still reduce margin over time.</div>';
    }
    h += '<div class="formula">liq: IM + extra − entry fee + side×(P−entry)×size = Σ tier(size×P × MMR) + size×P×taker(' + (taker * 100).toFixed(3) + "%)</div>";
    out.innerHTML = h;
  }

  // ================= PORTFOLIO (cross margin) =================
  const ps = { inited: false, rows: [], timer: null, uid: 0 };
  const CMODES = ["single", "portfolio"];
  function setCalcMode(m, silent) {
    const mode = CMODES.includes(m) ? m : "single";
    $$("#c-mode .seg-b").forEach((b) => { const on = b.dataset.v === mode; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); });
    $("#calc-single").hidden = mode !== "single"; $("#calc-port").hidden = mode !== "portfolio";
    try { localStorage.setItem("pdx_cmode", mode); } catch (e) {}
    if (mode === "portfolio") initPort();
  }
  $("#c-mode").addEventListener("click", (ev) => { const b = ev.target.closest(".seg-b"); if (b) setCalcMode(b.dataset.v); });
  function initPort() {
    if (ps.inited) { pCompute(); return; } ps.inited = true;
    const VOL = ["<3M", "≥3M", "≥15M", "≥50M", "≥100M", "≥500M", "≥2B"];
    $("#p-vip").innerHTML = DOC_FEES.map((f, i) => '<option value="' + i + '">VIP ' + i + " (" + VOL[i] + ")</option>").join("");
    let saved = null; try { saved = JSON.parse(localStorage.getItem("pdx_port") || "null"); } catch (e) {}
    Promise.all([loadConfig(), loadBoard().catch(() => null)]).then(() => {
      $("#p-live").textContent = board ? "Live marks from PopDEX" : "Marks unavailable"; $("#p-live").className = "tag " + (board ? "ok" : "bad");
      if (saved && Array.isArray(saved.rows) && saved.rows.length) {
        $("#p-coll").value = saved.coll != null ? saved.coll : "2000"; $("#p-vip").value = String(saved.vip || 0);
        saved.rows.slice(0, 20).forEach((r) => addPos(r));
      } else {
        addPos({ sym: "BTCUSDT", side: 1, size: "5000", unit: "usdt", lev: "10" });
        addPos({ sym: "ETHUSDT", side: -1, size: "3000", unit: "usdt", lev: "10" });
      }
      pCompute();
      ps.timer = setInterval(() => { if (!$("#calc-port").hidden && !$("#calc").hidden) loadBoard(true).then(pCompute).catch(() => {}); }, 60000);
    }).catch(() => {
      $("#p-live").textContent = "PopDEX data unavailable"; $("#p-live").className = "tag bad";
      $("#p-out").innerHTML = '<div class="small">Could not load markets and margin tiers from PopDEX\'s public API right now. Try again in a minute.</div>';
      ps.inited = false;
    });
    $("#p-add").addEventListener("click", () => { addPos({ sym: "BTCUSDT", side: 1, size: "1000", unit: "usdt", lev: "10" }); pCompute(); });
    ["#p-coll", "#p-vip"].forEach((s) => $(s).addEventListener("input", pCompute));
    $("#p-list").addEventListener("input", (ev) => { const row = ev.target.closest(".p-row"); if (!row) return; if (ev.target.matches(".p-sym")) pFillEntry(row, true); pCompute(); });
    $("#p-list").addEventListener("change", (ev) => { if (ev.target.matches(".p-sym")) { pFillEntry(ev.target.closest(".p-row"), true); pCompute(); } });
    $("#p-list").addEventListener("click", (ev) => {
      const row = ev.target.closest(".p-row"); if (!row) return;
      const sb = ev.target.closest(".seg-b");
      if (sb) { row.dataset.side = sb.dataset.v; $$(".seg-b", row).forEach((x) => { x.classList.toggle("on", x === sb); x.setAttribute("aria-pressed", String(x === sb)); }); pCompute(); }
      if (ev.target.closest(".p-del")) { row.remove(); pCompute(); }
      if (ev.target.closest(".p-usemark")) { ev.preventDefault(); pFillEntry(row, true); pCompute(); }
    });
  }
  function symOptions(sel) {
    const syms = config.symbols.filter((s) => s.status === "Trading");
    const group = (cls, label) => { const g = syms.filter((s) => (s.assetClass || "").toLowerCase() === cls).sort((a, b) => a.symbol.localeCompare(b.symbol)); return g.length ? '<optgroup label="' + label + '">' + g.map((s) => '<option value="' + s.symbol + '"' + (s.symbol === sel ? " selected" : "") + ">" + s.symbol + "</option>").join("") + "</optgroup>" : ""; };
    return group("crypto", "Crypto") + group("rwa", "RWA");
  }
  function addPos(r) {
    const id = ++ps.uid, sym = symOf(r.sym) ? r.sym : (symOf("BTCUSDT") ? "BTCUSDT" : config.symbols[0].symbol);
    const el = document.createElement("div"); el.className = "p-row"; el.dataset.side = String(r.side > 0 ? 1 : -1);
    el.innerHTML = '<div class="p-hd"><b class="p-no">Position</b><button type="button" class="p-del" aria-label="Remove position">Remove</button></div>' +
      '<div class="p-top"><label class="fld p-m"><span class="sr">Market</span><select class="p-sym" aria-label="Market">' + symOptions(sym) + '</select></label>' +
      '<div class="seg sm p-side" role="radiogroup" aria-label="Side"><button type="button" class="seg-b long' + (r.side > 0 ? " on" : "") + '" data-v="1" aria-pressed="' + (r.side > 0) + '">Long</button><button type="button" class="seg-b short' + (r.side > 0 ? "" : " on") + '" data-v="-1" aria-pressed="' + (r.side <= 0) + '">Short</button></div></div>' +
      '<div class="p-grid"><label class="fld"><span>Size</span><div class="in-unit"><input class="p-size" type="text" inputmode="decimal" value="' + esc(r.size || "1000") + '"><select class="p-unit" aria-label="Size unit"><option value="usdt"' + (r.unit !== "qty" ? " selected" : "") + '>USDT</option><option value="qty"' + (r.unit === "qty" ? " selected" : "") + '>Contracts</option></select></div></label>' +
      '<label class="fld"><span>Entry price</span><input class="p-entry" type="text" inputmode="decimal" value="' + esc(r.entry || "") + '"></label>' +
      '<label class="fld"><span>Leverage</span><div class="in-unit"><input class="p-lev" type="text" inputmode="decimal" value="' + esc(r.lev || "10") + '"><span class="unit">x</span></div></label></div>' +
      '<p class="hint p-hint"></p>';
    $("#p-list").appendChild(el);
    if (!r.entry) pFillEntry(el, true); else pHint(el);
  }
  function pFillEntry(row, force) {
    const s = symOf($(".p-sym", row).value); if (!s) return;
    const mk = markPrice(s.symbol);
    if (force && isFinite(mk)) $(".p-entry", row).value = mk.toFixed(Number(s.pricePrecision));
    pHint(row);
  }
  function pHint(row) {
    const s = symOf($(".p-sym", row).value); if (!s) return;
    const mk = markPrice(s.symbol), max = s.tiers[0] ? s.tiers[0].leverage : "?";
    $(".p-hint", row).innerHTML = (isFinite(mk) ? "Mark now <b>" + fmtPrice(mk, Number(s.pricePrecision)) + '</b> · <a href="#calc" class="p-usemark">use as entry</a>' : "Live mark unavailable") + " · max " + max + "x";
  }
  function pCompute() {
    if (!config) return;
    const vip = Number($("#p-vip").value || 0), coll = parseNum($("#p-coll").value);
    const out = $("#p-out"), errs = [], pos = [], meta = [];
    const save = { coll: $("#p-coll").value, vip, rows: [] };
    $$("#p-list .p-row").forEach((row, i) => {
      $(".p-no", row).textContent = "Position " + (i + 1);
      const s = symOf($(".p-sym", row).value); if (!s) return;
      pHint(row);
      const side = Number(row.dataset.side) > 0 ? 1 : -1, entry = parseNum($(".p-entry", row).value), size = parseNum($(".p-size", row).value), unit = $(".p-unit", row).value, lev = parseNum($(".p-lev", row).value);
      save.rows.push({ sym: s.symbol, side, size: $(".p-size", row).value, unit, entry: $(".p-entry", row).value, lev: $(".p-lev", row).value });
      const mk = markPrice(s.symbol);
      const label = "#" + (i + 1) + " " + s.symbol;
      if (!(entry > 0) || !(size > 0) || !(lev >= 1)) { errs.push(label + ": enter size, entry price and leverage (1x or more)."); return; }
      if (!isFinite(mk)) { errs.push(label + ": live mark price unavailable."); return; }
      let q = unit === "qty" ? size : size / entry; q = C.floorStep(q, Number(s.lotSize));
      if (!(q > 0)) { errs.push(label + ": size is below one lot (" + s.lotSize + ")."); return; }
      const fr = (s.fees || []).find((f) => Number(f.vipLevel) === vip);
      const taker = fr ? Number(fr.takerFeeRate) : Number(DOC_FEES[vip][1]);
      pos.push({ side, qty: q, entry, mark: mk, lev, tiers: s.tiers, taker }); meta.push({ s, label });
    });
    try { localStorage.setItem("pdx_port", JSON.stringify(save)); } catch (e) {}
    if (!(coll >= 0)) errs.unshift("Enter your account collateral in USDT (0 or more).");
    if (!pos.length || !(coll >= 0)) { out.innerHTML = '<div class="errs">' + (errs.length ? errs : ["Add at least one position."]).map((x) => "<p>" + esc(x) + "</p>").join("") + "</div>"; return; }
    const r = C.portfolio({ collateral: coll, positions: pos });
    const pct = (x) => isFinite(x) ? fmtNum(x * 100, 2) + "%" : "∞";
    const mmrCls = r.mmr >= 1 ? "neg" : r.mmr >= 0.7 ? "warnc" : "";
    let h = '<div class="res-grid">' +
      '<div class="big"><span>Equity</span><b>' + fmtNum(r.equity, 2) + '</b><small>USDT = collateral ' + fmtSigned(r.upnl, 2) + ' uPnL</small></div>' +
      '<div class="big liq"><span>Account margin ratio (MMR)</span><b class="' + mmrCls + '">' + pct(r.mmr) + '</b><small>liquidation starts at 100%</small></div>' +
      '<div class="big"><span>Margin used (initial)</span><b>' + fmtNum(r.im, 2) + '</b><small>USDT · IMR ' + pct(r.imr) + "</small></div>" +
      '<div class="big"><span>Unrealized PnL</span><b class="' + (r.upnl > 0 ? "pos" : r.upnl < 0 ? "neg" : "") + '">' + fmtSigned(r.upnl, 2) + "</b><small>USDT at live mark</small></div></div>";
    h += '<div class="rows">' +
      "<div><span>Total maintenance margin</span><span>" + fmtUSD(r.mm) + "</span></div>" +
      "<div><span>Buffer above maintenance</span><span>" + fmtUSD(r.buffer) + "</span></div>" +
      "<div><span>Free margin (equity − initial)</span><span>" + fmtUSD(r.free) + "</span></div>";
    let moveTxt;
    if (r.moveStatus === "ok") moveTxt = fmtNum(r.move * 100, 2) + "% against every position";
    else if (r.moveStatus === "immediate") moveTxt = "already at or below maintenance";
    else if (r.moveStatus === "none") moveTxt = "no uniform move reaches it";
    else moveTxt = "–";
    h += "<div><span>Est. account liquidation (uniform move)</span><span><b>" + esc(moveTxt) + "</b></span></div></div>";
    // per position
    h += '<div class="tbl-wrap"><table class="tbl p-tbl"><thead><tr><th class="l">Position</th><th>uPnL</th><th>Initial margin</th><th>Maint. margin</th><th>Est. liq price*</th></tr></thead><tbody>' +
      r.rows.map((x, i) => {
        const m = meta[i], prec = Number(m.s.pricePrecision), qp = Number(m.s.qtyPrecision);
        let liq = "–", sub = "";
        if (x.liqStatus === "ok") { liq = fmtPrice(x.liq, prec); sub = x.liqPast ? "already past" : fmtPct((x.liq - x.mark) / x.mark, 2) + " from mark"; }
        else if (x.liqStatus === "none") { liq = "None"; sub = "equity covers it"; }
        else if (x.liqStatus === "immediate") { liq = "Now"; sub = "below maintenance"; }
        const levWarn = x.lev > x.maxLev ? '<small class="neg">max ' + x.maxLev + "x at this size</small>" : "";
        return '<tr><td class="l"><b>' + m.s.symbol.replace(/USDT$/, "") + ' <span class="' + (x.side > 0 ? "sd-l" : "sd-s") + '">' + (x.side > 0 ? "Long" : "Short") + "</span></b><small>" + fmtNum(x.qty, qp) + " @ " + fmtPrice(x.entry, prec) + " · mark " + fmtPrice(x.mark, prec) + " · " + fmtNum(x.lev, x.lev % 1 ? 1 : 0) + "x</small>" + levWarn + "</td>" +
          '<td class="' + (x.upnl > 0 ? "pos" : x.upnl < 0 ? "neg" : "") + '">' + fmtSigned(x.upnl, 2) + "</td><td>" + fmtNum(x.im, 2) + "</td><td>" + fmtNum(x.mm, 2) + "</td><td><b>" + liq + "</b><small>" + esc(sub) + "</small></td></tr>";
      }).join("") + "</tbody></table></div>";
    h += '<p class="hint">*Each liq price assumes only that market moves while every other position stays at its current mark price.</p>';
    if (errs.length) h += '<div class="errs">' + errs.map((x) => "<p>" + esc(x) + "</p>").join("") + "</div>";
    if (r.moveStatus === "immediate" || r.mmr >= 1) h += '<div class="risk"><b>Risk:</b> equity is at or below total maintenance margin, so this account would already be in liquidation.</div>';
    else if (r.moveStatus === "ok") { const cls = r.move < 0.03 ? "" : r.move < 0.1 ? "mid" : "low"; h += '<div class="risk ' + cls + '"><b>Risk (estimate):</b> if every market moved about ' + fmtNum(r.move * 100, 2) + "% against you at the same time, equity would fall to the total maintenance margin and liquidation would begin. Real markets don't move together, so treat this as a rough guide.</div>"; }
    else if (r.moveStatus === "none") h += '<div class="risk low"><b>Risk (estimate):</b> no single uniform move against all positions brings equity down to maintenance margin. Funding and fees still reduce equity over time.</div>';
    h += '<div class="formula">Equity = collateral + Σ side×(mark−entry)×size · MMR = Σ MM ÷ equity · MM = Σ tier(size×mark×MMR) + size×mark×taker · liquidation when MMR ≥ 100%</div>';
    h += '<p class="warn-note"><b>Estimate.</b> PopDEX does not publish its exact liquidation formula; this ignores collateral discounts, open orders, funding and fees.</p>';
    out.innerHTML = h;
  }

  // ================= FUNDING =================
  const fs = { inited: false, filter: "all", q: "", sortK: "apr", asc: false, rows: [], timer: null, fcSide: 1, fcMarket: null };
  function initFunding() {
    if (fs.inited) return; fs.inited = true;
    refreshFunding();
    fs.timer = setInterval(refreshFunding, 60000);
    loadConfig().then(() => renderFunding()).catch(() => {});
    $("#f-filter").addEventListener("click", (ev) => { const b = ev.target.closest(".seg-b"); if (!b) return; fs.filter = b.dataset.v; $$("#f-filter .seg-b").forEach((x) => x.classList.toggle("on", x === b)); renderFunding(); });
    $("#f-search").addEventListener("input", () => { fs.q = $("#f-search").value.trim().toUpperCase(); renderFunding(); });
    $$("#f-table th").forEach((th) => th.addEventListener("click", () => { const k = th.dataset.k; if (fs.sortK === k) fs.asc = !fs.asc; else { fs.sortK = k; fs.asc = k === "symbol"; } renderFunding(); }));
    $("#f-table tbody").addEventListener("click", (ev) => {
      const calcBtn = ev.target.closest("[data-fcalc]");
      if (calcBtn) { $("#fc-market").value = calcBtn.dataset.fcalc; fcMarket(); $("#fc-value").focus({ preventScroll: true }); $("#fc-out").scrollIntoView({ behavior: "smooth", block: "center" }); return; }
      const tr = ev.target.closest("tr[data-s]"); if (!tr) return;
      fs.open = fs.open === tr.dataset.s ? null : tr.dataset.s;
      fs.scrollOpen = true;
      placeHistory();
    });
    $("#f-table tbody").addEventListener("keydown", (ev) => { const tr = ev.target.closest("tr[data-s]"); if (tr && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); tr.click(); } });
    $("#fc-market").addEventListener("change", fcMarket);
    $("#fc-side").addEventListener("click", (ev) => { const b = ev.target.closest(".seg-b"); if (!b) return; fs.fcSide = Number(b.dataset.v); $$("#fc-side .seg-b").forEach((x) => x.classList.toggle("on", x === b)); fcCompute(); });
    ["#fc-value", "#fc-rate", "#fc-hours"].forEach((s) => $(s).addEventListener("input", fcCompute));
  }
  async function refreshFunding() {
    try {
      await loadBoard(true);
      fs.fetchedAt = Date.now();
      renderFunding();
      if (!$("#fc-market").options.length) {
        $("#fc-market").innerHTML = board.markets.map((m) => m.symbol).sort().map((s) => '<option value="' + s + '">' + s + "</option>").join("");
        $("#fc-market").value = board.markets.some((m) => m.symbol === "BTCUSDT") ? "BTCUSDT" : board.markets[0].symbol;
        fcMarket();
      }
    } catch (e) {
      if (!board) $("#f-table tbody").innerHTML = '<tr><td colspan="6" class="loading">PopDEX\'s public API did not answer. Retrying every 60 seconds.</td></tr>';
      $("#f-updated").textContent = "Refresh failed at " + new Date().toLocaleTimeString() + "; showing the last data.";
    }
  }
  function fRows() {
    return board.markets.map((m) => {
      const rate = Number(m.fundingRate), iv = Number(m.intervalH) || 1, s = symOf(m.symbol);
      return { symbol: m.symbol, cls: s ? s.assetClass : "", rate, iv, apr: rate * (24 / iv) * 365, next: Number(m.nextUpdate), mark: Number(m.markPrice), prec: s ? Number(s.pricePrecision) : null,
        pays: rate > 0 ? 1 : rate < 0 ? -1 : 0 };
    });
  }
  function renderFunding() {
    if (!board) return;
    let rows = fRows();
    if (fs.filter !== "all") rows = rows.filter((r) => (r.cls || "").toLowerCase() === fs.filter.toLowerCase());
    if (fs.q) rows = rows.filter((r) => r.symbol.includes(fs.q));
    const k = fs.sortK, dir = fs.asc ? 1 : -1;
    rows.sort((a, b) => (k === "symbol" ? a.symbol.localeCompare(b.symbol) : (a[k] - b[k]) || a.symbol.localeCompare(b.symbol)) * dir);
    $$("#f-table th").forEach((th) => { th.classList.toggle("sorted", th.dataset.k === k); th.classList.toggle("asc", th.dataset.k === k && fs.asc); });
    const now = Date.now();
    $("#f-table tbody").innerHTML = rows.length ? rows.map((r) => {
      const who = r.pays > 0 ? '<span class="pays-l">Longs pay</span>' : r.pays < 0 ? '<span class="pays-s">Shorts pay</span>' : "No payment";
      return '<tr class="click' + (fs.open === r.symbol ? " open" : "") + '" data-s="' + r.symbol + '" tabindex="0" aria-expanded="' + (fs.open === r.symbol) + '"><td class="l"><b>' + r.symbol.replace(/USDT$/, "") + "</b><small>" + (r.cls === "Rwa" ? "RWA · " : "") + r.iv + "h</small></td>" +
        "<td>" + fmtSigned(r.rate * 100, 4) + '%<small class="hide-l">' + (r.pays > 0 ? '<span class="pays-l">longs pay</span>' : r.pays < 0 ? '<span class="pays-s">shorts pay</span>' : "") + "</small></td>" +
        "<td>" + fmtSigned(r.apr * 100, 2) + "%</td>" +
        '<td class="hide-s">' + who + "</td>" +
        '<td class="hide-s" data-next="' + r.next + '">' + mmss(r.next - now) + "</td>" +
        '<td class="hide-s">' + fmtPrice(r.mark, r.prec) + "</td></tr>";
    }).join("") : '<tr><td colspan="6" class="loading">No market matches.</td></tr>';
    const upd = Number(board.updatedTime);
    $("#f-updated").textContent = rows.length + " of " + board.markets.length + " markets · last updated " + new Date(fs.fetchedAt || Date.now()).toLocaleTimeString() + (upd ? " (PopDEX data " + utc(upd, true).replace(/^\w+, /, "") + ")" : "") + " · refreshes every 60s · tap a market for its 7-day history";
    tickFunding();
    placeHistory();
  }
  // ---------- 7-day funding history (PopDEX public history API) ----------
  const fh = {};
  function placeHistory() {
    $$("#f-table tr.f-hist").forEach((x) => x.remove());
    $$("#f-table tr[data-s]").forEach((x) => { const on = x.dataset.s === fs.open; x.classList.toggle("open", on); x.setAttribute("aria-expanded", String(on)); });
    if (!fs.open) return;
    const tr = $('#f-table tr[data-s="' + fs.open + '"]'); if (!tr) return;
    const d = document.createElement("tr"); d.className = "f-hist";
    d.innerHTML = '<td colspan="6"><div class="fh" id="fh-box"></div></td>';
    tr.after(d);
    const wrap = tr.closest(".tbl-wrap"), th = $("#f-table thead");
    if (wrap && fs.scrollOpen) { wrap.scrollTop = Math.max(0, tr.offsetTop - (th ? th.offsetHeight : 0)); fs.scrollOpen = false; }
    renderHistory(fs.open);
  }
  async function renderHistory(sym) {
    const box = $("#fh-box"); if (!box) return;
    const c = fh[sym];
    if (!c || (!c.data && !c.loading && Date.now() - (c.t || 0) > 15000)) {
      fh[sym] = { loading: true };
      box.innerHTML = '<div class="loading">Loading 7-day funding history for ' + esc(sym) + "…</div>";
      try { const j = await getJSON("/api/funding-history?symbol=" + encodeURIComponent(sym), 15000); fh[sym] = { data: j, t: Date.now() }; }
      catch (e) { fh[sym] = { error: true, t: Date.now() }; }
      if (fs.open === sym) renderHistory(sym);
      return;
    }
    if (c.loading) { box.innerHTML = '<div class="loading">Loading 7-day funding history…</div>'; return; }
    if (c.error) { box.innerHTML = '<div class="small">PopDEX\'s funding history API did not answer. Tap the row again to retry.</div>'; fh[sym] = null; return; }
    if (Date.now() - c.t > 300000) { fh[sym] = null; return renderHistory(sym); }
    const now = Date.now(), from = now - 7 * 864e5;
    const pts = c.data.points.filter((p) => p.t >= from);
    const m = marketOf(sym), iv = m ? Number(m.intervalH) || 1 : 1;
    if (!pts.length) { box.innerHTML = '<div class="small">PopDEX returned no funding settlements for ' + esc(sym) + " in the last 7 days.</div>"; return; }
    const rates = pts.map((p) => p.r), avg = rates.reduce((a, b) => a + b, 0) / rates.length;
    const mn = Math.min.apply(null, rates), mx = Math.max.apply(null, rates);
    const pos = rates.filter((r) => r > 0).length, neg = rates.filter((r) => r < 0).length;
    const ivData = pts.length > 1 ? Math.round((pts[pts.length - 1].t - pts[0].t) / (pts.length - 1) / 36e5) || iv : iv;
    const apr = avg * (24 / ivData) * 365;
    const pc = (x) => fmtSigned(Math.round(x * 1e12) / 1e10, 5) + "%";
    box.innerHTML = '<div class="fh-head"><b>' + esc(sym) + '</b> · funding, last 7 days <span class="small">(' + pts.length + " settlements, " + shortDate(pts[0].t) + " – " + shortDate(pts[pts.length - 1].t) + ")</span></div>" +
      historySVG(pts, from, now) +
      '<div class="fh-stats"><div><span>Average</span><b>' + pc(avg) + "</b><small>" + fmtSigned(apr * 100, 2) + "% APR</small></div><div><span>Lowest</span><b>" + pc(mn) + "</b></div><div><span>Highest</span><b>" + pc(mx) + "</b></div><div><span>Longs paid</span><b>" + pos + "/" + pts.length + "</b><small>" + neg + " times shorts paid</small></div></div>" +
      '<div class="fh-foot"><span class="small">Source: PopDEX funding history API · every ' + ivData + 'h</span><button type="button" class="btn ghost small" data-fcalc="' + esc(sym) + '">Funding calculator</button></div>';
  }
  function historySVG(pts, from, to) {
    const box = $("#fh-box");
    const W = Math.max(260, Math.round(box ? box.clientWidth - 16 : 600)), Hh = 150, pl = 8, pr = 8, pt = 14, pb = 22;
    const rates = pts.map((p) => p.r);
    let mn = Math.min(0, Math.min.apply(null, rates)), mx = Math.max(0, Math.max.apply(null, rates));
    if (mx - mn < 1e-9) { mx += 1e-6; mn -= 1e-6; }
    const pad = (mx - mn) * 0.08; mx += pad; mn -= pad;
    const X = (t) => pl + (t - from) / (to - from) * (W - pl - pr), Y = (r) => pt + (mx - r) / (mx - mn) * (Hh - pt - pb);
    const y0 = Y(0);
    let line = "";
    pts.forEach((p, i) => { const x = X(p.t).toFixed(1), y = Y(p.r).toFixed(1); line += (i ? " L" : "M") + x + " " + y; });
    const first = X(pts[0].t).toFixed(1), last = X(pts[pts.length - 1].t).toFixed(1);
    const area = line + " L" + last + " " + y0.toFixed(1) + " L" + first + " " + y0.toFixed(1) + " Z";
    let ticks = "";
    for (let k = 7; k >= 0; k--) {
      const t = to - k * 864e5, x = X(t);
      if (k < 7) ticks += '<line x1="' + x.toFixed(1) + '" y1="' + pt + '" x2="' + x.toFixed(1) + '" y2="' + (Hh - pb) + '" class="fh-grid"/>';
      if ((W < 420 ? k % 2 === 0 && k < 7 : k > 0) || k === 0) ticks += '<text x="' + Math.min(W - 26, Math.max(22, x)).toFixed(1) + '" y="' + (Hh - 6) + '" class="fh-t">' + (k === 0 ? "now" : shortDate(t)) + "</text>";
    }
    const lab = (r) => fmtSigned(Math.round(r * 1e12) / 1e10, 5) + "%";
    return '<svg class="fh-svg" viewBox="0 0 ' + W + " " + Hh + '" role="img" aria-label="Funding rate over the last 7 days">' + ticks +
      '<line x1="' + pl + '" y1="' + y0.toFixed(1) + '" x2="' + (W - pr) + '" y2="' + y0.toFixed(1) + '" class="fh-zero"/>' + '<text x="' + (pl + 2) + '" y="' + (y0 - 4).toFixed(1) + '" class="fh-t" style="text-anchor:start">0%</text>' +
      '<path d="' + area + '" class="fh-area"/><path d="' + line + '" class="fh-line" vector-effect="non-scaling-stroke"/></svg>' +
      '<div class="fh-axis">' + (Math.max.apply(null, rates) === Math.min.apply(null, rates) ? "<span>Same rate at every settlement: " + lab(rates[0]) + "</span>" : "<span>max " + lab(Math.max.apply(null, rates)) + "</span><span>min " + lab(Math.min.apply(null, rates)) + "</span>") + "</div>";
  }
  function tickFunding() {
    if (!board) return;
    const now = Date.now();
    const nexts = board.markets.map((m) => Number(m.nextUpdate)).filter((x) => x > now);
    const soon = nexts.length ? Math.min.apply(null, nexts) : NaN;
    $("#f-next").textContent = isFinite(soon) ? mmss(soon - now) : "now";
    $$("#f-table td[data-next]").forEach((td) => { td.textContent = mmss(Number(td.dataset.next) - now); });
    const passed = board.markets.some((m) => Number(m.nextUpdate) <= now - 5000);
    if (passed && !fs.reloading && fs.inited) { fs.reloading = true; setTimeout(() => { fs.reloading = false; refreshFunding(); }, 8000); }
  }
  function fcMarket() {
    const m = marketOf($("#fc-market").value); fs.fcMarket = m;
    if (m) $("#fc-rate").value = (Number(m.fundingRate) * 100).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
    fcCompute();
  }
  function fcCompute() {
    const m = fs.fcMarket, v = parseNum($("#fc-value").value), rate = parseNum($("#fc-rate").value) / 100, hrs = parseNum($("#fc-hours").value);
    const iv = m ? Number(m.intervalH) || 1 : 1;
    if (!(v > 0) || !isFinite(rate)) { $("#fc-out").innerHTML = '<div class="small">Enter a position value and a rate.</div>'; return; }
    const per = v * rate * fs.fcSide; // >0 you pay
    const n = isFinite(hrs) && hrs > 0 ? Math.floor(hrs / iv) : 0;
    const word = (x) => x > 0 ? "You pay" : x < 0 ? "You receive" : "No payment";
    $("#fc-out").innerHTML = '<div class="res-grid">' +
      '<div class="big"><span>' + word(per) + " per settlement</span><b class=\"" + (per > 0 ? "neg" : per < 0 ? "pos" : "") + '">' + fmtNum(Math.abs(per), 4) + "</b><small>USDT every " + iv + "h</small></div>" +
      '<div class="big"><span>' + word(per) + " over " + fmtNum(hrs || 0, 0) + "h</span><b class=\"" + (per > 0 ? "neg" : per < 0 ? "pos" : "") + '">' + fmtNum(Math.abs(per * n), 2) + "</b><small>USDT, " + n + " settlement" + (n === 1 ? "" : "s") + " at this rate</small></div></div>" +
      '<div class="formula">payment = position value × rate = ' + fmtNum(v, 2) + " × " + (rate * 100).toFixed(6).replace(/0+$/, "").replace(/\.$/, "") + "% = " + fmtNum(Math.abs(per), 4) + " USDT (" + (rate >= 0 ? "longs pay shorts" : "shorts pay longs") + ")</div>" +
      '<p class="small">Uses one rate for every settlement. The real rate changes each period.</p>';
  }

  // ================= boot =================
  setInterval(() => { if (mp.nextTarget) tickCountdown(); if (fs.inited) tickFunding(); }, 1000);
  showTab();
  loadMegapop();
  loadBoard().catch(() => {});
})();
