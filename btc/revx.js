// Panneau "Mes ordres Revolut X" : lit l'API perso (VPS) en lecture seule.
// Le jeton d'accès reste dans le navigateur (localStorage) ; aucune clé Revolut ici.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const ls = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  const DEFAULT_URL = "https://api.antoineviger.com";
  const nf = (d = 0) => new Intl.NumberFormat("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const cur = (q) => (q === "USD" ? "$" : q === "EUR" ? "€" : q);
  const money = (v, q = "USD", d = 0) => (v == null || !isFinite(v) ? "—" : nf(d).format(v) + " " + cur(q));
  const sgn = (v, d = 1) => (v == null || !isFinite(v) ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + nf(d).format(Math.abs(v)) + " %");
  const ago = (ms) => {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 90) return "à l'instant";
    if (s < 3600) return "il y a " + Math.round(s / 60) + " min";
    if (s < 86400) return "il y a " + Math.round(s / 3600) + " h";
    return new Date(ms).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
  };

  let state = null, timer = null, busy = false;

  const url = () => (ls.get("revx.url") || DEFAULT_URL).replace(/\/+$/, "");
  const tok = () => ls.get("revx.token");

  function setStatus(txt, kind) {
    $("rxStatus").textContent = txt;
    $("rxDot").className = "dot" + (kind ? " " + kind : "");
  }

  // ---------- repères options autour d'un prix ----------
  function levels() {
    const s = typeof st !== "undefined" ? st.snap : null;
    if (!s || !s.gamma) return [];
    const g = s.gamma, S = s.cours_btc, em = s.volatilite && s.volatilite.mouvement_attendu_7j_pct;
    const L = [];
    if (g.put_wall) L.push({ px: g.put_wall, n: "put wall" });
    if (g.gamma_flip) L.push({ px: g.gamma_flip, n: "gamma flip" });
    if (g.max_pain_selection) L.push({ px: g.max_pain_selection, n: "max pain" });
    if (g.call_wall) L.push({ px: g.call_wall, n: "call wall" });
    if (S && em) L.push({ px: Math.round(S * (1 - em / 100)), n: "bas 1σ 7 j" });
    return L;
  }
  function landmark(px, L, S, em) {
    let best = null;
    for (const l of L) { const d = (px / l.px - 1) * 100; if (Math.abs(d) <= 1.5 && (!best || Math.abs(d) < Math.abs(best.d))) best = { ...l, d }; }
    if (best) return `<span class="rx-lm">≈ ${esc(best.n)}</span> ${nf(0).format(best.px)}${Math.abs(best.d) < 0.05 ? "" : ` (${sgn(best.d)})`}`;
    if (S && em) {
      const lo = S * (1 - em / 100);
      return px < lo ? `<span class="rx-lm muted">sous la fourchette 1σ 7 j</span>` : `<span class="rx-lm muted">dans la fourchette 1σ 7 j</span>`;
    }
    return "—";
  }

  // ---------- rendu ----------
  function render() {
    const has = !!tok();
    $("rxConnect").hidden = has && !$("rxSettings").open;
    if (!state) { $("rxBody").hidden = true; updateBell(); return; }
    $("rxBody").hidden = false;

    const bal = Object.fromEntries((state.balances || []).map((b) => [b.currency, b]));
    const pUsd = state.prices && state.prices["BTC/USD"] ? state.prices["BTC/USD"].mid : null;
    const btc = bal.BTC ? +bal.BTC.total : 0;
    const orders = (state.orders || []).slice().sort((a, b) => +b.price - +a.price);
    const engaged = orders.filter((o) => o.side === "buy").reduce((a, o) => a + +o.leaves_quantity * +o.price, 0);
    const pend = orders.filter((o) => o.side === "buy").reduce((a, o) => a + +o.leaves_quantity, 0);

    const stat = (l, v, s) => `<div class="stat"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s || "&nbsp;"}</div></div>`;
    $("rxStats").innerHTML = [
      stat("BTC détenu", nf(5).format(btc), pUsd ? "≈ " + money(btc * pUsd) : ""),
      stat("Engagé en ordres", money(engaged), orders.length ? `${orders.length} ordre${orders.length > 1 ? "s" : ""} · +${nf(5).format(pend)} BTC si tout passe` : "aucun ordre"),
      stat("USD disponible", money(bal.USD ? +bal.USD.available : 0, "USD", 2), ""),
      stat("EUR disponible", money(bal.EUR ? +bal.EUR.available : 0, "EUR", 2), ""),
      stat("Cours Revolut X", money(pUsd), "BTC/USD, milieu de carnet"),
    ].join("");

    const s = typeof st !== "undefined" ? st.snap : null;
    const S = s && s.cours_btc, em = s && s.volatilite && s.volatilite.mouvement_attendu_7j_pct, L = levels();
    $("rxOrders").innerHTML = orders.length ? orders.map((o) => {
      const [base, q] = (o.symbol || "BTC/USD").split("/");
      const p = state.prices && state.prices[o.symbol] ? state.prices[o.symbol].mid : null;
      const px = +o.price, left = +o.leaves_quantity, filled = +o.filled_quantity;
      const dist = p ? (px / p - 1) * 100 : null;
      const near = dist != null && Math.abs(dist) <= 1;
      const pUsdLvl = q === "USD" ? px : null;
      return `<tr${near ? ' class="cur"' : ""}>
        <td><span class="tag ${o.side === "buy" ? "buy" : "sell"}">${o.side === "buy" ? "ACHAT" : "VENTE"}</span>${o.type !== "limit" ? ` <span class="note">${esc(o.type)}</span>` : ""}</td>
        <td class="r">${money(px, q)}</td>
        <td class="r">${nf(5).format(left)} ${esc(base)}${filled > 0 ? `<div class="note">${nf(5).format(filled)} déjà exécutés</div>` : ""}</td>
        <td class="r">${money(left * px, q)}</td>
        <td class="r ${dist != null && dist < 0 ? "dn" : "up"}">${sgn(dist)}</td>
        <td>${pUsdLvl ? landmark(pUsdLvl, L, S, em) : "—"}</td>
        <td class="note">${new Date(o.created_date).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}</td></tr>`;
    }).join("") : `<tr><td colspan="7" class="note" style="font-family:var(--sans)">Aucun ordre actif.</td></tr>`;

    const seen = +ls.get("revx.seen", "0");
    const notifs = state.notifications || [];
    $("rxNotifs").innerHTML = notifs.length ? notifs.slice(0, 12).map((n) => `
      <li class="${n.ts > seen ? "new" : ""} ${n.level === "important" ? "imp" : ""}">
        <span class="rx-t">${ago(n.ts)}</span>
        <div><b>${esc(n.title)}</b>${n.body ? `<div class="rx-b">${esc(n.body)}</div>` : ""}</div></li>`).join("")
      : `<li><div class="rx-b">Rien pour l'instant.</div></li>`;

    const stale = state.last_ok && Date.now() - state.last_ok > 10 * 60e3;
    if (state.fail_count) setStatus(`Revolut X injoignable (${state.fail_count} essais) · ${esc(state.last_error || "")}`, "load");
    else setStatus("Relevé " + ago(state.last_ok || state.updated_at) + " · lecture seule", stale ? "load" : "live");
    updateBell();
    publishSnap();
  }

  function updateBell() {
    const seen = +ls.get("revx.seen", "0");
    const n = state ? (state.notifications || []).filter((x) => x.ts > seen).length : 0;
    const b = $("rxBell");
    b.hidden = !tok();
    $("rxBellN").textContent = n;
    $("rxBellN").hidden = n === 0;
    b.setAttribute("aria-label", n ? `${n} nouvelle${n > 1 ? "s" : ""} notification${n > 1 ? "s" : ""} Revolut X` : "Ordres Revolut X");
  }
  function markSeen() {
    if (!state || !(state.notifications || []).length) return;
    const top = Math.max(...state.notifications.map((n) => n.ts));
    if (top > +ls.get("revx.seen", "0")) { ls.set("revx.seen", String(top)); updateBell(); }
  }

  // Données transmises à Vega avec le reste du dashboard
  function publishSnap() {
    if (typeof st === "undefined" || !st.snap || !state) return;
    const bal = Object.fromEntries((state.balances || []).map((b) => [b.currency, b]));
    const pUsd = state.prices && state.prices["BTC/USD"] ? state.prices["BTC/USD"].mid : null;
    const data = {
      source: "API Revolut X, lecture seule, relevé du " + new Date(state.last_ok || state.updated_at).toISOString(),
      cours_btc_usd_revolut: pUsd ? Math.round(pUsd) : null,
      soldes: { btc: bal.BTC ? +bal.BTC.total : 0, usd_disponible: bal.USD ? +bal.USD.available : 0, usd_reserve_ordres: bal.USD ? +bal.USD.reserved : 0, eur_disponible: bal.EUR ? +bal.EUR.available : 0 },
      ordres_actifs: (state.orders || []).map((o) => ({ sens: o.side, type: o.type, paire: o.symbol, prix: +o.price, quantite_restante: +o.leaves_quantity, deja_execute: +o.filled_quantity,
        montant: Math.round(+o.leaves_quantity * +o.price), ecart_cours_pct: pUsd && o.symbol === "BTC/USD" ? Math.round((+o.price / pUsd - 1) * 1000) / 10 : null, cree_le: new Date(o.created_date).toISOString().slice(0, 10) })),
      notifications_recentes: (state.notifications || []).slice(0, 6).map((n) => `${new Date(n.ts).toISOString().slice(0, 16)} ${n.title} : ${n.body}`),
    };
    const sig = JSON.stringify(data.ordres_actifs) + JSON.stringify(data.soldes);
    const changed = !st.snap.ordres_revolut_x || st.snap._rxSig !== sig;
    st.snap.ordres_revolut_x = data;
    Object.defineProperty(st.snap, "_rxSig", { value: sig, enumerable: false, configurable: true, writable: true });
    if (changed) st.snap.horodatage = new Date().toISOString(); // force Vega à renvoyer le snapshot
  }

  // ---------- chargement ----------
  async function load() {
    if (!tok() || busy) { render(); return; }
    busy = true; setStatus("Relevé en cours…", "load");
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 12000);
    try {
      const r = await fetch(url() + "/v1/state", { headers: { Authorization: "Bearer " + tok() }, signal: c.signal, cache: "no-store" });
      if (r.status === 401) { setStatus("Jeton refusé : vérifie-le dans les réglages", ""); $("rxSettings").open = true; $("rxConnect").hidden = false; return; }
      if (!r.ok) throw new Error("HTTP " + r.status);
      state = await r.json();
      render();
    } catch (e) {
      setStatus(e.name === "AbortError" ? "Serveur trop lent à répondre" : "Serveur injoignable (" + (e.message || e) + ")", "");
      if (state) render();
    } finally { clearTimeout(t); busy = false; }
  }

  // ---------- init ----------
  function init() {
    $("rxUrl").value = ls.get("revx.url") || "";
    $("rxUrl").placeholder = DEFAULT_URL;
    $("rxTok").value = tok() || "";
    $("rxSave").addEventListener("click", () => {
      const u = $("rxUrl").value.trim(), k = $("rxTok").value.trim();
      u ? ls.set("revx.url", u) : ls.del("revx.url");
      k ? ls.set("revx.token", k) : ls.del("revx.token");
      $("rxSettings").open = false; state = null; render(); load();
    });
    $("rxForget").addEventListener("click", () => { ls.del("revx.token"); $("rxTok").value = ""; state = null; render(); setStatus("Non connecté", ""); });
    $("rxBell").addEventListener("click", () => { $("revxPanel").scrollIntoView({ behavior: "smooth", block: "start" }); setTimeout(markSeen, 1200); });
    if ("IntersectionObserver" in window) {
      let tm = null;
      new IntersectionObserver((es) => { for (const e of es) { clearTimeout(tm); if (e.isIntersecting) tm = setTimeout(markSeen, 2500); } }, { threshold: 0.35 }).observe($("rxNotifs"));
    }
    document.addEventListener("radar:snap", () => { publishSnap(); if (state) render(); });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
    timer = setInterval(() => { if (!document.hidden) load(); }, 120000);
    if (!tok()) setStatus("Non connecté", "");
    render(); load();
  }
  init();
})();
