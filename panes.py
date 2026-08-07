"""What each agent is actually doing, read from its tmux pane.

`gt status --json` carries a `state` field, and it does not mean activity. It means
"is there a bead on this agent's hook". The Mayor executes tool calls for hours with
`running=true state=idle has_work=false` because nothing is slung to it, and the
Deacon reads identically mid-patrol — for the persistent agents that is most of the
time. Nothing in `gt` carries liveness, so the console derives it here instead, from
the one place the truth is visible: the agent's screen.

This town has concluded the same thing twice from the other direction (hq-1e2,
hq-cat): every stranding it has caught was caught by someone who happened to look at
a pane, never by a status field. So a pane read is the only honest source, and four
things fall out of it that no `gt` read distinguishes:

  working  the footer says a turn is in flight
  staged   the turn ended with text sitting in the input box, Enter never pressed —
           the exact shape of all four strandings so far
  idle     alive at an empty prompt
  unknown  a session we could not read as a Claude Code screen; said plainly rather
           than guessed at, because a wrong state here is worse than no state

Like models.py this is a read declared in `READS` and run only on the scheduler; a
capture-pane is milliseconds but it happens once per session in town, so it never
belongs on the HTTP request path. Nothing here writes to tmux — capture-pane and
list-sessions only — and every string it returns is agent-authored text the front
end must escape.

The bottom half of the file is the same concern read deeper: watch(). The summary
above is all the Agents tab needs for every session at once, but an operator watching
one agent wants its whole screen, and wants it faster than 6s. That capture cannot run
on every session (too expensive) and cannot run when the browser asks (the request
path is off limits), so it runs here on a lease — see watch() for the shape.
"""

import os
import re
import subprocess
import shutil
import threading
import time

PATH = "/opt/homebrew/bin:/usr/local/bin:" + os.environ.get("PATH", "")

# Claude Code's input box. A bare chevron is an empty box; anything after it was
# typed and never sent. tmux renders the gap after the chevron as U+00A0, not a
# space — spelled out here because the difference is invisible in an editor.
PROMPT = "\u276f"       # ❯
NBSP = "\u00a0"
# The footer hint, shown only while a turn is in flight.
BUSY = "esc to interrupt"
# The turn-status line, taken by position (see _classify) and then sanity-checked:
# a glyph, a space, then text — "✳ Julienning… (12m 24s · ↓ 36.4k tokens)" running,
# "✻ Churned for 2m 38s" finished. Matching by position rather than by glyph means a
# new spinner verb or emoji does not break the read.
STATUS = re.compile(r"^[^\w\s]\s+\S")
# What separates the two: the running form is an unfinished participle plus a live
# timer. Do not match on the verbs themselves — Claude Code rotates them constantly.
RUNNING = re.compile(r"…\s*\(")
# Agent-authored text handed to the browser, clipped so one runaway line cannot
# dominate a row.
CLIP = 180
# A town with more sessions than this is not one the console can usefully draw, and
# every session past the cap costs another capture-pane.
MAX_SESSIONS = 64


def _tmux(sock, *args, timeout=5):
    """One read-only tmux command, or None if it failed for any reason at all."""
    exe = shutil.which("tmux", path=PATH) or "tmux"
    # gt reports both; a path means a private socket file, a bare name means -L.
    flag = "-S" if os.sep in sock else "-L"
    try:
        p = subprocess.run([exe, flag, sock, *args], capture_output=True, text=True,
                           timeout=timeout, env=dict(os.environ, PATH=PATH))
    except (OSError, subprocess.SubprocessError):
        return None
    return None if p.returncode else p.stdout


def _socket(status):
    """The town's tmux socket out of `gt status --json`, or None if tmux is down."""
    tmux = status.get("tmux") if isinstance(status, dict) else None
    if not isinstance(tmux, dict) or not tmux.get("running"):
        return None
    return str(tmux.get("socket_path") or tmux.get("socket") or "").strip() or None


def _classify(text):
    """One pane's visible screen -> what that agent is doing.

    Claude Code's screen ends in a fixed shape — status line, rule, input box, rule,
    footer — so the input box is found first and everything else is read relative to
    it. That matters for the footer especially: "esc to interrupt" is tested against
    the last line and only the last line, because the agents in this town discuss
    that string in their own output and scrollback must not read as a running turn.
    """
    lines = [l.rstrip() for l in (text or "").splitlines()]
    while lines and not lines[-1].strip():
        lines.pop()
    if not lines:
        return {"activity": "unknown", "note": "", "staged": ""}

    box = next((i for i in range(len(lines) - 1, -1, -1)
                if lines[i].startswith(PROMPT)), None)
    staged = ("" if box is None else
              lines[box][len(PROMPT):].replace(NBSP, " ").strip())
    # The last real line above the input box and its rule.
    above = [l for l in lines[:max((box or 0) - 1, 0)] if l.strip()]
    note = above[-1] if above and STATUS.match(above[-1]) else ""

    working = BUSY in lines[-1] or bool(note and RUNNING.search(note))
    activity = ("working" if working else
                "unknown" if box is None else
                "staged" if staged else "idle")
    return {"activity": activity, "note": note[:CLIP], "staged": staged[:CLIP]}


