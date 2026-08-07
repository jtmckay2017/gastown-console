"""The `backlog` read's picture of itself: epic trees and blocks chains, drawn as SVG.

The Backlog tab already lists everything this module draws. A list is the wrong shape
for two of the questions a planning session actually asks, though, and both of them are
about *edges* rather than about rows:

  "how much of this epic is stuck" — answerable from a list only by reading nineteen
  rows and holding the tally in your head, and answerable from a picture at a glance.
  "what is behind what" — not answerable from a list at all. A chain of three, where A
  blocks B blocks C, is three rows that each mention one id, sitting in three different
  places on a page sorted by something else. Nothing about the list says "chain".

So this draws the structure that is already in the payload rather than any new fact:
epics with their children, and the `blocks` edges as a left-to-right dependency graph.
Nothing here reads anything. `build()` takes the beads backlog.py has already trimmed
and returns markup, which is why it can live inside that read's cache entry instead of
becoming a second read with its own cadence — a picture that disagreed with the list
beside it for a minute at a time would read as a bug, and would be one.

WHY SERVER-SIDE. The alternative is shipping the same beads to the front end twice and
laying them out in JavaScript. Layout is the part with the arithmetic in it, `app.js`
is already the largest file in the project, and a layout pass is exactly the kind of
slow-ish pure computation the scheduler exists to absorb: it runs once per backlog
refresh, not once per render, and never on the request path (CLAUDE.md, hard).

WHY IT IS SAFE TO INJECT. `app.js` hand-escapes every interpolated value because every
value from `gt` and from `bd` is untrusted; this module emits *markup*, so it takes on
that obligation itself. Every dynamic value goes through `_txt()` — control characters
scrubbed, then `html.escape` with quotes — and the tag set is closed and written down
here: `svg g rect path text title`. No script, no event handler, no `foreignObject`, no
external reference, nothing whose content is a URL. Adding a tag to that list means
re-reading this paragraph first. SVG text is an injection surface exactly like HTML is.

SIZE. This rides the heaviest panel in the console on every snapshot, so it is capped
hard (MAX_EPICS, MAX_NODES) and drawn in the fewest elements that will do — one path
for a whole spine, `translate()` on a node group so its parts need no coordinates.
About 350 bytes a node with these long ids, which measures at 8KB for zombie_prototype's
19-child epic and 42KB for all seven of its open epics plus its blocks graph, on top of
that rig's 44KB of beads. If that ratio ever looks wrong, the lever is MAX_EPICS: the
trees are almost all of it and the blocks graph is a rounding error.

GEOMETRY. Pixels, not percentages: an SVG scaled to fit a phone is a legible diagram
turned into a grey smear. Everything here has a fixed width and the front end scrolls
it inside its own container (see `.fig-scroll`), which is why the epic tree stacks its
children in one column — narrow and tall fits a phone; wide and short does not.
"""

import html

# ---- type ------------------------------------------------------------------------
# There is no way to measure a string from here, so widths are budgeted by average
# advance. Both are a little generous: a title that stops one character early is
# invisible, a title that overflows its box is not.
PX_SANS = 6.15   # 11.5px UI font
PX_MONO = 6.3    # 10.5px mono, used for ids

# ---- epic tree -------------------------------------------------------------------
PAD = 8
NODE_W = 404     # epic header, and the right edge every child aligns to
TOP_H = 40       # the epic's own two-line box
SPINE_X = 16
KID_X = 34
ROW_H = 26
ROW_PITCH = 30
GAP_TOP = 12     # epic box to first child
ARC_MIN = 14     # how far the shallowest dependency arc bows into the gutter
# The id column, which is measured rather than fixed: a rig's ids are 20-odd characters
# here and three here are twice that, and an ellipsized id is worse than useless — it is
# the string the reader is about to search for. Every box grows by whatever the column
# takes beyond ID_W so the titles keep their room, and ID_MAX stops one pathological id
# from widening a whole diagram (it keeps its `<title>` tooltip).
ID_W = 62
ID_MAX = 172

