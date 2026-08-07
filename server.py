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
import flight
import models
import panes

STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
ENV = dict(os.environ, PATH="/opt/homebrew/bin:/usr/local/bin:" + os.environ.get("PATH", ""))
TOWN = os.path.expanduser("~/gt")
TOKEN = None
DEMO = False


def _status():
    """The last status payload, for the two reads that decorate it. Both run on the
    scheduler and status is refreshed faster than either, so it is warm by then."""
    with _guard:
        return _cache["status"]["data"]


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


def send_mail(body):
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


WRITE_ACTIONS = {"mail": send_mail}


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
        payload, code = WRITE_ACTIONS[action](body)
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
    if TOKEN is None and args.bind not in ("127.0.0.1", "localhost") and not args.no_auth:
        TOKEN = secrets.token_urlsafe(16)

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
    ThreadingHTTPServer((args.bind, args.port), Handler).serve_forever()
