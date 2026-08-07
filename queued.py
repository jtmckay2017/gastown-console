"""The "queue" read: what the scheduler is holding, what each item is blocked behind,
and — in words — why none of it is dispatching.

WHY THIS PANEL EXISTS. `gt config set scheduler.max_polecats N` turns dispatch from
"sling it now" into "queue it, and dispatch when a slot frees". That is what lets a
chain of beads run to completion with no human kick, and it is also what makes a
stalled town look exactly like a finished one. The console's other work reads answer
"what is running" (flight.py) and "what could be started" (`gt ready`). Neither can
answer the third question, because a scheduled bead is in neither list: it is not open
and unblocked to `gt ready`'s eyes if it is blocked, and nobody has picked it up, so
flight.py cannot see it either. The operator is left reading a blank Work tab, which
is the same picture a finished town draws.

Two live failures from the day this was filed (gc-cdt), both of which read as "fine":

  1. A polecat finished, the next bead was never slung, and the console truthfully
     showed nothing in flight. The operator read it as a broken console.
  2. Capacity showed six polecats in recovery — phantoms, all healthy, all counted as
     blocked. With a cap of one that is a deadlock: the queue sits scheduled forever,
     every status line reads fine, and nothing moves.

So the panel's job is not to list beads. It is to state a verdict, and to show the
arithmetic behind it.

WHERE THE NUMBERS COME FROM. One call: `gt scheduler status --json`, which carries the
scheduled beads, the capacity breakdown and the paused flag together. `gt scheduler
list --json` returns the same bead array with none of the rest, so it is not called.

WHY THE SENTENCE IS DERIVED HERE AND NOT ASKED FOR. `gt scheduler run --dry-run`
prints the exact sentence a human wants — and `gt scheduler run` is the command that
dispatches. A read path does not get to call the dispatcher and rely on a flag to stop
it: this console's whole security posture is that reads cannot act (see CLAUDE.md), and
"we passed --dry-run" is an argument, not a guarantee. Every input to that sentence is
already in the status payload, so _verdict() reconstructs it from the numbers. If the
wording drifts from gt's, gt's is not the authority here — the numbers are, and they
are shown beside the sentence so the operator can check it.

WHY THE FILE IS CALLED THIS. The panel is "queue" and this file is not queue.py,
because `queue` is a stdlib module and this directory is sys.path[0] for server.py — a
queue.py here would shadow it for the whole process, and ThreadPoolExecutor imports
`queue`. It is not dispatch.py either: that is the *write* path, the one that approves a
plan and slings an agent at it. The two are worth keeping apart in the filename as well
as in the head, because this one is the read that can only ever say why nothing is
dispatching, and that one is the only thing here that can make something dispatch. Do
not "fix" either name.

BLOCKED ITEMS NAME THEIR BLOCKER, and that costs nothing extra. `gt scheduler status`
says `blocked: true` and stops there, but the `backlog` read has already fetched every
rig's `blocks` edges and the titles on both ends of them (see backlog.py). So this read
joins against that panel's last answer, exactly the way models.py, panes.py, flight.py
and backlog.py all join against the `status` panel's. A blocker is named as id, title
and current status — including a *closed* one, because a scheduler still holding a bead
behind a blocker that has already closed is itself the diagnosis.

That join is best-effort by design. The backlog is the slowest read in the table (180s)
and this one is 20s, so it must not wait: an unnamed blocker still says "blocked", and
_blocked_note() says which of the four reasons the name is missing for. Making the
queue view wait on the backlog would reproduce the blank screen it exists to fix.

Everything here is a projection of two payloads. No subprocess but the one gt call, no
`bd`, no filesystem — and, like every other entry in `READS`, it runs on the scheduler
and never on a request path.
"""

# Everything the console draws from `gt scheduler status --json`'s capacity block, in
# reading order: the two numbers that decide whether anything can dispatch, then the
# breakdown that says where the slots went. The breakdown is the diagnostic — "0 free
# of 1" is the symptom, "recovery: 6" is the cause.
CAPACITY = ("max", "free", "working", "recovery_blocked", "reservations",
            "reusable_idle", "pending_mr")
