#!/usr/bin/env python3
"""Gas Town admin console — a read-mostly web front end over the `gt` CLI.

A background scheduler keeps every panel warm on its own cadence, so HTTP
requests always serve from cache and never block on a slow `gt` call. Writes are
limited to the allowlist in WRITE_ACTIONS. Binding beyond localhost forces a token.
"""

import argparse
import json
import mimetypes
import os
import secrets
import shutil
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import backlog
import beads
import dispatch
import edit
import flight
import models
import panes
import queued

STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
ENV = dict(os.environ, PATH="/opt/homebrew/bin:/usr/local/bin:" + os.environ.get("PATH", ""))
TOWN = os.path.expanduser("~/gt")
TOKEN = None
DEMO = False
# The addresses that mean "nobody but this machine". Everything else is a LAN binding,
# where the only thing standing in front of the console is the token below — a speed
# bump, as the README says. LOCAL is what decides whether this console can dispatch at
# all; see dispatch.py, WRITE_ACTIONS and _page() for the three places it is enforced.
LOOPBACK = ("127.0.0.1", "localhost", "::1")
# Fails closed: nothing dispatches until a bind address has actually been read and found
# to be the loopback. The startup block below is the only thing that ever sets it true.
LOCAL = False


def _last(name):
    """The last data a panel landed. For the reads that decorate another read rather
    than fetching what it already has — all of them run on the scheduler, so what they
    borrow is whatever that panel last answered, never a fetch of their own."""
    with _guard:
        return _cache[name]["data"]


def _status():
    """The last status payload, for the reads that decorate it. All of them run on the
    scheduler and status is refreshed faster than any of them, so it is warm by then."""
    return _last("status")


def agent_models():
    """The "models" read: which model each agent runs, out of its Claude Code
    transcript because `gt` exposes none. See models.py — it derives from the status
    panel, which the scheduler keeps warmer than this one on its own cadence."""
    return models.by_agent(_status(), TOWN)


def agent_panes():
    """The "panes" read: what each agent is actually doing, from its tmux screen.
    `gt` has no liveness field at all — its `state` means "has a bead on its hook" —
    so this is the console's only source of activity. See panes.py."""
    return panes.by_session(_status())


def watched_panes():
    """The "watch" read: the whole screen of any session an operator has a watch view
    open on, so the Agents tab can show a live terminal. Costs nothing when nobody is
    watching — see panes.watch() for the lease that turns it on and off."""
    return panes.watched(_status())


# The two reads that fan out per rig learn the rig list from the status panel, so they
# cannot usefully run before it lands. On the first scheduler tick every read is due at
# once: one that fanned out over a town it could not see yet would find only the town's
# own beads repo and then cache that answer — a town with one rig in it — for a whole
# interval. Saying not-yet costs a beat; refresh() brings a panel that has never landed
# back on the cold-start floor rather than on its own cadence.
COLD = "waiting for the status read"


def work_in_flight():
    """The "flight" read: every bead that is not open and not closed, and who holds
    it. `gt ready` drops a bead the moment somebody picks it up and no `gt` read
    carries an agent's work, so this is the console's only answer to "what is being
    worked on right now". One `bd` call per beads repo in town — see flight.py."""
    return flight.in_flight(_status(), TOWN) if _status() is not None else (None, COLD)


def scheduled_work():
    """The "queue" read: what the scheduler is holding, what each item is blocked
    behind, and why nothing is dispatching — in words. The two reads above say what is
    running and what could be started; a scheduled bead is in neither, so a stalled
    queue and a finished town draw the same blank page without this. Unlike them it
    borrows a *second* panel: `backlog` already knows every rig's blocks edges, which is
    what lets a blocked item name its blocker for no extra call. See queued.py — and
    note it is the read that can only ever *say* why nothing is dispatching, where
    dispatch.py beside it is the write that can make something dispatch."""
    return queued.state(run_gt, _status(), _last("backlog"))


def planned_work():
    """The "backlog" read: every rig's whole backlog with its structure intact — the
    epic hierarchy, the blocks edges, and why each closed bead closed. The three reads
    above answer "what is happening"; this one answers "what did we plan", which is
    what a ceremony is for and what no `gt` read carries. See backlog.py."""
    return backlog.by_rig(_status(), TOWN) if _status() is not None else (None, COLD)


