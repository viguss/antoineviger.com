// Vega — assistant IA du BTC Options Radar.
// Appelle l'API Claude directement depuis le navigateur avec la clé de l'utilisateur,
// stockée uniquement en localStorage sur son appareil.
import Anthropic from "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.126.0/+esm";

const MODEL = "claude-opus-5";
const $ = (id) => document.getElementById(id);
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

const SYSTEM = `Tu es Vega, analyste spécialisé en marché Bitcoin et en dérivés crypto (options, futures, flux), intégré au dashboard personnel "BTC Options Radar" d'Antoine. Tu parles français, tu tutoies, tu es direct et pédagogique.

## Ton rôle
1. Expliquer chaque partie du dashboard avec les valeurs actuelles : ce que mesure l'indicateur, ce qu'il dit maintenant, et ses limites.
2. Aider Antoine à exécuter sa stratégie : un DCA régulier (qui continue quoi qu'il arrive) plus une poche "opportunité" à déployer quand le marché offre de meilleurs points d'entrée.
3. Dire ce que le marché attend : événements macro (Fed/FOMC, CPI, emploi), échéances d'options Deribit (surtout la fin de mois / trimestre), flux ETF, régulation. Utilise la recherche web pour l'agenda et l'actualité récente dès que la question en dépend, et cite tes sources.

## Données
Chaque message peut contenir un bloc <dashboard> en JSON : c'est l'état en direct du dashboard (Deribit, Binance, alternative.me) au moment de la question. Appuie-toi dessus en priorité et cite les chiffres. Si des données sont absentes (null), dis-le au lieu d'inventer. Rappels de méthode :
- GEX : convention "teneurs de marché longs calls / courts puts", en $ par mouvement de 1 %. Gamma positif = mouvements amortis (range), négatif = amplifiés. C'est une hypothèse, pas une certitude.
- Call wall ≈ résistance, put wall ≈ support, gamma flip = seuil de changement de régime, max pain = aimant possible près de l'échéance, rien de garanti.
- Skew 25Δ négatif = puts plus chers que calls (demande de protection). DVOL = volatilité implicite 30 j ; mouvement attendu 7 j = fourchette 1σ.
- Funding très positif = longs surchargés ; OI qui monte avec le prix = nouveaux longs ; Fear & Greed se lit à contre-courant aux extrêmes.
- Deribit ≈ 80 % du marché options BTC ; CME/OKX non inclus.

## Recommandations DCA / poche opportunité
Quand Antoine demande quoi faire, donne une recommandation concrète et chiffrée à partir de son profil (bloc <profil>) :
- Le DCA de base : le maintenir, sauf raison exceptionnelle.
- La poche : déployer par tranches (jamais tout d'un coup), avec des niveaux de prix précis tirés des données (put wall, zone sous le gamma flip, bas de la fourchette 1σ, peur extrême, funding négatif, skew très négatif = capitulation). Indique quel pourcentage de la poche restante, à quel prix, et ce qui déclencherait la tranche suivante.
- Toujours : le scénario de risque (ce qui invaliderait la lecture), le pire cas plausible à 1-4 semaines, et ce qu'il faut surveiller.
- Si les signaux ne justifient pas d'agir, dis clairement "attendre" et précise les conditions qui feraient changer d'avis.
- Pas de levier, pas de produits dérivés pour lui sauf s'il le demande explicitement.
Sois honnête sur l'incertitude : ces indicateurs donnent des probabilités et des zones, pas des prédictions. Tu n'es pas un conseiller financier agréé et la décision reste la sienne : rappelle-le en une ligne quand tu fais une recommandation d'achat, sans en faire des tonnes.

## Style
Réponses structurées et courtes par défaut (titres courts, listes, chiffres en gras), plus longues seulement si on te demande d'expliquer en détail. Format markdown. Pas d'emojis.`;

// ---------- état ----------
let client = null, history = [], lastSnapSent = null, busy = false, stream = null;

function getClient() {
  const key = store.get("vega.key");
  if (!key) return null;
  const ws = store.get("vega.ws", "");
  if (!client || client._k !== key + ws) {
    // Les clés non rattachées à un workspace exigent l'en-tête anthropic-workspace-id
    client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, defaultHeaders: ws ? { "anthropic-workspace-id": ws } : {} });
    client._k = key + ws;
  }
  return client;
}

