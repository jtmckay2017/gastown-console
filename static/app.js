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
  // The Backlog tab: its own filter pair (the Work tab's chips mean something else
  // there), and its own expansion set, keyed by bead id. One set across all four of
  // its sections — a bead expanded as an epic is the same bead expanded as a closure.
  bq: "", brig: "all", beads: new Set(),
  // The Board tab. Its own filter pair again — it draws the same beads as the Backlog
  // tab through a different question, and a shared filter box would mean answering one
  // of them changed the other. `lanes` holds the COLLAPSED swimlanes rather than the
  // open ones, because a board that started with every epic shut would be an empty
  // page; `boardMore` is the cells that have been asked for their whole contents.
  boardq: "", boardRig: "all", boardFlat: false,
  lanes: new Set(), boardMore: new Set(),
  // The focused card, and the prose behind it. The prose is not in the snapshot — see
  // backlog.py — so it is fetched per selection and kept here under the key it was
  // fetched for, which is what makes a late response for a card nobody is looking at
  // any more discardable rather than confusing.
  sel: null, selData: null,
  // The pane's open form — drafting a bead, editing one, linking two, or mailing an
  // agent about one — or null while the pane is only being read. One at a time, because
  // the pane is one room and two half-filled forms in it is two chances to lose
  // somebody's writing. While it is set the pane is NOT repainted by the 8s poll: see
  // paintPane. `paneNote` is what the last write said, shown once the form has closed.
  form: null, paneNote: "", paneBad: false,
  // The map's last markup. The pictures are the biggest subtree on the page and they
  // scroll inside their own boxes, so they are only rewritten when they change — see
  // renderMap.
  mapHtml: "",
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
  renderBoard();
  renderBacklog();
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
  // The whole town's open backlog, not the tab's current rig selection — a pill that
  // moved when you filtered would be reporting the filter, not the backlog.
  $("#pill-backlog").textContent = ((dataOf("backlog", {}) || {}).rigs || [])
    .reduce((n, r) => n + num((r.status || {}).open), 0);
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

/* ---------------- backlog ----------------
   The Work tab answers "what is happening"; this one answers "what did we plan", and
   they are not the same question asked at different volumes. Everything a ceremony
   reads is structurally absent from the reads the Work tab is built on: `gt ready` is
   unblocked-and-open, so epics with blocked children, everything already picked up and
   all 74 closed beads are excluded by definition rather than by omission.

   So this tab is built on the one read that keeps the structure (see backlog.py), and
   it is laid out as the four questions a ceremony actually asks, in the order it asks
   them:

     Epics       what is the plan, and what sits under each part of it
     Blocked     what is stuck, and behind WHAT — the blocks edges, drawn nowhere until now
     In progress what is moving right now, and who has it
     Closed      what finished, and why — close_reason, fetched nowhere until now

   The third of those is the `flight` read the Work tab draws (gc-8ho), filtered to
   this tab's rig and rendered by the same flightRow(). It is deliberately not a second
   in-progress read: two answers to "who has what" that could disagree is worse than
   one answer in two places.

   Everything on this tab is agent-authored and untrusted — bead titles, descriptions,
   close reasons and assignee strings alike — so every interpolation goes through
   esc(), and the two prose fields are pre-wrapped rather than parsed. */

const CLOSED_DATE = ["closed_at", "updated_at", "created_at"];
const BEAD_DATE = ["updated_at", "created_at"];
const isClosed = (b) => String(b.status || "").toLowerCase() === "closed";

/** The selected slice of the backlog read, plus the two indexes every section below
    needs: id -> bead, and parent id -> its children. Built once per render so no two
    sections can disagree about the shape of the tree. */
function backlogModel(brig) {
  const rigs = ((dataOf("backlog", {}) || {}).rigs) || [];
  const sel = rigs.filter((r) => brig === "all" || r.rig === brig);
  const items = sel.flatMap((r) => (r.beads || []).map((b) => ({ ...b, rig: r.rig })));
  const byId = new Map(items.map((b) => [b.id, b]));
  // The children actually carried, which is not the same as the children that exist —
  // see `kids` on a parent bead for the true count (backlog.py). This map is what the
  // expansion can draw; that number is what the row is allowed to claim.
  const children = new Map();
  // The blocks edges read the other way: who is waiting on this bead. Nothing stores
  // that direction — `bd` keeps the edge on the blocked bead — so "what does closing
  // this unblock" is only answerable by inverting the map, which the planning pane asks
  // and no list on the Backlog tab does.
  const dependents = new Map();
  for (const b of items) {
    if (b.parent) {
      if (!children.has(b.parent)) children.set(b.parent, []);
      children.get(b.parent).push(b);
    }
    for (const id of b.blocked_by || []) {
      if (!dependents.has(id)) dependents.set(id, []);
      dependents.get(id).push(b);
    }
  }
  return { rigs, sel, items, byId, children, dependents };
}

/** What a bead is waiting on, resolved against the same view. backlog.py pulls every
    blocker into the payload even when a cap would have dropped it, so an id that does
    not resolve here is a genuinely foreign bead — say so rather than drawing a bare
    id and letting the reader assume it is a bug. */
const blockersOf = (m, b) => (b.blocked_by || [])
  .map((id) => m.byId.get(id) || { id, title: "(not in this rig's backlog)", status: "" });

/** Blocked means blocked *now*. An edge to a bead that has already closed is history,
    and counting it leaves work looking stuck forever — the fixture has one of each for
    exactly that reason. `bd`'s stored `blocked` status counts too: it is set by hand
    and carries no edge, so a viewer that only read edges would miss it. */
const unmetOf = (m, b) => blockersOf(m, b).filter((x) => !isClosed(x));
const isBlocked = (m, b) => !isClosed(b)
  && (String(b.status || "").toLowerCase() === "blocked" || unmetOf(m, b).length > 0);

const IN_FLIGHT = new Set(["in_progress", "hooked"]);
const beadDot = (m, b) => (isClosed(b) ? "done" : isBlocked(m, b) ? "off"
  : IN_FLIGHT.has(String(b.status || "").toLowerCase()) ? "busy" : "");

/** The text filter, over the fields a bead is searched by. The query is an argument
    rather than a global because two tabs now draw these beads through their own filter
    box — never called bare from a .filter(), where the index would arrive as `q`. */
const beadMatches = (b, q) => !q
  || `${b.id} ${b.title} ${b.assignee || ""} ${b.issue_type || ""} ${b.rig || ""}`
    .toLowerCase().includes(q);

const beadDetailId = (id) => `bead-detail-${String(id).replace(/[^a-zA-Z0-9]+/g, "-")}`;
const TRUNC = '<div class="bead-trunc">The server clipped this text — run '
  + '<code class="mono">bd show</code> on the id above for the whole thing.</div>';

/** Agent-authored prose: a description, or the reason something closed. It arrives
    with its own line breaks, so it is pre-wrapped rather than collapsed, and it is
    escaped here like every other value that came out of a bead. */
const beadText = (label, text) => (text ? `<div class="bead-text">
  <span class="bead-text-label">${esc(label)}</span>${esc(text)}</div>` : "");

/** One bead, as every section on this tab draws it — the sections differ only in what
    they put under the fold, because they are one object seen from four angles. A row
    with nothing under the fold is not a button at all: an expander that opens onto an
    empty box is worse than no expander. */
function beadRow(m, b, note, detail) {
  const st = String(b.status || "").toLowerCase();
  const open = state.beads.has(b.id);
  const body = `
    <i class="dot ${beadDot(m, b)}"></i>
    <span class="row-main">
      <span class="title wrap">${esc(b.title)}</span>
      <span class="sub">
        <span class="mono">${esc(b.id)}</span>
        <span>${esc(b.rig || "")}</span>
        ${b.assignee ? `<span>${esc(b.assignee)}</span>` : ""}
        <span>${esc(ago(pick(b, isClosed(b) ? CLOSED_DATE : BEAD_DATE)))}</span>
      </span>
      ${note || ""}
    </span>
    <span class="row-side">
      ${b.issue_type && b.issue_type !== "task"
    ? `<span class="badge ${b.issue_type === "epic" ? "epic" : ""}">${esc(b.issue_type)}</span>` : ""}
      ${b.priority == null ? "" : `<span class="badge p${esc(b.priority)}">P${esc(b.priority)}</span>`}
      <span class="badge ${st === "closed" ? "ok" : st === "blocked" ? "bad" : ""}">${esc(st || "?")}</span>
      ${detail ? '<svg viewBox="0 0 24 24" class="ico chev" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>' : ""}
    </span>`;
  if (!detail) return `<div class="bead"><span class="row bead-row is-flat">${body}</span></div>`;
  return `
    <div class="bead">
      <button type="button" class="row bead-row" data-bead="${esc(b.id)}"
              aria-expanded="${open}" aria-controls="${esc(beadDetailId(b.id))}">${body}</button>
      ${open ? `<div class="bead-detail" id="${esc(beadDetailId(b.id))}">${detail}</div>` : ""}
    </div>`;
}

/** A bead inside somebody else's expansion — a child of an epic, or a blocker. Flat
    and never itself expandable: one level of nesting is a tree, two is a maze. */
function beadLine(m, b) {
  const unmet = unmetOf(m, b);
  return `
    <div class="row bead-child">
      <i class="dot ${beadDot(m, b)}"></i>
      <div class="row-main">
        <div class="title wrap">${esc(b.title)}</div>
        <div class="sub">
          <span class="mono">${esc(b.id)}</span>
          ${b.assignee ? `<span>${esc(b.assignee)}</span>` : ""}
          ${b.updated_at || b.closed_at
    ? `<span>${esc(ago(pick(b, isClosed(b) ? CLOSED_DATE : BEAD_DATE)))}</span>` : ""}
          ${unmet.length ? `<span class="bead-blocked">blocked by ${esc(unmet.map((x) => x.id).join(", "))}</span>` : ""}
        </div>
      </div>
      <div class="row-side">
        ${b.priority == null ? "" : `<span class="badge p${esc(b.priority)}">P${esc(b.priority)}</span>`}
        <span class="badge ${isClosed(b) ? "ok" : String(b.status || "").toLowerCase() === "blocked" ? "bad" : ""}">${esc(b.status || "unknown")}</span>
      </div>
    </div>`;
}

