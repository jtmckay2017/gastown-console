"""Writing beads — the console's second write, and the first one that changes a plan.

WHAT THIS IS FOR. The operator asked for a loop, not a form: they write a rough goal,
an agent drafts a plan onto a bead, they critique it, the agent revises. Most of that
loop already shipped. The board and the map draw the plan; `POST /api/mail` wakes the
agent that writes it. The one thing missing was the operator's own hand on the bead —
so this module is deliberately small, and everything it does is `bd create`, `bd update`
and `bd dep add` against the rig's own database.

WHAT IT DELIBERATELY CANNOT DO. There is no delete, and there is no status change: a
planning surface that can destroy a bead is a different risk class, and closing or
dispatching one is somebody signing off on work (gc-dzd) rather than editing a plan.
Nor is there an unlink — adding the wrong edge is currently fixed with `bd`, which is
worse than it should be and is filed rather than smuggled in here.

THE THREE RULES THE FEATURE IS BUILT ON, all of them lessons this town has already paid
for, and none of them optional:

1. OPTIMISTIC CONCURRENCY, PER FIELD. Agents rewrite these beads continuously. A
   last-write-wins Save would let the operator drop an agent's revision without either
   of them noticing, which is the divergent-copies failure (hq-m2p, hq-r1e) with a nicer
   button on it. So the request carries what the console *had* for each field it is
   writing, this module re-reads the bead from the store, and a field that moved
   underneath is a 409 naming the field, the old value and the new one — never a merge
   and never a silent overwrite. It is per field rather than per bead on purpose: an
   agent claiming a bead changes its status and its assignee every few minutes, and a
   whole-bead revision check would reject an edit to the description over a status the
   operator never touched, which trains people to click through the warning.

2. NOTHING FAILS QUIETLY. Every path here returns either ok:true with what landed, or
   ok:false with a reason a human can read. `bd` is asked again after every write and
   the answer, not the form, is what comes back — so "saved" means the store agrees.
   Eleven instruments misled this town on 2026-08-07 and every one of them failed by
   returning a plausible value instead of an error.

3. THE REPO IS NEVER OPTIONAL. Rig beads live in separate Dolt databases and `bd` from
   the wrong directory answers empty without failing (hq-rin), so every call goes
   through beads.py, which takes the repo first. A rig this module cannot resolve to a
   repo is refused rather than written to whatever database happened to be nearest.

WHY IT MAY SHELL OUT WHERE THE READS MAY NOT. CLAUDE.md's rule is that nothing slow runs
on the *read* path, because a panel is polled every eight seconds by every open tab and
`gt`/`bd` contend on one Dolt server. A write is the opposite shape: it happens when an
operator presses a button, it is one call, and it has to be synchronous — the whole
point of rule 2 is that they are told whether it landed, which a write queued onto the
scheduler could not do. It is still `bd`, so it is still slow: only a POST may come here.

DEMO. `--demo` writes to the fixtures in memory and never to a database — same
validation, same conflict shape, same payload, with the `bd` call skipped and the
cached panel patched instead (backlog.apply_write, which the live path also uses so the
board does not sit on a stale title while the next read runs). That is what lets
`python3 server.py --demo` show the whole loop with no town attached.
"""

import time

import backlog
import beads

# The console's name for a field -> the name `bd` stores it under. The prose half is
# taken from backlog.PROSE rather than restated: the pane already reads those fields
# under those names, and two spellings of one field is the failure this town keeps
# paying for. close_reason is dropped from it — bd writes that when a bead is closed,
# and closing a bead is not one of the console's writes.
FIELDS = {"title": "title", "priority": "priority", "type": "issue_type",
          **{name: field for name, field in backlog.PROSE if field != "close_reason"}}
# ...and the flag that writes each one. `bd create` and `bd update` take the same set.
FLAGS = {"title": "--title", "priority": "--priority", "issue_type": "--type",
         "description": "--description", "design": "--design",
         "acceptance_criteria": "--acceptance", "notes": "--notes"}
TYPES = ("task", "bug", "feature", "epic", "chore", "decision")
# The ceiling on one field. It is backlog.PROSE_MAX because that is what the pane can
# carry back: writing more than the operator could have been shown would be writing
# something nobody read.
MAX = backlog.PROSE_MAX
ACTIONS = ("new", "edit", "link")