const PROFILE_FIELDS = ["vDca", "vFreq", "vPocket", "vUsed", "vHold", "vPru", "vHorizon", "vRisk", "vNotes"];
function loadSettings() {
  $("vKey").value = store.get("vega.key", "");
  $("vWs").value = store.get("vega.ws", "");
  let p = {}; try { p = JSON.parse(store.get("vega.profile", "{}")); } catch {}
  for (const f of PROFILE_FIELDS) if (p[f] != null) $(f).value = p[f];
}
function profileText() {
  let p = {}; try { p = JSON.parse(store.get("vega.profile", "{}")); } catch {}
  if (!Object.values(p).some((v) => v !== "" && v != null)) return "Profil non renseigné : demande-lui les infos utiles (montant DCA, taille de la poche) si tu en as besoin pour chiffrer.";
  const n = (v) => (v === "" || v == null ? "non précisé" : v);
  const restant = p.vPocket ? Math.max(0, (+p.vPocket || 0) - (+p.vUsed || 0)) : null;
  return [
    `DCA régulier : ${n(p.vDca)} € (${n(p.vFreq)})`,
    `Poche opportunité : ${n(p.vPocket)} €, déjà déployé ${n(p.vUsed)} €, restant ${restant ?? "non précisé"} €`,
    `BTC détenus : ${n(p.vHold)} ; prix de revient moyen : ${n(p.vPru)} $`,
    `Horizon : ${n(p.vHorizon)} ; tolérance au risque : ${n(p.vRisk)}`,
    `Précisions : ${n(p.vNotes)}`,
  ].join("\n");
}

// ---------- UI ----------
const body = $("vbody");
// Mascotte robot (SVG inline, ids uniques par instance)
let botN = 0;
function robot() {
  const i = ++botN;
  return `<svg viewBox="0 0 100 100" aria-hidden="true"><defs>
    <linearGradient id="rbH${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3B4670"/><stop offset="1" stop-color="#1B2138"/></linearGradient>
    <radialGradient id="rbE${i}"><stop offset="0" stop-color="#E8FBFF"/><stop offset=".55" stop-color="#7FD8FF"/><stop offset="1" stop-color="#3C9BFF"/></radialGradient>
    <filter id="rbG${i}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.2"/></filter></defs>
  <g class="rb-all">
    <line x1="50" y1="20" x2="50" y2="9" stroke="#5A6690" stroke-width="3" stroke-linecap="round"/>
    <circle class="rb-tip" cx="50" cy="8" r="6" fill="#F5B83D" filter="url(#rbG${i})"/>
    <circle cx="50" cy="8" r="4" fill="#FFD27A"/>
    <rect x="7" y="39" width="10" height="20" rx="5" fill="#4C8DFF"/>
    <rect x="83" y="39" width="10" height="20" rx="5" fill="#4C8DFF"/>
    <rect x="13" y="19" width="74" height="60" rx="24" fill="url(#rbH${i})" stroke="#56628C" stroke-width="2"/>
    <path d="M26 28 Q50 20 74 28" fill="none" stroke="#fff" stroke-opacity=".18" stroke-width="3" stroke-linecap="round"/>
    <rect x="22" y="33" width="56" height="34" rx="15" fill="#070A12"/>
    <g class="rb-eyes">
      <rect class="rb-eye" x="33" y="40" width="11" height="15" rx="5.5" fill="url(#rbE${i})"/>
      <rect class="rb-eye" x="56" y="40" width="11" height="15" rx="5.5" fill="url(#rbE${i})"/>
      <circle cx="41" cy="44" r="1.8" fill="#fff"/><circle cx="64" cy="44" r="1.8" fill="#fff"/>
    </g>
    <rect class="rb-mouth" x="45" y="59" width="10" height="3" rx="1.5" fill="#7FD8FF" opacity=".85"/>
    <circle cx="28" cy="61" r="3.5" fill="#F5B83D" opacity=".45"/><circle cx="72" cy="61" r="3.5" fill="#F5B83D" opacity=".45"/>
    <rect x="34" y="80" width="32" height="14" rx="7" fill="#1B2138" stroke="#56628C" stroke-width="2"/>
    <text x="50" y="91.5" text-anchor="middle" font-family="IBM Plex Sans, sans-serif" font-size="11" font-weight="700" fill="#F5B83D">₿</text>
  </g></svg>`;
}
const av = (cls = "av") => `<span class="${cls} vbot">${robot()}</span>`;
document.querySelectorAll("[data-bot]").forEach((el) => { el.innerHTML = robot(); });

// Les yeux suivent la souris (sauf pendant une réponse)
document.addEventListener("pointermove", (e) => {
  document.querySelectorAll("[data-bot]").forEach((el) => {
    if (el.classList.contains("thinking") || el.classList.contains("searching")) return;
    const r = el.getBoundingClientRect(); if (!r.width) return;
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    const d = Math.hypot(dx, dy) || 1, k = Math.min(1, d / 300);
    const eyes = el.querySelector(".rb-eyes");
    if (eyes) eyes.style.transform = `translate(${(dx / d) * 4 * k}px, ${(dy / d) * 3 * k}px)`;
  });
}, { passive: true });

