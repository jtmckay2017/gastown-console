"""Approving a plan, and putting an agent on it — the console's fifth write, and the
only one that starts something rather than describing something.

WHAT THIS IS. `gt sling <bead> <target>` spawns a fresh polecat, hands it the bead, and
lets go. That polecat writes code, opens an MR, and the refinery merges it. So this
endpoint can merge code. It is bounded and recoverable — a branch and some tokens — but
it is real, and it is a different class of thing from every other write here: edit.py
changes what a plan SAYS, and this one makes it HAPPEN.

WHY IT EXISTS ANYWAY, since a viewer that dispatches sounds like exactly the feature a
careful console would not have. Dispatch already happens: the Mayor slings on its own
judgement, with the operator seeing a description of a plan rather than the plan. A
button that will not fire until a human has read the actual plan text is MORE gate than
exists today, not less. That is hq-ayx reached from the other side — a dispatching
action needs a human, not a threshold.

FOUR GUARDS. All four are required and none of them is decoration (gc-dzd).

1. LOCALHOST ONLY, and absent rather than disabled. This module is never reached at all
   when the server is bound past the loopback: server.py leaves `dispatch` out of
   WRITE_ACTIONS, so the endpoint 404s like a route that was never written, and the page
   it serves carries `gt-dispatch: off` so the button is not in the document either.
   The token the server generates off localhost is, in the README's own words, a speed
   bump — and a speed bump in front of "start an autonomous agent that can merge code"
   is not a lock. Reaching this from a phone is an authentication decision and a
   separate bead; it is not something to smuggle in behind a flag.

2. THE APPROVAL PINS THE PLAN. The request carries what the console showed the operator
   for every field of the bead — title, type, priority, status, assignee and the four
   long fields — and this module re-reads the bead and refuses if any of them moved.
   Agents rewrite these beads continuously, so approving one plan and executing another
   is the EXPECTED failure here rather than the paranoid one. A refusal names the field
   and shows both versions, the same shape edit.py's conflict takes, because it is the
   same problem with more at stake.

   There is deliberately no free-text message on a dispatch. Anything the operator typed
   into a box beside the button would travel to the agent without being part of what the
   approval pinned, which is the whole guard leaking out through its own UI. What the
   agent is told is the bead, and the bead is what was read.

3. THE APPROVAL IS RECORDED ON THE BEAD, BEFORE ANYTHING RUNS. Who, when, to what, and
   the plan text they actually saw, with a fingerprint over everything that was pinned.
   Recording first and slinging second is on purpose: an approval with no dispatch is a
   puzzle, a dispatch with no approval is hq-9q2 — a decision that exists only in
   somebody's memory. If the sling then fails, that is recorded too, so the trail never
   claims something ran when it did not.

   IT IS A COMMENT, NOT A FIELD, and that is guard 2's doing rather than a filing
   preference. `notes` is one of the fields the approval pins — so an approval written
   into `notes` would move the very thing it had just promised had not moved, and the
   next approval on that bead would be refused by the audit trail of the last one. A
   guard that its own record breaks is not a guard. `bd comment` is append-only,
   timestamped and attributed by `bd` itself, and it touches nothing the operator or an
   agent is writing a plan in.

   The record is honest about what it can and cannot know. This console has no
   per-operator authentication, so it names the machine, the loopback address and the OS
   user the server runs as — not a person — and says so in the text rather than letting
   a reader assume otherwise.

4. ONE AT A TIME, AND CONFIRM ON REPEAT. Every sling spawns a FRESH polecat rather than
   reusing an idle one (hq-m2p), so a double-click is two polecats and two worktrees.
   `_GATE` allows one dispatch in the whole console at a time; a bead that already
   carries an approval, or that is already on somebody's hook, needs an explicit second
   press that says so out loud.

PERMANENTLY OUT OF SCOPE, and not by omission: auto-approve, batch approve, approve on a
timer, or any dispatch triggered by a condition rather than by a human pressing a button
for one bead. This town spent 2026-08-07 cataloguing threshold-triggered destructive
actions — hq-y89, hq-97l, hq-g7g — and hq-ayx is the finding that ties them together. A
timer that slings would contradict it directly. If you are adding a caller to `apply()`
that is not a click, stop.

DEMO DISPATCHES NOTHING, EVER. The first line of `apply()` refuses, before any argument
is even looked at, so there is no path through this file that reaches a subprocess with
fixtures loaded.
"""

import getpass
import hashlib
import os
import platform
import shutil
import subprocess
import threading
import time

import backlog
import beads
import edit

