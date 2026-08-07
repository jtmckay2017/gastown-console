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

## Hard constraint 2: never shell out on a *read* path

`gt status` takes seconds, and concurrent `gt` calls contend on the Dolt server. Every read
here is polled every eight seconds by every open tab, so a slow one is not slow once — it is
slow forever, on everyone's page at the same time. So:

- A background scheduler thread (`scheduler()` in `server.py`) refreshes each panel on its own
  cadence into `_cache`. Cadences live in the `READS` table — that table is the single place a
  read is declared: name → (source, refresh interval). A source is normally `gt` argv; it may
  also be a callable returning `(data, error)`, for a read that is not a `gt` call at all (the
  `models` panel, see `models.py`; the `panes` panel, see `panes.py`; the `flight` and
  `backlog` panels, see `flight.py` and `backlog.py`) — or for one that is a `gt` call plus a
  judgement about what it means (the `queue` panel, see `queued.py`). Adding a read means
  adding a row here, nowhere else — a read that does not fit the `gt`-argv shape is a
  callable, not a second table.
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

Any change that makes a **read** handler block on a subprocess is wrong, no matter how fast it
looks on a quiet town. Measure on a busy town, not yours. The rule is about slow work, not
subprocesses specifically — `models.py` reads the filesystem rather than shelling out,
`panes.py` shells out to `tmux` rather than to `gt`, and `flight.py` shells out to `bd`; all
three live behind the same scheduler for the same reason. `panes` costs one `capture-pane` per
session in town and `flight` one `bd list` per beads repo, which is milliseconds each and still
has no business on a request path. `queue` is a single `gt scheduler status`, which takes one
to three seconds on a *quiet* town — the plainest case in the table for the rule, and a read
whose whole job is to be trustworthy when the town is not quiet. `watch` costs one
`capture-pane` for each session under
lease — never more than `panes.MAX_WATCHED`, and none at all when nobody is watching, which is
nearly always. `backlog` is the heaviest of the lot — a whole `bd list --all` per beads repo —
which is why it runs on the slowest cadence in the table and trims hard before it caches.

`refresh()` is called only from the scheduler pool, and it returns immediately under `--demo`
so no read path can shell out — or touch a real transcript, or a real tmux socket, or a real
beads repo — with fixtures loaded.

**Writes are the other shape and they are allowed to block.** `POST /api/mail`, the three bead
writes (`edit.py`) and the dispatch (`dispatch.py`) call `gt`/`bd` on the request thread on
purpose. A write happens when somebody presses a button, it is one call rather than a poll, and
it has to be synchronous: the operator is owed an answer about whether it landed, and a write
queued onto the scheduler could not give one — it would be exactly the fire-and-forget the
feature exists to rule out. That is a licence for a POST and for nothing else. If you find
yourself wanting a GET to shell out, you want a scheduler entry.

The dispatch is the longest of them by far — `gt sling` spawns a polecat and boots a rig, and
it is allowed three minutes. That is deliberate: the worst answer this console can give is "it
failed" about a dispatch that actually ran, so on a timeout it says it does not know, rather
than guessing at the cheaper-sounding half.

Every place that spawns a subprocess (`refresh()`, `send_mail()`, `edit.py`, `dispatch.py`, and
`panes.py`/`beads.py` beneath them) is demo-guarded. Keep it that way.

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
  expands (`expandRow()` in `app.js` — or `beadRow()`, which predates it, with the whole
  prose under the fold); a card that clips and opens a pane (`.bcard-title` →
  `paneHtml()`); a diagram node that clips and reads out (`graph.py` `_node()` →
  `paintRead()` in `app.js`). Where something still clips, the CSS rule says which of
  those is its recovery path — keep that comment true. A `.prose-box` is the far side of
  the first shape: it scrolls rather than clips, and carries `tabindex="0"` so that
  scroll belongs to the keyboard too, not only to a wheel.
