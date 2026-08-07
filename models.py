"""Which model each agent is running.

`gt` does not carry this. `agent_alias` and `agent_info` are both the string
"claude" for every agent — that is the tool, not the model — and `gt costs --json`
prices sessions per-model without ever naming one. The only place the model exists
is the Claude Code transcript for the agent's session, so this is the console's one
read that is not a `gt` call. It is declared in `READS` like every other read and
runs only on the scheduler; nothing here may touch the HTTP request path.

Two things make it delicate:

* A transcript directory is named for the agent's working directory with every
  non-alphanumeric character replaced by "-", which is lossy — "gastown_console"
  and "gastown-console" both encode to "gastown-console". So we derive forward
  (path -> directory name) and never read a directory name back into a path, then
  confirm the guess against the `cwd` that every transcript line carries. Seen in
  the wild: a directory whose newest transcript was written somewhere else
  entirely. An unconfirmed transcript is not used — no model beats a wrong one.
* Transcripts run to megabytes (182 MB across ~105 files here, largest 8 MB), so
  we read backwards from the end and stop at the first line carrying a model. The
  model is stable within a session, so one line answers it.
"""

import json
import os
import string

HOME = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
PROJECTS = os.path.join(HOME, "projects")

_KEEP = frozenset(string.ascii_letters + string.digits)

# How far back to read, in steps. Assistant lines are frequent, so the first step
# answers nearly every transcript; past the last one we give up rather than walk a
# file of any size.
TAIL_STEPS = (64 * 1024, 512 * 1024)
# Transcripts to try per directory, newest first. A directory holds one file per
# past session and the newest is the live one — but see the cwd caveat above.
TRIES = 3

# transcript path -> ((mtime, size), model). The real cache: a re-read only happens
# when a transcript has actually grown, so idle agents cost one stat() per cycle.
_seen = {}


def encode(path):
    """Claude Code's directory name for a working directory. Forward only — every
    non-alphanumeric character becomes "-", which cannot be undone."""
    return "".join(c if c in _KEEP else "-" for c in path)


def _mtime(path):
    try:
        return os.stat(path).st_mtime
    except OSError:
        return 0.0


def _agents(status):
    """Every agent in `gt status --json`, paired with its rig (None at town level)."""
    for a in status.get("agents") or []:
        if isinstance(a, dict):
            yield a, None
    for r in status.get("rigs") or []:
        if not isinstance(r, dict):
            continue
        for a in r.get("agents") or []:
            if isinstance(a, dict):
                yield a, r.get("name")


def _base(agent, rig, town):
    """The agent's folder in the town, by role. `gt status` gives no working
    directory, so this comes from the rig layout: town agents sit at the town root,
    a rig's witness and refinery under the rig, polecats and crew in their own
    subtree. Wrong guesses cost nothing — the cwd check below throws them out."""
    name = str(agent.get("name") or "").strip()
    role = str(agent.get("role") or "").lower()
    if not name or os.sep in name or name.startswith("."):
        return None
    if not rig:
        return os.path.join(town, name)
    parts = {"polecat": ("polecats", name), "crew": ("crew", name)}.get(role, (name,))
    return os.path.join(town, str(rig), *parts)


def _candidates(base):
    """The agent's folder plus one level below it. A witness works in its folder
    directly, a refinery in `rig/`, a polecat in a worktree named for the rig — one
    level covers all three without hard-coding any of them."""
    out = [base]
    try:
        children = sorted(os.listdir(base))
    except OSError:
        return out
    for c in children:
        if not c.startswith(".") and os.path.isdir(os.path.join(base, c)):
            out.append(os.path.join(base, c))
            if len(out) > 24:
                break
    return out


def _tail(path, nbytes):
    """The last `nbytes` of a file as lines, dropping the fragment a mid-file seek
    always lands in. Never loads the whole file."""
    start = 0
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            end = fh.tell()
            start = max(0, end - nbytes)
            fh.seek(start)
            chunk = fh.read(end - start)
    except OSError:
        return []
    lines = chunk.split(b"\n")
    return lines[1:] if start else lines


def _real(model):
    """Claude Code stands in a placeholder for messages no model produced — an API
    error, an interrupt, a modal the session sat on — and writes it in the model
    field as "<synthetic>". Those cluster at the tail of a transcript precisely when
    something went wrong, which is exactly where we read, so a strict read-from-the-
    end lands on one and reports it as the agent's model. Skip the whole `<...>`
    form rather than naming the one we have seen, and keep scanning backwards; do
    not allowlist real model ids, which drift with every release."""
    return isinstance(model, str) and bool(model) and not model.startswith("<")


def _model_in(path, cwd):
    """The model from the tail of one transcript — but only from a line that agrees
    it was written in `cwd`. None for anything else, including an unreadable file."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    key = (st.st_mtime, st.st_size)
    hit = _seen.get(path)
    if hit and hit[0] == key:
        return hit[1]
    model = None
    for nbytes in TAIL_STEPS:
        for line in reversed(_tail(path, nbytes)):
            if b'"model"' not in line:
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            msg = rec.get("message") if isinstance(rec, dict) else None
            found = msg.get("model") if isinstance(msg, dict) else None
            if _real(found) and rec.get("cwd") == cwd:
                model = str(found)
                break
        if model or st.st_size <= nbytes:
            break
    _seen[path] = (key, model)
    return model


def _resolve(agent, rig, town, dirs):
    """(mtime, model, transcript) for the newest confirmed transcript of one agent,
    or None if nothing confirms."""
    base = _base(agent, rig, town)
    if not base:
        return None
    best = None
    for cwd in _candidates(base):
        name = encode(cwd)
        if name not in dirs:
            continue
        d = os.path.join(PROJECTS, name)
        try:
            files = [os.path.join(d, f) for f in os.listdir(d) if f.endswith(".jsonl")]
        except OSError:
            continue
        files.sort(key=_mtime, reverse=True)
        for path in files[:TRIES]:
            model = _model_in(path, cwd)
            if model:
                at = _mtime(path)
                if best is None or at > best[0]:
                    best = (at, model, path)
                break
    return best


def by_agent(status, town):
    """{agent address: model} for every agent we can map with confidence, as
    (data, error) — the shape `READS` sources return.

    Agents we cannot map are absent from the result and the panel renders nothing
    for them. That is the point: this panel exists so the user can trust what an
    agent is, so it never falls back to a default or to "claude"."""
    if not isinstance(status, dict):
        return {}, None                     # status has not landed yet; retry next cycle
    try:
        dirs = set(os.listdir(PROJECTS))
    except OSError as e:
        return None, f"{PROJECTS}: {e.strerror or e}"

    out, claimed = {}, {}
    for agent, rig in _agents(status):
        addr = str(agent.get("address") or "").strip()
        best = _resolve(agent, rig, town, dirs)
        if not addr or best is None:
            continue
        owner = claimed.setdefault(best[2], addr)
        if owner != addr:
            out.pop(owner, None)            # one transcript, two agents: trust neither
            continue
        out[addr] = best[1]
    return out, None
