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
"""

import os
import re
import subprocess
import shutil

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