- **Keyboard reachable, and visibly so.** Every interactive element is focusable and
  operable without a mouse, with a focus indicator. `:focus-visible` in `app.css` is the
  floor for anything nobody styled. Expanders carry `aria-expanded` and `aria-controls`, and
  focus survives the 8s refresh that rebuilds the markup under it — `paint()` restores
  `document.activeElement` for every panel built on `expandRow()`, `renderBacklog()` and
  `renderBoard()` do it for the older three, `renderMap()` restores the focused node, and
  `renderPlans()`/`paintPlansDoc()` restore the index row, the action button and the
  scrollable `<pre>` alike.
  That is the standard to match, not exceed. `paint()` restores the panel's scroll
  position for the same reason: a card that jumps back to its first row every eight
  seconds is unreadable by anyone who cannot re-find their place at a glance.
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

## Every `bd` call runs in the rig's directory — always

Every rig keeps its **own** Dolt database, and `bd` chooses one from the directory it runs in.
`bd list` run from the town root therefore returns an **empty list** for a rig's beads, with no
error and no warning — which is indistinguishable from an empty backlog and has already cost
this town once (hq-rin). So every `bd` call goes through `beads.py`, which passes `-C repo`
*and* `cwd=repo` and owns the only definition of where a rig's beads live. Do not assemble a
`bd` argv anywhere else, and treat a repo that answers with nothing as suspicious rather than
as empty — `backlog.py` reports it as an error instead of drawing a rig that planned nothing.

The writes make this sharper, not looser. A read against the wrong database answers "nothing";
a *write* against the wrong database puts somebody's bead in it. So `edit.py` resolves the repo
from `beads.repos()` by exact rig label and refuses a rig that does not resolve, rather than
falling back to the nearest database — and `beads.write()` is the same one door with the same
two flags on it.

## Security posture

Read-mostly, with a **write allowlist** — `WRITE_ACTIONS`; `do_POST` refuses anything not in
it. There is no shell passthrough and no command palette. That is a deliberate design, not an
unfinished feature.

| Action | Runs | Owned by | Where it is reachable |
|---|---|---|---|
| `mail` | `gt mail send` | `send_mail()` in `server.py` | anywhere the console is |
| `bead-new` | `bd create` in the rig's own repo | `edit.py` | anywhere |
| `bead-edit` | `bd update` — title, type, priority, description, design, acceptance, notes | `edit.py` | anywhere |
| `bead-link` | `bd dep add`, or `bd update --parent` | `edit.py` | anywhere |
| `dispatch` | `bd comment`, then `gt sling` | `dispatch.py` | **the loopback only** |

Two *surfaces* now open these forms — the Board tab's pane and the Plans tab — and that
is a front-end fact, not a fifth and sixth endpoint. `HOSTS` in `app.js` is the whole of
the difference between them (which element the form paints into, what repaints around
it, which bead it opens on); everything below it — what is sent, what a conflict is, how
a refusal is spoken — is one implementation that does not know which tab it is on. Keep
it that way: a second copy of the conflict handling is a second thing to get wrong about
somebody else's writing. `dispatch` is reachable from the Board's pane only, because
approving a plan and reading one are different acts and only one of them starts an agent.

**What is deliberately absent is as much of the design as what is there.** There is no delete,
no close, no status change and no unlink — and no pause, resume or clear on the scheduler
either. A planning surface that can destroy a bead is a different risk class, and closing one
is a claim about work that the console cannot verify. The Work tab's queue view can say in
words why nothing is dispatching precisely *because* it cannot do anything about it: reading a
stalled queue and restarting one are two different risk classes as well, and a scheduler
control is not a thing that arrives as part of a diagnostic. `bd`'s vocabulary is much larger
than this table and the gap is the point — adding a row to it is a design decision that needs a
human, exactly like a new endpoint is.

**The console can now start an agent, and that is the fifth row.** `dispatch` approves a plan
and slings the bead, which spawns a fresh polecat that will write code and open a merge
request — so this endpoint can merge code. It was argued for and decided rather than added
(gc-dzd): dispatch already happens on the Mayor's judgement with the operator seeing a
*description* of a plan, and a button that will not fire until a human has read the actual plan
text is more gate than exists today, not less. Read the header of `dispatch.py` before you
touch any of it. Four guards hold it up and **none of them is optional**:

