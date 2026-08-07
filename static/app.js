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
const FLIGHT_DATE = ["updated_at", "created_at"];
const CONVOY_DATE = ["created_at", "updated_at", "at"];

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

const state = {
  snap: null, view: "overview", q: "", source: "all", prio: "all", busy: false,
  // Agents tab: which rows are expanded, keyed by agent address. Lives here rather
  // than in the DOM because every render replaces #agents wholesale — see renderAgents.
  expanded: new Set(),
  // Same, for the convoy rows on the Work tab, keyed by convoy id.
  convoys: new Set(),
  // The tmux session whose terminal is open in the watch view, and the last `watch`
  // panel fetched for it. One at a time: watching is an act of attention, and two
  // live terminals on one screen is two things nobody is reading. See watchView().
  watch: null,
  watchPanel: null,
};

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
// The watch view keeps its own faster timer (see watchSchedule) — it is not the Auto
// toggle's business, but a hidden tab stops both.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearInterval(timer); else schedule();
  watchSchedule();
});

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
  renderWorkView();
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

/** A dog's tmux session. `gt dog list --json` names none, so match the pack against
    the live session list — `hq-dog-alpha` today, anything ending `dog-<name>` if the
    town prefix ever changes. "" means the dog is registered but has no session. */
const dogSession = (name, panes) => {
  const want = `dog-${name}`;
  return Object.keys(panes).find((s) => s === want || s.endsWith(`-${want}`)) || "";
};

/** Every agent in town, from three reads that each see a different slice of it:

      `gt status --json`     town agents and rig agents — but no dogs and no boot
      `gt dog list --json`   the deacon's dog pack, which status omits entirely
      the tmux session list  anything else holding a session, boot most often

    The third is the safety net, and the reason `panes` is keyed by session rather
    than by agent: whatever `gt` forgets to name still shows up, so a live agent can
    never be invisible. Dogs and loose sessions have no mail address, so they carry
    address:"" and the compose datalist drops them rather than offering an address
    that would bounce. */
function allAgents(s) {
  const panes = dataOf("panes", {}) || {};
  const read = Object.keys(panes).length > 0;
  const town = (s.agents || []).map((a) => ({ ...a, rig: "town", source: "gt status" }));
  const rigged = (s.rigs || []).flatMap((r) =>
    (r.agents || []).map((a) => ({ ...a, rig: r.name, source: "gt status" })));
  const claimed = new Set([...town, ...rigged].map((a) => a.session).filter(Boolean));

  const dogs = (dataOf("dogs", []) || []).map((d) => {
    const session = dogSession(d.name, panes);
    if (session) claimed.add(session);
    // With no pane read there is no session to match, but `gt dog list` only lists
    // dogs that exist — trust it rather than reporting the whole pack never started.
    return {
      name: d.name, address: "", rig: "town", role: "dog", session,
      running: !read || !!session, state: d.state || "", has_work: false,
      unread_mail: 0, last_active: d.last_active, source: "gt dog list",
    };
  });

  const loose = Object.keys(panes).filter((n) => !claimed.has(n)).map((n) => ({
    name: n, address: "", rig: "town", role: "session", session: n,
    running: true, state: "", has_work: false, unread_mail: 0, source: "tmux session",
  }));

  // Agents carry no timestamp (verified against live `gt status --json`), so there is
  // nothing to sort newest-first by; order town first, then rig, then address.
  return byKey([...town, ...rigged, ...dogs, ...loose], (a) =>
    `${a.rig === "town" ? "0" : "1" + a.rig}\u0000${a.address || a.name || ""}`);
}

/** What every agent row is read against: the pane map, which rigs are parked, and
    whether the pane read landed at all. Built once per render — `panes` can error
    (tmux down) or lag the first paint, and `live:false` is what makes the tab fall
    back to gt's own signals instead of declaring the whole town stopped. */
function agentCtx() {
  const panes = dataOf("panes", {}) || {};
  const parked = new Set((dataOf("rigs", []) || [])
    .filter((r) => String(r.status || "").toLowerCase() === "parked")
    .map((r) => r.name));
  return { panes, parked, live: Object.keys(panes).length > 0 };
}