# The line every approval comment starts with. It is also how a repeat is detected, so it
# has to stay stable: change it and every bead approved before the change reads as never
# approved, which is the one thing an audit trail may not do.
MARK = "APPROVED FOR DISPATCH"
# ...and the line that says one of those approvals never became a dispatch. Deliberately
# NOT starting with MARK: it is part of the record and it is read back with it, but it is
# not an approval and counting it as one would tell the next reader this bead had been
# approved twice when it was approved once and nothing ran.
FAIL_MARK = "DISPATCH FAILED AFTER APPROVAL"
# What the approval covers, under the console's own names for the fields. The seven
# edit.py writes plus the two it does not: an agent claiming a bead moves `status` and
# `assignee`, and a plan approved for an idle bead is not an approval to sling one that
# somebody has already picked up.
PINNED = (*edit.FIELDS, "status", "assignee")
# A status a dispatch will not start from at all. A closed bead has an answer already;
# slinging one puts an agent on finished work and there is no reading of the button that
# means that. Reopening is `bd`'s job, not a console button's.
REFUSED = {"closed"}
# ...and the two that mean somebody is already on it. Not refused — an operator may well
# be re-slinging deliberately — but never without saying so first.
BUSY = {"hooked", "in_progress"}
# How much of the plan text goes into the record verbatim. The fingerprint covers all of
# it whatever this is; this is the point past which copying the whole plan into the notes
# of the bead that already holds it stops being an audit trail and starts being a second
# copy of the same paragraphs. Real plans are far under it.
RECORD_MAX = 4000
# `gt sling` spawns a polecat, boots a rig and takes a Dolt commit or two. Long, because
# the failure mode of a short timeout is the worst answer this endpoint can give: "it
# failed" about a dispatch that actually ran. On a timeout it says exactly that instead.
SLING_TIMEOUT = 180

PATH = "/opt/homebrew/bin:/usr/local/bin:" + os.environ.get("PATH", "")
# One dispatch in the whole console at a time — see guard 4. Not per bead: two beads
# slung in the same second still spawn two polecats into the same rig boot, and the
# operator who pressed twice is owed a refusal either way.
_GATE = threading.Lock()


def apply(body, repos, panel, status, town, demo, client):
    """One approval and the dispatch it authorises, as (payload, http status) — the shape
    every WRITE_ACTIONS entry returns. On success the payload is edit.py's, so the board
    patches itself with the bead's new state exactly the way a save does."""
    if demo:
        # First line, before anything is even read off the request: --demo must have no
        # path to a subprocess at all, not merely no path that validates.
        return _no("demo mode — the console never dispatches, and this is the fixture "
                   "of a console that would", 400)

    rig = str(body.get("rig") or "").strip()
    block = next((r for r in ((panel or {}).get("rigs") or []) if r.get("rig") == rig), None)
    if block is None:
        return _no(f"{rig or '(none)'} is not a rig the console has read a backlog for", 400)
    repo = dict(repos).get(rig)
    if repo is None:
        return _no(f"no beads repo for {rig} — the console will not guess at one", 400)
    ident = str(body.get("id") or "").strip()
    if not edit.carried(block, ident):
        return _no(f"{ident or '(none)'} is not one of the beads this rig's backlog "
                   "carried — reload the board and try again", 404)
    target = str(body.get("target") or "").strip()
    if not any(target == value for value, _label in targets(status, rig)):
        return _no(f"{target or '(none)'} is not somewhere this console will sling "
                   f"a {rig} bead — pick one of the agents it has read", 400)
    base = body.get("base")
    if not isinstance(base, dict):
        return _no("the request did not say what plan the console showed — refusing to "
                   "dispatch against a plan nobody read", 400)
    blind = sorted(n for n in PINNED if n not in base)
    if blind:
        return _no(f"the request did not say what the console had for {', '.join(blind)}"
                   " — refusing to dispatch against a plan it cannot pin", 400)

    # Guard 4, the half that has to hold across requests. Taken before the re-read so
    # that two clicks cannot both pass the freshness check and then both sling.
    if not _GATE.acquire(blocking=False):
        return _no("another dispatch is already in flight — wait for it to answer. "
                   "Every sling spawns a fresh polecat, so two are two agents", 409)
    try:
        return _dispatch(body, rig, ident, repo, target, base, town, client)
    finally:
        _GATE.release()