# name -> (source, seconds between background refreshes). A source is `gt` argv —
# every one read-only — or a callable returning (data, error) for a read that is not
# a `gt` call at all. Either way this table stays the one place a read is declared.
READS = {
    "status":      (["status", "--json"], 15),
    "rigs":        (["rig", "list", "--json"], 45),
    "ready":       (["ready", "--json"], 20),
    # The other half of "ready": what has already been picked up, and by whom. Same
    # cadence as ready on purpose — they answer two halves of one question, and a
    # visible skew between them reads as a bug rather than as staleness.
    "flight":      (work_in_flight, 20),
    # The third half of the same question, on the same cadence for the same reason:
    # what is scheduled but has not been slung yet. `gt scheduler status` is a slow
    # call (1-3s on a quiet town) and the queue only changes when something dispatches,
    # so this is nowhere near a request path — but it must not visibly lag the two
    # lists it sits between either.
    "queue":       (scheduled_work, 20),
    # The slowest read in the table, and the largest payload: `bd list --all` over
    # every rig. A plan is not a live signal — it changes when somebody files or closes
    # a bead, not between two blinks — so it is read on the order of minutes.
    "backlog":     (planned_work, 180),
    "mail":        (["mail", "inbox", "--json"], 12),
    "escalations": (["escalate", "list", "--json"], 45),
    "trail":       (["trail", "--limit", "40", "--json"], 20),
    "changelog":   (["changelog", "--json"], 90),
    "convoys":     (["convoy", "list", "--json"], 60),
    # `gt status` omits the deacon's dog pack entirely, so the Agents tab would show
    # a working dog nowhere at all without this. Slow: the pack changes rarely, and
    # what a dog is *doing* comes from "panes" below, not from here.
    "dogs":        (["dog", "list", "--json"], 45),
    # Slower than the panels it decorates: a session's model never changes under it,
    # and models.py re-reads a transcript only once it has actually grown.
    "models":      (agent_models, 60),
    # Faster than everything else, because this is the one read that answers "who is
    # working right now" and a stale answer to that is the bug it exists to fix. It
    # is also the cheapest — a capture-pane per session, no Dolt, no `gt`.
    "panes":       (agent_panes, 6),
    # The only read that exists solely while somebody is looking: one agent's whole
    # screen, for the watch view on the Agents tab. Fast, because a terminal you are
    # watching at 6s reads as frozen; affordable at that cadence only because it does
    # nothing at all unless a watch lease is open, and at most three ever are.
    "watch":       (watched_panes, 2),
}

# Concurrent `gt` calls contend on the Dolt server, so keep the fan-out small.
POOL = ThreadPoolExecutor(max_workers=3, thread_name_prefix="gt")
# A panel that has never landed retries on this floor instead of on its own cadence.
# The slow cadences are tuned for steady state; making a panel that has nothing to show
# wait three minutes for a second attempt is not what they are for.
COLD_RETRY = 8
_cache = {n: {"data": None, "error": None, "at": 0.0, "loading": True, "due": 0.0, "inflight": False}
          for n in READS}
_guard = threading.Lock()


def run_gt(args, timeout=60):
    """Run a gt subcommand, returning (parsed_json_or_None, error_or_None)."""
    gt = shutil.which("gt", path=ENV["PATH"]) or "gt"
    try:
        p = subprocess.run([gt, *args], capture_output=True, text=True,
                           timeout=timeout, cwd=TOWN, env=ENV)
    except subprocess.TimeoutExpired:
        return None, f"timed out after {timeout}s"
    except FileNotFoundError:
        return None, "gt not found on PATH"
    out = (p.stdout or "").strip()
    # gt prefixes some payloads with warnings; recover the JSON body.
    if out and out[0] not in "[{":
        for i, ch in enumerate(out):
            if ch in "[{":
                out = out[i:]
                break
    if not out:
        return None, ((p.stderr or "").strip() or None) if p.returncode else None
    try:
        return json.loads(out), None
    except json.JSONDecodeError:
        return None, "unparseable output"


