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
  `models` panel, see `models.py`; the `panes` panel, see `panes.py`; the `flight` and
  `backlog` panels, see `flight.py` and `backlog.py`). Adding a read means adding a row here,
  nowhere else — a read that does not fit the `gt`-argv shape is a callable, not a second table.
- HTTP handlers **only read memory the scheduler filled** — never a subprocess, never a file,
  never anything that can be slow. `GET /api/snapshot` returns every panel plus its age;
  `GET /api/panel/<name>` returns one panel in the same shape — the UI uses `/api/snapshot`,
  `POST /api/mail`, and `/api/panel/watch` for the live terminal view, which wants a faster
  poll than the page render. `GET /api/bead?rig=&id=` is the one handler that serves
  something that is not a panel: one bead's long prose for the Board tab's planning pane,
  out of a dict the `backlog` refresh filled in the same pass that built the panel (see
  `backlog.py`). It is a two-string dict lookup and it obeys the rule for the reason the rule
  exists — the rule is about slow work on a request path, and there is none here. Carrying
  that prose in the snapshot instead would have doubled the largest panel on every poll to
  serve a pane that reads one bead at a time; the measurement is in that file.
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
`backlog` is the heaviest of the lot — a whole `bd list --all` per beads repo — which is why
it runs on the slowest cadence in the table and trims hard before it caches.

There are now **no exceptions**: `refresh()` is called only from the scheduler pool, and it
returns immediately under `--demo` so no read path can shell out — or touch a real transcript,
or a real tmux socket, or a real beads repo — with fixtures loaded. Every place that spawns a
subprocess (`refresh()`, `send_mail()`, and `panes.py`/`beads.py` beneath `refresh()`) is
demo-guarded. Keep it that way.

## Hard constraint 3: nothing is reachable by mouse only

The operator reads this console on a phone. A hover is not available there, a hover is not
available to a keyboard, and a hover was never available to a screen reader — so anything
that only a hover can reach is not in the console at all. This is a constraint like the two
above it: check a change against every line here before you claim it is done.

- **No information is hover-only.** Hover is an enhancement, never the only path to content.
  Whatever a hover reveals must also be reachable by tap, by keyboard focus, or by an
  always-visible control. A `title=` attribute is a hover; so is a `<title>` in SVG.
- **Truncation requires a recovery path**, and a native tooltip is not one. If text is
  clipped, there is a discoverable, non-hover way to read all of it. Three shapes of that
  answer are already here, so copy one rather than inventing a fourth: a row that clips and
  expands (`beadRow()` in `app.js`, the whole prose under the fold); a card that clips and
  opens a pane (`.bcard-title` → `paneHtml()`); a diagram node that clips and reads out
  (`graph.py` `_node()` → `paintRead()` in `app.js`). Where something still clips, the CSS
  rule says which of those is its recovery path — keep that comment true.
- **Keyboard reachable, and visibly so.** Every interactive element is focusable and
  operable without a mouse, with a focus indicator. `:focus-visible` in `app.css` is the
  floor for anything nobody styled. Expanders carry `aria-expanded` and `aria-controls`, and
  focus survives the 8s refresh that rebuilds the markup under it — `renderBacklog()` and
  `renderBoard()` both restore `document.activeElement`, and `renderMap()` restores the
  focused node. That is the standard to match, not exceed.
- **Many stops or one stop with arrows, never a wall.** A list of controls is fine. Seven
  hundred tab stops between the filter box and the next section is not: the map gives one
  stop per diagram and walks the beads inside it with the arrow keys (roving tabindex —
  `mapRoving()`/`mapFocus()`), and says so in words on the page.
- **Touch targets.** Real tap targets, not hover-only affordances, and comfortably hittable
  on a phone — the `max-width: 760px` block grows the rows, the chips and the icon buttons
  for exactly this.
- **Contrast and theme.** Legible in **both** themes; there is a toggle and both are used.
  Colour is never the only carrier of meaning: a blocked bead is red *and* dashed *and*
  flagged (`graph.py` `_node()`, `.g-block` in `app.css`), and every status dot sits beside
  the same status in words.
- **Screen-reader sanity.** Meaningful names on controls and diagrams. An SVG gets a role and
  an `aria-label` — but note `role="img"` makes its children presentational, which is why the
  figures are `role="group"` now that the nodes inside them are controls. Decorative glyphs
  are `aria-hidden`.

