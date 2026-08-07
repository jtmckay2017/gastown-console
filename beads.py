"""Running `bd`, and the one rule every call to it has to obey.

Rig beads do not live in one database. Every rig keeps its own, and `bd` picks the
database from the directory it runs in — so `bd list` run from the town root sees
ONLY the town's beads and returns an EMPTY LIST for a rig's, with no error and no
warning. An empty answer from the wrong database is indistinguishable from an empty
backlog, and this town has already paid for that confusion once: hq-rin, where the
Deacon classified the town idle while a polecat was mid-task, because it ran `bd
list` from the wrong directory.

So there is one way in and it takes the repo first. `_bd()` passes `-C repo` *and*
runs with `cwd=repo` — belt and braces, because the failure mode is silent — and
`repos()` is the only place that decides where a rig's beads live. No caller builds a
`bd` argv of its own, which is what keeps the directory from being something a caller
can forget. Callers should also treat a repo that answers with nothing as suspicious
rather than as empty; backlog.py says so out loud.

WHAT RUNS WHERE. The two readers above this — flight.py and backlog.py — run only on
the scheduler, because `bd` is heavier than `gt status` and neither has any business on
a request path; see CLAUDE.md, and note that `refresh()` returns before either of them
under --demo. `show()` and `write()` are the exception the same document names: they are
the bead-editing write path (edit.py), which is user-initiated and synchronous by
definition — an operator pressing Save has to be told whether it landed, and a write
queued onto a cache would be exactly the fire-and-forget the feature exists to avoid.
They are still `bd`, so they are still slow, and nothing but a POST may call them.
"""

import json
import os
import shutil
import subprocess

PATH = "/opt/homebrew/bin:/usr/local/bin:" + os.environ.get("PATH", "")
# Every write says the console did it rather than inheriting the shell user's git
# identity. Agents write these beads too, so "who last touched this" is a question with
# a real answer, and a console edit that signed itself as a person would erase it.
ACTOR = "gastown-console"


def _bd(repo, args, timeout, strict=False):
    """One `bd` invocation against one beads repo, as (parsed json, error). The repo is
    the first argument because it is the argument that must never be omitted. Never
    raises: a rig whose beads cannot be read is one rig's problem, not the panel's.

    `strict` also fails on a non-zero exit that printed a usable body. Reads do not want
    that — a list that parsed is a list, whatever bd thought of the run — but a write
    does: "it wrote something and also exited 1" is the one answer a Save button must
    never round down to success."""
    exe = shutil.which("bd", path=PATH) or "bd"
    try:
        p = subprocess.run([exe, "-C", repo, *args, "--json"],
                           capture_output=True, text=True, timeout=timeout,
                           cwd=repo, env=dict(os.environ, PATH=PATH))
    except subprocess.TimeoutExpired:
        return None, f"timed out after {timeout}s"
    except FileNotFoundError:
        return None, "bd not found on PATH"
    except OSError as e:
        return None, str(e)
    # bd prefixes its payload with git-config warnings, the same way gt does — take the
    # first line that opens a JSON body rather than the first bracket anywhere, since a
    # warning is free to contain one.
    lines = (p.stdout or "").splitlines()
    start = next((i for i, l in enumerate(lines) if l.lstrip()[:1] in ("[", "{")), None)
    if start is None:
        return None, _why(p)
    try:
        parsed = json.loads("\n".join(lines[start:]))
    except json.JSONDecodeError:
        return None, "unparseable output"
    # A failing bd still answers in JSON, with the reason inside it. Reading the body and
    # ignoring the exit status would turn "no issue found" into an empty success.
    if isinstance(parsed, dict) and parsed.get("error"):
        return None, str(parsed["error"])
    if strict and p.returncode:
        return None, _why(p)
    return parsed, None


def _why(p):
    """The first line of a failure that actually says something. bd puts its reason on
    stderr and its usage block underneath, so take a line rather than the lot."""
    for stream in (p.stderr, p.stdout):
        for line in (stream or "").splitlines():
            line = line.strip()
            if line and not line.startswith(("warning:", "Usage:", "Fix:", "Or:")):
                return line
    return f"bd exited {p.returncode}" if p.returncode else "no output"


def run_bd(repo, args, timeout=20):
    """One `bd` list-shaped read, as (rows, error). Scheduler only — see the note above."""
    parsed, err = _bd(repo, [*args, "--no-pager"], timeout)
    if err:
        return None, err
    return (parsed if isinstance(parsed, list) else []), None


def show(repo, ident, timeout=20):
    """One whole bead, as (bead, error) — every field `bd` stores, not the trimmed
    projection the panel carries. This is what the write path compares against before it
    overwrites anything, so it must be a live read and not a cached one: a freshness
    check run against a cache is a freshness check that cannot fail."""
    parsed, err = _bd(repo, ["show", ident], timeout, strict=True)
    if err:
        return None, err
    rows = parsed if isinstance(parsed, list) else [parsed]
    row = next((r for r in rows if isinstance(r, dict) and r.get("id")), None)
    if row is None:
        return None, f"{ident} is not a bead in this rig"
    return row, None


def comments(repo, ident, timeout=20):
    """One bead's comments, as (rows, error). `bd show` carries only a count of them, so
    anything that has to read what a comment SAYS needs this second call. The console's
    approval records live here (dispatch.py) — a bead's fields belong to whoever is
    planning it, and an audit trail that had to share one would keep colliding with them.

    Write path only, like show(): this is `bd`, so it may not go near a read."""
    parsed, err = _bd(repo, ["comments", ident], timeout, strict=True)
    if err:
        return None, err
    return (parsed if isinstance(parsed, list) else []), None


def write(repo, args, timeout=60):
    """One `bd` write, as (parsed, error). Longer default timeout than a read: a write
    takes a Dolt commit, and a write that times out half-done is worse than one that
    waits. Callers re-read with show() afterwards rather than trusting what comes back —
    bd's write output is not the same shape from one subcommand to the next."""
    return _bd(repo, [*args, "--actor", ACTOR], timeout, strict=True)


def repos(status, town):
    """[(label, path)] for every beads repo in town — the town's own, then one per rig.
    `gt` reports no path for a rig; the directory is <town>/<rig name>, so each one is
    checked for a .beads before it is asked. The label matches the source names `gt
    ready --json` uses, so every list keyed by rig groups and filters alike."""
    rigs = (status or {}).get("rigs") if isinstance(status, dict) else None
    names = [r.get("name") for r in (rigs or []) if isinstance(r, dict) and r.get("name")]
    out, seen = [], set()
    for label, path in [("town", town), *((n, os.path.join(town, n)) for n in names)]:
        full = os.path.abspath(os.path.expanduser(path))
        if full in seen or not os.path.isdir(os.path.join(full, ".beads")):
            continue
        seen.add(full)
        out.append((label, full))
    return out