def refresh(name):
    """Run one read into the cache. Scheduler thread only — this is the slow half."""
    if DEMO:
        # Demo serves fixtures and must never shell out or read a real transcript;
        # keep what was seeded.
        with _guard:
            _cache[name]["inflight"] = False
        return
    source, interval = READS[name]
    data, err = run_gt(source) if isinstance(source, list) else source()
    with _guard:
        e = _cache[name]
        e["at"] = time.time()
        e["due"] = e["at"] + (interval if data is not None or e["data"] is not None
                              else min(interval, COLD_RETRY))
        e["inflight"] = False
        e["loading"] = False
        if err and e["data"] is not None:
            e["error"] = err          # a transient failure must not blank a live panel
        else:
            e["data"], e["error"] = data, err


def scheduler():
    while True:
        now = time.time()
        with _guard:
            due = [n for n, e in _cache.items() if not e["inflight"] and now >= e["due"]]
            for n in due:
                _cache[n]["inflight"] = True
        for n in due:
            POOL.submit(refresh, n)
        time.sleep(1)


def mark_due(*names):
    """Make panels eligible for the next scheduler tick. Never blocks on `gt`."""
    with _guard:
        for n in (names or _cache):
            _cache[n]["due"] = 0.0


def _view(entry, now):
    return {"data": entry["data"], "error": entry["error"], "loading": entry["loading"],
            "age": round(now - entry["at"], 1) if entry["at"] else None}


def panel(name):
    now = time.time()
    with _guard:
        return _view(_cache[name], now)


def snapshot():
    now = time.time()
    with _guard:
        panels = {n: _view(e, now) for n, e in _cache.items()}
    return {"at": now, "panels": panels}


def _page(raw):
    """index.html with the one thing about it that is not static filled in.

    The dispatch affordance has to be ABSENT off localhost, not disabled (gc-dzd), and
    "absent" has to be checkable by fetching the page rather than by looking at it — a
    control that a script decides not to draw is invisible to a reader of the HTML
    either way, so a page that never says which console this is cannot be inspected at
    all. So the served document carries the answer, and `curl -s / | grep gt-dispatch`
    is a real test with two possible results.

    One named marker, substituted once. That is not a template engine and must not grow
    into one: a second marker here is a sign that something belongs in a read instead."""
    return raw.replace(b"__GT_DISPATCH__", b"on" if LOCAL else b"off")


def send_mail(body, _client):
    if DEMO:
        return {"ok": False, "error": "demo mode — nothing is actually sent"}, 400
    to = (body.get("to") or "").strip()
    subject = (body.get("subject") or "").strip()
    message = (body.get("message") or "").strip()
    if not to or not subject or not message:
        return {"ok": False, "error": "to, subject and message are all required"}, 400
    args = ["mail", "send", to, "-s", subject, "-m", message,
            "--type", body.get("type") or "notification",
            "--priority", str(int(body.get("priority", 2)))]
    gt = shutil.which("gt", path=ENV["PATH"]) or "gt"
    p = subprocess.run([gt, *args], capture_output=True, text=True, timeout=60,
                       cwd=TOWN, env=ENV)
    if p.returncode:
        # gt appends its full usage block to failures; the first stanza is the reason.
        reason = (p.stderr or p.stdout or "send failed").split("Usage:")[0].strip()
        return {"ok": False, "error": reason or "send failed"}, 502
    mark_due("mail")
    return {"ok": True, "detail": (p.stdout or "sent").strip()}, 200


def dispatch_bead(body, client):
    """Approve a plan and put an agent on it — the one write that starts something. Same
    seam as write_bead below and for the same reason: dispatch.py owns every judgement
    (what may be pinned, what a repeat is, what `gt sling` is asked), backlog.py owns the
    shape of the cache, and this folds one into the other.

    Two things a handler cannot delegate. The client address is read off the connection
    rather than the body, because it goes into the audit record and a body is whatever
    the sender typed. And the `status` panel goes in because that is what bounds the
    targets — an agent this console has never been told about is not somewhere it will
    hand an autonomous worker to.

    This blocks for as long as spawning a polecat takes. That is the licence a POST has
    and a read never does; see CLAUDE.md."""
    with _guard:
        panel = _cache["backlog"]["data"]
    repos = [] if DEMO else beads.repos(_status(), TOWN)
    payload, code = dispatch.apply(body, repos, panel, _status(), TOWN, DEMO, client)
    if code != 200:
        return payload, code
    patched = backlog.apply_write(panel, payload["rig"], payload["bead"], payload["prose"])
    with _guard:
        if _cache["backlog"]["data"] is panel:
            _cache["backlog"]["data"] = patched
    # A sling moves the bead onto a hook and wakes an agent, so three panels are now
    # wrong at once — what is planned, what is in flight, and who is holding it.
    mark_due("backlog", "flight", "status")
    return payload, code