# ---- blocks graph ----------------------------------------------------------------
BN_W = 208
BN_H = 26
BN_PITCH = 32
COL_GAP = 64

# Per rig. A backlog with more open epics than this has a different problem than a
# missing picture, and the count is reported rather than quietly clipped.
MAX_EPICS = 12
MAX_KIDS = 60
MAX_NODES = 80

LIVE = {"in_progress", "hooked"}
# Draw order inside an epic: what is stuck, then what is moving, then what is waiting,
# then what is finished. A ceremony reads the top of this list and stops.
GROUP = {"g-block": 0, "g-live": 1, "g-open": 2, "g-done": 3}


def _txt(value):
    """One untrusted string, ready to sit inside an SVG element. Control characters
    become spaces (an agent's title can carry anything, and most of them are not legal
    XML at all), runs of whitespace collapse because a node is one line, and the result
    is escaped including quotes so it is safe in an attribute too."""
    s = "".join(c if c >= " " and c != "\x7f" else " " for c in str(value or ""))
    return html.escape(" ".join(s.split()), quote=True)


def _fit(value, px, per=PX_SANS):
    """Clip to what will fit in `px`, then escape. Truncation happens before escaping
    so an entity is never cut in half — `&amp` is not `&amp;`."""
    s = " ".join(str(value or "").split())
    n = max(1, int(px / per))
    return _txt(s if len(s) <= n else s[:n - 1].rstrip() + "…")


def _closed(bead):
    return str(bead.get("status") or "").lower() == "closed"


def _cls(bead, blocked):
    if _closed(bead):
        return "g-done"
    if blocked:
        return "g-block"
    return "g-live" if str(bead.get("status") or "").lower() in LIVE else "g-open"


def _unmet(index):
    """id -> the blockers still in the way, matching what the list beside this draws
    (`unmetOf` in app.js): an edge to a closed bead is history, and an id that resolves
    to nothing at all is a foreign bead rather than a met dependency. A bead `bd` marks
    blocked by hand carries no edge, so it is folded in here as an empty list — which is
    still blocked."""
    out = {}
    for b in index.values():
        stuck = [x for x in (b.get("blocked_by") or [])
                 if not (x in index and _closed(index[x]))]
        if stuck or (not _closed(b) and str(b.get("status") or "").lower() == "blocked"):
            out[b["id"]] = stuck
    return out


def _id_w(rows):
    """How wide the id column has to be for these beads — see ID_W."""
    longest = max((len(str(b.get("id") or "")) for b in rows), default=0)
    return max(ID_W, min(ID_MAX, int(longest * PX_MONO) + 10))


def _node(x, y, w, cls, bead, idw=ID_W, label="", h=ROW_H, ty=None):
    """One bead as a box. The group carries the position so nothing inside it needs
    coordinates that depend on where it landed, which is most of why this is compact.
    `<title>` is the browser's own tooltip — the whole title, for the ones clipped to
    fit, with no hover machinery in the front end to go with it.

    Nothing here can measure text, so everything that shares the box takes its width out
    of the title's budget first. A title that stops early is fine; a title that runs
    under the blocked flag is the panel drawing over its own alarm."""
    title = " ".join(str(bead.get("title") or "").split())
    flag = 20 if cls == "g-block" else 0
    tail = len(label) * PX_SANS + 6 if label else 0
    base = h / 2 + 4 if ty is None else ty
    parts = [f'<g class="gn {cls}" transform="translate({x},{y})">',
             f'<title>{_txt(bead.get("id"))} · {_txt(title)}</title>',
             f'<rect width="{w}" height="{h}" rx="5"/>',
             f'<text class="gi" x="8" y="{base:g}">{_fit(bead.get("id"), idw - 8, PX_MONO)}</text>',
             f'<text x="{idw + 8}" y="{base:g}">'
             f'{_fit(title, w - idw - 16 - flag - tail)}</text>']
    if label:
        parts.append(f'<text class="gx" x="{w - 8 - flag}" y="{base:g}" '
                     f'text-anchor="end">{_txt(label)}</text>')
    if flag:
        # Colour alone is not a distinction — plenty of operators reading this will not
        # see red as red, and blocked is the one state the panel exists to surface. The
        # flag is shape, and it sits at the end of the row the eye is already on.
        parts.append(f'<path class="gw" d="M{w - 17},{h - 8}l5.5,-11l5.5,11z"/>')
    return "".join(parts) + "</g>"