def by_session(status):
    """{tmux session: {activity, note, staged, attached}} for every session on the
    town socket, as (data, error) — the shape `READS` sources return.

    Keyed by session rather than by agent on purpose: `gt status` names a session for
    every agent it knows, and the sessions it leaves over are exactly the agents no
    read names — boot, most often. The front end pairs the two up, so a live agent
    can never be invisible just because nothing in `gt` lists it.
    """
    sock = _socket(status)
    if not sock:
        return {}, None                  # status has not landed yet, or tmux is down
    listing = _tmux(sock, "list-sessions", "-F", "#{session_name}\t#{session_attached}")
    if listing is None:
        return None, f"tmux: no server on {sock}"

    out = {}
    for line in listing.splitlines()[:MAX_SESSIONS]:
        name, _, attached = line.partition("\t")
        if not name.strip():
            continue
        pane = _classify(_tmux(sock, "capture-pane", "-p", "-t", name))
        # Someone is looking at this pane, so text in its input box is as likely to
        # be a human mid-sentence as a stranding. The front end says so.
        pane["attached"] = attached.strip() not in ("", "0")
        out[name] = pane
    return out, None


# ---------------------------------------------------------------------------
# Watching one session
#
# A watch is a LEASE, not a subscription. The front end names the session it has open
# on each of its polls; watch() writes that name and an expiry into a dict, and the
# scheduler's next tick captures whatever is unexpired. Nothing is ever "closed":
# a shut panel, a backgrounded tab, a phone that went to sleep and a browser that
# crashed all stop the capture the same way, by no longer renewing. That is the whole
# reason for the shape — a subscription you have to cancel is a subscription that
# leaks, and a leaked one here means capturing a pane nobody is looking at forever.
#
# The lease write is the one thing in this file the HTTP thread touches, and it is a
# dict assignment: no tmux, no `gt`, no subprocess, nothing that can block. The
# capture stays where every other slow thing lives, on the scheduler.

# Long enough to ride out a slow poll or a phone flipping networks, short enough that
# an abandoned view stops costing captures within a few seconds.
WATCH_TTL = 15.0
# The bound the operator never sees and the town would feel: at most this many panes
# are under fast capture at once, however many browsers are open.
MAX_WATCHED = 3
# Scrollback kept above the visible screen. The visible screen alone is what tmux
# would show, but a watcher arrives mid-turn and wants the sentence that led here.
WATCH_SCROLLBACK = 200
WATCH_MAX_LINES = 320
# A pane is 80-200 columns; anything past this is a runaway line, not a terminal.
WATCH_COLS = 400

# capture-pane without -e already strips SGR sequences, so this is belt and braces
# for the day tmux changes its mind — or an agent prints raw bytes into its own
# scrollback, which is the more likely of the two. Escapes are STRIPPED, not
# rendered: colour is worth nothing here and an escape parser is a second injection
# surface on the app's most untrusted string.
ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]")
# C0 controls minus tab and newline, plus DEL. Box drawing is printable Unicode and
# survives — it is most of what a Claude Code screen is made of.
CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

_leases = {}                      # tmux session -> monotonic expiry
_leases_guard = threading.Lock()


def watch(session):
    """Renew (or open) a watch lease on one session, returning True if this opened one.

    Called from the HTTP path. Naming a session here is a request to *read* it — there
    is no path from this function to anything that could write to a pane. Over the cap
    the least-recently-renewed lease is dropped rather than the new one refused, so a
    forgotten tab can never lock a live watcher out of the last slot.

    The return value exists so the caller can wake the scheduler for a *new* watch and
    only for one: without it the first frame waits out a whole cycle and the view opens
    on a blank screen, and marking it due on every renewal would quietly move the
    cadence out of the READS table and into the browser's poll rate.
    """
    name = str(session or "").strip()
    if not name or len(name) > 200:
        return False
    now = time.monotonic()
    with _leases_guard:
        for s in [s for s, exp in _leases.items() if exp <= now]:
            del _leases[s]
        fresh = name not in _leases
        while fresh and len(_leases) >= MAX_WATCHED:
            del _leases[min(_leases, key=_leases.get)]
        _leases[name] = now + WATCH_TTL
        return fresh


def _leased():
    now = time.monotonic()
    with _leases_guard:
        return [s for s, exp in _leases.items() if exp > now]


def _plain(text):
    """One captured pane -> text safe to hand a browser as text. Escapes stripped,
    control characters dropped, and both dimensions clipped so no agent can decide
    how much of the operator's screen it gets."""
    lines = [CTRL.sub("", ANSI.sub("", ln)).rstrip()[:WATCH_COLS]
             for ln in (text or "").splitlines()]
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines[-WATCH_MAX_LINES:])


def watched(status):
    """The "watch" read: {tmux session: whole screen} for the sessions under lease.

    Free when nobody is watching, which is nearly always — an empty lease list returns
    before it even asks tmux whether it is up. Only a session tmux currently lists can
    be captured, so a name the front end invented, or one whose agent exited while the
    panel was open, reads as absent rather than as an error.
    """
    live = _leased()
    if not live:
        return {}, None
    sock = _socket(status)
    if not sock:
        return {}, None
    listing = _tmux(sock, "list-sessions", "-F", "#{session_name}")
    if listing is None:
        return None, f"tmux: no server on {sock}"
    known = {ln.strip() for ln in listing.splitlines() if ln.strip()}

    out = {}
    for name in live:
        if name not in known:
            continue
        text = _tmux(sock, "capture-pane", "-p", "-S", f"-{WATCH_SCROLLBACK}", "-t", name)
        if text is not None:
            out[name] = _plain(text)
    return out, None