def write_bead(action, body):
    """One bead write, and the one thing a handler has to do around it: fold the answer
    into the panel it came from. edit.py owns the write and every judgement in it — what
    may be written, what a conflict is, what `bd` is asked; backlog.py owns the shape of
    the cache. This is the seam, and it stays this size.

    Unlike every read here, this blocks on `bd`. That is the point: an operator pressing
    Save is owed a synchronous answer, and a write queued onto the scheduler could not
    give one. See edit.py and the CLAUDE.md note on why the rule is about the read path."""
    with _guard:
        panel = _cache["backlog"]["data"]
    # Demo is handed no repos at all rather than trusted not to use the ones it was
    # given: with an empty list there is no path for a write to reach, whatever it does.
    repos = [] if DEMO else beads.repos(_status(), TOWN)
    payload, code = edit.apply(action, body, repos, panel, DEMO)
    if code != 200:
        return payload, code
    # Built outside the lock and swapped in under it, and only if the scheduler has not
    # landed a fresh read in the meantime — that read is the authority, and a patch built
    # on the panel this write started from would put it back.
    patched = backlog.apply_write(panel, payload["rig"], payload["bead"], payload["prose"])
    with _guard:
        if _cache["backlog"]["data"] is panel:
            _cache["backlog"]["data"] = patched
    # The patch above is a cache repair, not a second source of truth — this is what
    # replaces it with a real read a beat later. Under --demo there is no scheduler and
    # the patch is all there is, which is exactly what makes the demo writable.
    mark_due("backlog")
    return payload, code


# The allowlist. Everything else that arrives at do_POST is a 404, and there is no shell
# passthrough behind any of these — each one is a fixed argv assembled from validated
# fields. Note what is still NOT here: no delete and no close. Removing a bead is a
# different risk class, and closing one is a claim about work this console cannot check.
#
# A FIFTH ENTRY, "dispatch", IS ADDED BELOW AND ONLY ON THE LOOPBACK. It is not in this
# literal because it must be absent rather than refused when the console is reachable
# from the LAN — off localhost the endpoint 404s exactly like a route nobody ever wrote.
# See dispatch.py for why a token is not enough in front of it.
WRITE_ACTIONS = {
    "mail": send_mail,
    "bead-new": lambda body, _client: write_bead("new", body),
    "bead-edit": lambda body, _client: write_bead("edit", body),
    "bead-link": lambda body, _client: write_bead("link", body),
}