def apply(action, body, repos, panel, demo):
    """One bead write, as (payload, http status) — the shape every WRITE_ACTIONS entry
    returns. The rig is checked twice on purpose: it has to be one the backlog read
    actually carried, which bounds this write to beads the console has drawn, and it has
    to resolve to a beads repo, which is the only thing that decides where `bd` runs."""
    rig = str(body.get("rig") or "").strip()
    block = next((r for r in ((panel or {}).get("rigs") or []) if r.get("rig") == rig), None)
    if block is None:
        return _no(f"{rig or '(none)'} is not a rig the console has read a backlog for", 400)
    repo = dict(repos).get(rig)
    if repo is None and not demo:
        return _no(f"no beads repo for {rig} — the console will not guess at one", 400)
    if action not in ACTIONS:
        return _no(f"{action} is not a write this console does", 404)
    return {"new": _new, "edit": _edit, "link": _link}[action](body, rig, repo, block, demo)


# ---------------------------------------------------------------- the three writes

def _new(body, rig, repo, block, demo):
    """Create one bead. No baseline to check — there is nothing yet to overwrite — but
    a parent, if one is named, has to be a bead this rig actually has."""
    want, err = _clean(body)
    if err:
        return _no(err, 400)
    if not want.get("title"):
        return _no("a new bead needs a title", 400)
    parent = str(body.get("parent") or "").strip()
    if parent and not _carried(block, parent):
        return _no(f"{parent} is not one of the beads this rig's backlog carried", 400)

    if demo:
        ident = _demo_id(block)
        row = {"id": ident, "status": "open", "created_at": _now(), "updated_at": _now(),
               "parent": parent, **{FIELDS[n]: v for n, v in want.items()}}
        row.setdefault("issue_type", "task")
        row.setdefault("priority", "2")
        return _done(rig, ident, row, _values(row), f"created {ident}")

    argv = ["create", "--title", want["title"],
            "--type", want.get("type") or "task", "--priority", want.get("priority") or "2"]
    for name, value in want.items():
        if name not in ("title", "type", "priority") and value:
            argv += [FLAGS[FIELDS[name]], value]
    if parent:
        argv += ["--parent", parent]
    made, err = beads.write(repo, argv)
    if err:
        return _no(f"bd would not create the bead: {err}", 502)
    ident = _new_id(made)
    if not ident:
        # It wrote something and the console cannot say what. That is not a success, and
        # the operator has to go and look rather than be told it worked.
        return _no("bd created a bead but did not say which — check `bd list` in " + rig, 502)
    return _reread(rig, ident, repo, f"created {ident}")


def _edit(body, rig, repo, block, demo):
    """Rewrite fields on one bead, if and only if nobody else has moved them since the
    console drew them. Everything before the write is that check."""
    ident = str(body.get("id") or "").strip()
    if not _carried(block, ident):
        return _no(f"{ident or '(none)'} is not one of the beads this rig's backlog "
                   "carried — reload the board and try again", 404)
    want, err = _clean(body)
    if err:
        return _no(err, 400)
    if not want:
        return _no("no fields to write", 400)
    if "title" in want and not want["title"]:
        return _no("a bead has to keep a title", 400)
    base = body.get("base")
    if not isinstance(base, dict):
        return _no("the request did not say what the console had — refusing to "
                   "overwrite a bead blind", 400)
    blind = sorted(n for n in want if n not in base)
    if blind:
        return _no("the request did not say what the console had for "
                   f"{', '.join(blind)} — refusing to overwrite a field blind", 400)

    now, row, err = _read(repo, rig, ident, demo, block)
    if err:
        return _no(f"could not re-read {ident} before writing it: {err}", 502)
    huge = sorted(n for n in want if len(now.get(n) or "") > MAX)
    if huge:
        return _no(f"{', '.join(huge)} is longer than the console can carry, so it only "
                   f"has part of it — edit that field with `bd update {ident}`", 409)
    clashes = [{"field": n, "was": _norm(base.get(n), n), "now": now[n]}
               for n in sorted(want) if _norm(base.get(n), n) != now[n]]
    if clashes:
        return ({"ok": False, "conflict": True, "rig": rig, "id": ident, "now": now,
                 "conflicts": clashes,
                 "error": f"{ident} changed under you — "
                          f"{', '.join(c['field'] for c in clashes)} "
                          f"{'were' if len(clashes) > 1 else 'was'} rewritten since the "
                          "console read it. Nothing was saved."}, 409)

    changed = {n: v for n, v in want.items() if v != now[n]}
    if not changed:
        return _done(rig, ident, row, now, "nothing to save — the bead already says that")
    if demo:
        row = {**row, **{FIELDS[n]: v for n, v in changed.items()}, "updated_at": _now()}
        return _done(rig, ident, row, _values(row), _saved(changed))
    argv = ["update", ident]
    for name, value in changed.items():
        argv += [FLAGS[FIELDS[name]], value]
    _, err = beads.write(repo, argv)
    if err:
        return _no(f"bd refused the edit: {err}", 502)
    return _reread(rig, ident, repo, _saved(changed))


