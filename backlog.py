"""The "backlog" read: the planned shape of every rig's work, for running a ceremony
against it rather than reading a list.

The console's other two bead reads are both about *now*. `gt ready` is unblocked and
open by definition, so a bead leaves it the moment somebody picks it up; flight.py is
not-open-and-not-closed, which is the other half of the same instant. Neither can
answer what a standup, a planning session or a retro actually asks, because every one
of those questions is about structure: what are the epics and what sits under each,
what is blocked and *by what*, what closed and *why*. All of it is invisible in a list
of ready work by construction, not by omission.

So this read takes the whole thing — `bd list --all`, once per beads repo — and keeps
the structure rather than flattening it: the parent-child edges that make the
hierarchy, the `blocks` edges that make the dependency chains (17 of them on
zombie_prototype, drawn nowhere before this), and close_reason, which is the "why" for
every completed item and was fetched nowhere at all.

WHY THIS IS A CALLABLE IN `READS` AND NOT A SECOND TABLE. A bead read has to run with
a rig's own directory as cwd (see beads.py) and `READS` is shaped as name -> (gt argv,
interval), which cannot say that. It does not need to: `READS` has taken a callable
source since models.py, and flight.py is already exactly this shape — a callable that
fans out over the town's beads repos and returns (data, error). A parallel table would
be a second place to look for "where does a read come from", and the single answer to
that question is the whole point of `READS`.

It is the slowest entry in that table on purpose. A backlog is a plan: plans do not
change every eight seconds, `bd list --all` over a few hundred beads is the heaviest
call the console makes, and the payload is the largest of any panel even after the
trimming below.

SIZE. `bd` hands back whole beads — description, notes, acceptance criteria, design —
which is 287KB for zombie_prototype's 124 alone, and this panel rides every snapshot.
_project() keeps the fields the front end draws, and keeps prose only where prose is
the answer: an epic's description (the argument for the epic) and close_reason (the
argument for closing), both clipped. A leaf task's description is what `bd show` is
for. That is 58KB for the same 124 beads.
"""

import collections

import beads

# Scaffolding, not work, and the same three flight.py drops: a convoy has its own
# renderer, a molecule is the workflow wrapper around a bead rather than the bead, and
# a rig bead is the rig itself. They stay out of the lists and out of the distribution
# bars — but they are counted, so the totals still add up to what the database holds.
SKIP_TYPES = {"convoy", "molecule", "rig"}
KEEP = ("id", "title", "status", "priority", "issue_type", "assignee", "parent",
        "created_at", "updated_at", "closed_at", "close_reason")
# Agent-authored prose runs to paragraphs. Long enough to carry the argument, short
# enough that a few hundred of them are not the snapshot.
CLIP = 400
# Per rig. A backlog this size is already more than a ceremony can walk; the caps are
# reported in the payload rather than applied quietly. MAX_CLOSED is the *history* cap
# — closed work that hangs under a live parent is the plan rather than history, and is
# carried under the far looser MAX_TREE instead, because half an epic is not an epic.
MAX_OPEN = 300
MAX_CLOSED = 60
MAX_TREE = 400


def _clip(text):
    """(text, was_clipped). Newlines survive — the front end pre-wraps these."""
    t = str(text or "").strip()
    return (t, False) if len(t) <= CLIP else (t[:CLIP].rstrip() + "…", True)


def _blockers(bead):
    """The beads this one is waiting on. `bd dep add <blocked> <blocker>` stores the
    edge on the blocked bead, so depends_on_id here is the thing in the way."""
    return [d.get("depends_on_id") for d in (bead.get("dependencies") or [])
            if isinstance(d, dict) and d.get("type") == "blocks" and d.get("depends_on_id")]


def _project(bead, with_desc, kids=None):
    """One bead, trimmed to what the front end draws. Empty fields are dropped rather
    than sent as null — at a few hundred beads on every snapshot, the nulls are real."""
    out = {k: bead.get(k) for k in KEEP}
    # Counted over the whole backlog, before any cap, and sent rather than left to be
    # re-counted from the beads that happen to have been carried. An epic's child count
    # is the number a planning session reads off the row; a cap that quietly turned 19
    # into 15 would be the panel lying in the one place it is being trusted.
    if kids:
        out["kids"], out["kids_closed"] = kids
    out["title"] = str(out["title"] or "(untitled)")
    out["assignee"] = str(out["assignee"] or "").strip()
    out["status"] = str(out["status"] or "").strip().lower()
    out["issue_type"] = str(out["issue_type"] or "").strip()
    # Drawn as a P-badge, so anything that is not a number is no badge at all rather
    # than a "Pnull".
    if not isinstance(out["priority"], int) or isinstance(out["priority"], bool):
        out["priority"] = None
    out["close_reason"], clipped = _clip(out["close_reason"])
    blocked_by = _blockers(bead)
    if blocked_by:
        out["blocked_by"] = blocked_by
    if with_desc:
        out["desc"], more = _clip(bead.get("description"))
        clipped = clipped or more
    if clipped:
        out["more"] = True
    return {k: v for k, v in out.items() if v not in (None, "", [])}