def _dispatch(body, rig, ident, repo, target, base, town, client):
    """The part that runs under the gate: pin, refuse or record, then sling."""
    row, err = beads.show(repo, ident)
    if err:
        return _no(f"could not re-read {ident} before dispatching it: {err} — nothing "
                   "was approved and nothing was slung", 502)
    now = seen(row)

    # Guard 2. Every pinned field, compared against what the console actually showed.
    clashes = [{"field": n, "was": edit.norm(base.get(n), n), "now": now[n]}
               for n in PINNED if edit.norm(base.get(n), n) != now[n]]
    if clashes:
        # `now` is every pinned field as the store has it this instant, which is fresher
        # than anything the console could fetch — the panel behind the pane is on a
        # three-minute cadence. So the refusal carries the new plan with it and the
        # operator reads it here, rather than being sent to wait for a read.
        return ({"ok": False, "conflict": True, "rig": rig, "id": ident, "now": now,
                 "clipped": clipped(row), "conflicts": clashes,
                 "error": f"{ident} changed since the console drew it — "
                          f"{', '.join(c['field'] for c in clashes)} "
                          f"{'were' if len(clashes) > 1 else 'was'} rewritten. Nothing "
                          "was approved and nothing was dispatched: read what it says "
                          "now, then approve that."}, 409)

    state = now["status"]
    if state in REFUSED:
        return _no(f"{ident} is closed. Dispatching it would put an agent on finished "
                   f"work — reopen it with `bd update {ident}` if that is really what "
                   "this is", 400)
    # Guard 4, the half about repeats: every approval this console has already given for
    # this bead. A second `bd` call, because `bd show` carries only a count of comments —
    # worth it on a write path, and a failure here is a refusal rather than a guess. "I
    # could not find out whether you have approved this before" is not a reason to spawn
    # an agent.
    said, err = beads.comments(repo, ident)
    if err:
        return _no(f"could not read {ident}'s approval history ({err}), so the console "
                   "cannot tell whether this has been dispatched before — nothing was "
                   "approved and nothing was slung", 502)
    mine = [str(c.get("text") or "").lstrip() for c in said
            if isinstance(c, dict)
            and str(c.get("text") or "").lstrip().startswith((MARK, FAIL_MARK))]
    prior = [t for t in mine if t.startswith(MARK)]
    # Each objection carries a stable key as well as its sentence, so that confirming is
    # confirming THESE things. A bare "yes" would wave through an objection that appeared
    # between the two presses — which is exactly the shape of thing a confirmation is
    # supposed to stop.
    reasons = []
    # The whole feature is "a human read the actual plan text before agents ran". A bead
    # with neither a plan nor acceptance criteria has no plan text to have read, so the
    # gate would be ceremony over nothing — say that, and make it a deliberate press.
    if not now["design"] and not now["acceptance"]:
        reasons.append(("no-plan",
                        f"{ident} has no proposed plan and no acceptance criteria written "
                        "on it, so there is nothing for this approval to be an approval of"))
    if prior:
        # The count is of approvals; the quote is of the latest entry either way, so a
        # dispatch that was approved and then failed says so rather than reading as one
        # that is running.
        reasons.append(("repeat",
                        f"{ident} has already been approved {len(prior)} time"
                        f"{'' if len(prior) == 1 else 's'} from this console — the latest "
                        f"entry in its dispatch record says: "
                        f"{mine[-1].splitlines()[0].strip()}"))
    if state in BUSY:
        who = now["assignee"] or "an agent"
        reasons.append(("busy",
                        f"{ident} is already {state.replace('_', ' ')} and {who} has it"))
    # A list, not a flag: anything not in it has not been shown to anybody. All the
    # outstanding ones are reported together, because "it is on a hook AND you have
    # approved it twice already" is a different sentence from either half of itself.
    acked = body.get("confirm")
    acked = set(acked) if isinstance(acked, list) else set()
    unmet = [(key, text) for key, text in reasons if key not in acked]
    if unmet:
        return ({"ok": False, "confirm": True, "rig": rig, "id": ident,
                 "reasons": [{"key": key, "text": text} for key, text in unmet],
                 "error": " · ".join(t for _k, t in unmet) + ". Every sling spawns a "
                          "FRESH polecat rather than reusing an idle one, so dispatching "
                          "again is a second agent and a second worktree. Press again to "
                          "do it anyway."}, 409)

    # Guard 3, and it happens before the sling on purpose — see the note at the top.
    record = _record(now, target, client, len(prior) + 1, clipped(row))
    _, err = beads.write(repo, ["comment", ident, record])
    if err:
        return _no(f"the approval could not be recorded on {ident} ({err}), so nothing "
                   "was dispatched — this console will not start an agent it cannot "
                   "leave a record of", 502)

    out, err = _gt(town, ["sling", ident, target, "-m", _brief(ident, target)])
    if err:
        # There is now a comment on the bead saying this was approved. Left alone it
        # would read as a dispatch that happened, so the failure goes on the record too
        # rather than only to whoever happens to be looking at the screen right now.
        _, back = beads.write(repo, ["comment", ident,
                                     f"{FAIL_MARK} — the sling that followed the approval "
                                     f"above did not run and nothing was started: {err}"])
        also = "" if not back else (" (and the console could not record that failure on "
                                    f"the bead either: {back})")
        return _no(f"the approval is recorded on {ident}, but `gt sling` refused it: "
                   f"{err}. Nothing is running{also}", 502)

    fresh, err = beads.show(repo, ident)
    if err:
        return _no(f"{ident} was dispatched to {target}, but the console could not read "
                   f"the bead back afterwards: {err} — refresh the board", 502)
    return edit.done(rig, ident, fresh, edit.values(fresh),
                     f"approved and dispatched {ident} to {target}"
                     + (f" — {out.splitlines()[0].strip()}" if out else ""))