/* ---- the four sections ---- */

/** Anything with children, whatever `bd` calls its type — a plan is made of the edges,
    not of the word "epic", and this town has parents typed feature and decision. */
function renderEpics(m) {
  // `kids` is the server's count over the whole backlog; m.children is what was carried
  // past the caps. The row states the first and draws the second, and says so when they
  // differ — an epic that quietly reported 15 of its 19 children would be wrong in
  // exactly the place a planning session is trusting it.
  const all = m.items.filter((b) => num(b.kids));
  // An epic matches if it matches or any of its children does. Filtering a tree on the
  // parent alone hides the row somebody was searching for inside a collapsed one.
  const hits = all.filter((b) => beadMatches(b, state.bq)
    || (m.children.get(b.id) || []).some((k) => beadMatches(k, state.bq)));
  // Open first, closed after — a finished epic is history, not plan. byNewest runs
  // first and byKey is stable, so newest-first survives inside each group.
  const items = byKey(byNewest(hits, BEAD_DATE), (b) => (isClosed(b) ? "1" : "0"));
  $("#epic-count").textContent = !all.length ? ""
    : items.length === all.length ? `${all.length} with children`
      : `${items.length} of ${all.length}`;
  $("#epics").innerHTML = items.length ? items.map((b) => {
    const total = num(b.kids), done = num(b.kids_closed);
    const drawn = byKey(byNewest(m.children.get(b.id) || [], BEAD_DATE),
      (k) => (isClosed(k) ? "1" : "0"));
    const note = `
      <span class="sub"><span>${total} child${total === 1 ? "" : "ren"} · ${done} closed</span></span>
      <span class="bar-track"><span class="bar-fill"
        style="width:${Math.round((done / total) * 100)}%;background:${done === total ? "var(--green)" : "var(--blue)"}"></span></span>`;
    const short = drawn.length < total
      ? `<div class="bead-trunc">${drawn.length} of ${total} children carried — the rest are older closed ones.</div>` : "";
    const detail = beadText("Description", b.desc)
      + drawn.map((k) => beadLine(m, k)).join("") + short + (b.more ? TRUNC : "");
    return beadRow(m, b, note, detail);
  }).join("") : empty(all.length ? "No epic matches that filter" : "Nothing here has children");
}

function renderBlocked(m) {
  const all = m.items.filter((b) => isBlocked(m, b));
  const items = byNewest(all.filter((b) => beadMatches(b, state.bq)), BEAD_DATE);
  $("#blocked-count").textContent = !all.length ? ""
    : items.length === all.length ? `${all.length} stuck` : `${items.length} of ${all.length}`;
  $("#blocked").innerHTML = items.length ? items.map((b) => {
    const unmet = unmetOf(m, b);
    // The whole point of the section is the second half of the sentence, so it is on
    // the row rather than under the fold. The fold carries the blockers themselves.
    const note = `<span class="bead-blocked-line">${unmet.length
      ? `blocked by ${esc(unmet.map((x) => `${x.id} — ${x.title}`).join(" · "))}`
      : "marked blocked by hand — no blocking bead recorded"}</span>`;
    return beadRow(m, b, note, unmet.map((x) => beadLine(m, x)).join(""));
  }).join("") : empty(all.length ? "Nothing blocked matches that filter" : "Nothing is blocked");
}

/** The `flight` read the Work tab draws, narrowed to this tab's rig — not a second
    in-progress read. Two answers to "who has what" that could disagree is strictly
    worse than one answer shown in two places. */
function renderBacklogFlight() {
  if (loadingOf("flight")) return void ($("#backlog-flight").innerHTML = SKEL);
  const fm = flightModel();
  const ix = agentIndex(allAgents(dataOf("status", {}) || {}));
  const ctx = agentCtx();
  const all = fm.items.filter((b) => state.brig === "all" || b.rig === state.brig);
  const items = all.filter((b) => beadMatches(b, state.bq));
  $("#progress-count").textContent = !all.length ? ""
    : items.length === all.length ? `${all.length} in flight` : `${items.length} of ${all.length}`;
  $("#backlog-flight").innerHTML = errNote("flight") + (items.length
    ? items.map((b) => flightRow(b, ix, ctx)).join("")
    : empty(all.length ? "Nothing in flight matches that filter" : "Nothing in flight here"));
}

// A retro reads the recent end of the history, not all of it. The server already caps
// what it carries per rig (backlog.MAX_CLOSED); this caps what one screen draws, and
// the Coverage card above says what both dropped.
const CLOSED_ROWS = 40;

function renderClosed(m) {
  const all = byNewest(m.items.filter(isClosed), CLOSED_DATE);
  const hits = all.filter((b) => beadMatches(b, state.bq));
  const items = hits.slice(0, CLOSED_ROWS);
  // The rigs' own totals, not this list's — the panel is showing a window onto them.
  const held = m.sel.reduce((n, r) => n + num(r.closed_total), 0);
  $("#closed-count").textContent = !held ? ""
    : `${items.length} of ${hits.length === all.length ? held : hits.length}`;
  $("#closed").innerHTML = items.length ? items.map((b) => beadRow(
    m, b,
    b.close_reason ? `<span class="bead-reason">${esc(b.close_reason)}</span>` : "",
    beadText("Why it closed", b.close_reason) + (b.close_reason && b.more ? TRUNC : ""),
  )).join("") : empty(all.length ? "Nothing closed matches that filter" : "Nothing closed yet");
}

/* ---- the numbers above them ---- */

/* Reading order for the status bars: the pipeline in the shape it actually runs in,
   rather than whatever order the counts came back in. `hooked` is in here because it
   is what `gt sling` sets — see flight.py, it is where most live work sits. */
const STATUS_ORDER = ["open", "hooked", "in_progress", "blocked", "deferred", "closed"];
// Never data-derived: these land inside a style attribute, so the map is the allowlist.
const STATUS_COLOR = {
  open: "var(--blue)", hooked: "var(--green)", in_progress: "var(--green)",
  blocked: "var(--red)", deferred: "var(--faint)", closed: "var(--faint)",
};
const TYPE_COLOR = {
  bug: "var(--red)", epic: "var(--purple)", feature: "var(--green)",
  decision: "var(--accent)", task: "var(--blue)",
};

function sumCounts(rigs, key) {
  const out = {};
  for (const r of rigs) {
    for (const [k, v] of Object.entries(r[key] || {})) out[k] = (out[k] || 0) + num(v);
  }
  return out;
}

function barsHtml(counts, keys, colors) {
  const max = Math.max(1, ...keys.map((k) => counts[k]));
  return keys.map((k) => `
    <div class="bar wide">
      <span class="bar-label">${esc(k)}</span>
      <span class="bar-track"><span class="bar-fill"
        style="width:${(counts[k] / max) * 100}%;background:${colors[k] || "var(--faint)"}"></span></span>
      <span class="bar-n">${counts[k]}</span>
    </div>`).join("");
}

function renderDistribution(m) {
  const st = sumCounts(m.sel, "status");
  const ty = sumCounts(m.sel, "type");
  const stKeys = [...STATUS_ORDER.filter((k) => st[k]),
    ...Object.keys(st).filter((k) => !STATUS_ORDER.includes(k)).sort()];
  const tyKeys = Object.keys(ty).sort((a, b) => ty[b] - ty[a] || (a < b ? -1 : 1));
  $("#backlog-status").innerHTML = stKeys.length
    ? barsHtml(st, stKeys, STATUS_COLOR) : empty("No beads");
  $("#backlog-type").innerHTML = tyKeys.length
    ? barsHtml(ty, tyKeys, TYPE_COLOR) : empty("No beads");
}

/** What was read against what is drawn. A backlog viewer that silently truncated would
    be the same failure as reading the wrong database — an answer that looks complete
    and is not — so the caps are on the page, per rig, whether or not they bit. */
function renderCoverage(m) {
  const shown = m.sel.reduce((n, r) => n + (r.beads || []).length, 0);
  const work = m.sel.reduce((n, r) => n + num(r.work), 0);
  $("#backlog-coverage").textContent = work ? `${shown} of ${work} carried` : "";
  $("#backlog-rigs").innerHTML = errNote("backlog") + (m.rigs.length ? m.rigs.map((r) => `
    <div class="row">
      <div class="row-main">
        <div class="title">${esc(r.rig)}</div>
        <div class="sub">
          <span>${num(r.total)} in the database</span>
          <span>${num(r.work)} work${num(r.total) - num(r.work)
    ? ` · ${num(r.total) - num(r.work)} scaffolding` : ""}</span>
          <span>${num(r.open_total)} not closed · ${num(r.closed_total)} closed</span>
          <span>${(r.beads || []).length} carried to this page</span>
        </div>
      </div>
    </div>`).join("") : empty("No beads repo answered"));
}

/* ---- the map ----

   The one place on this page where markup arrives from the server instead of being
   built here. graph.py draws the epic trees and the blocks graph as SVG and escapes
   every bead title on the way out — read the note at the top of that file before
   touching this, because assigning it through innerHTML is what makes that escaping
   load-bearing rather than decorative. The captions are counts and the rig name goes
   through esc(); the readout below is the one part that interpolates bead values of its
   own, and every one of them is esc()'d for the same reason.

   THE READOUT IS THE RECOVERY PATH FOR EVERY CLIPPED TITLE IN A DIAGRAM. A node is a
   box of fixed pixels and a title is however long somebody typed, so graph.py clips it
   and hangs the whole thing off `<title>` and `aria-label`. A `<title>` is a mouse
   tooltip and this town reads the console on a phone: no hover, no way in (gc-uu8). So
   the nodes are controls — focus one or tap one and it is spelled out in full in a bar
   above the diagrams, with its status, its assignee and what it is waiting on.

   ONE TAB STOP PER DIAGRAM, ARROWS INSIDE IT. Twelve epics of sixty children is 720 tab
   stops between the filter box and the lists below, which is not "keyboard accessible",
   it is a keyboard trap with an exit. So each figure holds a single stop and the arrow
   keys (and Home/End) walk the beads inside it — the roving-tabindex pattern, the same
   bargain a toolbar or a grid makes. The bar says so in words, because a keyboard
   affordance nobody is told about is not one. */

