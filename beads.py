"""Reading beads, and the one rule every bead read has to obey.

Rig beads do not live in one database. Every rig keeps its own, and `bd` picks the
database from the directory it runs in — so `bd list` run from the town root sees
ONLY the town's beads and returns an EMPTY LIST for a rig's, with no error and no
warning. An empty answer from the wrong database is indistinguishable from an empty
backlog, and this town has already paid for that confusion once: hq-rin, where the
Deacon classified the town idle while a polecat was mid-task, because it ran `bd
list` from the wrong directory.

So there is one way in and it takes the repo first. `run_bd()` passes `-C repo` *and*
runs with `cwd=repo` — belt and braces, because the failure mode is silent — and
`repos()` is the only place that decides where a rig's beads live. No caller builds a
`bd` argv of its own, which is what keeps the directory from being something a caller
can forget. Callers should also treat a repo that answers with nothing as suspicious
rather than as empty; backlog.py says so out loud.

Both readers above this — flight.py and backlog.py — run only on the scheduler. `bd`
is heavier than `gt status` and neither has any business on a request path; see
CLAUDE.md, and note that `refresh()` returns before either of them under --demo.
"""

import json
import os
import shutil
import subprocess

PATH = "/opt/homebrew/bin:/usr/local/bin:" + os.environ.get("PATH", "")


def run_bd(repo, args, timeout=20):
    """One `bd` list-shaped read against one beads repo, as (rows, error). The repo is
    the first argument because it is the argument that must never be omitted. Never
    raises: a rig whose beads cannot be read is one rig's problem, not the panel's."""
    exe = shutil.which("bd", path=PATH) or "bd"
    try:
        p = subprocess.run([exe, "-C", repo, *args, "--json", "--no-pager"],
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
        return None, ((p.stderr or "").strip().splitlines() or ["no output"])[0]
    try:
        parsed = json.loads("\n".join(lines[start:]))
    except json.JSONDecodeError:
        return None, "unparseable output"
    return (parsed if isinstance(parsed, list) else []), None


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