# ---------------------------------------------------------------- what may be dispatched

def targets(status, rig):
    """[(value, label)] — every place this console will sling a bead belonging to `rig`.

    Bounded by the status read for the same reason every other write here is bounded by
    the backlog read: an address the console has not been told about is one it has no
    business handing an autonomous agent to. The rig itself is first and is the ordinary
    answer — `gt sling <bead> <rig>` spawns a fresh polecat, which is what dispatching a
    plan usually means. Everything else is an agent that already exists, labelled with
    what it is and whether it is holding something, so "send this to the witness" is not
    a guess about which of two witnesses.

    The front end draws the same list from the same panel, and this is the one that
    decides: a picker that offered something this refuses is a visible error, which is
    the harmless direction for the two to disagree in."""
    status = status if isinstance(status, dict) else {}
    out = []
    for block in status.get("rigs") or []:
        if not isinstance(block, dict) or block.get("name") != rig:
            continue
        out.append((rig, f"a fresh polecat in {rig}"))
        out += [(a["address"], _agent_label(a)) for a in block.get("agents") or []
                if isinstance(a, dict) and str(a.get("address") or "").strip()]
    # The town's own agents can take a rig's bead, and a bead in the town's own database
    # (labelled "town", which is not a rig and has no polecats) has nowhere else to go.
    out += [(a["address"], _agent_label(a)) for a in status.get("agents") or []
            if isinstance(a, dict) and str(a.get("address") or "").strip()]
    seen_, uniq = set(), []
    for value, label in out:
        if value not in seen_:
            seen_.add(value)
            uniq.append((value, label))
    return uniq


def _agent_label(a):
    role = str(a.get("role") or "agent").strip()
    if not a.get("running"):
        return f"{role} — not running"
    return f"{role} — {'holding work already' if a.get('has_work') else 'idle'}"


# ---------------------------------------------------------------- the pinned plan

def seen(row):
    """One bead's pinned fields, as the console would have SHOWN them.

    Not as `bd` stores them: the panel titles an untitled bead "(untitled)" and lower-
    cases its status, and the pane clips the long fields at PROSE_MAX. Comparing the raw
    store value against what the operator read would report a conflict on every bead
    with a 20,000-character description and on nothing else — a check that cries wolf is
    a check people learn to click through. So this mirrors backlog._project and
    backlog._prose exactly, and if either of those changes what it shows, this changes
    with it."""
    out = dict(edit.values(row))
    for name, _field in backlog.PROSE:
        if name in out and len(out[name]) > backlog.PROSE_MAX:
            out[name] = out[name][:backlog.PROSE_MAX] + "…"
    out["title"] = out["title"] or "(untitled)"
    out["status"] = edit.norm(row.get("status")).lower()
    out["assignee"] = edit.norm(row.get("assignee"))
    return {n: out[n] for n in PINNED}


def clipped(row):
    """The long fields the console could only show part of, if any. Almost always empty
    — PROSE_MAX is 20,000 characters. It exists so the record cannot overstate itself: an
    approval that says "the plan as it was shown" while the plan ran past what a response
    carries has to say which part, or it is claiming somebody read something they did
    not. The front end says the same thing above the button, off the same field names."""
    return [name for name, field in backlog.PROSE
            if name in edit.FIELDS
            and len(edit.norm(row.get(field))) > backlog.PROSE_MAX]