const MAP_HINT = "Tap a bead in a diagram to read it in full — "
  + "or tab into one and walk it with the arrow keys.";

const readHtml = () => `<div class="fig-read" id="map-read">
  <span class="muted">${esc(MAP_HINT)}</span></div>`;

/** One node, spelled out: the whole id and the whole title, plus the things the drawing
    says in shape and colour. Falls back to the node's own `<title>` — which carries the
    same two strings — for a bead the current filter's model cannot resolve. */
function paintRead(node) {
  const box = $("#map-read");
  if (!box) return;
  const m = backlogModel(state.brig);
  const b = m.byId.get(node.dataset.node);
  box.classList.add("is-on");
  if (!b) {
    box.textContent = node.querySelector("title")?.textContent || node.dataset.node || "";
    return;
  }
  const unmet = unmetOf(m, b);
  box.innerHTML = `
    <i class="dot ${beadDot(m, b)}" aria-hidden="true"></i>
    <span class="mono">${esc(b.id)}</span>
    <span class="fig-read-title">${esc(b.title)}</span>
    ${b.assignee ? `<span class="muted">${esc(b.assignee)}</span>` : ""}
    ${b.priority == null ? "" : `<span class="badge p${esc(b.priority)}">P${esc(b.priority)}</span>`}
    <span class="badge ${isClosed(b) ? "ok" : isBlocked(m, b) ? "bad" : ""}">${
  esc(String(b.status || "unknown").toLowerCase())}</span>
    ${unmet.length ? `<span class="bead-blocked">blocked by ${
  esc(unmet.map((x) => `${x.id} — ${x.title}`).join(" · "))}</span>` : ""}`;
}

/** The nodes of the diagram a node belongs to, in drawing order — which is reading
    order in both pictures: an epic then its children down the column, and the blocks
    graph column by column. */
const mapNodes = (node) => $$(".gn", node.ownerSVGElement || node);

/** One stop per figure. Re-run after every rewrite of #map, because the tabindex lives
    in the markup and the markup is thrown away wholesale. */
function mapRoving(root) {
  $$(".fig-svg", root).forEach((svg) =>
    $$(".gn", svg).forEach((n, i) => n.setAttribute("tabindex", i ? "-1" : "0")));
}

/** Focus follows the arrow keys, and the stop follows focus — otherwise tabbing back
    into a diagram would land on its first bead rather than where the reader left. */
function mapFocus(node) {
  mapNodes(node).forEach((n) => n.setAttribute("tabindex", n === node ? "0" : "-1"));
  paintRead(node);
}

const MAP_STEP = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };

$("#map").addEventListener("focusin", (ev) => {
  const node = ev.target.closest?.(".gn");
  if (node) mapFocus(node);
});
// Tapping is the whole point on a phone, and a tap does not focus a non-form element on
// its own everywhere — so focus is moved by hand and focusin does the painting.
$("#map").addEventListener("click", (ev) => {
  const node = ev.target.closest?.(".gn");
  if (node) node.focus();
});
$("#map").addEventListener("keydown", (ev) => {
  const node = ev.target.closest?.(".gn");
  if (!node) return;
  if (ev.key === "Enter" || ev.key === " ") return void (ev.preventDefault(), paintRead(node));
  const nodes = mapNodes(node);
  const at = nodes.indexOf(node);
  const to = MAP_STEP[ev.key] ? at + MAP_STEP[ev.key]
    : ev.key === "Home" ? 0 : ev.key === "End" ? nodes.length - 1 : null;
  if (to == null) return;
  ev.preventDefault();
  nodes[Math.max(0, Math.min(nodes.length - 1, to))].focus();
});

const LEGEND = [["g-open", "open"], ["g-live", "in flight"], ["g-block", "blocked"],
  ["g-done", "closed"], ["g-cross", "leaves its epic"]];

const legendHtml = () => `<div class="fig-key">${LEGEND
  .map(([k, l]) => `<span class="key ${k}">${esc(l)}</span>`).join("")}</div>`;

function figure(title, note, svg) {
  return `<figure class="fig">
    <figcaption class="fig-head"><h3>${esc(title)}</h3><span class="muted">${esc(note)}</span></figcaption>
    <div class="fig-scroll">${svg}</div>
  </figure>`;
}

/** Every selected rig's pictures: its dependency graph first, because the chains are
    the thing no list on this page can show, then one tree per open epic, biggest first.
    The text filter applies — an epic is drawn if it or any child matches — so the map
    narrows with the lists rather than sitting there contradicting them. */
function renderMap(m) {
  if (loadingOf("backlog")) {
    state.mapHtml = "";     // so the first real draw is never mistaken for a no-op
    return void ($("#map").innerHTML = SKEL);
  }
  const blocks = [], trees = [];
  for (const r of m.sel) {
    const g = r.graphs || {};
    const kids = (id) => (m.children.get(id) || []);
    if (g.blocks) {
      // Drawn whole, and drawn even while the filter is on: the server laid this one
      // out over every edge in the rig and a half of a dependency graph is not a
      // smaller dependency graph. The caption says so rather than letting it look
      // filtered.
      blocks.push(figure(`${r.rig} · dependencies`,
        [`${g.blocks.edges} blocks edges over ${g.blocks.nodes} beads`,
          `${g.blocks.depth} deep`,
          g.blocks.met ? `${g.blocks.met} already met` : "",
          g.blocks.cross ? `${g.blocks.cross} leaving an epic` : "none leave an epic",
          g.blocks.trimmed ? `${g.blocks.trimmed} trimmed` : "",
          state.bq ? "whole rig — not filtered" : ""].filter(Boolean).join(" · "),
        g.blocks.svg));
    }
    for (const e of g.epics || []) {
      const bead = m.byId.get(e.id);
      if (state.bq && !(bead && beadMatches(bead, state.bq))
        && !kids(e.id).some((k) => beadMatches(k, state.bq))) continue;
      trees.push(figure(`${r.rig} · ${e.id}`,
        [`${e.kids} children`, e.drawn < e.kids ? `${e.drawn} drawn` : "",
          e.blocked ? `${e.blocked} blocked` : "nothing blocked"].filter(Boolean).join(" · "),
        e.svg));
    }
  }
  const total = m.sel.reduce((n, r) => n + num((r.graphs || {}).epics_total), 0);
  $("#map-count").textContent = !total ? ""
    : trees.length === total ? `${total} open epic${total === 1 ? "" : "s"}`
      : `${trees.length} of ${total} open epics`;
  const drawn = blocks.join("") + trees.join("");
  const html = drawn ? readHtml() + legendHtml() + drawn
    : empty(total ? "Nothing in the map matches that filter"
      : "Nothing here has children or dependencies to draw");
  // These are the largest subtrees on the page and they scroll sideways inside their
  // own boxes, so rewriting them on every 8s poll would throw away the operator's
  // scroll position mid-read. The pictures only change when the backlog read does.
  if (html !== state.mapHtml) {
    // A rewrite is rare, but it must not drop the reader out of the diagram they are
    // reading — the same bargain the bead rows below make with document.activeElement.
    const focused = document.activeElement?.dataset?.node;
    state.mapHtml = html;
    const el = $("#map");
    el.innerHTML = html;
    mapRoving(el);
    if (focused) $$("#map .gn").find((n) => n.dataset.node === focused)?.focus();
  }
}

function renderBacklog() {
  if (loadingOf("backlog")) {
    ["#epics", "#blocked", "#closed", "#backlog-rigs"].forEach((s) => ($(s).innerHTML = SKEL));
    return;
  }
  const rigs = ((dataOf("backlog", {}) || {}).rigs) || [];
  // The selected rig can vanish under the tab — unregistered, parked out of the status
  // read, or a repo that stopped answering. Fall back rather than draw an empty page.
  if (state.brig !== "all" && !rigs.some((r) => r.rig === state.brig)) state.brig = "all";
  const m = backlogModel(state.brig);
  // The 8s auto-refresh rebuilds these subtrees; expansion lives in state.beads so it
  // survives, and the focused row is restored so keyboard focus does not jump to <body>.
  const focused = document.activeElement?.dataset?.bead;
  renderBacklogChips(m);
  renderBacklogKpis(m);
  renderDistribution(m);
  renderCoverage(m);
  renderMap(m);
  renderEpics(m);
  renderBlocked(m);
  renderBacklogFlight();
  renderClosed(m);
  if (focused) $$("#view-backlog [data-bead]").find((el) => el.dataset.bead === focused)?.focus();
}

function renderBacklogChips(m) {
  const names = byKey(m.rigs.map((r) => r.rig), (n) => (n === "town" ? "0" : "1" + n));
  $("#backlog-chips").innerHTML = [["all", "All rigs"], ...names.map((n) => [n, n])]
    .map(([k, label]) => `<button class="chip ${state.brig === k ? "is-active" : ""}"
      data-brig="${esc(k)}">${esc(label)}</button>`).join("");
  $$("#backlog-chips [data-brig]").forEach((b) =>
    (b.onclick = () => { state.brig = b.dataset.brig; renderBacklog(); }));
}

function renderBacklogKpis(m) {
  const st = sumCounts(m.sel, "status");
  const total = m.sel.reduce((n, r) => n + num(r.total), 0);
  const work = m.sel.reduce((n, r) => n + num(r.work), 0);
  const closed = m.sel.reduce((n, r) => n + num(r.closed_total), 0);
  // Neither open nor closed, counted off the rig's own totals rather than off the
  // capped list, so it agrees with the bars beside it.
  const moving = Object.entries(st)
    .filter(([k]) => k !== "open" && k !== "closed").reduce((n, [, v]) => n + v, 0);
  const blocked = m.items.filter((b) => isBlocked(m, b)).length;
  const epics = m.items.filter((b) => !isClosed(b) && num(b.kids)).length;
  const cards = [
    { v: total, l: "Beads", sub: `${work} work${total - work ? ` · ${total - work} scaffolding` : ""}` },
    { v: num(st.open), l: "Open", sub: "filed, not started" },
    { v: moving, l: "Not open, not closed", cls: moving ? "good" : "", sub: "hooked, in progress or blocked" },
    { v: blocked, l: "Blocked", cls: blocked ? "alert" : "", sub: blocked ? "waiting on another bead" : "nothing is stuck" },
    { v: epics, l: "Open epics", sub: "parents with children" },
    { v: closed, l: "Closed", sub: "the history below" },
  ];
  $("#backlog-kpis").innerHTML = cards.map((c) => `
    <div class="kpi ${c.cls || ""}">
      <div class="kpi-value">${esc(c.v)}</div>
      <div class="kpi-label">${esc(c.l)}</div>
      <div class="kpi-sub muted">${esc(c.sub || "")}</div>
    </div>`).join("");
}