# What a queue item carries from the scheduler itself. Anything else on the row is
# joined in from the backlog panel below.
KEEP = ("id", "title", "status")
# A queue longer than this is not one this panel can usefully draw. The totals are
# reported from gt's own counts rather than from the carried items, so a cap can never
# make the queue look shorter than it is.
MAX_ITEMS = 100
# A bead with no priority sorts after every bead that has one, rather than as a P0.
NO_PRIO = 99


def _int(v, dflt=0):
    """gt spells these as JSON numbers today; a string or a null must not become a
    TypeError three lines into a verdict."""
    if isinstance(v, bool):
        return dflt
    if isinstance(v, int):
        return v
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return dflt


def _index(backlog):
    """rig label -> {bead id -> bead}, out of the `backlog` panel's last answer. Empty
    when that read has not landed, which is a state this module handles rather than
    waits for."""
    out = {}
    for block in ((backlog or {}).get("rigs") or []):
        if isinstance(block, dict) and block.get("rig"):
            out[block["rig"]] = {b["id"]: b for b in (block.get("beads") or [])
                                 if isinstance(b, dict) and b.get("id")}
    return out


def _blockers(bead, rig_beads):
    """The beads this one is waiting on, named. backlog.py already resolved the `blocks`
    edges into `blocked_by`; this puts a title and a status on each id, so the row can
    say "blocked on gc-ebv — Planning loop… (hooked)" rather than showing a pause glyph.

    A blocker the backlog did not carry is still listed, by id alone. The id is the
    thing the operator types into `bd show`, and dropping the row because the title is
    missing would turn a named blocker back into an anonymous one."""
    out = []
    for ident in (bead.get("blocked_by") or []):
        other = rig_beads.get(ident)
        row = {"id": ident}
        if other:
            row["title"] = str(other.get("title") or "")
            row["status"] = str(other.get("status") or "")
        out.append(row)
    return out


def _blocked_note(rig, ident, index, bead):
    """Why a blocked item's blocker could not be named. Four different things go wrong
    here and they want four different sentences, because three of them are the console
    catching up and the fourth is a real disagreement with the scheduler."""
    if not index:
        return "the backlog read has not landed yet, so its blocker is not named"
    if rig not in index:
        return f"no backlog has been read for {rig}, so its blocker is not named"
    if bead is None:
        return f"{ident} is not in the backlog the console read for {rig}"
    return "the scheduler is holding it back, but records no blocks edge on it"


def _item(row, index):
    """One scheduled bead: what the scheduler holds, plus what the backlog knows about
    it. The scheduler's own fields win — `blocked` is the dispatcher's verdict on its
    own queue and nothing here is entitled to second-guess it."""
    out = {k: row.get(k) for k in KEEP}
    out["title"] = str(out["title"] or "(untitled)")
    out["status"] = str(out["status"] or "").strip().lower()
    # A scheduled bead with no target rig is the town's own — the label beads.py gives
    # the town repo, so the tab's rig filter reaches it like any other row.
    rig = str(row.get("target_rig") or "").strip() or "town"
    out["rig"] = rig
    out["blocked"] = bool(row.get("blocked"))

    bead = index.get(rig, {}).get(out["id"])
    if bead:
        # Only what the row draws. The backlog panel carries far more per bead and none
        # of the rest belongs in a second copy of it.
        for field in ("priority", "issue_type", "assignee", "created_at", "updated_at"):
            if bead.get(field) not in (None, ""):
                out[field] = bead[field]
        # Only for an item the scheduler is actually holding back. A bead can carry a
        # `blocks` edge to something that has already closed and be perfectly eligible;
        # drawing "waiting on" against a row the scheduler calls ready would be the
        # console contradicting the dispatcher about its own queue.
        if out["blocked"]:
            blockers = _blockers(bead, index.get(rig, {}))
            if blockers:
                out["blocked_by"] = blockers
    if out["blocked"] and not out.get("blocked_by"):
        out["blocked_note"] = _blocked_note(rig, out["id"], index, bead)
    return {k: v for k, v in out.items() if v not in (None, "", [])}


