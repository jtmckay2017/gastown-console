const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pick = (o, keys, dflt = "") => {
  for (const k of keys) if (o && o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
  return dflt;
};
const num = (v) => (typeof v === "number" ? v : 0);

/* ---------------- ordering ----------------
   gt promises no order, so every list asserts its own instead of inheriting one.
   Newest first, sorted BEFORE any truncation, missing or unparseable timestamps
   last, and ties broken on a stable identity so an 8s auto-refresh never
   reshuffles rows. Field spelling differs per list, so timestamps are read
   through pick() with these alias lists. */
const CHANGELOG_DATE = ["closed_at", "updated_at", "created_at"];
const MAIL_DATE = ["created_at", "sent_at", "timestamp"];
const ESC_DATE = ["created_at", "at", "timestamp", "updated_at"];
const TRAIL_DATE = ["at", "created_at", "timestamp", "time", "updated_at"];
const WORK_DATE = ["updated_at", "created_at"];

/** Epoch millis for a gt timestamp (ISO string or epoch seconds), or null. */
function stamp(v) {
  if (v === null || v === undefined || v === "") return null;
  const t = typeof v === "number" ? v * 1000 : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Newest first. Undated rows sink to the bottom rather than floating to the top. */
function byNewest(items, dateKeys, idKeys = ["id", "address", "name"]) {
  return items
    .map((it, i) => ({ it, i, t: stamp(pick(it, dateKeys, null)) }))
    .sort((a, b) => {
      if (a.t === null || b.t === null) {
        if (a.t !== b.t) return a.t === null ? 1 : -1;   // undated last
      } else if (a.t !== b.t) {
        return b.t - a.t;
      }
      const ai = String(pick(a.it, idKeys, "")), bi = String(pick(b.it, idKeys, ""));
      if (ai !== bi) return ai < bi ? -1 : 1;            // deterministic tie-break
      return a.i - b.i;
    })
    .map((x) => x.it);
}

/** For lists gt returns with no timestamp at all — gt builds some of them from Go
    maps, whose iteration order is randomised, so they still need a fixed order. */
const byKey = (items, keyFn) => [...items].sort((a, b) => {
  const x = keyFn(a), y = keyFn(b);
  return x < y ? -1 : x > y ? 1 : 0;
});

function ago(ts) {
  const t = stamp(ts);
  if (t === null) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const state = { snap: null, view: "overview", q: "", source: "all", prio: "all", busy: false };

/* ---------------- theme ---------------- */
const theme = new URLSearchParams(location.search).get("theme")
  || localStorage.getItem("gt-theme")
  || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
document.documentElement.dataset.theme = theme;
$("#theme").onclick = () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("gt-theme", next);
};

/* ---------------- tabs ---------------- */
$$(".tab").forEach((t) => {
  t.onclick = () => {
    state.view = t.dataset.view;
    $$(".tab").forEach((x) => x.classList.toggle("is-active", x === t));
    $$(".view").forEach((v) => v.classList.toggle("is-active", v.id === `view-${state.view}`));
  };
});

/* ---------------- fetching ---------------- */
async function load(fresh = false) {
  if (state.busy) return;
  state.busy = true;
  $("#refresh").classList.add("is-busy");
  try {
    const r = await fetch(`/api/snapshot${fresh ? "?fresh=1" : ""}`, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    state.snap = await r.json();
    render();
    const ages = Object.values(state.snap.panels).map((p) => p.age).filter((a) => a != null);
    const oldest = ages.length ? Math.round(Math.max(...ages)) : 0;
    $("#updated").textContent = anyLoading()
      ? "loading panels…"
      : `updated ${new Date().toLocaleTimeString()} · data ≤${oldest}s old`;
    if (anyLoading()) setTimeout(() => load(false), 1500);
  } catch (e) {
    $("#updated").textContent = `refresh failed — ${e.message}`;
  } finally {
    state.busy = false;
    $("#refresh").classList.remove("is-busy");
  }
}
// fresh=1 only marks panels due; the results land a beat later.
$("#refresh").onclick = () => { load(true); setTimeout(() => load(false), 2200); setTimeout(() => load(false), 5000); };

let timer = null;
function schedule() {
  clearInterval(timer);
  if ($("#auto").checked) timer = setInterval(() => load(false), 8000);
}
$("#auto").onchange = schedule;
document.addEventListener("visibilitychange", () => (document.hidden ? clearInterval(timer) : schedule()));

const panel = (n) => state.snap?.panels?.[n] || {};
const dataOf = (n, dflt) => { const p = panel(n); return p.data ?? dflt; };

function errNote(name) {
  const e = panel(name).error;
  return e ? `<div class="error-note">${esc(name)}: ${esc(e)}</div>` : "";
}
const empty = (msg) => `<div class="empty">${esc(msg)}</div>`;
const SKEL = '<div class="skeleton"></div><div class="skeleton"></div>';
const loadingOf = (n) => panel(n).loading && panel(n).data == null;
const anyLoading = () => Object.keys(state.snap?.panels || {}).some(loadingOf);

/* ---------------- render ---------------- */
function render() {
  const status = dataOf("status", {}) || {};
  renderTop(status);
  renderKpis(status);
  renderRigs(status);
  renderEscalations();
  renderPriority();
  renderChangelog();
  renderWork();
  renderAgents(status);
  renderMail();
  renderTrail();
}

function renderTop(s) {
  $("#town-name").textContent = s.location || "—";
  const svc = [
    ["daemon", s.daemon?.running, s.daemon?.pid ? `pid ${s.daemon.pid}` : ""],
    ["dolt", s.dolt?.running, s.dolt?.port ? `:${s.dolt.port}` : ""],
    ["tmux", s.tmux?.running, s.tmux?.session_count ? `${s.tmux.session_count} sessions` : ""],
  ];
  $("#services").innerHTML = svc.map(([n, up, extra]) =>
    `<span class="svc"><i class="dot ${up ? "on" : "off"}"></i>${esc(n)}${extra ? ` <span class="muted">${esc(extra)}</span>` : ""}</span>`).join("");
}

function allAgents(s) {
  const town = (s.agents || []).map((a) => ({ ...a, rig: "town" }));
  const rigged = (s.rigs || []).flatMap((r) => (r.agents || []).map((a) => ({ ...a, rig: r.name })));
  // Agents carry no timestamp (verified against live `gt status --json`), so there is
  // nothing to sort newest-first by; order town first, then rig, then address.
  return byKey([...town, ...rigged], (a) =>
    `${a.rig === "town" ? "0" : "1" + a.rig}\u0000${a.address || a.name || ""}`);
}

function renderKpis(s) {
  const agents = allAgents(s);
  const up = agents.filter((a) => a.running).length;
  const ready = dataOf("ready", {}) || {};
  const esc_ = dataOf("escalations", []) || [];
  const mail = dataOf("mail", []) || [];
  const unread = mail.filter((m) => !pick(m, ["read", "is_read"], false)).length;
  const cards = [
    { v: `${up}/${agents.length}`, l: "Agents up", cls: up === agents.length && agents.length ? "good" : "", sub: agents.filter((a) => a.state === "working").length ? `${agents.filter((a) => a.state === "working").length} working` : "all idle" },
    { v: num(s.summary?.rig_count), l: "Rigs", sub: `${num(s.summary?.polecat_count)} polecats · ${num(s.summary?.crew_count)} crew` },
    { v: num(ready.summary?.total), l: "Ready work", sub: `P1 ${num(ready.summary?.p1_count)} · P2 ${num(ready.summary?.p2_count)}` },
    { v: num(s.summary?.active_hooks), l: "Active hooks", sub: "work on an agent" },
    { v: esc_.length, l: "Escalations", cls: esc_.length ? "alert" : "", sub: esc_.length ? "needs a human" : "clear" },
    { v: unread || mail.length, l: unread ? "Unread mail" : "Mail", sub: `${mail.length} in inbox` },
  ];
  $("#kpis").innerHTML = cards.map((c) => `
    <div class="kpi ${c.cls || ""}">
      <div class="kpi-value">${esc(c.v)}</div>
      <div class="kpi-label">${esc(c.l)}</div>
      <div class="kpi-sub muted">${esc(c.sub || "")}</div>
    </div>`).join("");
  const pw = $("#pill-work"), pa = $("#pill-agents"), pm = $("#pill-mail");
  pw.textContent = num(ready.summary?.total);
  pa.textContent = agents.length;
  pm.textContent = unread || mail.length;
  pm.classList.toggle("hot", unread > 0);
}

function renderRigs(s) {
  if (loadingOf("status")) return void ($("#rigs").innerHTML = SKEL);
  const meta = Object.fromEntries((dataOf("rigs", []) || []).map((r) => [r.name, r]));
  const rigs = byKey(s.rigs || [], (r) => r.name || "");   // no timestamp on a rig; keep it fixed
  $("#rig-count").textContent = rigs.length ? `${rigs.length} registered` : "";
  $("#rigs").innerHTML = errNote("status") + (rigs.length ? rigs.map((r) => {
    const m = meta[r.name] || {};
    const hooks = (r.hooks || []).filter((h) => h.has_work).length;
    return `
      <div class="rig">
        <div class="rig-head">
          <i class="dot ${m.status === "operational" ? "on" : "off"}"></i>
          <span class="rig-name">${esc(r.name)}</span>
          ${m.beads_prefix ? `<span class="badge mono">${esc(m.beads_prefix)}</span>` : ""}
        </div>
        <div class="rig-stats">
          <span class="stat"><b>${r.has_witness ? "●" : "○"}</b><span>witness ${esc(m.witness || (r.has_witness ? "present" : "none"))}</span></span>
          <span class="stat"><b>${r.has_refinery ? "●" : "○"}</b><span>refinery ${esc(m.refinery || (r.has_refinery ? "present" : "none"))}</span></span>
          <span class="stat"><b>${num(r.polecat_count)}</b><span>polecats</span></span>
          <span class="stat"><b>${num(r.crew_count)}</b><span>crew</span></span>
          <span class="stat"><b>${hooks}</b><span>hooks with work</span></span>
        </div>
      </div>`;
  }).join("") : empty("No rigs registered"));
}

function renderEscalations() {
  if (loadingOf("escalations")) return void ($("#escalations").innerHTML = SKEL);
  const items = byNewest(dataOf("escalations", []) || [], ESC_DATE);
  $("#escalations").innerHTML = errNote("escalations") + (items.length ? items.map((e) => {
    const at = ago(pick(e, ESC_DATE));
    return `
    <div class="row">
      <div class="row-main">
        <div class="title wrap">${esc(pick(e, ["title", "summary"], "(untitled)"))}</div>
        <div class="sub"><span class="mono">${esc(pick(e, ["id"]))}</span>${at ? `<span>${esc(at)}</span>` : ""}</div>
      </div>
      <div class="row-side"><span class="badge bad">escalated</span></div>
    </div>`;
  }).join("") : empty("Nothing escalated"));
}

function renderPriority() {
  if (loadingOf("ready")) return void ($("#prio").innerHTML = SKEL);
  const sum = (dataOf("ready", {}) || {}).summary || {};
  const rows = [0, 1, 2, 3, 4].map((p) => ({ p, n: num(sum[`p${p}_count`]) }));
  const max = Math.max(1, ...rows.map((r) => r.n));
  const colors = ["var(--red)", "var(--accent)", "var(--blue)", "var(--faint)", "var(--faint)"];
  $("#prio").innerHTML = rows.some((r) => r.n) ? rows.map((r) => `
    <div class="bar">
      <span class="badge p${r.p}">P${r.p}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${(r.n / max) * 100}%;background:${colors[r.p]}"></span></span>
      <span class="bar-n">${r.n}</span>
    </div>`).join("") : empty("No ready work");
}

function renderChangelog() {
  if (loadingOf("changelog")) return void ($("#changelog").innerHTML = SKEL);
  // Sort before the slice — truncating arrival order would drop the newest closures.
  const items = byNewest(dataOf("changelog", []) || [], CHANGELOG_DATE).slice(0, 40);
  $("#changelog").innerHTML = errNote("changelog") + (items.length ? items.map((c) => `
    <div class="row">
      <div class="row-main">
        <div class="title">${esc(c.title)}</div>
        <div class="sub"><span class="mono">${esc(c.id)}</span><span>${esc(c.rig || "")}</span><span>${esc(ago(pick(c, CHANGELOG_DATE)))}</span></div>
      </div>
    </div>`).join("") : empty("Nothing closed yet"));
}

/* ---------------- work ---------------- */
$("#work-q").oninput = (e) => { state.q = e.target.value.toLowerCase(); renderWork(); };

function renderWork() {
  const ready = dataOf("ready", {}) || {};
  // Sources are a fixed set (town + rigs) with no timestamp of their own, so the
  // groups get a fixed order — town first — and the issues inside sort newest-first.
  const sources = byKey(ready.sources || [], (s) => (s.name === "town" ? "0" : "1" + s.name));
  const chips = [["all", "All"], ...sources.map((s) => [s.name, s.name])];
  $("#work-chips").innerHTML = chips.map(([k, label]) =>
    `<button class="chip ${state.source === k ? "is-active" : ""}" data-src="${esc(k)}">${esc(label)}</button>`).join("")
    + ["all", "1", "2", "3"].map((p) =>
      `<button class="chip ${state.prio === p ? "is-active" : ""}" data-prio="${esc(p)}">${p === "all" ? "Any P" : "P" + p}</button>`).join("");
  $$("#work-chips [data-src]").forEach((b) => (b.onclick = () => { state.source = b.dataset.src; renderWork(); }));
  $$("#work-chips [data-prio]").forEach((b) => (b.onclick = () => { state.prio = b.dataset.prio; renderWork(); }));

  const html = sources
    .filter((s) => state.source === "all" || s.name === state.source)
    .map((s) => {
      const items = byNewest((s.issues || []).filter((i) => {
        if (state.prio !== "all" && String(i.priority) !== state.prio) return false;
        if (!state.q) return true;
        return `${i.id} ${i.title} ${s.name}`.toLowerCase().includes(state.q);
      }), WORK_DATE);
      if (!items.length) return "";
      return `<div class="group-head">${esc(s.name)} · ${items.length}</div>` + items.map((i) => `
        <div class="row row-card">
          <div class="row-main">
            <div class="title wrap">${esc(i.title)}</div>
            <div class="sub">
              <span class="mono">${esc(i.id)}</span>
              ${i.parent ? `<span>↳ ${esc(i.parent)}</span>` : ""}
              <span>${esc(ago(pick(i, WORK_DATE)))}</span>
            </div>
          </div>
          <div class="row-side">
            ${i.issue_type && i.issue_type !== "task" ? `<span class="badge ${i.issue_type === "epic" ? "epic" : ""}">${esc(i.issue_type)}</span>` : ""}
            <span class="badge p${esc(i.priority)}">P${esc(i.priority)}</span>
          </div>
        </div>`).join("");
    }).join("");

  $("#work").innerHTML = loadingOf("ready") ? SKEL
    : errNote("ready") + (html || empty(state.q || state.prio !== "all" ? "Nothing matches that filter" : "No ready work"));
}

/* ---------------- agents ---------------- */
function renderAgents(s) {
  if (loadingOf("status")) return void ($("#agents").innerHTML = SKEL);
  const agents = allAgents(s);
  $("#agent-addresses").innerHTML = agents.map((a) => `<option value="${esc(a.address)}">`).join("")
    + (s.rigs || []).map((r) => `<option value="${esc(r.name)}/">`).join("");
  $("#agents").innerHTML = errNote("status") + (agents.length ? agents.map((a) => `
    <div class="row row-card">
      <i class="dot ${a.running ? (a.state === "working" ? "busy" : "on") : "off"}"></i>
      <div class="row-main">
        <div class="title">${esc(a.name)} <span class="muted mono">${esc(a.address || "")}</span></div>
        <div class="sub">
          <span>${esc(a.role || "")}</span>
          <span class="mono">${esc(a.session || "no session")}</span>
          ${a.agent_alias ? `<span>${esc(a.agent_alias)}</span>` : ""}
          ${a.unread_mail ? `<span class="badge warn">${a.unread_mail} mail</span>` : ""}
        </div>
      </div>
      <div class="row-side">
        ${a.has_work ? '<span class="badge ok">has work</span>' : ""}
        <span class="badge ${a.running ? (a.state === "working" ? "p2" : "") : "bad"}">${esc(a.running ? a.state || "running" : "stopped")}</span>
      </div>
    </div>`).join("") : empty("No agents"));
}

/* ---------------- mail ---------------- */
function renderMail() {
  if (loadingOf("mail")) return void ($("#mail").innerHTML = SKEL);
  // Unread first — it beats newest-first when the two conflict — and newest-first
  // orders within each group.
  const unreadOf = (m) => !pick(m, ["read", "is_read"], false);
  const dated = byNewest(dataOf("mail", []) || [], MAIL_DATE);
  const items = [...dated.filter(unreadOf), ...dated.filter((m) => !unreadOf(m))];
  $("#mail").innerHTML = errNote("mail") + (items.length ? items.map((m) => {
    const unread = unreadOf(m);
    return `
      <div class="row row-card">
        <div class="row-main">
          <div class="title wrap">${esc(pick(m, ["subject", "title"], "(no subject)"))}</div>
          <div class="sub">
            <span>from ${esc(pick(m, ["from", "sender", "from_address"], "?"))}</span>
            <span>${esc(ago(pick(m, MAIL_DATE)))}</span>
            ${m.type ? `<span class="badge">${esc(m.type)}</span>` : ""}
          </div>
        </div>
        <div class="row-side">${unread ? '<span class="badge p1">unread</span>' : ""}</div>
      </div>`;
  }).join("") : empty("Inbox empty"));
}

$("#m-send").onclick = async () => {
  const body = {
    to: $("#m-to").value.trim(),
    subject: $("#m-subject").value.trim(),
    message: $("#m-body").value.trim(),
    type: $("#m-type").value,
    priority: Number($("#m-priority").value),
  };
  const st = $("#m-status");
  if (!body.to || !body.subject || !body.message) { st.textContent = "to, subject and message are required"; return; }
  $("#m-send").disabled = true;
  st.textContent = "sending…";
  try {
    const r = await fetch("/api/mail", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (j.ok) { st.textContent = "sent ✓"; $("#m-subject").value = ""; $("#m-body").value = ""; load(true); }
    else st.textContent = j.error || "send failed";
  } catch (e) { st.textContent = e.message; }
  finally { $("#m-send").disabled = false; setTimeout(() => (st.textContent = ""), 6000); }
};

/* voice dictation, where the browser supports it */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const mic = $("#mic");
if (!SR) { mic.title = "Dictation unsupported here — use your keyboard's mic key"; }
else {
  let rec = null;
  mic.onclick = () => {
    if (rec) { rec.stop(); return; }
    rec = new SR();
    rec.continuous = true; rec.interimResults = true; rec.lang = navigator.language || "en-US";
    const base = $("#m-body").value;
    rec.onresult = (ev) => {
      let out = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) out += ev.results[i][0].transcript;
      $("#m-body").value = (base ? base + " " : "") + out;
    };
    rec.onend = () => { rec = null; mic.classList.remove("is-live"); };
    rec.onerror = () => { rec = null; mic.classList.remove("is-live"); };
    rec.start();
    mic.classList.add("is-live");
  };
}

/* ---------------- activity ---------------- */
function renderTrail() {
  if (loadingOf("trail")) return void ($("#trail").innerHTML = SKEL);
  const raw = dataOf("trail", []) || [];
  const items = byNewest(Array.isArray(raw) ? raw : (raw.items || raw.entries || []), TRAIL_DATE);
  $("#trail").innerHTML = errNote("trail") + (items.length ? items.map((t) => `
    <div class="row row-card">
      <div class="row-main">
        <div class="title wrap">${esc(pick(t, ["title", "message", "summary", "event", "action"], "(event)"))}</div>
        <div class="sub">
          ${pick(t, ["agent", "actor", "who"]) ? `<span>${esc(pick(t, ["agent", "actor", "who"]))}</span>` : ""}
          ${pick(t, ["rig"]) ? `<span>${esc(t.rig)}</span>` : ""}
          ${pick(t, ["id"]) ? `<span class="mono">${esc(t.id)}</span>` : ""}
          <span>${esc(ago(pick(t, TRAIL_DATE)))}</span>
        </div>
      </div>
    </div>`).join("") : empty("No recent activity"));
}

/* ---------------- boot ---------------- */
["#rigs", "#escalations", "#prio", "#changelog", "#work", "#agents", "#mail", "#trail"]
  .forEach((s) => ($(s).innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>'));
load(true);
schedule();
