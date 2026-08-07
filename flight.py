"""The "flight" read: every bead in flight across the town, and who is holding it.

Two structural gaps meet here. `gt status --json` carries no work/issue/bead field on
an agent — verified against the live town, the key is simply absent — so nothing in
`gt` says what an agent is on. And `gt ready --json` is unblocked-and-open by
definition, so a bead is excluded from it the moment somebody picks it up. Between the
two the console could show what *could* be worked and who was awake, and never what
was being worked. This is the missing half: not-open, not-closed, which is exactly the
work in flight.

The statuses are not the ones you would guess. `gt sling` puts a bead on an agent's
hook as `hooked`, not `in_progress` — this town's in-flight work is almost entirely
`hooked`, and a read that asked for `in_progress` alone would report an empty town
with three agents mid-task. `blocked` is here because stalled work is the other half
of "what is happening": invisible in `gt ready` for the same structural reason, and
worth more attention rather than less.

It shells out to `bd` rather than `gt` because `gt` has no cross-status list, and once
per beads repo because every rig keeps its own — the town's, then one per rig, around
100ms each. Every one of those calls goes through beads.py, which is what makes the
per-rig directory impossible to forget; read its header before touching this. Like
models.py and panes.py it is declared in `READS` and runs only on the scheduler; it
has no business on a request path. `bd list --json` returns whole beads, description
and acceptance criteria included, which is kilobytes apiece — _project() keeps only
the fields the front end draws, so the snapshot stays small.
"""

import beads

# Not open, not closed. `hooked` leads because it is what a sling actually sets and is
# where nearly all of this town's live work sits.
STATUSES = "hooked,in_progress,blocked"
# Scaffolding, not work: a convoy has its own renderer, a molecule is the workflow
# wrapper around a bead rather than the bead, and a rig bead is the rig itself. `bd`
# already hides infra, gate and template beads without being asked.
SKIP_TYPES = {"convoy", "molecule", "rig"}
# Exactly what the front end draws. Everything else `bd` returns per bead — the
# description, the acceptance criteria, the dependency list — is kilobytes down the
# wire on every snapshot, for text nothing renders.
KEEP = ("id", "title", "status", "priority", "issue_type", "assignee",
        "parent", "created_at", "updated_at")
# A town with more work in flight than this is not one this panel can usefully draw.
MAX_ITEMS = 200


def _project(bead, rig):
    """One bead, trimmed to what the front end draws."""
    out = {k: bead.get(k) for k in KEEP}
    out["rig"] = rig
    out["title"] = str(out["title"] or "(untitled)")
    out["assignee"] = str(out["assignee"] or "").strip()
    out["status"] = str(out["status"] or "").strip()
    # Drawn as a P-badge, so anything that is not a number is no badge at all rather
    # than a "Pnull".
    if not isinstance(out["priority"], int) or isinstance(out["priority"], bool):
        out["priority"] = None
    return out


def in_flight(status, town):
    """Every in-flight bead in town, newest first, as (data, error) — the shape a
    `READS` source returns. A rig whose beads repo cannot be read costs that rig, not
    the panel: its failure is reported alongside whatever the others returned."""
    items, failed = [], []
    for label, repo in beads.repos(status, town):
        rows, err = beads.run_bd(repo, ["list", "--status", STATUSES, "--limit", "0"])
        if err:
            failed.append(f"{label}: {err}")
            continue
        for b in rows:
            if isinstance(b, dict) and b.get("issue_type") not in SKIP_TYPES:
                items.append(_project(b, label))
    if failed and not items:
        return None, "; ".join(failed[:3])
    # Sorted here as well as in the front end so the cap drops the stalest work rather
    # than whatever arrived last (gc-feh).
    items.sort(key=lambda b: str(b.get("updated_at") or b.get("created_at") or ""),
               reverse=True)
    return items[:MAX_ITEMS], ("; ".join(failed[:3]) if failed else None)