def _sorted(items):
    """Ready first, then blocked; oldest waiting first inside each group.

    NOT the scheduler's dispatch order, and this does not claim to be. gt promises no
    order in a JSON array and builds some of them from Go maps, so inheriting the array
    order would be inheriting a shuffle (the same reason every list in app.js asserts
    its own). What the operator needs from this list is which items *could* go and which
    cannot, so that is what it is grouped by — and the front end labels the groups in
    words rather than numbering the rows, because a number would be a promise about
    which one goes next that nothing here can keep."""
    return sorted(items, key=lambda b: (
        1 if b.get("blocked") else 0,
        _int(b.get("priority"), NO_PRIO),
        str(b.get("created_at") or ""),
        str(b.get("id") or ""),
    ))


def _by_rig(items):
    """The queue grouped by rig, town first then alphabetically — the order every other
    per-rig list in this console uses, so the same town reads the same way twice."""
    groups = {}
    for it in items:
        groups.setdefault(it["rig"], []).append(it)
    out = []
    for rig in sorted(groups, key=lambda n: ("0" if n == "town" else "1" + n)):
        rows = _sorted(groups[rig])
        blocked = sum(1 for b in rows if b.get("blocked"))
        out.append({"rig": rig, "items": rows, "queued": len(rows),
                    "blocked": blocked, "ready": len(rows) - blocked})
    return out


def _notes(cap, free):
    """Where the slots went, when the answer is not "agents are working".

    This is the hq-m2p failure made visible: six phantom polecats in recovery, all
    healthy, every one of them counted as a blocked slot. With a cap of one that is a
    permanent deadlock and nothing else on the page would have said so. The note is
    emitted whenever a slot is held by something that is not work, and it only draws the
    deadlock conclusion when there is genuinely nothing free — a recovery slot in a town
    with capacity to spare is a fact, not a problem."""
    notes = []
    recovery = _int(cap.get("recovery_blocked"))
    if recovery:
        note = (f"{recovery} slot{'' if recovery == 1 else 's'} held by polecats in "
                "recovery rather than by working agents")
        if free <= 0:
            note += (". If those sessions are actually healthy the capacity is phantom, "
                     "and the queue cannot move until they are cleared")
        notes.append(note + ".")
    if free <= 0:
        for field, label in (("pending_mr", "waiting in the merge queue"),
                             ("reservations", "reserved")):
            n = _int(cap.get(field))
            if n:
                notes.append(f"{n} slot{'' if n == 1 else 's'} {label}.")
    return notes