$("#backlog-q").oninput = (e) => { state.bq = e.target.value.toLowerCase(); renderBacklog(); };

// One delegated listener; every section under #view-backlog is replaced wholesale on
// each render, so per-row handlers would not survive.
$("#view-backlog").addEventListener("click", (ev) => {
  const row = ev.target.closest("[data-bead]");
  if (!row) return;
  if (!state.beads.delete(row.dataset.bead)) state.beads.add(row.dataset.bead);
  renderBacklog();
});

/* ---------------- board ----------------
   The same beads again, and the third question about them. The Work tab asks what is
   happening, the Backlog tab asks what was planned, and both answer in lists — which is
   the wrong shape for the question a review actually opens with, "where is everything".
   A list can only be sorted by one thing at a time; a board shows the state machine at
   once, and the interesting cells are the ones nobody has to scroll to find.

   FOUR THINGS ARE DELIBERATE HERE.

   Columns are beads' OWN statuses. Not a vocabulary of ours mapped onto them — the
   store already has open / hooked / in_progress / blocked / deferred / closed and every
   one of them means something the town set. A console that invented "To do / Doing /
   Done" over the top would be a second spelling of a fact that already has one, which is
   the failure class gc-5u3 was filed to avoid. Anything this town uses that the table
   below does not name gets a column of its own rather than being folded into "other".

   BLOCKED IS ALWAYS A COLUMN, even when it is empty. It is the thing a ceremony most
   needs and the thing the Work tab structurally cannot show — `gt ready` is
   unblocked-and-open by definition — so it does not get to be absent on a good day and
   appear on a bad one. Same for open, in progress and closed: the four corners of the
   machine are fixed, so the shape of the board means something across rigs and days.

   Swimlanes are the parent-child edges, one lane per parent that has a card on the
   board. Nothing is grouped by anything the console decided — a lane exists because
   somebody filed those beads under that epic. The biggest epic in this town has 19
   children; a lane is a grid rather than a row of stacks so 19 spreads across six
   columns instead of into one very long one, and each cell still holds only a screenful
   before it says how many it is not showing.

   BLOCKED-BY IS ON THE CARD, not behind it. A card that cannot move says what is
   holding it, in the column, without being opened — that sentence is the entire reason
   the blocked column is worth having, and putting it under a fold would mean the board
   showed you the problem and hid the cause.

   The pane is the focused half, and it is a docked panel rather than the inline
   expansion the Backlog tab uses (gc-6gp). Same idea, different room: a column is 200px
   wide and the fields the pane exists for — gathered context, proposed plan, acceptance
   criteria — are paragraphs. Expanding one inside a column would either reflow the whole
   board on every click or render prose in a 200px gutter. It is docked, not modal:
   no overlay, no scrim, no focus trap, the board stays live and legible beside it, and
   on a narrow screen it simply stacks underneath. Read-only, like everything else here
   — the pane shows the plan, and approving one is somebody else's bead (gc-dzd).

   Its prose does not come from the snapshot. See backlog.py: carrying four long fields
   for every bead would have doubled the panel every poll for a pane that reads one, so
   the backlog refresh keeps them beside the panel and `GET /api/bead` hands over the one
   that is open. Everything else on this tab is the cached `backlog` panel, unchanged. */

/* Reading order is the order work moves in, which is not the order `bd` lists statuses.
   The four in ALWAYS are drawn whether or not anything is in them — see above. */
const BOARD_COLUMNS = [
  { key: "open",        label: "Open",        hint: "filed, nobody on it" },
  { key: "hooked",      label: "On a hook",   hint: "slung to an agent — this town's usual shape" },
  { key: "in_progress", label: "In progress", hint: "claimed and moving" },
  { key: "blocked",     label: "Blocked",     hint: "cannot move until something else does" },
  { key: "deferred",    label: "Deferred",    hint: "parked on purpose" },
  { key: "closed",      label: "Closed",      hint: "finished" },
];
const BOARD_ALWAYS = new Set(["open", "in_progress", "blocked", "closed"]);
// Per cell, before it stops drawing and says how many it is holding back. A 19-child
// epic must not turn one column into a page of its own.
const BOARD_CARDS = 8;
/* Two identifiers name a card — a rig and a bead id — and they travel differently.
   In state they are one key; in markup they are two data attributes, because a
   separator inside an attribute is a bug waiting for the first id that contains it, and
   the obvious separator is worse than that: the HTML parser rewrites a NUL in an
   attribute value to U+FFFD, so a key built with one would not survive the round trip
   at all. JSON is the key here — no separator to collide with, and printable, which
   this file has already paid for once (gc-53s). */
const key2 = (rig, id) => JSON.stringify([rig || "", id]);
const boardKey = (b) => key2(b.rig, b.id);
const selKey = () => (state.sel ? key2(state.sel.rig, state.sel.id) : "");
const cardAttrs = (b) => `data-card="${esc(b.id)}" data-rig="${esc(b.rig || "")}"`;
const beadStatus = (b) => String(b.status || "").toLowerCase() || "?";

/** The columns this board draws: the four fixed ones, the rest of the known order where
    the beads use it, and then anything else the store came back with — a status the
    console has never heard of is a column, not a silent omission. */
function boardColumns(cards) {
  const seen = new Set(cards.map(beadStatus));
  const known = BOARD_COLUMNS.filter((c) => BOARD_ALWAYS.has(c.key) || seen.has(c.key));
  const extra = [...seen].filter((k) => !BOARD_COLUMNS.some((c) => c.key === k)).sort()
    .map((k) => ({ key: k, label: k, hint: "a status this console does not name" }));
  return [...known, ...extra];
}

/** One card. Everything on it is either structure the panel carries or a sentence the
    column would be useless without — the blocked line especially, which is the half of
    "blocked" that a status word alone never says. */
function boardCard(m, b) {
  const unmet = unmetOf(m, b);
  const sel = selKey() === boardKey(b);
  const hand = !unmet.length && beadStatus(b) === "blocked";
  const kids = num(b.kids);
  // Badges on their own line, the id down in the sub with the rest of the metadata —
  // the convention every other row in this app already follows, and the one a 200px
  // column forces anyway: this town's ids run to 23 characters, so an id sharing the top
  // line with two badges takes three lines of a card to say nothing the title does not.
  const tags = [
    b.plan ? '<span class="bcard-plan" title="carries a design or acceptance criteria">plan</span>' : "",
    b.issue_type && b.issue_type !== "task"
      ? `<span class="badge ${b.issue_type === "epic" ? "epic" : ""}">${esc(b.issue_type)}</span>` : "",
    b.priority == null ? "" : `<span class="badge p${esc(b.priority)}">P${esc(b.priority)}</span>`,
  ].filter(Boolean).join("");
  return `
    <button type="button" class="bcard ${isClosed(b) ? "is-done" : ""} ${sel ? "is-sel" : ""}"
            ${cardAttrs(b)} aria-pressed="${sel}">
      ${tags ? `<span class="bcard-tags">${tags}</span>` : ""}
      <span class="bcard-title">${esc(b.title)}</span>
      <span class="bcard-sub">
        <span class="mono bcard-id">${esc(b.id)}</span>
        ${b.assignee ? `<span class="bcard-who">${esc(b.assignee)}</span>` : ""}
        <span>${esc(ago(pick(b, isClosed(b) ? CLOSED_DATE : BEAD_DATE)))}</span>
      </span>
      ${kids ? `<span class="bcard-kids">${num(b.kids_closed)} of ${kids} children closed</span>` : ""}
      ${unmet.length ? `<span class="bcard-blocked">blocked by ${
    esc(unmet.map((x) => x.id).join(", "))}</span>` : ""}
      ${hand ? '<span class="bcard-blocked">marked blocked by hand — no blocking bead</span>' : ""}
    </button>`;
}

/** One lane's cell in one column. The cap is per cell rather than per lane so a crowded
    column cannot bury a quiet one beside it, and what it holds back is stated. */
function boardCell(m, lane, col, cards) {
  const open = state.boardMore.has(key2(lane, col.key));
  const drawn = open ? cards : cards.slice(0, BOARD_CARDS);
  const rest = cards.length - drawn.length;
  return `<div class="bcol ${cards.length ? "" : "is-empty"}">
    ${drawn.map((b) => boardCard(m, b)).join("")}
    ${rest > 0 || (open && cards.length > BOARD_CARDS)
    ? `<button type="button" class="bcol-more" data-more="${esc(col.key)}"
               data-more-lane="${esc(lane)}">${
      rest > 0 ? `+${rest} more` : "show fewer"}</button>` : ""}
  </div>`;
}

/** One swimlane: an epic across the top, its cards in the columns below. Two controls
    side by side for the same reason an agent row has two — collapsing a lane and reading
    its plan are different intentions, and buttons do not nest. Both are content-sized
    and pinned to the left edge: a lane is as wide as the whole board, so anything that
    floated to its right-hand end would be off screen exactly when somebody has scrolled
    out to the columns that made them want it. */