def _link(body, rig, repo, block, demo):
    """Join two beads: one under the other, or one waiting on the other.

    A blocks edge is added, never replaced, so there is nothing for an optimistic check
    to protect — two agents adding the same edge agree. A parent is single-valued and a
    reparent therefore *is* an overwrite, so that one carries a baseline like any other
    field. Both ends must be beads this rig's backlog carried: a dependency on something
    the board cannot draw is a row saying "blocked by" and an id nobody can resolve."""
    ident = str(body.get("id") or "").strip()
    target = str(body.get("target") or "").strip()
    kind = str(body.get("kind") or "").strip()
    if kind not in ("parent", "blocks"):
        return _no(f"{kind or '(none)'} is not a link this console makes", 400)
    for who, what in (("bead", ident), ("other bead", target)):
        if not _carried(block, what):
            return _no(f"the {who} ({what or 'none'}) is not one of the beads this rig's "
                       "backlog carried", 400)
    if ident == target:
        return _no("a bead cannot be linked to itself", 400)

    now, row, err = _read(repo, rig, ident, demo, block)
    if err:
        return _no(f"could not re-read {ident} before linking it: {err}", 502)
    if kind == "parent":
        had = str(row.get("parent") or "").strip()
        base = str((body.get("base") or {}).get("parent") or "").strip()
        if had != base:
            return ({"ok": False, "conflict": True, "rig": rig, "id": ident, "now": now,
                     "conflicts": [{"field": "parent", "was": base, "now": had}],
                     "error": f"{ident} was moved under {had or 'no epic'} since the "
                              "console read it. Nothing was changed."}, 409)
        if had == target:
            return _done(rig, ident, row, now, f"{ident} is already under {target}")
        argv, detail = ["update", ident, "--parent", target], f"{ident} moved under {target}"
        extra = {"parent": target}
    else:
        # `bd dep add <blocked> <blocker>` — the edge is stored on the blocked bead, the
        # same direction backlog._blockers() reads it back out in.
        blocked_by = list(_carried(block, ident).get("blocked_by") or [])
        if target in blocked_by:
            return _done(rig, ident, row, now, f"{ident} already waits on {target}")
        argv = ["dep", "add", ident, target]
        detail = f"{ident} now waits on {target}"
        extra = {"blocked_by": sorted({*blocked_by, target})}

    if not demo:
        _, err = beads.write(repo, argv)
        if err:
            return _no(f"bd refused the link: {err}", 502)
        return _reread(rig, ident, repo, detail, extra)
    return _done(rig, ident, {**row, "updated_at": _now()}, now, detail, extra)


# ---------------------------------------------------------------- reading and shaping

def _read(repo, rig, ident, demo, block):
    """The bead as it stands right now, as (console-named values, whole row, error).

    Live, this is a fresh `bd show`: a freshness check run against a cache is not a
    freshness check, so it deliberately does not touch the cached panel. In demo there is
    no store to be fresh against — the fixture the board is drawing is the whole truth —
    so it is assembled from the panel and the pane's prose table, which between them
    hold every field this module writes."""
    if not demo:
        row, err = beads.show(repo, ident)
        return (None, None, err) if err else (_values(row), row, None)
    carried = _carried(block, ident)
    if carried is None:
        return None, None, f"{ident} is not one of the beads this rig's backlog carried"
    fields, err = backlog.prose(rig, ident)
    if err:
        return None, None, err
    row = {**carried, **{FIELDS[n]: v for n, v in (fields or {}).items() if n in FIELDS}}
    return _values(row), row, None


def _reread(rig, ident, repo, detail, extra=None):
    """What actually landed, read back out of the store. The response never echoes the
    form: "saved" has to mean the database agrees, and a write that half-applied has to
    show up as the half it applied rather than as the whole thing the operator typed."""
    row, err = beads.show(repo, ident)
    if err:
        return _no(f"the write landed but the console could not read {ident} back: {err} "
                   "— refresh before editing it again", 502)
    return _done(rig, ident, row, _values(row), detail, extra)