def _fingerprint(now):
    """A sha256 over every pinned field, so the record can say what was approved even
    when the plan itself is too long to copy into it whole. Field names are in the digest
    as well as values: without them, moving a paragraph from `notes` to `design` would
    leave the fingerprint unchanged."""
    # Escaped rather than typed, and a NUL rather than a newline: every value here
    # may contain newlines, so a printable separator could be forged from inside
    # a field and two different plans made to fingerprint alike.
    body = "\x00".join(f"{name}\x00{now[name]}" for name in PINNED)
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def _record(now, target, client, nth, short):
    """The approval, as it goes onto the bead. Written to be read by somebody a month
    from now asking "why did this run" — so it says what was approved, what it was
    fingerprinted as, where the button was pressed, and plainly what the console does
    not know about who pressed it."""
    plan = ("--- the proposed plan, as the console showed it ---\n"
            f"{now['design'] or '(no plan was written on this bead)'}\n\n"
            "--- the acceptance criteria ---\n"
            f"{now['acceptance'] or '(none were written)'}")
    if len(plan) > RECORD_MAX:
        plan = (plan[:RECORD_MAX].rstrip()
                + f"\n… [{len(plan) - RECORD_MAX} more characters not copied here — the "
                  "fingerprint above is over all of it]")
    return "\n".join([
        f"{MARK} — {_now()} (approval #{nth} on this bead)",
        f"Target: {target}. Approved through the Gas Town console, from {client}, "
        f"running as {_whoami()}.",
        "The console has no per-operator authentication: that names the machine and the "
        "session that pressed the button, not a person.",
        f"Plan fingerprint sha256:{_fingerprint(now)} over {', '.join(PINNED)} exactly "
        "as they were on screen.",
        *([f"NOTE: {', '.join(short)} ran past the {backlog.PROSE_MAX} characters the "
           "console can carry, so what was read, fingerprinted and copied below is the "
           "first part of it and not the whole field."] if short else []),
        plan,
        "--- end of the approved plan ---",
    ])


def _brief(ident, target):
    """What `gt sling -m` carries. Not the plan — the agent reads the bead for that, and
    a second copy in the message is a second thing to drift. It says only where this came
    from, which is what tells the agent (and anyone reading its hook) that a human signed
    this off rather than a scheduler."""
    return (f"A human read the plan on {ident} in the Gas Town console and approved it "
            f"for dispatch to {target} at {_now()}. The approval, the fingerprint of "
            "exactly what was approved, and the plan text as it was read are all in "
            f"that bead's notes. If the bead now says something different from what you "
            "were sent to do, trust the bead and say so.")


# ---------------------------------------------------------------- running gt

def _gt(town, args, timeout=SLING_TIMEOUT):
    """One `gt` call, as (stdout, error). Its own invocation rather than server.run_gt's
    because `gt sling` answers in prose, not JSON, and because a write wants its failure
    text rather than "unparseable output" — the same reason beads.py owns its own.

    Only a POST may come here: this blocks for as long as spawning a polecat takes. See
    CLAUDE.md — the rule is about the read path, and this is the other shape."""
    exe = shutil.which("gt", path=PATH) or "gt"
    env = dict(os.environ, PATH=PATH)
    try:
        p = subprocess.run([exe, *args], capture_output=True, text=True,
                           timeout=timeout, cwd=town, env=env)
    except subprocess.TimeoutExpired:
        # The one failure this module cannot describe honestly as "nothing happened",
        # so it does not: a sling that is still running may well have spawned already.
        return None, (f"`gt {args[0]}` did not answer within {timeout}s. It may or may "
                      "not have spawned an agent — check `gt status` before pressing "
                      "this again")
    except FileNotFoundError:
        return None, "gt not found on PATH"
    except OSError as e:
        return None, str(e)
    if p.returncode:
        return None, _why(p)
    return (p.stdout or "").strip(), None


def _why(p):
    """The first line of a gt failure that says something. `gt` appends its whole usage
    block to a refusal, so take the reason and leave the manual."""
    for stream in (p.stderr, p.stdout):
        for line in (stream or "").splitlines():
            line = line.strip()
            if line and not line.startswith(("Usage:", "Flags:", "warning:")):
                return line.removeprefix("Error: ")
    return f"gt exited {p.returncode}"


def _whoami():
    try:
        return f"{getpass.getuser()}@{platform.node() or 'this machine'}"
    except Exception:                                    # noqa: BLE001 - never fatal
        return "an unknown OS user"


def _now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _no(reason, code):
    return {"ok": False, "error": reason}, code