function renderKpis(s) {
  const agents = allAgents(s);
  const ctx = agentCtx();
  const up = agents.filter((a) => a.running).length;
  // Derived from panes like the tab itself — counting gt's state="working" here was
  // the same lie in a bigger font.
  const busy = agents.filter((a) => agentState(a, ctx).key === "working").length;
  const stuck = agents.filter((a) => agentState(a, ctx).key === "staged").length;
  const ready = dataOf("ready", {}) || {};
  const esc_ = dataOf("escalations", []) || [];
  const mail = dataOf("mail", []) || [];
  const unread = mail.filter((m) => !pick(m, ["read", "is_read"], false)).length;
  // Who is working, then what they are working on — the second half of the question
  // the first half raises. Both are counts of the same town, from different reads.
  const inflight = dataOf("flight", []) || [];
  const blocked = inflight.filter((b) => flightState(b).key === "blocked").length;
  const convoys = (dataOf("convoys", []) || [])
    .filter((c) => String(c.status || "").toLowerCase() !== "closed").length;
  const cards = [
    { v: `${busy}/${agents.length}`, l: "Agents working", cls: busy ? "good" : "",
      sub: `${up} up${stuck ? ` · ${stuck} with input staged` : ""}` },
    { v: inflight.length, l: "Work in flight", cls: inflight.length ? "good" : "",
      sub: `${inflight.length - blocked} moving${blocked ? ` · ${blocked} blocked` : ""}`
        + `${convoys ? ` · ${convoys} convoy${convoys === 1 ? "" : "s"}` : ""}` },
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
    // Parked is a decision, not a fault — grey, and named. Red is reserved for a rig
    // that is neither running nor deliberately stood down.
    const parked = String(m.status || "").toLowerCase() === "parked";
    return `
      <div class="rig">
        <div class="rig-head">
          <i class="dot ${m.status === "operational" ? "on" : parked ? "done" : "off"}"></i>
          <span class="rig-name">${esc(r.name)}</span>
          ${parked ? '<span class="badge">parked</span>' : ""}
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

/* ---------------- work ----------------
   This tab answers "what is happening in this town right now", and no single read
   answers it. Three do, and stitching them is the whole job:

     flight   which beads are in flight        (bd, one call per rig — see flight.py)
     status   which agent each one sits with   (correlated by address — see addrKeys)
     panes    what that agent is doing this second   (the read gc-vy3 introduced)

   Alone each one is a half-answer. `gt status` carries no bead field on an agent,
   `gt ready` drops a bead the moment somebody picks it up, and a pane says a turn is
   in flight without saying what about. Joined they say "Toast holds wp-120, and its
   screen says it is running tests", which is what was asked for. Convoys sit on the
   same tab because they are the town's own answer to "how far along" — the progress
   dimension over the same beads, not a fourth widget.

   The sections read top to bottom as one sentence: what is moving, how far along it
   is, what could be started next. One filter bar drives all three. */

/* An agent's address and a bead's assignee name the same agent and do not spell it
   the same way. `gt status` calls this polecat gastown_console/chrome; the bead on
   its hook says assignee gastown_console/polecats/chrome. Crew runs the other way —
   there the address itself carries the /crew/ segment. So neither spelling is
   canonical: index each side under both its raw form and the form with the role
   segment dropped, and treat a hit on either as a match. */
const ROLE_SEG = new Set(["polecats", "polecat", "crew", "crews", "agents"]);
function addrKeys(addr) {
  const raw = String(addr ?? "").trim().toLowerCase().replace(/\/+$/, "");
  if (!raw) return [];
  const parts = raw.split("/").filter(Boolean);
  const bare = parts.filter((p, i) => !(i > 0 && i < parts.length - 1 && ROLE_SEG.has(p))).join("/");
  return bare && bare !== raw ? [raw, bare] : [raw];
}

/** Beads in flight, newest-first, plus an index from agent address to the beads that
    agent holds. Built once and read by both tabs — the Work tab draws the list, the
    Agents tab looks up its own row — so the two can never disagree. */
function flightModel() {
  const items = byNewest(dataOf("flight", []) || [], FLIGHT_DATE);
  const byAgent = new Map();
  for (const b of items) {
    for (const k of addrKeys(b.assignee)) {
      if (!byAgent.has(k)) byAgent.set(k, []);
      byAgent.get(k).push(b);
    }
  }
  return { items, byAgent };
}

/** What one agent is holding. Both spellings are looked up and the results merged,
    because a town can carry beads filed under each. */
function flightFor(fm, address) {
  const out = [], seen = new Set();
  for (const k of addrKeys(address)) {
    for (const b of fm.byAgent.get(k) || []) {
      if (!seen.has(b.id)) { seen.add(b.id); out.push(b); }
    }
  }
  return out;
}

/** address -> agent, under both spellings, so a bead can find who is holding it. */
function agentIndex(agents) {
  const ix = new Map();
  for (const a of agents) for (const k of addrKeys(a.address)) if (!ix.has(k)) ix.set(k, a);
  return ix;
}
function agentFor(ix, assignee) {
  for (const k of addrKeys(assignee)) { const a = ix.get(k); if (a) return a; }
  return null;
}

/* The stored statuses that are neither open nor closed (see flight.py). `hooked` is
   the one that matters most and the one nobody expects: it is what `gt sling` sets,
   so it is where nearly all live work sits. Order is reading order — what is moving
   first, what is stuck last, where it cannot be missed at the end of a short list. */
const FLIGHT_STATES = [
  { key: "in_progress", label: "In progress", hint: "claimed by an agent", badge: "ok" },
  { key: "hooked",      label: "On a hook",   hint: "slung to an agent — this town's usual shape", badge: "ok" },
  { key: "blocked",     label: "Blocked",     hint: "stalled behind something else", badge: "bad" },
  { key: "other",       label: "In flight",   hint: "neither open nor closed",   badge: "" },
];
const flightState = (b) => FLIGHT_STATES.find((x) => x.key === String(b.status || "").toLowerCase())
  || FLIGHT_STATES[FLIGHT_STATES.length - 1];

/** The one filter bar over the tab. Applied to in-flight beads and ready issues
    alike — they are the same kind of thing at different moments of their life, and a
    filter that hid one but not the other would be lying about the other. */
function matches(o, source) {
  if (state.source !== "all" && source !== state.source) return false;
  if (state.prio !== "all" && String(o.priority) !== state.prio) return false;
  if (!state.q) return true;
  return `${o.id} ${o.title} ${source} ${o.assignee || ""}`.toLowerCase().includes(state.q);
}

$("#work-q").oninput = (e) => { state.q = e.target.value.toLowerCase(); renderWorkView(); };

function renderWorkView() {
  const s = dataOf("status", {}) || {};
  renderWorkChips();
  renderFlight(s);
  renderConvoys(s);
  renderReady();
}

function renderWorkChips() {
  // Sources are a fixed set (town + rigs) with no timestamp of their own, so they get
  // a fixed order, town first. A rig with work in flight but nothing ready still owns
  // a chip — otherwise the filter could not reach the rows the tab now leads with.
  const ready = dataOf("ready", {}) || {};
  const names = new Set((ready.sources || []).map((s) => s.name).filter(Boolean));
  (dataOf("flight", []) || []).forEach((b) => b.rig && names.add(b.rig));
  const sources = byKey([...names], (n) => (n === "town" ? "0" : "1" + n));
  $("#work-chips").innerHTML = [["all", "All"], ...sources.map((n) => [n, n])].map(([k, label]) =>
    `<button class="chip ${state.source === k ? "is-active" : ""}" data-src="${esc(k)}">${esc(label)}</button>`).join("")
    + ["all", "1", "2", "3"].map((p) =>
      `<button class="chip ${state.prio === p ? "is-active" : ""}" data-prio="${esc(p)}">${p === "all" ? "Any P" : "P" + p}</button>`).join("");
  $$("#work-chips [data-src]").forEach((b) => (b.onclick = () => { state.source = b.dataset.src; renderWorkView(); }));
  $$("#work-chips [data-prio]").forEach((b) => (b.onclick = () => { state.prio = b.dataset.prio; renderWorkView(); }));
}

/** One bead in flight: what it is, who has it, and — where the agent can be paired
    with a live pane — what that agent's screen says it is doing about it right now. */
function flightRow(b, ix, ctx) {
  const st = flightState(b);
  const agent = agentFor(ix, b.assignee);
  const ast = agent ? agentState(agent, ctx) : null;
  const note = agent ? agentNote(agent, ctx) : "";
  // The live line is the point of the row: the agent's own screen, one line of it.
  // When the assignee matches no agent at all, say so — a gap there would read as
  // "nobody is on it", which is the opposite of what an assignee means.
  const live = ast ? `${ast.label.toLowerCase()}${note ? ` · ${note}` : ""}`
    : b.assignee ? "no live session for this assignee" : "";
  return `
    <div class="row row-card flight ${ast && ast.key === "working" ? "is-live" : ""}">
      <i class="dot ${ast ? ast.dot : ""}"></i>
      <div class="row-main">
        <div class="title wrap">${esc(b.title)}</div>
        <div class="sub">
          <span class="mono">${esc(b.id)}</span>
          <span>${esc(b.rig || "")}</span>
          <span>${b.assignee ? esc(b.assignee) : "unassigned"}</span>
          <span>${esc(ago(pick(b, FLIGHT_DATE)))}</span>
        </div>
        ${live ? `<div class="flight-live">${esc(live)}</div>` : ""}
      </div>
      <div class="row-side">
        ${b.issue_type && b.issue_type !== "task" ? `<span class="badge ${b.issue_type === "epic" ? "epic" : ""}">${esc(b.issue_type)}</span>` : ""}
        ${b.priority == null ? "" : `<span class="badge p${esc(b.priority)}">P${esc(b.priority)}</span>`}
        <span class="badge ${st.badge}">${esc(st.label)}</span>
      </div>
    </div>`;
}

function renderFlight(s) {
  if (loadingOf("flight")) return void ($("#flight").innerHTML = SKEL);
  const fm = flightModel();
  const ix = agentIndex(allAgents(s));
  const ctx = agentCtx();
  const items = fm.items.filter((b) => matches(b, b.rig));
  $("#flight-count").textContent = !fm.items.length ? ""
    : items.length === fm.items.length ? `${items.length} in flight`
      : `${items.length} of ${fm.items.length} in flight`;

  // Status first, so blocked work cannot hide at the bottom of a long list. byNewest
  // ran in flightModel and byKey is stable, so newest-first survives inside a group.
  const ordered = byKey(items, (b) => String(FLIGHT_STATES.indexOf(flightState(b))).padStart(2, "0"));
  const counts = {};
  ordered.forEach((b) => { const k = flightState(b).key; counts[k] = (counts[k] || 0) + 1; });
  let last = null;
  const rows = ordered.map((b) => {
    const st = flightState(b);
    const head = st.key === last ? ""
      : `<div class="group-head">${esc(st.label)} · ${counts[st.key]}
           <span class="group-hint">${esc(st.hint)}</span></div>`;
    last = st.key;
    return head + flightRow(b, ix, ctx);
  }).join("");

  $("#flight").innerHTML = errNote("flight") + (ordered.length ? rows
    : empty(fm.items.length ? "Nothing in flight matches that filter" : "Nothing in flight"));
}

/* ---------------- convoys ----------------
   A convoy is the town's own unit of tracked work — an id, the beads it tracks, and
   its own completed/total. The read has been running since it was added and nothing
   drew it. It belongs beside the in-flight list rather than in a tab of its own: the
   list says what is moving, the convoy says how much of the batch is left. */
const convoyKey = (c) => String(pick(c, ["id", "name", "title"], ""));
const convoyDetailId = (key) => `convoy-detail-${key.replace(/[^a-zA-Z0-9]+/g, "-")}`;

function convoyDetail(c, key, ix, ctx) {
  // Outstanding first, closed after — the same reason the in-flight list groups by
  // status. Tracked entries carry no timestamp, so id is the tiebreak.
  const tracked = (Array.isArray(c.tracked) ? c.tracked : []).filter((t) => t && typeof t === "object");
  const rows = byKey(tracked, (t) => `${String(t.status || "").toLowerCase() === "closed" ? "1" : "0"} ${t.id || ""}`)
    .map((t) => {
      const closed = String(t.status || "").toLowerCase() === "closed";
      const agent = closed ? null : agentFor(ix, t.assignee);
      const ast = agent ? agentState(agent, ctx) : null;
      return `
        <div class="row convoy-item">
          <i class="dot ${closed ? "done" : ast ? ast.dot : ""}"></i>
          <div class="row-main">
            <div class="title wrap">${esc(t.title || "(untitled)")}</div>
            <div class="sub">
              <span class="mono">${esc(t.id || "")}</span>
              ${t.assignee ? `<span>${esc(t.assignee)}</span>` : ""}
              ${ast ? `<span>${esc(ast.label.toLowerCase())}</span>` : ""}
            </div>
          </div>
          <div class="row-side"><span class="badge ${closed ? "ok" : ""}">${esc(t.status || "?")}</span></div>
        </div>`;
    }).join("");
  return `<div class="convoy-detail" id="${esc(convoyDetailId(key))}">${rows || empty("Nothing tracked")}</div>`;
}

function convoyRow(c, ix, ctx) {
  const key = convoyKey(c);
  const open = state.convoys.has(key);
  const tracked = Array.isArray(c.tracked) ? c.tracked : [];
  const total = num(c.total) || tracked.length;
  const done = Math.min(num(c.completed), total);
  const closed = String(c.status || "").toLowerCase() === "closed";
  return `
    <div class="convoy">
      <button type="button" class="row convoy-row" data-convoy="${esc(key)}"
              aria-expanded="${open}" aria-controls="${esc(convoyDetailId(key))}">
        <span class="row-main">
          <span class="title">${esc(pick(c, ["title", "name"], "(untitled convoy)"))}</span>
          <span class="sub">
            <span class="mono">${esc(key)}</span>
            <span>${esc(ago(pick(c, CONVOY_DATE)))}</span>
            <span>${done} of ${total} landed</span>
          </span>
          <span class="bar-track"><span class="bar-fill"
            style="width:${total ? Math.round((done / total) * 100) : 0}%;background:${closed ? "var(--green)" : "var(--blue)"}"></span></span>
        </span>
        <span class="row-side">
          <span class="badge ${closed ? "ok" : ""}">${esc(c.status || "open")}</span>
          <svg viewBox="0 0 24 24" class="ico chev" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
        </span>
      </button>
      ${open ? convoyDetail(c, key, ix, ctx) : ""}
    </div>`;
}

function renderConvoys(s) {
  if (loadingOf("convoys")) return void ($("#convoys").innerHTML = SKEL);
  const raw = dataOf("convoys", []) || [];
  const all = byNewest(Array.isArray(raw) ? raw : (raw.convoys || raw.items || []), CONVOY_DATE);
  // A convoy has no priority and no single rig, so only the text filter can speak to
  // it; the other two chips would silently empty the section instead.
  const items = state.q
    ? all.filter((c) => `${convoyKey(c)} ${pick(c, ["title", "name"], "")} `
      .concat((c.tracked || []).map((t) => `${t.id} ${t.title}`).join(" ")).toLowerCase().includes(state.q))
    : all;
  const ix = agentIndex(allAgents(s));
  const ctx = agentCtx();
  $("#convoy-count").textContent = !all.length ? ""
    : items.length === all.length ? `${all.length} tracked` : `${items.length} of ${all.length}`;

  const focused = document.activeElement?.dataset?.convoy;
  $("#convoys").innerHTML = errNote("convoys") + (items.length
    ? items.map((c) => convoyRow(c, ix, ctx)).join("")
    : empty(all.length ? "No convoy matches that filter" : "No convoys tracked"));
  if (focused) $$("#convoys [data-convoy]").find((el) => el.dataset.convoy === focused)?.focus();
}

// One delegated listener; #convoys is replaced wholesale on every render.
$("#convoys").addEventListener("click", (ev) => {
  const row = ev.target.closest("[data-convoy]");
  if (!row) return;
  if (!state.convoys.delete(row.dataset.convoy)) state.convoys.add(row.dataset.convoy);
  renderConvoys(dataOf("status", {}) || {});
});

/* ---------------- ready ----------------
   Unblocked and open: what could be started, which is a different question from the
   two above and now says so by sitting under its own heading. */
function renderReady() {
  const ready = dataOf("ready", {}) || {};
  const sources = byKey(ready.sources || [], (s) => (s.name === "town" ? "0" : "1" + s.name));
  const html = sources
    .filter((s) => state.source === "all" || s.name === state.source)
    .map((s) => {
      const items = byNewest((s.issues || []).filter((i) => matches(i, s.name)), WORK_DATE);
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

  const total = num((ready.summary || {}).total);
  $("#ready-count").textContent = total ? `${total} unblocked and open` : "";
  $("#work").innerHTML = loadingOf("ready") ? SKEL
    : errNote("ready") + (html || empty(state.q || state.prio !== "all" || state.source !== "all"
      ? "Nothing matches that filter" : "No ready work"));
}

/* ---------------- agents ----------------
   This tab exists to answer one question — which agent is working right now — so
   state is the primary sort key and each state gets its own labelled group.

   Until gc-vy3 it answered a different question. `gt status --json` has a `state`
   field and it does not mean activity: it means "is there a bead on this agent's
   hook". The Mayor executes tool calls for hours reading state=idle has_work=false
   because nothing is slung to it, and for the persistent agents — mayor, deacon,
   witness, refinery — that is nearly all the time. So activity now comes from the
   `panes` read, which looks at what is on the agent's screen (see panes.py), and
   the hook flag survives as its own separately labelled signal because it is real
   information about a different thing.

   The two states worth the trouble are `working` — a turn actually in flight — and
   `staged`, a finished turn with text sitting unsent in the input box. Every
   stranding this town has caught (hq-1e2, hq-cat, two more) had exactly that shape
   and was caught only because somebody happened to look at a pane.

   The rest of the table is about not crying wolf: a finished polecat (done), a
   parked rig's agents, and a workspace nobody ever started are all healthy, and
   none of them may read like the one row that means something broke. Order is the
   order of this table. */
const AGENT_STATES = [
  { key: "working",  label: "Working",      hint: "a turn is in flight",           dot: "busy", badge: "working" },
  { key: "staged",   label: "Input staged", hint: "turn ended, text never sent",   dot: "warn", badge: "warn" },
  { key: "assigned", label: "Assigned",     hint: "bead on the hook, not thinking", dot: "on",  badge: "ok" },
  { key: "idle",     label: "Idle",         hint: "alive at an empty prompt",      dot: "on",   badge: "" },
  { key: "unknown",  label: "Unreadable",   hint: "session up, screen not legible", dot: "", badge: "" },
  { key: "done",     label: "Done",         hint: "finished and exited",           dot: "done", badge: "ok" },
  { key: "parked",   label: "Parked",       hint: "rig is parked — expected",      dot: "done", badge: "" },
  { key: "unstarted", label: "Not started", hint: "no session — never launched",   dot: "done", badge: "" },
  { key: "stopped",  label: "Stopped",      hint: "session up, agent gone",        dot: "off",  badge: "bad" },
];

/** Bucket an agent into AGENT_STATES, from its pane where there is one and from gt
    where there is not. Ordering inside matters: a pane read beats everything because
    it is the only evidence of what is happening *now*, and "stopped" is reserved for
    the one genuinely wrong shape — tmux still holds the session but gt says the agent
    is gone. Missing pane + missing session is "never started", which is not a fault. */
function agentState(a, ctx) {
  const gt = String(a.state || "").toLowerCase();
  const pane = ctx.live ? ctx.panes[a.session || ""] : null;
  let key;
  if (pane) {
    key = pane.activity === "working" || pane.activity === "staged" ? pane.activity
      : !a.running && a.session ? "stopped"
        : pane.activity === "unknown" ? "unknown"
          : a.has_work ? "assigned" : "idle";
  } else if (!ctx.live) {
    // No pane read — tmux is down, or the panel has not landed yet. Fall back to gt's
    // own signals so the tab degrades to what it showed before rather than to nothing.
    key = gt === "done" ? "done" : a.running ? (a.has_work ? "assigned" : "idle")
      : ctx.parked.has(a.rig) ? "parked" : "unstarted";
  } else {
    key = gt === "done" ? "done" : ctx.parked.has(a.rig) ? "parked" : "unstarted";
  }
  const rank = AGENT_STATES.findIndex((x) => x.key === key);
  return { ...AGENT_STATES[rank], rank };
}

/** The one line of the agent's own screen worth putting on the row: what it is doing
    if it is doing something, what is sitting unsent if it is not. Agent-authored text
    — the server clips it, esc() escapes it, and neither is optional. */
function agentNote(a, ctx) {
  const pane = ctx.live ? ctx.panes[a.session || ""] : null;
  if (!pane) return "";
  if (pane.activity === "staged") {
    return `unsent: ${pane.staged}${pane.attached ? "  (someone is attached)" : ""}`;
  }
  return pane.note;
}

/** Stable identity for an agent across refreshes — the array index is not one. */
const agentKey = (a) => String(a.address || `${a.rig}/${a.name || ""}`);
const detailId = (key) => `agent-detail-${key.replace(/[^a-zA-Z0-9]+/g, "-")}`;

/** Everything gt actually carries per agent, plus the two things it does not: the
    model, and the work. `gt status --json` has no work/issue field — verified, the
    key is simply absent — so "Working on" is correlated from the flight read by
    assignee, the same model the Work tab draws. `models` is the models panel, keyed
    by address; it is a separate read because gt carries no model either. */
function agentDetail(a, models, ctx, work) {
  const runtime = [a.agent_alias, a.agent_info !== a.agent_alias ? a.agent_info : ""].filter(Boolean).join(" · ");
  const st = agentState(a, ctx);
  const pane = ctx.live ? ctx.panes[a.session || ""] : null;
  const fields = [
    ["Rig", a.rig, ""],
    ["Address", a.address, "mono"],
    ["Role", a.role, ""],
    // Derived here, from the agent's screen. Directly above gt's own word for the
    // same agent, because the two disagree constantly and both are worth seeing.
    ["Activity", `${st.label} — ${st.hint}`, ""],
    // What it is doing it to. Every bead, not the two the row has space for.
    ["Working on", work.map((b) => `${b.id} — ${b.title} (${b.status})`).join(" · "), "wrap"],
    ["Pane", pane ? pane.note || "(no status line)" : "", "wrap"],
    ["Unsent input", pane ? pane.staged : "", "wrap"],
    // What gt calls the state. It tracks the hook, not activity — see AGENT_STATES.
    ["gt state", a.state, ""],
    ["Process", a.running ? "running" : "not running", ""],
    ["Session", a.session ? a.session + (pane?.attached ? " (attached)" : "") : "no session", "mono"],
    ["Listed by", a.source, ""],
    ["Last active", a.last_active ? ago(a.last_active) : "", ""],
    ["Hook", a.has_work ? "has work" : "empty", ""],
    ["Unread mail", a.unread_mail ? `${a.unread_mail}` : "none", ""],
    // Fetched on every refresh and, until now, rendered nowhere.
    ["Oldest unread", pick(a, ["first_subject"]), "wrap"],
    ["Agent", runtime, ""],
    // "Agent" above is the tool (always "claude"); this is the model it runs. Blank
    // whenever the server could not map the agent to a transcript with certainty —
    // the filter below then drops the row, because a wrong model is worse than none.
    ["Model", (models || {})[agentKey(a)] || "", "mono"],
    ["ACP", a.acp ? "enabled" : "", ""],
  ];
  return `<dl class="agent-detail" id="${esc(detailId(agentKey(a)))}">${fields
    .filter(([, v]) => v !== "" && v !== null && v !== undefined)
    .map(([k, v, cls]) => `<div class="detail-item"><dt>${esc(k)}</dt><dd class="${cls}">${esc(v)}</dd></div>`)
    .join("")}</dl>`;
}

/* ---------------- watching a terminal ----------------
   The operator wants to see what an agent is doing, and a browser cannot attach a
   tmux session. So the console shows the agent's screen instead — which is better
   than an attach rather than a substitute for one: it works on a phone, it needs no
   capability the console did not already have (panes.py has been capturing screens
   since gc-vy3), and it cannot type. A real attach is offered beside it, as a command
   to paste, for the times the operator wants to interact rather than to watch.

   READ-ONLY IS THE WHOLE POINT, not an unfinished edge. Synthetic input into a pane
   merges with whatever the agent has staged in its input box and submits the pair
   (hq-97l, hq-cat) — so a "just send Enter" button here would submit half-written
   instructions belonging to somebody else. There is no key path in this view and
   there is no write endpoint behind it.

   The cost is kept off both hot paths by a lease: naming the session on the poll
   below is what makes the scheduler capture it, and going quiet is what makes it
   stop. Nothing is captured for an agent nobody is looking at, and nothing at all is
   captured on the request path — see panes.watch(). */

/** Shell-quote for the attach command shown beside the view — it is text to paste,
    so it has to survive a session name with a space in it. */
const shq = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`);

/** The `tmux attach` the operator would run themselves. The town's socket is in the
    status read; gt reports it either as a path (private socket file, -S) or as a bare
    name (-L). Offered as text, never run — the console has no shell passthrough. */
function attachCmd(session) {
  const t = (dataOf("status", {}) || {}).tmux || {};
  const sock = String(t.socket_path || t.socket || "").trim();
  const where = sock ? `${sock.includes("/") ? "-S" : "-L"} ${shq(sock)} ` : "";
  return `tmux ${where}attach -t ${shq(session)}`;
}

const watchAge = (p) => (p.error ? p.error
  : p.age == null ? "connecting…" : `live · ${Math.round(p.age)}s behind`);

/** The live view: one agent's whole screen, refreshed by pullWatch() on its own two
    second timer rather than by the page render, so the rest of the tab is not rebuilt
    twenty times a minute to keep one panel moving. */
function watchView(a) {
  const p = state.watchPanel || {};
  const text = (p.data || {})[a.session];
  const cmd = attachCmd(a.session);
  return `
    <div class="watch">
      <div class="watch-head">
        <i class="dot busy"></i>
        <span class="watch-title">Watching <span class="mono">${esc(a.session)}</span></span>
        <span class="watch-age muted" id="watch-age">${esc(watchAge(p))}</span>
        <button type="button" class="btn" data-watch="${esc(a.session)}">Close</button>
      </div>
      <pre class="watch-screen ${text === undefined ? "is-waiting" : ""}" id="watch-screen"
           tabindex="0" aria-label="Live terminal output for ${esc(a.session)}">${
    esc(text === undefined ? "waiting for the first capture…" : text)}</pre>
      <div class="watch-foot">
        <span class="muted">Read-only — this view cannot send keystrokes.</span>
        <code class="mono watch-cmd">${esc(cmd)}</code>
        <button type="button" class="btn" data-copy="${esc(cmd)}">Copy</button>
      </div>
    </div>`;
}

function agentRow(a, models, ctx, work) {
  const st = agentState(a, ctx);
  const key = agentKey(a);
  const open = state.expanded.has(key);
  const note = agentNote(a, ctx);
  // The bead itself, on the row, because "has work" answers a yes/no question nobody
  // was asking. Two fit; the rest are counted and shown in full in the detail panel.
  const held = work.slice(0, 2).map((b) =>
    `<span class="mono">${esc(b.id)}</span> ${esc(b.title)}`).join(" · ")
    + (work.length > 2 ? ` <span class="muted">+${work.length - 2} more</span>` : "");
  // Only an agent whose session tmux is actually serving right now can be watched,
  // so the affordance is absent — not disabled — everywhere else: a parked rig's
  // agents, a crew workspace nobody started, a dog that was never launched. The pane
  // map is that list, which is also why it is the thing tested rather than a.session.
  const live = !!(ctx.live && ctx.panes[a.session || ""]);
  const watching = live && state.watch === a.session;
  return `
    <div class="agent ${st.key === "working" ? "is-working" : ""} ${st.key === "staged" ? "is-staged" : ""}">
      <div class="agent-head">
        <button type="button" class="row agent-row" data-agent="${esc(key)}"
                aria-expanded="${open}" aria-controls="${esc(detailId(key))}">
          <i class="dot ${st.dot}"></i>
          <span class="row-main">
            <span class="title">${esc(a.name)} <span class="muted mono">${esc(a.address || "")}</span></span>
            <span class="sub">
              <span class="badge">${esc(a.rig)}</span>
              <span>${esc(a.role || "")}</span>
              <span class="mono">${esc(a.session || "no session")}</span>
              ${a.unread_mail ? `<span class="badge warn">${esc(a.unread_mail)} mail</span>` : ""}
            </span>
            ${work.length ? `<span class="agent-work">${held}</span>` : ""}
            ${note ? `<span class="agent-note">${esc(note)}</span>` : ""}
          </span>
          <span class="row-side">
            ${a.has_work ? '<span class="badge ok">has work</span>' : ""}
            <span class="badge ${st.badge}">${esc(st.label)}</span>
            <svg viewBox="0 0 24 24" class="ico chev" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
          </span>
        </button>
        ${live ? `
        <button type="button" class="watch-btn ${watching ? "is-on" : ""}"
                data-watch="${esc(a.session)}" aria-pressed="${watching}"
                title="${watching ? "Stop watching" : "Watch this terminal (read-only)"}"
                aria-label="Watch ${esc(a.name)}'s terminal">
          <svg viewBox="0 0 24 24" class="ico" aria-hidden="true">
            <rect x="2.5" y="4" width="19" height="16" rx="2.5"/><path d="m7 10 2.6 2.6L7 15.2M13 15.2h4"/>
          </svg>
        </button>` : ""}
      </div>
      ${watching ? watchView(a) : ""}
      ${open ? agentDetail(a, models, ctx, work) : ""}
    </div>`;
}

function renderAgents(s) {
  if (loadingOf("status")) return void ($("#agents").innerHTML = SKEL);
  const all = allAgents(s);
  // Its own panel, on its own slower cadence, so it may still be empty for a beat
  // after the agents themselves land. Missing simply means no Model row.
  const models = dataOf("models", {}) || {};
  const ctx = agentCtx();
  // The watched agent exited, tmux dropped its session, or the pane read itself went
  // away. Any of those and the view cannot draw — so close it, rather than leave a
  // frozen screen on the page and a lease being renewed for a panel nobody has.
  if (state.watch && !(ctx.live && ctx.panes[state.watch])) closeWatch();
  // The same model the Work tab draws, read from the other end: there the bead finds
  // its agent, here the agent finds its beads. gc-vy3 owns whether a row is working;
  // this owns what it is working on.
  const fm = flightModel();
  // Dogs and loose tmux sessions have no mail address; offering one would bounce.
  $("#agent-addresses").innerHTML = all.filter((a) => a.address)
    .map((a) => `<option value="${esc(a.address)}">`).join("")
    + (s.rigs || []).map((r) => `<option value="${esc(r.name)}/">`).join("");

  // State first — working agents can never be buried mid-list. Array.prototype.sort
  // is stable, so allAgents()'s town/rig/address order survives as the tiebreak
  // inside each group (agents carry no timestamp to break ties on). Rank is padded
  // because the table outgrew one digit and "10" sorts before "2" as a string.
  const rank = (a) => String(agentState(a, ctx).rank).padStart(2, "0");
  const agents = byKey(all, rank);
  const counts = {};
  agents.forEach((a) => { const k = agentState(a, ctx).key; counts[k] = (counts[k] || 0) + 1; });
  let last = null;
  const rows = agents.map((a) => {
    const st = agentState(a, ctx);
    const head = st.key === last ? ""
      : `<div class="group-head ${st.key === "working" ? "is-working" : ""}">${esc(st.label)} · ${counts[st.key]}
           <span class="group-hint">${esc(st.hint)}</span></div>`;
    last = st.key;
    return head + agentRow(a, models, ctx, flightFor(fm, a.address));
  }).join("");

  // An 8s auto-refresh rebuilds this subtree; expansion lives in state.expanded so it
  // survives, and the focused row is restored so keyboard focus does not jump to <body>.
  const focused = document.activeElement?.dataset?.agent || document.activeElement?.dataset?.watch;
  // A watch view survives this rebuild, so its scroll position has to as well —
  // otherwise the terminal jumps to the top every eight seconds. Following the tail
  // is the default; a reader who scrolled up to look at something keeps their place.
  const keep = scrollOf($("#watch-screen"));
  // panes, dogs and flight each carry a slice of this tab; say so when one is failing
  // rather than quietly showing a town that looks asleep, or unassigned.
  $("#agents").innerHTML = errNote("status") + errNote("panes") + errNote("dogs")
    + errNote("flight") + (agents.length ? rows : empty("No agents"));
  restoreScroll($("#watch-screen"), keep);
  if (focused) $$("#agents [data-agent], #agents [data-watch]")
    .find((el) => (el.dataset.agent || el.dataset.watch) === focused)?.focus();
}

/** Whether a scroller is parked at the tail, and where it is if not. */
const scrollOf = (el) => (el
  ? { top: el.scrollTop, tail: el.scrollHeight - el.scrollTop - el.clientHeight < 24 }
  : null);
function restoreScroll(el, s) {
  if (!el) return;
  el.scrollTop = !s || s.tail ? el.scrollHeight : s.top;
}

/** Swap the live view onto one session, or off it. One at a time, so the previous
    session's lease simply stops being renewed and its capture stops with it. */
function toggleWatch(session) {
  state.watch = state.watch === session ? null : session;
  state.watchPanel = null;
  renderAgents(dataOf("status", {}) || {});
  watchSchedule();
  if (state.watch) pullWatch();
}
function closeWatch() {
  state.watch = null;
  state.watchPanel = null;
  watchSchedule();
}

/** The watch panel alone, on its own timer. Deliberately not part of the 8s snapshot
    poll: a terminal wants a couple of seconds to look alive, and re-rendering the
    whole tab that often would churn every other row to animate one panel. */
let watchTimer = null;
function watchSchedule() {
  clearInterval(watchTimer);
  // A hidden tab stops asking, so the lease lapses and the server stops capturing —
  // the console does not watch a terminal nobody is looking at.
  if (state.watch && !document.hidden) watchTimer = setInterval(pullWatch, 2000);
}
async function pullWatch() {
  const session = state.watch;
  if (!session) return;
  try {
    // The `watch=` parameter is the lease renewal; the response is the last capture
    // the scheduler took. Neither half of that blocks on tmux — see panes.watch().
    const r = await fetch(`/api/panel/watch?watch=${encodeURIComponent(session)}`,
      { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const p = await r.json();
    if (state.watch !== session) return;         // closed or switched mid-flight
    state.watchPanel = p;
  } catch (e) {
    state.watchPanel = { ...(state.watchPanel || {}), error: e.message };
  }
  paintWatch();
}

/** Patch the open panel in place. textContent, not innerHTML: this is the most
    directly agent-authored string in the app and it never becomes markup. */
function paintWatch() {
  const pre = $("#watch-screen");
  if (!pre) return;
  const p = state.watchPanel || {};
  const text = (p.data || {})[state.watch];
  const keep = scrollOf(pre);
  if (text !== undefined) {
    pre.textContent = text;
    pre.classList.remove("is-waiting");
  }
  const age = $("#watch-age");
  if (age) age.textContent = watchAge(p);
  restoreScroll(pre, keep);
}

// One delegated listener: #agents is replaced wholesale on every render, per-row
// handlers would not be. The terminal button is a sibling of the row button rather
// than a child — buttons do not nest — so it is matched first and on its own.
$("#agents").addEventListener("click", (ev) => {
  const watch = ev.target.closest("[data-watch]");
  if (watch) return void toggleWatch(watch.dataset.watch);
  const copy = ev.target.closest("[data-copy]");
  if (copy) return void copyCmd(copy);
  const row = ev.target.closest("[data-agent]");
  if (!row) return;
  const key = row.dataset.agent;
  if (!state.expanded.delete(key)) state.expanded.add(key);
  renderAgents(dataOf("status", {}) || {});
});

// Escape closes the terminal, the way it closes everything else that covers a page.
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && state.watch) toggleWatch(state.watch);
});

/** Copy the attach command. The clipboard API needs a secure context, which a console
    reached over http on a LAN address is not — so the command is on the page as
    selectable text either way and this only ever saves a gesture. */
async function copyCmd(btn) {
  const was = btn.textContent;
  try {
    await navigator.clipboard.writeText(btn.dataset.copy);
    btn.textContent = "Copied ✓";
  } catch {
    btn.textContent = "Select it →";
  }
  setTimeout(() => { btn.textContent = was; }, 2500);
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
["#rigs", "#escalations", "#prio", "#changelog", "#flight", "#convoys", "#work", "#agents",
  "#mail", "#trail"]
  .forEach((s) => ($(s).innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>'));
load(true);
schedule();