def _done(rig, ident, row, now, detail, extra=None):
    """The success payload, in the three shapes its three readers need: `bead` in the
    panel's shape for the cache patch, `prose` in the pane's shape, and `base` — the
    values the store now holds, which is the editor's next baseline. Handing that back
    is what keeps an operator's second edit from colliding with their own first one."""
    priority = row.get("priority")
    bead = {
        "id": ident,
        "title": now["title"] or "(untitled)",
        # Empty rather than None for anything that can be *cleared*: apply_write leaves a
        # None alone and drops an empty, which is the difference between "not saying" and
        # "no longer set".
        "priority": priority if isinstance(priority, int) and not isinstance(priority, bool)
                    else _int(now["priority"]),
        "issue_type": now["type"],
        "status": str(row.get("status") or "").strip().lower(),
        "parent": str(row.get("parent") or "").strip(),
        "assignee": str(row.get("assignee") or "").strip(),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
        "closed_at": row.get("closed_at"),
        "plan": True if (now["design"] or now["acceptance"]) else "",
        **(extra or {}),
    }
    prose = {name: _norm(row.get(field), name) for name, field in backlog.PROSE}
    return ({"ok": True, "detail": detail, "rig": rig, "id": ident,
             "bead": bead, "prose": {k: v for k, v in prose.items() if v}, "base": now}, 200)


def _values(row):
    """One bead's writable fields under the console's names for them."""
    return {name: _norm(row.get(field), name) for name, field in FIELDS.items()}


def _norm(value, name=""):
    """One field as a comparable string. Every comparison in this module runs through
    here, so the operator's "2" and bd's 2 are the same priority and trailing whitespace
    is never a conflict."""
    if name == "priority":
        return "" if value is None or value == "" else str(value).strip().lstrip("Pp")
    return str(value if value is not None else "").strip()


def _clean(body):
    """The fields a request is asking to write, validated, as (fields, error).

    Absent is not empty: a field the form did not send is left alone, and a field sent
    empty clears. That distinction is the whole reason this takes a dict rather than a
    fixed record — an editor that posted every field on every save would rewrite the
    three an operator did not open, and every one of those rewrites is a chance to
    clobber an agent."""
    raw = body.get("fields")
    if raw is None:
        return {}, None
    if not isinstance(raw, dict):
        return None, "fields must be an object"
    out = {}
    for name in sorted(raw):
        if name not in FIELDS:
            return None, f"{name} is not a field the console writes"
        text = _norm(raw[name], name)
        if len(text) > MAX:
            return None, f"{name} is longer than the {MAX} characters the console carries"
        if name == "priority":
            if _int(text) is None or not 0 <= _int(text) <= 4:
                return None, "priority is P0 to P4"
            text = str(_int(text))
        if name == "type" and text not in TYPES:
            return None, f"type is one of {', '.join(TYPES)}"
        out[name] = text
    return out, None


def _int(text):
    try:
        return int(str(text).strip())
    except (TypeError, ValueError):
        return None


def _carried(block, ident):
    """The bead as the panel carries it, or None. Every write checks this first: it is
    what bounds the write surface to beads the console has actually drawn."""
    return next((b for b in (block.get("beads") or []) if b.get("id") == ident), None) \
        if ident else None


def _saved(changed):
    return "saved " + ", ".join(sorted(changed))


def _new_id(made):
    """The id `bd create --json` reports. It answers with an object on its own or inside
    a list depending on the subcommand, so read both rather than assuming one."""
    rows = made if isinstance(made, list) else [made]
    for row in rows:
        if isinstance(row, dict) and str(row.get("id") or "").strip():
            return str(row["id"]).strip()
    return ""


def _demo_id(block):
    """An id for a bead created in demo mode, in the shape of the rig it lands in — the
    fixtures have no database to allocate one. Nothing outside --demo calls this."""
    ids = [str(b.get("id") or "") for b in (block.get("beads") or [])]
    prefix = ids[0].split("-")[0] if ids and "-" in ids[0] else "new"
    n = 901
    while f"{prefix}-{n}" in ids:
        n += 1
    return f"{prefix}-{n}"


def _now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _no(reason, code):
    return {"ok": False, "error": reason}, code