1. **Loopback only, and absent rather than disabled.** Bound anywhere but `127.0.0.1`, the
   action is not in `WRITE_ACTIONS` (so the POST is a 404, like a route nobody wrote) and the
   served page carries `<meta name="gt-dispatch" content="off">` (so the control is never
   built). `curl -s http://…/ | grep gt-dispatch` is the check, and it has two possible
   answers — which is the whole reason the marker exists. The token a LAN binding generates is
   a speed bump, and a speed bump in front of "start an autonomous agent" is not a lock.
   Reaching this from a phone is an authentication decision and a separate bead.
2. **The approval pins the plan.** The request carries every field as the console *showed* it
   — including status and assignee — and the server re-reads the bead and refuses if any of
   them moved, naming the field and handing back what the store says now. Agents rewrite these
   beads continuously, so approving one plan and executing another is the expected failure
   here, not the paranoid one.
3. **The approval is recorded before anything runs**, as a `bd comment`: who, when, to what,
   a sha256 over everything pinned, and the plan text as it was on screen. A comment and not a
   field, because `notes` is one of the fields guard 2 pins — an approval written there would
   move the thing it had just promised had not moved. If the sling then fails, that goes on the
   record too, so the trail never claims something ran when nothing did.
4. **One at a time, confirm on repeat.** One dispatch in flight across the whole console; a
   bead that was already approved, is already on a hook, or has no plan written on it at all
   takes a second deliberate press with the reason printed above the button.

**Permanently out of scope, and not by omission:** auto-approve, batch approve, approve on a
timer, or any dispatch triggered by a condition rather than a human pressing a button for one
bead. This town spent 2026-08-07 cataloguing threshold-triggered destructive actions (hq-y89,
hq-97l, hq-g7g); hq-ayx is the finding that ties them together, and a timer that slings would
contradict it directly.

Three properties hold for every bead write — `edit.py`'s three and `dispatch.py`'s one alike —
and a change that breaks any of them is wrong:

- **It can only touch a bead the console has already drawn.** `edit.apply()` and
  `dispatch.apply()` check the rig against the backlog panel and the id against that rig's
  carried beads before anything else, so a crafted `rig`, `id` or `target` has nothing to reach.
  The repo comes from `beads.repos()` by exact label — never from the request — and under
  `--demo` the repo list handed in is empty, so a demo write has no path to a database even in
  principle. A dispatch is bounded twice over: its *destination* has to be an agent address or
  rig name the `status` read actually carried, so it cannot hand work to something nobody told
  the console about either.
- **It cannot silently overwrite an agent.** Every edit carries what the console had for each
  field it writes; `edit.py` re-reads the bead from the store and refuses the whole write if
  any of them moved, naming the field and showing both versions. It is per field rather than per
  bead because an agent claiming a bead changes its status every few minutes, and a check that
  cried wolf over that would train people to click through it. Read the header of `edit.py`
  before touching this: divergent copies of one fact is this town's most expensive failure class
  (hq-m2p, hq-r1e), and last-write-wins is how you get them.
- **It cannot fail quietly.** Every path returns `ok:true` with what the store now holds, or
  `ok:false` with a reason. The response is a re-read, never an echo of the form, so "saved"
  means the database agrees. The front end never clears a form on a failure and never
  auto-dismisses the message.

Two things follow for the front end, both already true and both easy to undo by accident: an
open form **freezes the pane** against the 8s repaint (`paintPane`), because rebuilding a
`<textarea>` under somebody discards what they typed; and a save posts **only the fields whose
value differs from the baseline**, because asserting a baseline for a field nobody opened is a
chance to reject — or clobber — an edit that was never in dispute.

The Board tab's `GET /api/bead` predates all of this and is still just a read. It takes two
strings and uses them as dict keys into data the scheduler already read — it opens no file,
spawns no process, and can only answer for a bead the backlog read carried. The Plans tab
asks it a **second** time for the same bead whenever the `backlog` panel lands a newer read,
which is how it notices an agent rewriting a plan under the reader. That is still two dict
keys and no work, and it is bounded by the backlog cadence rather than by the poll: the
answer cannot change between two backlog reads, so asking oftener could only cost more and
learn nothing.

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
  That is exactly why the console **drops a capability** rather than trusting the token when it
  is bound past the loopback: reads and the four bead writes stay, `dispatch` goes. Startup says
  which of the two consoles you are running, out loud, in the banner.