function laneHead(m, head, cards) {
  const collapsed = state.lanes.has(head.id);
  const total = num(head.kids), done = num(head.kids_closed);
  const sel = selKey() === boardKey(head);
  return `
    <div class="lane-bar">
      <button type="button" class="lane-toggle" data-lane="${esc(head.id)}"
              aria-expanded="${!collapsed}"
              aria-label="${collapsed ? "Expand" : "Collapse"} this epic">
        <svg viewBox="0 0 24 24" class="ico chev" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
      </button>
      <button type="button" class="lane-head ${sel ? "is-on" : ""}" ${cardAttrs(head)}
              aria-pressed="${sel}" title="Open this epic in the planning pane">
        <span class="lane-main">
          <span class="lane-title">${esc(head.title)}</span>
          <span class="sub">
            <span class="mono">${esc(head.id)}</span>
            <span>${esc(head.rig || "")}</span>
            <span class="badge ${isClosed(head) ? "ok" : beadStatus(head) === "blocked" ? "bad" : ""}">${esc(beadStatus(head))}</span>
            <span>${cards.length} on the board${total ? ` · ${done} of ${total} closed` : ""}</span>
            ${head.parent ? `<span class="mono">↳ under ${esc(head.parent)}</span>` : ""}
          </span>
          ${total ? `<span class="bar-track lane-bar-track"><span class="bar-fill"
            style="width:${Math.round((done / total) * 100)}%;background:${
  done === total ? "var(--green)" : "var(--blue)"}"></span></span>` : ""}
        </span>
      </button>
    </div>`;
}

/** The board, as lanes over one shared set of columns. Every grid below uses the same
    template, so the tracks line up down the page and one horizontal scroll moves all of
    them — which is why the columns are named once at the top rather than per lane. */
function boardHtml(m, lanes, cols) {
  const style = `--bn:${cols.length}`;
  // The column rule is coloured off the same allowlist the distribution bars use — the
  // value lands inside a style attribute, so it is never data-derived.
  // The hint is printed, not hung off `title=`: what "hooked" means is the reason the
  // column is worth reading, and a tooltip says it to a mouse and to nobody else — no
  // phone, no keyboard, no screen reader (gc-uu8). It is one line, once, at the top of
  // the board, which is what the Work tab's `.group-hint` already pays for its states.
  const head = `<div class="board-row board-head" style="${style}">${cols.map((c) => `
    <div class="bcol-head" style="border-bottom-color:${STATUS_COLOR[c.key] || "var(--border)"}">
      <span class="bcol-top">
        <span class="bcol-label">${esc(c.label)}</span>
        <span class="bcol-n">${lanes.reduce((n, l) => n + (l.cols.get(c.key) || []).length, 0)}</span>
      </span>
      <span class="bcol-hint">${esc(c.hint)}</span>
    </div>`).join("")}</div>`;
  const body = lanes.map((l) => {
    const collapsed = l.head && state.lanes.has(l.head.id);
    const cells = collapsed ? "" : `<div class="board-row lane-cols" style="${style}">${
      cols.map((c) => boardCell(m, l.id, c, l.cols.get(c.key) || [])).join("")}</div>`;
    const bar = l.head ? laneHead(m, l.head, l.cards)
      : lanes.length > 1 ? `<div class="lane-bar"><div class="lane-loose muted">
          Under no epic · ${l.cards.length}</div></div>` : "";
    return `<section class="lane">${bar}${cells}</section>`;
  }).join("");
  return `<div class="board-inner">${head}${body}</div>`;
}

/** Which beads are on the board, and how they fall into lanes. A parent heads a lane
    because one of its children is on the board — never because it is typed "epic", the
    same rule the Epics section uses, since this town has parents typed feature and
    decision. A lane head is not also a card in its own lane. */
function boardModel(m) {
  const inRig = m.items.filter((b) => state.boardRig === "all" || b.rig === state.boardRig);
  const shown = inRig.filter((b) => beadMatches(b, state.boardq));
  // A lane head is not a card in its own lane, so the number of cards is smaller than
  // the number of beads whether or not anything is filtered. Counted the same way on
  // both sides for that reason — "36 of 38" when nothing is filtered would read as a
  // filter that is on, which is the one thing the count is there to tell you about.
  const split = (rows) => {
    const laneIds = state.boardFlat ? new Set()
      : new Set(rows.map((b) => b.parent).filter((p) => p && m.byId.has(p)));
    return { laneIds, cards: rows.filter((b) => !laneIds.has(b.id)) };
  };
  const { laneIds, cards } = split(shown);
  const total = shown.length === inRig.length ? cards.length : split(inRig).cards.length;

  const buckets = new Map([["", []]]);
  for (const b of cards) {
    const key = laneIds.has(b.parent) ? b.parent : "";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(b);
  }
  const order = (b) => `${isClosed(b) ? "1" : "0"} ${String(9999 - num(b.kids)).padStart(5, "0")} ${b.id}`;
  const lanes = byKey([...buckets.keys()].filter(Boolean).map((id) => ({ id, head: m.byId.get(id) })),
    (l) => order(l.head)).map((l) => ({ ...l, cards: buckets.get(l.id) }));
  // Loose beads last: they are what has not been placed in a plan, which is a useful
  // thing to see at the bottom and a useless thing to lead with.
  if (buckets.get("").length || !lanes.length) lanes.push({ id: "", head: null, cards: buckets.get("") });

  for (const l of lanes) {
    l.cols = new Map();
    for (const b of byNewest(l.cards, BEAD_DATE)) {
      const k = beadStatus(b);
      if (!l.cols.has(k)) l.cols.set(k, []);
      l.cols.get(k).push(b);
    }
  }
  return { shown, cards, total, lanes };
}

function renderBoard() {
  const full = backlogModel("all");
  // The pill counts the whole town, not the chip selection — blocked work is the thing
  // this tab exists to surface, and a count that moved when you filtered would be
  // reporting the filter. It is also the one number the Work tab structurally cannot
  // show, which is why it rides on the tab rather than inside it.
  const stuck = full.items.filter((b) => isBlocked(full, b)).length;
  const pill = $("#pill-board");
  pill.textContent = stuck;
  pill.classList.toggle("hot", stuck > 0);

  renderBoardChips(full);
  if (loadingOf("backlog")) {
    $("#board").innerHTML = SKEL;
    $("#board-meta").textContent = "";
    paintPane(full);
    return;
  }
  // The selected rig can vanish under the tab, the same way it can under the Backlog
  // tab — unregistered, parked out of the status read, or a repo that stopped answering.
  if (state.boardRig !== "all" && !full.rigs.some((r) => r.rig === state.boardRig)) {
    state.boardRig = "all";
    renderBoardChips(full);
  }
  const bm = boardModel(full);
  const cols = boardColumns(bm.cards);
  const blocked = bm.cards.filter((b) => isBlocked(full, b)).length;
  const laneCount = bm.lanes.filter((l) => l.head).length;
  const filtered = bm.cards.length !== bm.total;
  $("#board-meta").textContent = [
    `${filtered ? `${bm.cards.length} of ${bm.total}` : bm.cards.length} card${
      (filtered ? bm.total : bm.cards.length) === 1 ? "" : "s"}`,
    // Meaningless with swimlanes off, and a "0 epics" beside "swimlanes off" reads as
    // a town with no plan rather than as a board that was asked not to draw them.
    state.boardFlat ? "swimlanes off" : `${laneCount} epic${laneCount === 1 ? "" : "s"}`,
    blocked ? `${blocked} blocked` : "nothing blocked",
    state.sel ? "" : "pick a card to read its plan",
  ].filter(Boolean).join(" · ");

  // The board scrolls in both directions and is rebuilt by the 8s poll, so its scroll
  // position and the focused card are saved across the rewrite — otherwise reading a
  // lane on the right-hand columns is impossible while auto-refresh is on.
  const el = $("#board");
  const keep = { l: el.scrollLeft, t: el.scrollTop };
  const focused = document.activeElement?.dataset;
  const want = focused?.card || focused?.lane || focused?.more;
  el.innerHTML = errNote("backlog") + (bm.cards.length ? boardHtml(full, bm.lanes, cols)
    : empty(bm.total ? "No card matches that filter" : "No backlog has been read yet"));
  el.scrollLeft = keep.l;
  el.scrollTop = keep.t;
  if (want) {
    $$("#board [data-card], #board [data-lane], #board [data-more]")
      .find((n) => (n.dataset.card || n.dataset.lane || n.dataset.more) === want)?.focus();
  }
  paintPane(full);
}

function renderBoardChips(m) {
  const names = byKey(m.rigs.map((r) => r.rig), (n) => (n === "town" ? "0" : "1" + n));
  $("#board-chips").innerHTML = [["all", "All rigs"], ...names.map((n) => [n, n])]
    .map(([k, label]) => `<button class="chip ${state.boardRig === k ? "is-active" : ""}"
      data-brrig="${esc(k)}">${esc(label)}</button>`).join("")
    + `<button class="chip ${state.boardFlat ? "" : "is-active"}" data-lanes="on">Swimlanes</button>`
    + `<button class="chip ${state.boardFlat ? "is-active" : ""}" data-lanes="off">Flat</button>`;
  $$("#board-chips [data-brrig]").forEach((b) =>
    (b.onclick = () => { state.boardRig = b.dataset.brrig; renderBoard(); }));
  $$("#board-chips [data-lanes]").forEach((b) =>
    (b.onclick = () => { state.boardFlat = b.dataset.lanes === "off"; renderBoard(); }));
}

/* ---- the planning pane ---- */

/** A list of other beads the pane points at — what this one waits on, what waits on it,
    what sits under it. Each row selects that bead, so the pane walks the graph the card
    only names. A blocker backlog.py could not resolve is drawn as text rather than as a
    link: there is nothing to open. */
function paneRefs(m, label, hint, rows) {
  if (!rows.length) return "";
  return `<div class="pane-refs">
    <div class="pane-label">${esc(label)} <span class="muted">${esc(hint)}</span></div>
    ${rows.map((b) => (b.rig ? `
      <button type="button" class="pane-link" ${cardAttrs(b)}>
        <i class="dot ${beadDot(m, b)}"></i>
        <span class="pane-link-main">
          <span class="mono">${esc(b.id)}</span>
          <span class="pane-link-title">${esc(b.title)}</span>
        </span>
        <span class="badge ${isClosed(b) ? "ok" : beadStatus(b) === "blocked" ? "bad" : ""}">${esc(beadStatus(b))}</span>
      </button>` : `
      <div class="pane-link is-flat">
        <span class="pane-link-main"><span class="mono">${esc(b.id)}</span>
        <span class="pane-link-title">${esc(b.title)}</span></span>
      </div>`)).join("")}
  </div>`;
}

/** The prose half, out of `GET /api/bead` rather than out of the snapshot. Four states
    and all four are drawn: not asked yet, in flight, failed, and the common one — a
    bead nobody has written a plan on, which must read as "nothing here" rather than as
    four empty headings. */
function paneProse(key) {
  const d = state.selData && state.selData.key === key ? state.selData : null;
  if (!d || d.loading) return '<div class="pane-wait">reading the bead…</div>';
  if (d.error) return `<div class="error-note">${esc(d.error)}</div>`;
  const p = d.data || {};
  const blocks = [["Gathered context", p.desc], ["Proposed plan", p.design],
    ["Acceptance criteria", p.acceptance], ["Notes", p.notes],
    ["Why it closed", p.reason]].filter(([, v]) => v);
  if (!blocks.length) {
    return empty("Nothing written down on this bead — no description, plan or criteria");
  }
  return blocks.map(([k, v]) => beadText(k, v)).join("");
}

/** The pane's title bar, shared by the reading half and every form — one close button in
    one place, so escaping the pane is the same gesture whatever it is showing. */
function paneHead(eyebrow) {
  return `<div class="pane-head">
    <span class="pane-eyebrow muted">${esc(eyebrow)}</span>
    <button type="button" class="btn icon-only pane-close" data-close-pane="1"
            title="Close the pane" aria-label="Close the planning pane">
      <svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
    </button>
  </div>`;
}

function paneHtml(m) {
  // Nothing selected is nothing drawn: a permanently docked empty panel would cost the
  // board a third of its width to say "pick something". The invitation is one line in
  // the meta above the board instead, where it costs nothing.
  if (!state.sel) return "";
  const key = selKey();
  const b = m.byId.get(state.sel.id);
  const head = paneHead("Planning");
  if (!b) {
    return head + `<div class="pane-body">${empty(
      `${state.sel.id} is not in the backlog the console last read`)}</div>`;
  }
  const kids = byKey(byNewest(m.children.get(b.id) || [], BEAD_DATE), (k) => (isClosed(k) ? "1" : "0"));
  const waiting = (m.dependents.get(b.id) || []);
  const stuck = blockersOf(m, b);
  const fields = [
    ["Rig", b.rig], ["Status", beadStatus(b)], ["Type", b.issue_type],
    ["Priority", b.priority == null ? "" : `P${b.priority}`],
    ["Assignee", b.assignee || "unassigned"],
    ["Under", b.parent], ["Children", num(b.kids) ? `${num(b.kids_closed)} of ${num(b.kids)} closed` : ""],
    ["Updated", ago(pick(b, BEAD_DATE))], ["Closed", isClosed(b) ? ago(pick(b, CLOSED_DATE)) : ""],
  ].filter(([, v]) => v);
  return head + `
    <div class="pane-body">
      ${state.paneNote ? `<p class="pane-saved ${state.paneBad ? "is-bad" : ""}"
        role="${state.paneBad ? "alert" : "status"}">${esc(state.paneNote)}</p>` : ""}
      <h3 class="pane-title">${esc(b.title)}</h3>
      <div class="pane-id"><span class="mono">${esc(b.id)}</span>
        ${b.plan ? '<span class="bcard-plan">plan</span>' : ""}</div>
      <!-- Always live, never disabled-with-a-tooltip: a control that greys out for a beat
           and explains itself only on hover explains itself to a mouse and to nobody else
           (gc-uu8). If the prose has not landed yet, openForm() says so in words. -->
      <div class="pane-acts">
        <button type="button" class="btn small" data-form="edit">Edit</button>
        <button type="button" class="btn small" data-form="link">Link</button>
        <button type="button" class="btn small" data-form="mail">Send to an agent</button>
      </div>
      <dl class="agent-detail pane-fields">${fields.map(([k, v]) =>
    `<div class="detail-item"><dt>${esc(k)}</dt><dd class="wrap">${esc(v)}</dd></div>`).join("")}</dl>
      ${paneRefs(m, "Blocked by", "must land first", stuck)}
      ${paneRefs(m, "Blocks", "waiting on this one", waiting)}
      ${paneRefs(m, "Children", "under this bead", kids)}
      <div class="pane-prose">${paneProse(key)}</div>
    </div>`;
}

/** The pane alone. Called by renderBoard and by the fetch below, so a landing response
    repaints one panel instead of rebuilding the whole board under the reader.

    WHILE A FORM IS OPEN THE PANE IS NOT REBUILT. The board behind it keeps refreshing on
    its own cadence — but replacing a half-typed plan with the server's copy every eight
    seconds is gc-6gp's bug with somebody's writing inside it, and the writing is the
    thing this tab now exists to produce. Forms repaint only when they have something new
    to say (a conflict, an error, a save), through paintForm(). */
function paintPane(m) {
  const el = $("#board-pane");
  $("#board-layout").classList.toggle("has-pane", !!state.sel || !!state.form);
  if (state.form) return;
  const keep = el.scrollTop;
  el.innerHTML = paneHtml(m || backlogModel("all"));
  el.scrollTop = keep;
}

/** Open a card in the pane, or close it if it is already the open one — the same toggle
    every other expandable row on this page uses. */
function selectBead(rig, id) {
  // An open form owns the pane until it is saved or cancelled. Swapping the bead under
  // it would throw away whatever is typed in it, silently, on a stray click into the
  // board — so the click is refused out loud instead.
  if (state.form) return void formSays("Save or cancel this first — the pane is busy.");
  if (selKey() === key2(rig, id)) return void closePane();
  state.paneNote = "";
  state.paneBad = false;
  state.sel = { rig, id };
  state.selData = { key: key2(rig, id), loading: true };
  renderBoard();
  // Narrow screens stack the pane under a board that is several screens tall, so the
  // thing you just asked for would open somewhere below the fold. Only when it is
  // stacked: moving the page under a docked pane would be taking the scroll away from
  // somebody who is still reading the board beside it. On selection only, never on the
  // 8s repaint — a page that re-scrolled itself every eight seconds would be unusable.
  const pane = $("#board-pane");
  if (getComputedStyle(pane).position === "static") {
    pane.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  pullBead();
}
function closePane() {
  // Closing the pane with a form open closes the form and keeps the bead, rather than
  // both at once: one press, one thing lost, and the thing lost is the one you pressed.
  if (state.form) return void closeForm();
  state.sel = null;
  state.selData = null;
  state.paneNote = "";
  state.paneBad = false;
  renderBoard();
}

/** The one fetch on this tab. It reads a dict the backlog refresh already filled (see
    backlog.py), so it cannot block on `bd` and does not need a cadence — it is asked
    once per card opened, and the answer changes only when the backlog read runs. */
async function pullBead() {
  const key = selKey();
  if (!key) return;
  const { rig, id } = state.sel;
  try {
    const r = await fetch(`/api/bead?rig=${encodeURIComponent(rig)}&id=${encodeURIComponent(id)}`,
      { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (selKey() !== key) return;                 // closed or switched mid-flight
    state.selData = { key, data: j.data, error: j.error };
  } catch (e) {
    if (selKey() !== key) return;
    state.selData = { key, error: e.message };
  }
  paintPane();
}

/* ---- the writing half ----
   The operator asked for a loop, not a form: "the agent should help me to create the
   plan and i give feedback". Most of that loop already shipped — the board and the map
   draw the plan, and mail wakes the agent that writes it. What was missing was the
   operator's own hand on the bead, so these four forms close it:

     New bead   a rough goal, filed where an agent can find it
     Edit       the operator's revision of what an agent drafted
     Link       where it sits in the plan, and what it waits on
     Send       "go and work on this one" — the existing mail write, nothing new

   THREE THINGS HERE ARE NOT NEGOTIABLE, and all three are somebody's bad day.

   A FORM FREEZES THE PANE. Every panel on this page is rebuilt every eight seconds. A
   textarea inside one of those rebuilds loses its contents, its cursor and its focus, so
   an open form stops the repaint outright (paintPane) and repaints only when it has
   something to say. gc-6gp was the same bug before there was any typing to lose.

   ONLY WHAT WAS TOUCHED IS SENT. The request carries the fields whose value differs from
   the baseline, and the baseline for exactly those. A form that posted all seven fields
   would assert a baseline for four the operator never opened, and every one of those is
   a chance to reject — or clobber — an agent's revision of a field nobody was arguing
   about.

   A REJECTED SAVE IS LOUD AND KEEPS YOUR WRITING. A 409 does not clear the form and does
   not merge anything. It says which field moved, shows what the store has now, and
   offers the two honest choices: take theirs, or overwrite it deliberately. Both
   re-baseline that one field, so the next Save is a decision rather than a retry. */

/* The four long fields, in the order a plan gets written, with what each is for. The
   hint is printed rather than hung off `title=` — a tooltip is a mouse affordance, and
   the phone is the screen this console is read on (gc-uu8). */
const FORM_PROSE = [
  ["desc", "Gathered context", 6,
    "What is actually going on. The facts an agent would otherwise rediscover."],
  ["design", "Proposed plan", 8,
    "How to do it, and what not to do. This is the field the loop is about."],
  ["acceptance", "Acceptance criteria", 4,
    "How anybody can tell it is finished."],
  ["notes", "Notes", 3, "Anything that does not belong above."],
];
/* bd's own vocabulary, not ours — same rule the board's columns follow. */
const FORM_TYPES = ["task", "bug", "feature", "epic", "chore", "decision"];
const FORM_LABEL = { title: "Title", priority: "Priority", type: "Type", parent: "Parent",
  ...Object.fromEntries(FORM_PROSE.map(([k, label]) => [k, label])) };
const POSTS = { new: "/api/bead-new", edit: "/api/bead-edit", link: "/api/bead-link" };

/** Open one form in the pane. `fields` is what it is editing and `base` is what the
    console had when it drew them — the two stay separate for the whole life of the form,
    because their difference is both what gets sent and what a conflict is measured
    against. */
function openForm(kind) {
  const m = backlogModel("all");
  // Matched on rig AND id rather than through byId, which is keyed on the id alone. Two
  // rigs with one id is unlikely and reading the wrong one is only confusing; *writing*
  // the wrong one is somebody else's bead overwritten, so this end takes the long way.
  const b = state.sel
    ? m.items.find((x) => x.id === state.sel.id && x.rig === state.sel.rig) || null : null;
  const read = state.selData && state.selData.key === selKey();
  const prose = (read && !state.selData.error && state.selData.data) || {};
  if (kind !== "new" && !b) return void paneSays("Pick a card first.");
  // The editor has to be seeded from a read that landed. One that opened on a half
  // arrived response would offer to save a blank over somebody's plan, and the save
  // would look exactly like a deliberate deletion afterwards.
  if (kind === "edit" && (!read || state.selData.loading)) {
    return void paneSays("Still reading this bead — try again in a moment.");
  }
  if (kind === "edit" && state.selData.error) {
    return void paneSays(`This bead could not be read (${state.selData.error}), so there `
      + "is nothing safe to edit from.");
  }

  let fields = {};
  if (kind === "edit") {
    fields = { title: b.title || "", type: b.issue_type || "task",
      priority: b.priority == null ? "2" : String(b.priority),
      ...Object.fromEntries(FORM_PROSE.map(([k]) => [k, prose[k] || ""])) };
  } else if (kind === "new") {
    fields = { title: "", type: "task", priority: "2",
      ...Object.fromEntries(FORM_PROSE.map(([k]) => [k, ""])) };
  } else if (kind === "link") {
    fields = { kind: "parent", target: "", parent: b.parent || "" };
  } else {
    fields = { to: b.assignee || "", subject: `${b.id} — ${b.title}`, message: "" };
  }
  state.form = {
    kind,
    rig: b ? b.rig : (state.boardRig !== "all" ? state.boardRig : (m.rigs[0] || {}).rig || ""),
    id: b ? b.id : "",
    parent: b && kind === "new" ? b.id : "",
    fields,
    base: { ...fields },
    // Whichever long fields the server could only send part of. Editing one would save
    // the part over the whole — see backlog._prose(). Named, and refused, one by one.
    clipped: new Set(kind === "edit" ? prose.clipped || [] : []),
    conflicts: [], err: "", msg: "", busy: false,
  };
  state.paneNote = "";
  state.paneBad = false;
  paintForm(true);
}

function closeForm() {
  state.form = null;
  renderBoard();
}

/** A line the *pane* says when there is no form to say it in — a refusal to open one,
    mostly. Same slot the last write's outcome uses, for the same reason: it is the one
    place on this tab that reports on writing. */
function paneSays(msg) {
  state.paneNote = msg;
  state.paneBad = true;
  paintPane();
}

/** A line the form says without anything having gone wrong — a stray click into the
    board while a form is open, or a Save with nothing to save. Separate from formFails()
    because red is a currency: spend it on writes that did not land, not on being told
    that nothing needed one. */
function formSays(msg) {
  if (!state.form) return;
  state.form.msg = msg;
  state.form.err = "";
  paintForm();
}

/** The form, painted. The only thing that rewrites the pane while one is open, so it is
    also where focus is put: on open, the first thing to fill in; after a refusal, the
    line that says why, which is what a screen reader is left on too. */
function paintForm(fresh = false) {
  const el = $("#board-pane");
  $("#board-layout").classList.toggle("has-pane", true);
  // Rewriting the pane resets its scroll, and a form is taller than the pane — so a note
  // arriving mid-form must not throw the reader back to the top of their own writing.
  const keep = el.scrollTop;
  el.innerHTML = formHtml(backlogModel("all"));
  if (fresh) {
    el.scrollTop = 0;
    ($("#board-pane [data-edit]") || $("#board-pane .btn"))?.focus();
    if (getComputedStyle(el).position === "static") {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  } else {
    el.scrollTop = keep;
    // A refusal is given focus so that it is read out and so that the next Tab starts
    // from it rather than from wherever the page happened to be.
    if (state.form.err) $("#form-note")?.focus();
  }
}

function formHtml(m) {
  const f = state.form;
  const head = paneHead(f.kind === "new" ? "Drafting" : f.kind === "mail" ? "Sending"
    : f.kind === "link" ? "Linking" : "Editing");
  const body = f.kind === "mail" ? mailForm(m, f) : f.kind === "link" ? linkForm(m, f)
    : beadForm(m, f);
  return head + `<div class="pane-body form-body">${body}</div>`;
}

/** One labelled control, built here rather than by its caller so that the label, the
    hint and the field can be wired to each other in one place.

    The hint is DESCRIBED, not named: it hangs off aria-describedby instead of living
    inside the label, so a screen reader announces "Proposed plan, text area" and then
    the sentence, rather than reading a sentence as the name of the box every time focus
    lands in it. It is printed on the page for the same reason nothing else here is a
    `title=` — a tooltip is a mouse affordance and this console is read on a phone.

    `spec` says what to draw: options for a select, rows for a textarea, anything else
    is a one-line input. */
function formField(name, label, hint, spec) {
  const attrs = `id="f-${esc(name)}" data-edit="${esc(name)}"`
    + (hint ? ` aria-describedby="h-${esc(name)}"` : "");
  const value = spec.value ?? "";
  let control;
  if (spec.options) {
    control = `<select ${attrs}>${spec.options.map(([v, l]) => `<option value="${esc(v)}"${
      String(v) === String(value) ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  } else if (spec.rows) {
    control = `<textarea ${attrs} rows="${spec.rows}">${esc(value)}</textarea>`;
  } else {
    control = `<input ${attrs} autocomplete="off"${spec.list ? ` list="${esc(spec.list)}"` : ""}${
      spec.placeholder ? ` placeholder="${esc(spec.placeholder)}"` : ""} value="${esc(value)}">`;
  }
  return `<div class="field${spec.narrow ? " narrow" : ""}">
    <label class="field-name" for="f-${esc(name)}">${esc(label)}</label>
    ${hint ? `<p class="field-hint" id="h-${esc(name)}">${esc(hint)}</p>` : ""}
    ${control}
  </div>`;
}

const PRIORITY_OPTIONS = [["0", "P0 urgent"], ["1", "P1 high"], ["2", "P2 normal"],
  ["3", "P3 low"], ["4", "P4 someday"]];

/** Drafting a bead and editing one are the same form: the same fields, written the same
    way, differing only in whether there is already something on the other end of them. */
function beadForm(m, f) {
  const isNew = f.kind === "new";
  const rigs = m.rigs.map((r) => [r.rig, r.rig]);
  const inRig = m.items.filter((b) => b.rig === f.rig && !isClosed(b));
  return `
    <h3 class="pane-title">${isNew ? "New bead" : "Editing this bead"}</h3>
    ${isNew ? "" : `<div class="pane-id"><span class="mono">${esc(f.id)}</span></div>`}
    ${isNew ? formField("rig", "Rig", "Which rig's beads this belongs in",
    { options: rigs, value: f.rig }) : ""}
    ${isNew ? formField("parent", "Under", "An epic to file it beneath — optional.",
    { value: f.parent, list: "form-beads", placeholder: "a bead id" }) : ""}
    ${formField("title", "Title", "One line. This is what the card says.",
    { value: f.fields.title })}
    <div class="field-row">
      ${formField("type", "Type", "", { options: FORM_TYPES.map((t) => [t, t]),
    value: f.fields.type, narrow: true })}
      ${formField("priority", "Priority", "", { options: PRIORITY_OPTIONS,
    value: f.fields.priority, narrow: true })}
    </div>
    ${FORM_PROSE.map(([k, label, rows, hint]) => (f.clipped.has(k)
    ? `<div class="field"><span class="field-name">${esc(label)}</span>
         <p class="form-clipped">This field is longer than the console carries, so it
         only has part of it — saving would delete the rest. Edit it with
         <code class="mono">bd update ${esc(f.id)}</code>.</p></div>`
    : formField(k, label, hint, { rows, value: f.fields[k] }))).join("")}
    ${isNew ? beadList(inRig) : ""}
    ${clashHtml(f)}
    ${formFoot(f, isNew ? "Create bead" : "Save")}`;
}

/** Two beads, joined. Parent is single-valued so a change to it is an overwrite and
    carries a baseline; a blocks edge is only ever added, so it does not — see edit.py. */
function linkForm(m, f) {
  const b = m.byId.get(f.id) || {};
  const others = m.items.filter((x) => x.rig === f.rig && x.id !== f.id);
  const parent = m.byId.get(f.fields.parent);
  return `
    <h3 class="pane-title">Link this bead</h3>
    <div class="pane-id"><span class="mono">${esc(f.id)}</span> ${esc(b.title || "")}</div>
    ${formField("kind", "How", "", { value: f.fields.kind, options: [
    ["parent", "goes under — as a child of"],
    ["blocks", "waits on — blocked by"]] })}
    ${formField("target", "The other bead",
    "One of this rig's beads. Type an id, or pick from the list.",
    { value: f.fields.target, list: "form-beads", placeholder: "a bead id" })}
    ${beadList(others)}
    ${f.fields.parent ? `<p class="form-hint">Currently under
      <span class="mono">${esc(f.fields.parent)}</span>${
  parent ? ` — ${esc(parent.title)}` : ""}. Choosing a new one replaces it.</p>` : ""}
    ${clashHtml(f)}
    ${formFoot(f, "Link")}`;
}

/** The other half of the loop, and not a new write: this is the same allowlisted
    `POST /api/mail` the Mail tab uses, prefilled with the bead so the agent it wakes
    knows which plan it is being asked about. */
function mailForm(m, f) {
  const b = m.byId.get(f.id) || {};
  return `
    <h3 class="pane-title">Send an agent to this bead</h3>
    <div class="pane-id"><span class="mono">${esc(f.id)}</span> ${esc(b.title || "")}</div>
    <p class="form-hint">Mail wakes the agent it is addressed to. Say what you want
      drafted or changed; the bead id travels with it, so it can write the plan onto the
      bead and you will see it here on the next read.</p>
    ${formField("to", "To", "An agent's address.",
    { value: f.fields.to, list: "agent-addresses", placeholder: "rig/polecats/name" })}
    ${formField("subject", "Subject", "", { value: f.fields.subject })}
    ${formField("message", "Message", "The goal, or the feedback.",
    { rows: 8, value: f.fields.message })}
    ${formFoot(f, "Send")}`;
}

/** The id picker behind both `parent` and `target`. A datalist rather than a select: a
    rig has hundreds of beads, and typing three characters of an id beats scrolling. */
function beadList(rows) {
  return `<datalist id="form-beads">${byKey(rows, (b) => b.id).slice(0, 400)
    .map((b) => `<option value="${esc(b.id)}">${esc(b.title)}</option>`).join("")}</datalist>`;
}

/** What the store has that the console did not. Shown in full, with the two choices that
    are actually available — never merged, and never resolved by guessing. */
function clashHtml(f) {
  if (!f.conflicts.length) return "";
  return `<div class="form-clash">
    <h4>${f.conflicts.length === 1 ? "One field" : `${f.conflicts.length} fields`}
      changed while you were writing</h4>
    <p>Nothing was saved. Read what the store has now, then either take it or write over
      it on purpose.</p>
    ${f.conflicts.map((c, i) => `
      <div class="clash">
        <div class="clash-head">
          <span class="clash-field">${esc(FORM_LABEL[c.field] || c.field)}</span>
          <button type="button" class="btn small" data-clash="theirs" data-clash-i="${i}">Take this one</button>
          <button type="button" class="btn small" data-clash="mine" data-clash-i="${i}">Keep mine</button>
        </div>
        <div class="clash-text">${esc(c.now || "(empty)")}</div>
      </div>`).join("")}
  </div>`;
}

/** The foot every form shares: what happened, then the way out and the way on. The note
    is focusable so a refusal can be given focus, and it is a live region so one that
    arrives while focus is elsewhere is still announced. */
function formFoot(f, label) {
  return `<div class="form-foot">
    <p id="form-note" tabindex="-1" class="form-note ${f.err ? "is-bad" : ""}"
       role="${f.err ? "alert" : "status"}" aria-live="polite">${esc(f.err || f.msg)}</p>
    <div class="form-actions">
      <button type="button" class="btn" data-form-cancel="1">Cancel</button>
      <button type="button" class="btn primary" data-form-save="1"${f.busy ? " disabled" : ""}>${
  esc(f.busy ? "Saving…" : label)}</button>
    </div>
  </div>`;
}

/* ---- sending it ---- */

/** What differs from the baseline, and nothing else. See the note at the top of this
    section: a field nobody touched is a field this console has no business asserting. */
function touched(f) {
  return Object.fromEntries(Object.entries(f.fields)
    .filter(([k, v]) => !f.clipped.has(k) && v !== (f.base[k] ?? "")));
}

async function submitForm() {
  const f = state.form;
  if (!f || f.busy) return;
  if (f.kind === "mail") return void sendFromPane(f);

  let body;
  if (f.kind === "new") {
    if (!f.fields.title.trim()) return void formFails("A new bead needs a title.");
    body = { rig: f.rig, parent: f.parent.trim(),
      fields: Object.fromEntries(Object.entries(f.fields).filter(([, v]) => v.trim())) };
    body.fields.title = f.fields.title;
  } else if (f.kind === "link") {
    if (!f.fields.target.trim()) return void formFails("Name the other bead.");
    body = { rig: f.rig, id: f.id, kind: f.fields.kind, target: f.fields.target.trim(),
      base: { parent: f.base.parent } };
  } else {
    const fields = touched(f);
    if (!Object.keys(fields).length) return void formSays("Nothing has changed — nothing to save.");
    if (!f.fields.title.trim()) return void formFails("A bead has to keep a title.");
    body = { rig: f.rig, id: f.id, fields,
      base: Object.fromEntries(Object.keys(fields).map((k) => [k, f.base[k] ?? ""])) };
  }
  await postWrite(POSTS[f.kind], body, f);
}

/** One write, and everything that follows from it landing. The response is what the
    store now holds rather than what the form said, so the pane and the next baseline are
    both the truth — which is what keeps a second edit from colliding with the first. */
async function postWrite(path, body, f) {
  f.busy = true;
  f.err = "";
  f.msg = "Saving…";
  paintForm();
  let j = null;
  try {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body) });
    j = await r.json();
  } catch (e) {
    f.busy = false;
    return void formFails(`The console could not reach the server — ${e.message}. Nothing was saved.`);
  }
  f.busy = false;
  if (!j || !j.ok) {
    f.conflicts = (j && j.conflicts) || [];
    return void formFails((j && j.error) || "The write failed and said nothing about why.");
  }
  // Landed. Take the store's answer as the new truth for the pane, close the form, and
  // ask for a fresh backlog — the server has already patched its cached copy so the card
  // moves now, and the real read overwrites that a beat later.
  state.sel = { rig: j.rig, id: j.id };
  state.selData = { key: key2(j.rig, j.id), data: j.prose || {} };
  state.paneNote = j.detail || "Saved.";
  state.paneBad = false;
  state.form = null;
  renderBoard();
  load(true);
  setTimeout(() => load(false), 2500);
}

/** One conflicted field, decided. Either way the baseline moves to what the store has,
    because that is now what this console knows about it — the difference between the two
    is only whose text is left in the box. Nothing is written until Save is pressed
    again, so "keep mine" is a decision the operator makes twice. */
function resolveClash(choice, i) {
  const f = state.form;
  const c = f && f.conflicts[i];
  if (!c) return;
  const label = FORM_LABEL[c.field] || c.field;
  f.base[c.field] = c.now;
  if (choice === "theirs") f.fields[c.field] = c.now;
  f.conflicts = f.conflicts.filter((_, n) => n !== i);
  f.msg = choice === "theirs"
    ? `${label} is now what the store has. Edit it if you wanted something else.`
    : `${label} will overwrite what the store has when you save.`;
  f.err = "";
  paintForm();
  $("#board-pane [data-clash]")?.focus();
}

function formFails(reason) {
  const f = state.form;
  if (!f) return;
  f.err = reason;
  f.msg = "";
  paintForm();
}

/** The pane's Send. Deliberately the Mail tab's endpoint and nothing else — waking an
    agent is already an allowlisted write, and this is a second door onto it rather than
    a second write. The bead travels in the body so the agent knows which plan it is
    being asked about. */
async function sendFromPane(f) {
  const to = f.fields.to.trim(), subject = f.fields.subject.trim();
  const message = f.fields.message.trim();
  if (!to || !subject || !message) return void formFails("To, subject and message are all required.");
  f.busy = true; f.err = ""; f.msg = "Sending…";
  paintForm();
  try {
    const r = await fetch("/api/mail", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, subject, type: "task", priority: 2,
        message: `${message}\n\n— from the Gas Town console, about ${f.rig} ${f.id}` }) });
    const j = await r.json();
    f.busy = false;
    if (!j.ok) return void formFails(j.error || "The send failed and said nothing about why.");
    state.paneNote = `Sent to ${to}. It will wake and read ${f.id}.`;
  state.paneBad = false;
    state.form = null;
    renderBoard();
    load(true);
  } catch (e) {
    f.busy = false;
    formFails(`The console could not reach the server — ${e.message}. Nothing was sent.`);
  }
}

/* ---- wiring ---- */

// Typed values live in state, not in the DOM: a form that repaints (a conflict, a
// failure) has to come back with what was typed still in it.
$("#view-board").addEventListener("input", (ev) => {
  const el = ev.target.closest("[data-edit]");
  if (!el || !state.form) return;
  const name = el.dataset.edit;
  if (name === "rig") {
    // The rig decides which beads the parent picker can offer, so this one redraws.
    state.form.rig = el.value;
    state.form.parent = "";
    return void paintForm();
  }
  if (name === "parent" && state.form.kind === "new") state.form.parent = el.value;
  else state.form.fields[name] = el.value;
});

$("#board-new").onclick = () => {
  if (state.form) return void formSays("Save or cancel this first — the pane is busy.");
  state.sel = null;
  state.selData = null;
  openForm("new");
};

$("#board-q").oninput = (e) => { state.boardq = e.target.value.toLowerCase(); renderBoard(); };

// One delegated listener over the whole tab: the board and the pane are both replaced
// wholesale on every render, and the pane's own links are cards by another name.
$("#view-board").addEventListener("click", (ev) => {
  if (ev.target.closest("[data-close-pane]")) return void closePane();
  // The form's own controls come first: they live inside the pane, which lives inside
  // this tab, and one of them (a pane link) is a card by another name.
  const open = ev.target.closest("[data-form]");
  if (open) return void openForm(open.dataset.form);
  if (ev.target.closest("[data-form-cancel]")) return void closeForm();
  if (ev.target.closest("[data-form-save]")) return void submitForm();
  const clash = ev.target.closest("[data-clash]");
  if (clash) return void resolveClash(clash.dataset.clash, Number(clash.dataset.clashI));
  const card = ev.target.closest("[data-card]");
  if (card) return void selectBead(card.dataset.rig, card.dataset.card);
  const more = ev.target.closest("[data-more]");
  if (more) {
    const k = key2(more.dataset.moreLane, more.dataset.more);
    if (!state.boardMore.delete(k)) state.boardMore.add(k);
    return void renderBoard();
  }
  const lane = ev.target.closest("[data-lane]");
  if (!lane) return;
  if (!state.lanes.delete(lane.dataset.lane)) state.lanes.add(lane.dataset.lane);
  renderBoard();
});

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

// Escape backs out of whatever is open — the live terminal on the Agents tab, the
// planning pane on the Board tab — the way it closes everything else on a page.
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  if (state.watch) toggleWatch(state.watch);
  else if (state.sel) closePane();
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
  "#mail", "#trail", "#epics", "#blocked", "#backlog-flight", "#closed", "#backlog-rigs",
  "#backlog-status", "#backlog-type", "#board"]
  .forEach((s) => ($(s).innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>'));
load(true);
schedule();