def _verdict(paused, cap, queued, ready, daemon_up):
    """(state, headline, reason) — the plain-language answer to "why is nothing
    dispatching", and the one thing on this panel an operator actually reads.

    The cases are ordered by what overrides what: a paused scheduler does not dispatch
    however much capacity it has, an empty queue has nothing to dispatch however free
    the town is, and a blocked queue has nothing *eligible* however many slots are open.
    Only past all three is capacity the answer.

    `state` is a key for the front end to style and to say out loud; `headline` is the
    two words that go in the badge; `reason` is the sentence."""
    free, cap_max = _int(cap.get("free")), _int(cap.get("max"))
    if paused:
        return ("paused", "Paused", (
            f"Dispatch is paused town-wide. {queued} scheduled bead"
            f"{'' if queued == 1 else 's'} will wait there until it is resumed."
            if queued else
            "Dispatch is paused town-wide. Nothing is scheduled in any case."))
    # A negative cap is how gt spells "deferred dispatch is off" — work is slung
    # straight to an agent and never queued. An empty queue then means the feature is
    # not in use, which is a different thing from an idle one and must not read as a
    # stall. A queue with items in it despite that is not this case, whatever the
    # config says, so it falls through to the real answers below.
    if cap_max < 0 and not queued:
        return ("direct", "Direct dispatch", (
            "Deferred dispatch is off (scheduler.max_polecats is negative), so work is "
            "slung straight to an agent and this queue stays empty by design."))
    if not queued:
        return ("empty", "Queue empty", (
            "Nothing is scheduled. This is an idle queue rather than a stalled one — "
            "there is no work waiting for a slot."))
    if not ready:
        return ("all-blocked", "Nothing can dispatch", (
            "The one scheduled bead is blocked on other work." if queued == 1 else
            f"All {queued} scheduled beads are blocked on other work."
        ) + " Nothing will dispatch until a blocker closes, whatever the capacity is.")
    if free <= 0:
        return ("no-capacity", "Not dispatching", (
            f"No capacity: {free} free of {cap_max} — {ready} ready bead"
            f"{'' if ready == 1 else 's'} waiting."))
    # Capacity and eligible work, and still nothing moving: dispatch is driven by the
    # daemon's heartbeat, so a stopped daemon is the whole answer. `gt status` carries
    # it and the topbar already draws it — but not next to this queue, which is where
    # the question is being asked.
    if not daemon_up:
        return ("no-daemon", "Not dispatching", (
            f"{ready} ready bead{'' if ready == 1 else 's'} and {free} free slot"
            f"{'' if free == 1 else 's'}, but the daemon is not running — nothing "
            "drives dispatch until it starts."))
    goes = "one of them" if min(ready, free) == 1 else f"{min(ready, free)} of them"
    return ("dispatching", "Dispatching", (
        f"{ready} ready bead{'' if ready == 1 else 's'} and {free} free slot"
        f"{'' if free == 1 else 's'} — the next scheduler heartbeat should sling "
        f"{goes}."))


def state(run_gt, status, backlog):
    """The whole panel, as (data, error) — the shape a `READS` source returns.

    `run_gt` is handed in rather than imported: server.py owns it, importing it back
    from here would be a cycle, and a second copy of its JSON-recovery would be a second
    thing to keep in step with gt's warning output. `status` and `backlog` are the last
    answers of two other panels, read from the cache by the caller — the same borrowing
    models.py, panes.py, flight.py and backlog.py all do from `status`."""
    raw, err = run_gt(["scheduler", "status", "--json"])
    if not isinstance(raw, dict):
        return None, err or "gt scheduler status returned no object"

    cap = {k: _int((raw.get("capacity") or {}).get(k)) for k in CAPACITY}
    index = _index(backlog)
    rows = [r for r in (raw.get("beads") or []) if isinstance(r, dict) and r.get("id")]
    # Sorted before the cap as well as inside each rig block, so a queue over MAX_ITEMS
    # loses the items furthest from dispatching rather than whichever ones gt listed
    # last — the same bargain flight.py and backlog.py make with theirs.
    items = _sorted([_item(r, index) for r in rows])[:MAX_ITEMS]

    # gt's own counts, not the carried items': MAX_ITEMS must be able to shorten the
    # list without shortening the truth, and the verdict is about the whole queue.
    queued = _int(raw.get("queued_total"), len(rows))
    ready = _int(raw.get("queued_ready"), sum(1 for r in rows if not r.get("blocked")))
    paused = bool(raw.get("paused"))
    daemon_up = bool(((status or {}).get("daemon") or {}).get("running", True))
    verdict, headline, reason = _verdict(paused, cap, queued, ready, daemon_up)
    return {
        "state": verdict,
        "headline": headline,
        "reason": reason,
        "notes": _notes(cap, cap["free"]),
        "paused": paused,
        "capacity": cap,
        "totals": {"queued": queued, "ready": ready, "blocked": max(0, queued - ready)},
        "last_dispatch_at": raw.get("last_dispatch_at") or "",
        # Whether the backlog join could run at all. The front end says so once, beside
        # the list, instead of repeating it on every blocked row.
        "named": bool(index),
        "rigs": _by_rig(items),
    }, err