def _svg(w, h, body, label):
    return (f'<svg class="fig-svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" '
            f'xmlns="http://www.w3.org/2000/svg" role="img" aria-label="{_txt(label)}">'
            f'{body}</svg>')


def _blocker_label(ids):
    """The unmet blockers that are not drawn in this picture, as the shortest thing
    that still names one. An id the reader can search for beats "3 blockers"."""
    if not ids:
        return ""
    return f"↤ {ids[0]}" + (f" +{len(ids) - 1}" if len(ids) > 1 else "")


def _epic(epic, kids, unmet):
    """One epic and its children: the epic across the top, its children in a single
    column under a spine, and the `blocks` edges *between those children* arced through
    a gutter on the right. The arcs are the reason this is a drawing — a chain that
    lives inside one epic is invisible in the list and obvious here."""
    idw = _id_w([epic, *kids])
    wide = NODE_W + idw - ID_W
    row = {b["id"]: i for i, b in enumerate(kids)}
    ytop = {b["id"]: TOP_H + GAP_TOP + i * ROW_PITCH for i, b in enumerate(kids)}
    cy = {k: v + ROW_H / 2 for k, v in ytop.items()}

    # Dependencies with both ends under this epic. A met one is drawn too, faintly: it
    # is the shape of the plan even once it has stopped costing anything.
    arcs = [(x, b["id"]) for b in kids for x in (b.get("blocked_by") or []) if x in row]
    gutter = 0
    for a, b in arcs:
        gutter = max(gutter, int(ARC_MIN + min(abs(row[a] - row[b]), 16) * 3.5) + 8)

    parts = []
    if kids:
        last = cy[kids[-1]["id"]]
        stubs = "".join(f"M{SPINE_X},{cy[b['id']]:g}H{KID_X}" for b in kids)
        parts.append(f'<path class="ge" d="M{SPINE_X},{TOP_H}V{last:g}{stubs}"/>')

    parts.append(_node(0, 0, wide, "g-epic", epic, idw, h=TOP_H, ty=18))
    done = sum(1 for b in kids if _closed(b))
    stuck = sum(1 for b in kids if b["id"] in unmet and not _closed(b))
    total = epic.get("kids") or len(kids)
    note = (f"{total} child{'' if total == 1 else 'ren'} · {done} closed"
            + (f" · {stuck} blocked" if stuck else ""))
    parts.append(f'<text class="gs" x="8" y="33">{_txt(note)}</text>')

    for b in kids:
        outside = [x for x in unmet.get(b["id"], []) if x not in row]
        parts.append(_node(KID_X, ytop[b["id"]], wide - KID_X,
                           _cls(b, b["id"] in unmet), b, idw, _blocker_label(outside)))

    for a, b in arcs:
        d = ARC_MIN + min(abs(row[a] - row[b]), 16) * 3.5
        ya, yb = cy[a], cy[b]
        met = "" if b in unmet and a in unmet.get(b, []) else " ge-past"
        parts.append(f'<path class="ge ge-dep{met}" d="M{wide},{ya:g}'
                     f'C{wide + d:g},{ya:g} {wide + d:g},{yb:g} {wide},{yb:g}"/>')
        # The arrow points back into the blocked bead, so the edge reads "this one is
        # waiting on that one" in the direction the eye travels.
        parts.append(f'<path class="ga{met}" d="M{wide},{yb:g}l7,-4l0,8z"/>')

    h = TOP_H + GAP_TOP + (len(kids) - 1) * ROW_PITCH + ROW_H if kids else TOP_H
    body = f'<g transform="translate({PAD},{PAD})">{"".join(parts)}</g>'
    label = f"{epic.get('id')}: {epic.get('title')} — {note}"
    return _svg(wide + gutter + PAD * 2, h + PAD * 2, body, label)