- `_page()` fills one named marker into `index.html` and nothing else fills anything anywhere.
  It is there so the loopback-only rule can be *inspected* rather than believed — a control
  that a script decides not to draw looks identical, in the served HTML, to one that was never
  built. One marker, substituted once. It is not a template engine and it must not become one:
  a second marker means something belongs in a read instead.
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
| `server.py` | HTTP handlers + the refresh scheduler + `READS`/`WRITE_ACTIONS`. ~460 lines and it should not grow much: handlers, the scheduler, the two tables, nothing else. Anything a handler needs to *know* belongs in the module that owns the read — or, for a write, the one that owns the write. `write_bead()` is the shape to copy: resolve, delegate, fold the answer into the cache, mark due. It also owns the one thing that is decided by where the console is bound — `LOCAL`, and the three places it shows up: the allowlist, `_page()`, and the startup banner. |
| `demo.py` | Synthetic fixtures for `--demo`. |
| `models.py` | The `models` read: which model each agent runs, from its Claude Code transcript. |
| `panes.py` | Two reads off the same tmux screens. `panes`: what each agent is *doing*, one summary line per session — `gt`'s `state` field means "has a bead on its hook", not "is working", so this is the console's only source of activity. `watch`: one agent's *whole* screen, for the live terminal view, and only while somebody has that view open. |
| `beads.py` | The one way to run `bd` — reads (`run_bd`, `show`, `comments`) and writes (`write`) alike. Owns repo discovery and the invocation, because a `bd` call against the wrong directory answers "nothing" instead of failing — see the section above. |
| `edit.py` | The bead writes: create, edit, link. Owns what may be written, what a conflict is, and the re-read that makes "saved" mean the store agrees. Allowed to be slow on a request path, and the header says why. Its `values`/`norm`/`carried`/`done`/`no` are public because `dispatch.py` answers in the same shape — one payload shape for the pane, not two. |
| `dispatch.py` | The fifth write, and the only one that *starts* something: approve a plan, record the approval, `gt sling`. Loopback only. Owns all four guards and its own `gt` invocation, because `gt sling` answers in prose rather than JSON and a write wants its failure text. Read its header before changing a line of it — every paragraph in there is a decision somebody already argued through. |
| `flight.py` | The `flight` read: every bead that is neither open nor closed, and who holds it. `gt ready` drops a bead the moment it is picked up and no `gt` read carries an agent's work, so this is the only answer to "what is being worked on". One `bd list` per beads repo in town. |
| `queued.py` | The `queue` read: what the scheduler is holding, what each item is blocked behind, and — in words — why nothing is dispatching. With deferred dispatch on, a stalled queue and a finished town draw the same blank page; this is the only thing that tells them apart, so it returns a *verdict* and the arithmetic behind it, not just a list. One `gt scheduler status --json`. Not `queue.py` (stdlib, and this directory is `sys.path[0]`) and not `dispatch.py` (the write above): this is the read that can only ever *say* why nothing is dispatching. |
| `backlog.py` | The `backlog` read: each rig's whole backlog with its structure intact — the epic hierarchy, the `blocks` edges, and why every closed bead closed. The Work tab's reads are all about this minute; this is the one a ceremony reads. Slowest cadence, biggest payload, trimmed hardest. Also owns the prose table behind `GET /api/bead` — the four long fields, kept beside the panel rather than in it — and `apply_write()`, which folds a bead the console just wrote into that cache so a save is visible before the next read lands. |
| `graph.py` | The same beads, drawn: epic trees and the `blocks` graph as SVG, laid out in stdlib Python. Not a read — it takes what `backlog.py` has already trimmed and rides inside that panel, so the picture and the lists beside it can never be a cadence apart. The one place markup is generated on the server, which is why it does its own escaping. Its nodes are controls rather than boxes — focusable, named, and read out in full by `app.js` — because every title in here is clipped to a pixel budget. |
| `static/index.html` | The whole page skeleton; every panel is an empty `<div id=…>`. The one exception to "static" is `<meta name="gt-dispatch">`, which the server fills in — see `_page()`. |

