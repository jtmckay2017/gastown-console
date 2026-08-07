# Gas Town Console — agent guide

A single-page web console over the [Gas Town](https://github.com/steveyegge/gastown) `gt` CLI.
Two constraints define this project. Both are easy to break with a change that looks like an
improvement, so read them before you touch anything.

## Hard constraint 1: Python standard library only

No pip, no npm, no build step, no bundler, no framework — server and front end alike.

The whole value proposition is `git clone && python3 server.py --demo`. A dependency breaks
that even when it makes some code nicer. This is not negotiable for a "nicer HTTP framework",
a template engine, a JS build, or a CSS toolchain. If you find yourself wanting one, write the
twenty lines by hand instead.

Runtime floor is Python 3.9 and a modern browser. `static/app.js` is one plain `<script src>`,
not a module; `static/app.css` is hand-written CSS with custom properties.

## Hard constraint 2: never shell out on the HTTP request path

`gt status` takes seconds, and concurrent `gt` calls contend on the Dolt server. So:

- A background scheduler thread (`scheduler()` in `server.py`) refreshes each panel on its own
  cadence into `_cache`. Cadences live in the `READS` table — that table is the single place a
  read is declared: name → (source, refresh interval). A source is normally `gt` argv; it may
  also be a callable returning `(data, error)`, for a read that is not a `gt` call at all (the
  `models` panel, see `models.py`; the `panes` panel, see `panes.py`; the `flight` panel,
  see `flight.py`). Adding a read means adding a row here, nowhere else.
- HTTP handlers **only read `_cache`**. `GET /api/snapshot` returns every panel plus its age;
  `GET /api/panel/<name>` returns one panel in the same shape — the UI uses `/api/snapshot`,
  `POST /api/mail`, and `/api/panel/watch` for the live terminal view, which wants a faster
  poll than the page render.
- `?fresh=1` does **not** block — `mark_due()` just sets panels due, and the scheduler picks
  them up a beat later. The UI compensates by re-polling (see `#refresh` in `app.js`).
- `?watch=<session>` is the same idea one step further, and the only server state the front
  end can set: it renews a **lease** naming the tmux session an operator has a live terminal
  view open on (`panes.watch()`), and the scheduler captures that one pane at a fast cadence.
  The handler writes a dict entry and returns; the capture stays on the scheduler like every
  other slow thing. A lease expires on its own, so a closed panel, a backgrounded tab and a
  crashed browser all stop the capture the same way — by no longer asking.
- A failed refresh **keeps the last good data** and attaches an error (`refresh()`), so a
  transient `gt` hiccup never blanks a live panel. Panels carry their own `age`; the UI shows
  the oldest.
- `POOL` is a 3-worker `ThreadPoolExecutor` on purpose. Raising it increases Dolt contention.

Any change that makes a handler block on a subprocess is wrong, no matter how fast it looks on
a quiet town. Measure on a busy town, not yours. The rule is about slow work, not subprocesses
specifically — `models.py` reads the filesystem rather than shelling out, `panes.py` shells out
to `tmux` rather than to `gt`, and `flight.py` shells out to `bd`; all three live behind the
same scheduler for the same reason. `panes` costs one `capture-pane` per session in town and
`flight` one `bd list` per beads repo, which is milliseconds each and still has no business on
a request path. `watch` costs one `capture-pane` for each session under lease — never more
than `panes.MAX_WATCHED`, and none at all when nobody is watching, which is nearly always.

There are now **no exceptions**: `refresh()` is called only from the scheduler pool, and it
returns immediately under `--demo` so no read path can shell out — or touch a real transcript,
or a real tmux socket, or a real beads repo — with fixtures loaded. Every place that spawns a
subprocess (`refresh()`, `send_mail()`, and `panes.py`/`flight.py` beneath `refresh()`) is
demo-guarded. Keep it that way.

## Security posture

Read-only **except one allowlisted write**: `POST /api/mail` → `gt mail send`. The allowlist is
`WRITE_ACTIONS`; `do_POST` refuses anything not in it. There is no shell passthrough and no
command palette. That is a deliberate design, not an unfinished feature.

Why this matters more than it looks: **sending mail nudges the recipient agent awake, and Gas
Town agents typically run with permission checks disabled.** The compose box is "start an
autonomous agent", not "send a chat message". A new write endpoint is a design decision that
needs a human — never a routine addition.

The live terminal view on the Agents tab is **read-only and must stay that way.** It shows an
agent's screen; it can never touch it. There is no keystroke path, not even Enter, and adding
one is not a small feature: synthetic input into a pane merges with whatever the agent has
staged in its input box and submits the pair (hq-97l, hq-cat), so a send button there would
submit half-written instructions belonging to somebody else. The secondary affordance beside
it is deliberately just *text* — the `tmux attach` command to paste into a real terminal —
because running it for the operator would mean a shell endpoint, which this console does not
have. Interaction is a separate bead with its own scrutiny, not an extension of watching.

Other things not to erode:

- Binding off localhost auto-generates a token (`--token`, or `--no-auth` to opt out). The token
  is a speed bump, not authentication; the README correctly points people at Tailscale/WireGuard.
- The front end builds HTML with `innerHTML` and hand-escapes **every** interpolated value
  through `esc()`. Every value from `gt` is untrusted, and the `panes` read is worse — it is
  whatever an agent wrote on its own screen, including tmux session names. If you add markup,
  `esc()` it. The `watch` read is the worst of the lot, being a whole screen of it: escape
  sequences and control characters are stripped server-side in `panes.py` (stripped, not
  rendered — colour is worth nothing here and an escape parser would be a second injection
  surface), and `paintWatch()` sets the text through `textContent` so it never becomes markup
  at all.
- `_file()` refuses paths that escape `static/`.

## Layout

| Path | What it is |
|---|---|
| `server.py` | HTTP handlers + the refresh scheduler + `READS`/`WRITE_ACTIONS`. ~250 lines; keep it that way. |
| `demo.py` | Synthetic fixtures for `--demo`. |
| `models.py` | The `models` read: which model each agent runs, from its Claude Code transcript. |
| `panes.py` | Two reads off the same tmux screens. `panes`: what each agent is *doing*, one summary line per session — `gt`'s `state` field means "has a bead on its hook", not "is working", so this is the console's only source of activity. `watch`: one agent's *whole* screen, for the live terminal view, and only while somebody has that view open. |
| `flight.py` | The `flight` read: every bead that is neither open nor closed, and who holds it. `gt ready` drops a bead the moment it is picked up and no `gt` read carries an agent's work, so this is the only answer to "what is being worked on". Shells out to `bd`, once per beads repo in town. |
| `static/index.html` | The whole page skeleton; every panel is an empty `<div id=…>`. |
| `static/app.js` | Fetch, state, and all rendering. Vanilla JS, no framework. |
| `static/app.css` | Themes via `:root` custom properties + `:root[data-theme="light"]`. |
| `start.sh` | Restart helper; `--lan` binds `0.0.0.0` and prints a tokenized URL. |

## Testing reality

There is no test suite. **`python3 server.py --demo` is how you verify a change** without a
live town — it seeds `_cache` from `demo.fixtures()`, never starts the scheduler, and never
runs `gt`. `POST /api/mail` returns 400 in demo rather than sending.

Demo mode must keep working. It is the project's 10-second first impression and the only
verification path a contributor without a town has.

Two rules follow from that:

- **`demo.fixtures()` must return exactly the keys in `READS`** — the demo seed loop iterates
  the fixtures, so a read added to `READS` without a fixture leaves that panel dead in demo.
- **Fixtures must match the real shape of `gt --json` output.** If you change what a renderer
  expects, change `demo.py` in the same commit.

When you do have a town, check a change against real `gt` output too — demo fixtures are the
happy path, and the real CLI is messier than they suggest.

## Working with `gt` output — assume it drifts

`gt`'s JSON is not a stable contract, and the code is written defensively on purpose. Keep it
that way rather than "simplifying":

- `run_gt()` strips leading warning text before the first `{`/`[`, and returns
  `(data, error)` — never raises.
- `app.js` uses `pick(obj, [...aliases])` for fields whose spelling varies (`read`/`is_read`,
  `from`/`sender`/`from_address`, `at`/`created_at`/`timestamp`), tolerates a list *or* an
  object for `trail`, and defaults everything.
- An agent's address and a bead's assignee name the same agent and spell it differently —
  `gastown_console/chrome` on one side, `gastown_console/polecats/chrome` on the other, and
  crew carries `/crew/` in the address instead. `addrKeys()` in `app.js` indexes both sides
  under both spellings; never assume either one is canonical.
- Renderers must survive `null` data, an error string, and a still-loading panel — that is
  what `loadingOf()`, `errNote()`, and the skeleton placeholders are for.

## Conventions

- Commit messages reference the issue: `feat: thing (gc-xxx)`.
- Keep it one page and one file per concern; this project's readability *is* its documentation.