def _rank(nodes, edges):
    """Longest-path layering: a bead sits one column right of everything blocking it.
    Bounded by the node count rather than run to a fixed point, because `bd` will
    happily record a dependency cycle and a picture is not the place to discover it —
    the loop simply stops and the cycle draws as a backward edge."""
    rank = {n: 0 for n in nodes}
    for _ in range(len(nodes)):
        moved = False
        for a, b in edges:
            if rank[b] < rank[a] + 1:
                rank[b] = rank[a] + 1
                moved = True
        if not moved:
            break
    return rank


def _order(cols, edges):
    """Two barycentre sweeps — every node slides towards the average height of what it
    is joined to, forwards over its blockers and then backwards over what it blocks.
    Not optimal and not trying to be: at this size it is the difference between a
    readable diagram and a ball of wool, and a third sweep changes nothing."""
    for _ in range(2):
        for back in (False, True):
            for col in (reversed(cols) if back else cols):
                # Re-read after every column, so a sweep sees the neighbours it has
                # just moved rather than where they started.
                pos = {n: i for c in cols for i, n in enumerate(c)}
                ties = {n: i for i, n in enumerate(col)}
                near = {n: [] for n in col}
                for a, b in edges:
                    if back and a in near and b in pos:
                        near[a].append(pos[b])
                    elif not back and b in near and a in pos:
                        near[b].append(pos[a])
                col.sort(key=lambda n: (sum(near[n]) / len(near[n]) if near[n]
                                        else ties[n], ties[n]))
    return cols


def _root(bead, index):
    """The epic a bead hangs under — the topmost ancestor still in the payload, or the
    bead itself when it hangs under nothing. Guarded against a parent cycle, which `bd`
    does not forbid."""
    seen, at = set(), bead
    while at.get("parent") in index and at["parent"] not in seen:
        seen.add(at["id"])
        at = index[at["parent"]]
    return at["id"]


def _leaves_epic(a, b, index):
    """Does this dependency leave a plan? Different roots is not enough on its own: two
    unparented beads have two roots and no epic between them, which is an ordinary edge
    and not the expensive kind. It counts when at least one end sits under an epic and
    the other end is not under the same one — the case that costs a planning session,
    because neither epic's own page shows it."""
    return (_root(a, index) != _root(b, index)
            and (a.get("parent") in index or b.get("parent") in index))