The **Plans tab** is the one view that is a document rather than a panel. It draws the same
`backlog` panel and the same `GET /api/bead` the Board's pane does, and opens the same two
forms; what it adds is a measure a three-thousand-character plan can be read at, a renderer
for the structure inside it, and a beat that says when an agent revised it mid-read (gc-e71).
Diagrams in a plan are deliberately still out of scope — every renderer for one is a
dependency, and that is a decision the operator has not made.

**It opens on the plans that are not closed, and that default is the feature** (gc-6z8). A
town finishes most of what it plans — nineteen plans, two of them live, the first time this
tab was pointed at a real backlog — so an unfiltered list is a history book with this week's
work buried in it. The status chips are `bd`'s own words, read off the plans actually in hand
so an unfamiliar status gets a chip rather than a silent omission; `active` is the one
grouping over that vocabulary and it is defined by subtraction, in those words, on the page.
Whatever the filters hold back is said in the index head, by count and by status — a filtered
list that looks like the whole list is a failure this console has hit more than once, and the
number above the rows is never the whole answer. Note what this tab does *not* borrow:
`workLane()`'s "being worked" substitution belongs to the two surfaces that ask what is
happening right now, and a derived lane here would be a third spelling of a bead's state on a
tab that asks what was written down.
| `static/app.js` | Fetch, state, and all rendering. Vanilla JS, no framework. Seven lists drill a row down into the rest of what its read already carried; the shared half of that is the "expandable detail" section near the top — `state.open`, `expandRow()`, `detailGrid()`, `prose()`, `paint()`, `expander()`. Expansion keys are namespaced per panel, because one flat set would let a mail id and a rig name mean the same row. It also carries the console's **one renderer** — `planBlocks()`/`planHtml()` in the "plans" section, which turns an agent's `design` field into headings, lists and preformatted blocks. It is hand-rolled and stays hand-rolled (a markdown dependency breaks constraint 1) and it stays on the *client* (a second server-side markup generator is what `graph.py`'s header asks not to have). It escapes every string before it adds a tag, and the only inline rule runs on the escaped text. |
| `static/app.css` | Themes via `:root` custom properties + `:root[data-theme="light"]`. |
| `start.sh` | Restart helper; `--lan` binds `0.0.0.0` and prints a tokenized URL. |

## Testing reality

There is no test suite. **`python3 server.py --demo` is how you verify a change** without a
live town — it seeds `_cache` from `demo.fixtures()`, never starts the scheduler, and never
runs `gt`. `POST /api/mail` returns 400 in demo rather than sending, which doubles as the
demo's one worked example of a write failing loudly.

**The bead writes work in demo, against the fixtures.** They run the same validation, produce
the same payloads and the same conflict shape, and skip only the `bd` call — `backlog.apply_write()`
patches the cached panel instead, which is what the live path uses anyway to stop the board
sitting on a stale title while the next read runs. So creating a bead, editing one and linking
two are all verifiable with no town attached, and the demo is where you check that a change to
`edit.py` still refuses what it should. Live is still where you check that `bd` agrees.

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
- **A bead's status is not activity, and no read in this console says outright who is
  working.** `gt sling` writes `hooked`; nothing on the sling path ever writes
  `in_progress`. The transition exists in gastown — `polecat_spawn.go` calls
  `polecat.Manager.SetState(StateWorking)` when the session starts — and that function
  skips the update when the bead is already `hooked`, which on the sling path it always
  is (gt-zecmc), while the compensating claim in `gt prime` was never built. So a lane
  keyed on status alone leaves an "in progress" column empty while polecats work in plain
  sight, which is one fact with three disagreeing sources again (hq-m2p, hq-r1e): the
  bead says hooked, `gt` says working, the pane says thinking. `workLane()` in `app.js`
  is the **one** place that answers "is somebody on this", by cross-referencing the
  assignee against the `panes` read, and both the Work tab and the Board tab draw through
  it. Every surface that draws the derived lane also prints the stored status beside it —
  the console may say what it thinks is happening and may never stop saying what the
  store holds (gc-sa1).
- Renderers must survive `null` data, an error string, and a still-loading panel — that is
  what `loadingOf()`, `errNote()`, and the skeleton placeholders are for.

## Conventions

- Commit messages reference the issue: `feat: thing (gc-xxx)`.
- Keep it one page and one file per concern; this project's readability *is* its documentation.