class Handler(BaseHTTPRequestHandler):
    server_version = "GastownAdmin"

    def log_message(self, *a):
        pass

    def _authed(self, qs):
        if not TOKEN:
            return True
        if self.headers.get("X-Token") == TOKEN:
            return True
        if qs.get("t", [None])[0] == TOKEN:
            return True
        return TOKEN in (self.headers.get("Cookie") or "")

    def _json(self, payload, code=200):
        raw = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def _file(self, path, qs):
        full = os.path.normpath(os.path.join(STATIC, path.lstrip("/")))
        if not full.startswith(STATIC) or not os.path.isfile(full):
            self.send_error(404)
            return
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        with open(full, "rb") as fh:
            raw = fh.read()
        if full == os.path.join(STATIC, "index.html"):
            raw = _page(raw)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-cache")
        if TOKEN and qs.get("t", [None])[0] == TOKEN:
            self.send_header("Set-Cookie", f"gtadmin={TOKEN}; Path=/; SameSite=Lax")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        u = urlparse(self.path)
        qs = parse_qs(u.query)
        if not self._authed(qs):
            self.send_error(401, "token required")
            return
        if u.path in ("/", "/index.html"):
            return self._file("index.html", qs)
        if u.path.startswith("/static/"):
            return self._file(u.path[len("/static/"):], qs)
        # ?watch=<session> renews a lease on the full-pane capture of one tmux session.
        # Like ?fresh=1 it does not do the work — it writes a name and an expiry into a
        # dict that the scheduler reads a beat later (see panes.watch). The poll that
        # draws the watch view is the same poll that keeps it alive, so nothing has to
        # be closed and no lease outlives the panel that asked for it.
        for session in qs.get("watch", [])[:1]:
            if panes.watch(session):
                mark_due("watch")   # a newly opened watch, so the first frame is not a wait
        if u.path == "/api/snapshot":
            if qs.get("fresh", ["0"])[0] == "1":
                mark_due()
            return self._json(snapshot())
        if u.path.startswith("/api/panel/"):
            name = u.path.rsplit("/", 1)[-1]
            if name not in READS:
                return self.send_error(404)
            if qs.get("fresh", ["0"])[0] == "1":
                mark_due(name)
            return self._json(panel(name))
        # One bead's long prose, for the Board tab's planning pane. Not a panel and not
        # a read: the `backlog` refresh already fetched these fields and kept them
        # beside the panel rather than in it (see backlog.py), so this is a dict lookup
        # by two exact strings — no subprocess, nothing that can block, and nothing the
        # snapshot has to carry for every bead on the off chance one card is open.
        if u.path == "/api/bead":
            rig = qs.get("rig", [""])[0]
            ident = qs.get("id", [""])[0]
            data, err = backlog.prose(rig, ident)
            return self._json({"rig": rig, "id": ident, "data": data, "error": err})
        self.send_error(404)

    def do_POST(self):
        u = urlparse(self.path)
        if not self._authed(parse_qs(u.query)):
            self.send_error(401, "token required")
            return
        action = u.path.rsplit("/", 1)[-1]
        if not u.path.startswith("/api/") or action not in WRITE_ACTIONS:
            return self.send_error(404)
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self._json({"ok": False, "error": "bad request body"}, 400)
        # The address comes off the connection, never out of the body: it lands in an
        # audit record, and a record of what the sender said about itself is not one.
        payload, code = WRITE_ACTIONS[action](body, self.client_address[0])
        self._json(payload, code)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Gas Town admin console")
    ap.add_argument("--port", type=int, default=8099)
    ap.add_argument("--bind", default="127.0.0.1")
    ap.add_argument("--town", default=os.path.expanduser("~/gt"))
    ap.add_argument("--token", default=None, help="require this token (auto-generated off localhost)")
    ap.add_argument("--no-auth", action="store_true", help="allow LAN binding with no token")
    ap.add_argument("--demo", action="store_true", help="serve synthetic data; never runs gt")
    args = ap.parse_args()

    TOWN = args.town
    TOKEN = args.token
    DEMO = args.demo
    LOCAL = args.bind in LOOPBACK
    if TOKEN is None and not LOCAL and not args.no_auth:
        TOKEN = secrets.token_urlsafe(16)
    if LOCAL:
        # The one write that starts an agent, and the only thing in this file that is
        # conditional on where the console is bound. It is added here rather than sitting
        # in WRITE_ACTIONS behind an `if` inside the handler, so that off localhost there
        # is nothing to guard: the action does not exist, the POST is a 404, and _page()
        # tells the front end not to draw the button. Three places, one condition.
        WRITE_ACTIONS["dispatch"] = dispatch_bead

    if DEMO:
        import demo
        seeded = time.time()
        fixtures = demo.fixtures()
        for name, data in fixtures.items():
            _cache[name] = {"data": data, "error": None, "at": seeded,
                            "loading": False, "due": float("inf"), "inflight": False}
        # The prose behind the planning pane lives beside the backlog panel rather than
        # in it, so the fixtures cannot carry it — `demo.fixtures()` must return exactly
        # the keys in READS. It is seeded the same way, from the same file, off the same
        # beads: every carried bead is a key, whether or not anybody wrote a plan on it.
        backlog.load_prose(demo.prose(fixtures["backlog"]))
    else:
        threading.Thread(target=scheduler, daemon=True).start()

    host = args.bind if args.bind != "0.0.0.0" else "<this-machine>"
    print(f"Gas Town admin console  ·  town: {TOWN}")
    print(f"  http://{host}:{args.port}/" + (f"?t={TOKEN}" if TOKEN else ""))
    if TOKEN:
        print("  token required — the link above carries it and sets a cookie")
    # Said out loud at startup, because it is the difference between a console that can
    # start an autonomous agent and one that cannot, and nobody should have to infer it
    # from a button being missing.
    print("  approve-and-dispatch: " + ("ON — bound to the loopback" if LOCAL else
          f"OFF — bound to {args.bind}, which is not the loopback"))
    ThreadingHTTPServer((args.bind, args.port), Handler).serve_forever()