def _rig(label, repo):
    """One rig's backlog, as (block, error)."""
    rows, err = beads.run_bd(repo, ["list", "--all", "--limit", "0"], timeout=30)
    if err:
        return None, f"{label}: {err}"
    if not rows:
        # The failure beads.py exists to prevent, caught where it would otherwise be
        # drawn as a rig that has planned nothing. Suspicion, not a silent zero.
        return None, (f"{label}: bd returned no beads at all — is this rig's database "
                      "being served?")
    work = [b for b in rows if isinstance(b, dict) and b.get("id")
            and b.get("issue_type") not in SKIP_TYPES]
    index = {b["id"]: b for b in work}

    live, closed = [], []
    for b in work:
        (closed if b.get("status") == "closed" else live).append(b)
    # Sorted here as well as in the front end so the caps drop the stalest work rather
    # than whatever arrived last (gc-feh).
    live.sort(key=lambda b: str(b.get("updated_at") or b.get("created_at") or ""),
              reverse=True)
    closed.sort(key=lambda b: str(b.get("closed_at") or b.get("updated_at") or ""),
                reverse=True)

    # A closed bead hanging under a parent that has not closed is not history — it is
    # the finished part of a plan somebody is about to walk through, and dropping it
    # under the history cap turns a 19-child epic into a 15-child one. Split it out and
    # let it in under its own far looser budget.
    def _lives_under_a_plan(b):
        parent = index.get(b.get("parent") or "")
        return bool(parent) and parent.get("status") != "closed"

    tree = [b for b in closed if _lives_under_a_plan(b)]
    history = [b for b in closed if not _lives_under_a_plan(b)]
    keep = ({b["id"] for b in live[:MAX_OPEN]} | {b["id"] for b in tree[:MAX_TREE]}
            | {b["id"] for b in history[:MAX_CLOSED]})
    # A cap that dropped a parent would orphan its children out of the tree, and one
    # that dropped a blocker would leave a row saying "blocked by" and an id nobody can
    # resolve. So anything the kept set points at comes back, parents transitively up
    # to the root — a handful of beads, and the difference between a hierarchy and a
    # list with holes in it.
    pending = list(keep)
    while pending:
        b = index.get(pending.pop())
        for ref in ([b.get("parent"), *_blockers(b)] if b else []):
            if ref in index and ref not in keep:
                keep.add(ref)
                pending.append(ref)

    # An epic's description is the argument for the epic, which is exactly what a
    # planning session is reading. A leaf task's is what `bd show` is for.
    kids = collections.Counter(b["parent"] for b in work if b.get("parent"))
    kids_closed = collections.Counter(b["parent"] for b in work
                                      if b.get("parent") and b.get("status") == "closed")
    return {
        "rig": label,
        # Everything the database holds, scaffolding included, so the panel can show
        # that it read the whole thing and still say what it chose not to draw.
        "total": len(rows),
        "work": len(work),
        "status": dict(collections.Counter(str(b.get("status") or "?") for b in work)),
        "type": dict(collections.Counter(str(b.get("issue_type") or "?") for b in work)),
        "open_total": len(live),
        "closed_total": len(closed),
        "beads": [_project(b, b["id"] in kids,
                           (kids[b["id"]], kids_closed[b["id"]]) if kids[b["id"]] else None)
                  for b in live + closed if b["id"] in keep],
    }, None


def by_rig(status, town):
    """Every rig's backlog, as (data, error) — the shape a `READS` source returns. A
    rig whose beads repo cannot be read costs that rig, not the panel."""
    out, failed = [], []
    for label, repo in beads.repos(status, town):
        block, err = _rig(label, repo)
        if err:
            failed.append(err)
        else:
            out.append(block)
    if failed and not out:
        return None, "; ".join(failed[:3])
    return {"rigs": out}, ("; ".join(failed[:3]) if failed else None)