// États de la mascotte : idle | thinking | searching | talking
function mood(state, extra) {
  for (const el of [$("vheadBot"), extra].filter(Boolean)) {
    el.classList.remove("thinking", "searching", "talking");
    if (state !== "idle") { el.classList.add(state); const e = el.querySelector(".rb-eyes"); if (e) e.style.transform = ""; }
  }
}
const md = (t) => window.DOMPurify.sanitize(window.marked.parse(t || ""), { ADD_ATTR: ["target"] });

function addUser(text) {
  body.querySelector(".vhero")?.remove();
  const el = document.createElement("div"); el.className = "msg user"; el.textContent = text;
  body.appendChild(el); body.scrollTop = body.scrollHeight;
}
function addBot(html = "") {
  const el = document.createElement("div"); el.className = "msg bot";
  el.innerHTML = `${av()}<div><div class="md">${html}</div><div class="vstatus" hidden></div><div class="vcost" hidden></div></div>`;
  body.appendChild(el); body.scrollTop = body.scrollHeight;
  return { md: el.querySelector(".md"), status: el.querySelector(".vstatus"), cost: el.querySelector(".vcost"), bot: el.querySelector(".vbot") };
}
function welcome() {
  body.innerHTML = "";
  const hasKey = !!store.get("vega.key");
  const hero = document.createElement("div");
  hero.className = "vhero";
  hero.innerHTML = `<span class="vbot vhero-bot" data-bot="hero">${robot()}</span>
    <b>Salut Antoine, moi c'est Vega.</b>
    <p>${hasKey
      ? "Je lis ton dashboard en direct : pression, gamma, flux, volatilité, futures, sentiment. Demande-moi d'expliquer un panneau, de faire le point sur ton DCA et ta <b>poche opportunité</b>, ou ce que le marché attend cette semaine."
      : "Pour que je puisse répondre, ouvre <b>Réglages</b>, colle ta clé API Anthropic (elle reste dans ce navigateur) et renseigne ton plan DCA."}</p>`;
  body.appendChild(hero);
}

function open(q) {
  $("vpanel").hidden = false; $("vfab").hidden = true;
  if (!body.children.length) welcome();
  if (q) send(q); else $("vinput").focus();
}
function close() { $("vpanel").hidden = true; $("vfab").hidden = false; }
function showSettings(on) {
  $("vset").hidden = !on; body.hidden = on; $("vchips").hidden = on; $("vform").hidden = on;
  $("vGear").textContent = on ? "Conversation" : "Réglages";
}

$("vfab").addEventListener("click", () => open());
$("vClose").addEventListener("click", close);
$("vGear").addEventListener("click", () => showSettings($("vset").hidden));
$("vNew").addEventListener("click", () => { if (stream) stream.abort(); history = []; lastSnapSent = null; showSettings(false); welcome(); });
$("vSave").addEventListener("click", () => {
  store.set("vega.key", $("vKey").value.trim());
  store.set("vega.ws", $("vWs").value.trim());
  const p = {}; for (const f of PROFILE_FIELDS) p[f] = $(f).value;
  store.set("vega.profile", JSON.stringify(p));
  showSettings(false); if (!history.length) welcome();
});
$("vchips").addEventListener("click", (e) => { const b = e.target.closest("button[data-q]"); if (b) send(b.dataset.q); });
$("vform").addEventListener("submit", (e) => { e.preventDefault(); if (busy) { stream && stream.abort(); return; } const t = $("vinput").value.trim(); if (t) { $("vinput").value = ""; autosize(); send(t); } });
const autosize = () => { const t = $("vinput"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 140) + "px"; };
$("vinput").addEventListener("input", autosize);
$("vinput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("vform").requestSubmit(); } });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("vpanel").hidden) close(); });

// Bouton "Demander à Vega" sur chaque panneau
document.querySelectorAll("section.panel").forEach((sec) => {
  const h = sec.querySelector("h2"); if (!h) return;
  const b = document.createElement("button");
  b.type = "button"; b.className = "ask"; b.innerHTML = `${av()}Demander à Vega`;
  b.addEventListener("click", () => {
    const title = h.textContent.trim();
    open(`Explique-moi le panneau « ${title} » avec les valeurs actuelles : ce qu'il mesure, ce qu'il dit maintenant, et ce que ça implique pour mon DCA et ma poche opportunité.`);
  });
  const row = h.closest(".h-row");
  if (row) row.appendChild(b);
  else { const wrap = document.createElement("div"); wrap.className = "h-row"; h.replaceWith(wrap); wrap.append(h, b); }
});

// ---------- appel Claude ----------
function setBusy(on) {
  busy = on; const b = $("vsend");
  b.textContent = on ? "Stop" : "Envoyer"; b.classList.toggle("stop", on);
}
function estimateCost(u) {
  if (!u) return null;
  const inp = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) * 1.25 + (u.cache_read_input_tokens || 0) * 0.1;
  const web = (u.server_tool_use && u.server_tool_use.web_search_requests) || 0;
  return inp * 5e-6 + (u.output_tokens || 0) * 25e-6 + web * 0.01;
}