def _blocks(index, unmet):
    """Every `blocks` edge in the rig, as a left-to-right dependency graph: earlier
    columns must finish before later ones.

    Every one of them, including the chains that have already been walked — eleven of
    zombie_prototype's seventeen have closed at both ends. Dropping those would draw a
    tidier picture of what is in the way today and would be the wrong panel: this is the
    one a retro reads, and "we planned it four deep and it took four passes" is the
    thing a retro is looking at. They recede instead of vanishing, greyed and thinned,
    and the caption says how many of the edges are already met."""
    edges, seen = [], set()
    for b in index.values():
        for x in (b.get("blocked_by") or []):
            if x in index and (x, b["id"]) not in seen:
                seen.add((x, b["id"]))
                edges.append((x, b["id"]))
    if not edges:
        return None
    nodes = list(dict.fromkeys([n for e in edges for n in e]))
    trimmed = len(nodes) - MAX_NODES
    if trimmed > 0:
        nodes = nodes[:MAX_NODES]
        keep = set(nodes)
        edges = [e for e in edges if e[0] in keep and e[1] in keep]

    idw = _id_w([index[n] for n in nodes])
    bw = BN_W + idw - ID_W
    rank = _rank(nodes, edges)
    cols = _order([[n for n in nodes if rank[n] == r] for r in range(max(rank.values()) + 1)],
                  edges)
    at = {}
    for c, col in enumerate(cols):
        for i, n in enumerate(col):
            at[n] = (c * (bw + COL_GAP), i * BN_PITCH)

    parts, cross, met = [], 0, 0
    for a, b in edges:
        (xa, ya), (xb, yb) = at[a], at[b]
        far = _leaves_epic(index[a], index[b], index)
        cross += far
        past = not (b in unmet and a in unmet.get(b, []))
        met += past
        bow = COL_GAP * 0.6 + abs(xb - xa) * 0.08
        ya, yb = ya + BN_H / 2, yb + BN_H / 2
        parts.append(f'<path class="ge ge-dep{" ge-cross" if far else ""}'
                     f'{" ge-past" if past else ""}" '
                     f'd="M{xa + bw},{ya:g}C{xa + bw + bow:g},{ya:g} '
                     f'{xb - bow:g},{yb:g} {xb},{yb:g}"/>')
        parts.append(f'<path class="ga{" ge-past" if past else ""}" '
                     f'd="M{xb},{yb:g}l-7,-4l0,8z"/>')
    # Nodes last so an edge never draws across a box it is not joined to.
    for n in nodes:
        x, y = at[n]
        parts.append(_node(x, y, bw, _cls(index[n], n in unmet), index[n], idw))

    w = (len(cols) - 1) * (bw + COL_GAP) + bw
    h = max(len(c) for c in cols) * BN_PITCH - (BN_PITCH - BN_H)
    return {
        "nodes": len(nodes), "edges": len(edges), "cross": cross, "met": met,
        "depth": len(cols), "trimmed": max(0, trimmed),
        "svg": _svg(w + PAD * 2, h + PAD * 2,
                    f'<g transform="translate({PAD},{PAD})">{"".join(parts)}</g>',
                    f"{len(edges)} dependency edges over {len(nodes)} beads, "
                    f"{len(cols)} deep"),
    }


def build(beads):
    """One rig's pictures, from the beads that rig's panel already carries. Returns the
    `graphs` block backlog.py hangs off its payload — never raises, because a rig whose
    plan cannot be drawn still has a plan worth listing."""
    index = {b["id"]: b for b in beads if b.get("id")}
    unmet = _unmet(index)
    kids = {}
    for b in beads:
        if b.get("parent") in index:
            kids.setdefault(b["parent"], []).append(b)

    # A closed epic is history; the tab lists it and nobody plans against it. What is
    # left is ordered biggest first, because the crowded one is the one a picture earns
    # its place on.
    parents = sorted((index[p] for p in kids if not _closed(index[p])),
                     key=lambda b: (-(b.get("kids") or len(kids[b["id"]])), b["id"]))
    epics = []
    for epic in parents[:MAX_EPICS]:
        # Grouped before the cap bites, so an epic too big to draw whole loses its
        # oldest closed children rather than the blocked ones it is being read for.
        drawn = sorted(kids[epic["id"]],
                       key=lambda b: GROUP[_cls(b, b["id"] in unmet)])[:MAX_KIDS]
        epics.append({
            "id": epic["id"], "title": epic.get("title") or "",
            "kids": epic.get("kids") or len(kids[epic["id"]]), "drawn": len(drawn),
            "blocked": sum(1 for b in drawn if b["id"] in unmet and not _closed(b)),
            "svg": _epic(epic, drawn, unmet),
        })
    return {"epics": epics, "epics_total": len(parents), "blocks": _blocks(index, unmet)}