## Bead reads run in the rig's directory — always

Every rig keeps its **own** Dolt database, and `bd` chooses one from the directory it runs in.
`bd list` run from the town root therefore returns an **empty list** for a rig's beads, with no
error and no warning — which is indistinguishable from an empty backlog and has already cost
this town once (hq-rin). So all three bead reads go through `beads.py`, which passes `-C repo`
*and* `cwd=repo` and owns the only definition of where a rig's beads live. Do not assemble a
`bd` argv anywhere else, and treat a repo that answers with nothing as suspicious rather than
as empty — `backlog.py` reports it as an error instead of drawing a rig that planned nothing.

## Security posture

Read-only **except one allowlisted write**: `POST /api/mail` → `gt mail send`. The allowlist is
`WRITE_ACTIONS`; `do_POST` refuses anything not in it. There is no shell passthrough and no
command palette. That is a deliberate design, not an unfinished feature.

The Board tab's `GET /api/bead` does not change that. It takes two strings and uses them as
dict keys into data the scheduler already read — it opens no file, spawns no process, and can
only answer for a bead the backlog read carried, so there is nothing for a crafted `rig` or
`id` to reach. The Board tab itself is read-only for the same reason the rest is: the operator's
design had an "Approve plan" button on it, and that is a write, filed separately (gc-dzd) so a
human signs off on it rather than it arriving as part of a viewer.

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
  at all. The **one** exception is the Backlog tab's map, which arrives from the server as
  SVG and is assigned straight through `innerHTML` — so `graph.py` takes on that escaping
  obligation itself, for every bead title and id it draws, and emits a closed tag set with no
  script, no handler and no URL in it. The attribute set is closed the same way, and two of
  them carry bead data — `aria-label` and `data-node`, which is what makes a clipped title
  readable without a mouse — so `_txt()` escapes quotes as well as angle brackets. Read the
  note at the top of that file before adding to it. SVG text is an injection surface exactly
  like HTML is, and a second such exception should be argued for rather than assumed.
- `_file()` refuses paths that escape `static/`.

## Layout

| Path | What it is |
|---|---|
| `server.py` | HTTP handlers + the refresh scheduler + `READS`/`WRITE_ACTIONS`. ~380 lines and it should not grow much: handlers, the scheduler, the two tables, nothing else. Anything a handler needs to *know* belongs in the module that owns the read. |
| `demo.py` | Synthetic fixtures for `--demo`. |
| `models.py` | The `models` read: which model each agent runs, from its Claude Code transcript. |
| `panes.py` | Two reads off the same tmux screens. `panes`: what each agent is *doing*, one summary line per session — `gt`'s `state` field means "has a bead on its hook", not "is working", so this is the console's only source of activity. `watch`: one agent's *whole* screen, for the live terminal view, and only while somebody has that view open. |
| `beads.py` | The one way to run `bd`. Owns repo discovery and the invocation, because a bead read against the wrong directory answers "nothing" instead of failing — see the section above. |
| `flight.py` | The `flight` read: every bead that is neither open nor closed, and who holds it. `gt ready` drops a bead the moment it is picked up and no `gt` read carries an agent's work, so this is the only answer to "what is being worked on". One `bd list` per beads repo in town. |
| `backlog.py` | The `backlog` read: each rig's whole backlog with its structure intact — the epic hierarchy, the `blocks` edges, and why every closed bead closed. The Work tab's reads are all about this minute; this is the one a ceremony reads. Slowest cadence, biggest payload, trimmed hardest. Also owns the prose table behind `GET /api/bead` — the four long fields, kept beside the panel rather than in it. |
| `graph.py` | The same beads, drawn: epic trees and the `blocks` graph as SVG, laid out in stdlib Python. Not a read — it takes what `backlog.py` has already trimmed and rides inside that panel, so the picture and the lists beside it can never be a cadence apart. The one place markup is generated on the server, which is why it does its own escaping. Its nodes are controls rather than boxes — focusable, named, and read out in full by `app.js` — because every title in here is clipped to a pixel budget. |
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
  `demo.prose()` is the exception that proves it: the planning pane's text is not a panel, so
  it cannot be a fixture key, and it is seeded through `backlog.load_prose()` beside them. It
  is handed the backlog fixture and fills a blank for every carried bead, because the live
  table's key set is every carried bead — a bead with nothing written on it has to answer
  "nothing written down" and not "not carried".
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