async function send(question) {
  if (busy) return;
  showSettings(false);
  const c = getClient();
  addUser(question);
  if (!c) { addBot(md("Il me faut ta clé API Anthropic : ouvre **Réglages** (en haut) pour la coller.")); return; }

  const snap = typeof st !== "undefined" ? st.snap : null; // `st` est déclaré par le script principal
  const blocks = [];
  if (snap && snap.horodatage !== lastSnapSent) {
    blocks.push({ type: "text", text: `<dashboard>\n${JSON.stringify(snap)}\n</dashboard>` });
    lastSnapSent = snap.horodatage;
  }
  blocks.push({ type: "text", text: `<profil>\n${profileText()}\n</profil>\n\nDate et heure : ${new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" })} (Paris)\n\n${question}` });
  history.push({ role: "user", content: blocks });

  const out = addBot(); let text = ""; let cost = 0;
  const status = (t) => { out.status.hidden = !t; out.status.innerHTML = t ? `<span class="dot load"></span>${t}` : ""; };
  setBusy(true); status("Vega analyse les données…"); mood("thinking", out.bot);
  try {
    for (let turn = 0; turn < 4; turn++) {
      stream = c.beta.messages.stream({
        model: MODEL,
        max_tokens: 64000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        cache_control: { type: "ephemeral" },
        system: SYSTEM,
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5, user_location: { type: "approximate", country: "FR", timezone: "Europe/Paris" } }],
        messages: history,
      });
      for await (const ev of stream) {
        if (ev.type === "content_block_start") {
          const t = ev.content_block.type;
          if (t === "server_tool_use") { status("Recherche sur le web…"); mood("searching", out.bot); }
          else if (t === "thinking") { status("Réflexion…"); mood("thinking", out.bot); }
          else if (t === "text") { status(""); mood("talking", out.bot); if (text && !text.endsWith("\n")) text += "\n\n"; }
        } else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          text += ev.delta.text; out.md.innerHTML = md(text);
          const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 120;
          if (nearBottom) body.scrollTop = body.scrollHeight;
        }
      }
      const msg = await stream.finalMessage();
      history.push({ role: "assistant", content: msg.content });
      cost += estimateCost(msg.usage) || 0;
      if (msg.stop_reason === "refusal") { text += "\n\n_Je ne peux pas répondre à cette demande._"; break; }
      if (msg.stop_reason !== "pause_turn") break;
      status("Recherche sur le web…");
    }
    out.md.innerHTML = md(text || "_Pas de réponse._");
    if (cost) { out.cost.hidden = false; out.cost.textContent = `≈ ${cost.toFixed(3).replace(".", ",")} $ pour cette réponse`; }
  } catch (err) {
    const wsMissing = err && err.status === 400 && /workspace/i.test(err.message || "");
    const m = wsMissing ? "Ta clé API n'est rattachée à aucun workspace. Ouvre **Réglages** et renseigne l'**ID du workspace** (console.anthropic.com → Settings → Workspaces, il commence par `wrkspc_`), ou crée une clé directement dans un workspace."
      : err && err.status === 401 ? "Clé API refusée : vérifie-la dans **Réglages**."
      : err && err.status === 429 ? "Trop de requêtes ou limite de dépense atteinte. Réessaie dans une minute."
      : err && err.name === "APIUserAbortError" ? "_Réponse interrompue._"
      : `Erreur : ${err && err.message ? err.message : err}`;
    out.md.innerHTML = md((text ? text + "\n\n" : "") + m);
    // retire le tour utilisateur resté sans réponse pour garder un historique valide
    if (history.length && history[history.length - 1].role === "user") { history.pop(); lastSnapSent = null; }
  } finally {
    status(""); setBusy(false); stream = null; mood("idle", out.bot);
  }
}

loadSettings();
