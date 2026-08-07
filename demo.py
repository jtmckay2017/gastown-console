"""Synthetic fixtures for `--demo`, so the console can be explored (and screenshotted)
without a live Gas Town workspace."""

import time
from collections import Counter
from datetime import datetime, timedelta, timezone

import graph


def _ago(**kw):
    return (datetime.now(timezone.utc) - timedelta(**kw)).isoformat().replace("+00:00", "Z")


def _agent(name, address, role, session, running=True, state="idle", work=False, mail=0,
           subject=None):
    # first_subject is always present in `gt status --json` — null when there is no
    # unread mail. It is the subject of the oldest unread message.
    return {"name": name, "address": address, "session": session, "role": role,
            "running": running, "acp": False, "has_work": work, "state": state,
            "unread_mail": mail, "first_subject": subject,
            "agent_alias": "claude", "agent_info": "claude"}


def _mail(mid, sender, subject, *, body="", read=False, type="notification",
          priority="normal", thread="", reply_to="", wisp=False, **when):
    """One row of `gt mail inbox --json`. Every key here is one gt actually sends; the
    optional ones are omitted when empty exactly as gt omits them, so the console's
    "field missing" path is the one the demo exercises for them."""
    m = {"id": mid, "from": sender, "to": "mayor/", "subject": subject, "body": body,
         "timestamp": _ago(**when), "read": read, "priority": priority, "type": type,
         "delivery_state": "acked", "delivery_acked_by": "mayor/",
         "delivery_acked_at": _ago(**when)}
    if thread:
        m["thread_id"] = thread
    if reply_to:
        m["reply_to"] = reply_to
    if wisp:
        m["wisp"] = True
    return m


def _pane(activity, note="", staged="", attached=False):
    """One entry of the `panes` read, shaped exactly as panes.by_session() returns it.
    Demo mode never opens a real tmux socket, so these are the only panes it sees."""
    return {"activity": activity, "note": note, "staged": staged, "attached": attached}


def _screen(pane, *body):
    """A synthetic Claude Code screen for the `watch` read, shaped the way capture-pane
    hands one over: transcript, the status line, the input box, the footer. Box-drawing
    characters are in here on purpose — they are most of what a real pane is made of,
    and the watch panel has to render them at phone width without breaking the page."""
    rule = "─" * 66
    lines = ["", *body, ""]
    if pane["note"]:
        lines += [pane["note"], ""]
    lines += ["╭" + rule + "╮",
              ("│ ❯ " + pane["staged"]).ljust(67) + "│",
              "╰" + rule + "╯",
              "  esc to interrupt · ctrl+t for todos" if pane["activity"] == "working"
              else "  ? for shortcuts · /help for commands"]
    return "\n".join(lines)


def _issue(id_, title, priority, type_="task", parent=None, hours=3):
    return {"id": id_, "title": title, "priority": priority, "issue_type": type_,
            "status": "open", "parent": parent, "created_at": _ago(days=2),
            "updated_at": _ago(hours=hours), "description": ""}


def _flight(id_, title, priority, status, assignee, rig, type_="task", **ago):
    """One entry of the `flight` read, shaped exactly as flight.in_flight() returns it
    — already projected down, so no description and no acceptance criteria."""
    return {"id": id_, "title": title, "priority": priority, "issue_type": type_,
            "status": status, "assignee": assignee, "rig": rig, "parent": None,
            "created_at": _ago(days=2), "updated_at": _ago(**ago)}


def _bead(id_, title, type_, priority, status="open", parent=None, assignee="",
          reason="", desc="", blocked_by=(), more=False, plan=False, **ago):
    """One entry of the `backlog` read, shaped exactly as backlog._project() returns it
    — already trimmed, empty fields absent rather than null, and prose (`desc`,
    `close_reason`) only where prose is the answer."""
    at = _ago(**(ago or {"hours": 5}))
    out = {"id": id_, "title": title, "issue_type": type_, "priority": priority,
           "status": status, "created_at": _ago(days=9), "updated_at": at}
    if status == "closed":
        out["closed_at"] = at
    for key, value in (("parent", parent), ("assignee", assignee),
                       ("close_reason", reason), ("desc", desc),
                       ("blocked_by", list(blocked_by))):
        if value:
            out[key] = value
    if more:
        out["more"] = True          # the server clipped it at backlog.CLIP
    if plan:
        # Somebody wrote a design or acceptance criteria for this one. The board marks
        # it; the pane draws it, out of prose() rather than out of the panel.
        out["plan"] = True
    return out


def _backlog_rig(label, rows, scaffolding=0):
    """One rig's block of the `backlog` read. The counts are computed off the beads
    rather than written down, so a fixture can never claim a distribution it does not
    have; `scaffolding` is the convoy/molecule/rig beads the real read counts in
    `total` and then declines to draw."""
    closed = [b for b in rows if b["status"] == "closed"]
    # `kids`/`kids_closed` are the server's own count over the whole backlog rather than
    # over what survived its caps (see backlog.py) — here nothing is capped, so counting
    # the fixture is the same thing, and keeps the two from drifting apart by hand.
    kids = Counter(b["parent"] for b in rows if b.get("parent"))
    for b in rows:
        if kids[b["id"]]:
            b["kids"] = kids[b["id"]]
            b["kids_closed"] = sum(1 for k in rows
                                   if k.get("parent") == b["id"] and k["status"] == "closed")
    return {"rig": label, "total": len(rows) + scaffolding, "work": len(rows),
            "status": dict(Counter(b["status"] for b in rows)),
            "type": dict(Counter(b["issue_type"] for b in rows)),
            "open_total": len(rows) - len(closed), "closed_total": len(closed),
            "beads": rows,
            # Drawn by the same code the live read draws with, off the same beads, so
            # demo exercises the layout rather than a picture of a picture.
            "graphs": graph.build(rows)}


def prose(backlog_block):
    """The Board tab's planning pane, seeded. This is NOT part of fixtures() — the
    prose rides beside the backlog panel rather than in it (see backlog.py), so it is
    seeded through backlog.load_prose() instead, and fixtures() keeps returning exactly
    the keys in READS. It is handed the backlog fixture because the live table's key set
    is every carried bead, prose or not: a bead with nothing written on it must answer
    "nothing written down" and not "not carried", so the blanks are filled in below off
    the same beads the board will draw.

    Four cases here are load-bearing, and they are the ones the bead asks demo to show:

      wp-110  an epic with nineteen children, whose description runs past the clip the
              panel carries — so the pane visibly holds more than the card does.
      wp-120  a card carrying BOTH a proposed plan and acceptance criteria, which is
              the pair the pane exists for.
      wp-122  a blocked card, so the pane's blocked-by list has something real above
              prose that says what the block is actually about.
      wp-90   closed with a reason, and notes underneath it — the retro case.

    Most beads carry nothing, which is also true of most real beads: the pane says so
    rather than drawing four empty headings."""
    written = {
        "town": {
            "hq-51c": {
                "desc": "Three rigs want to cut a release in the same week and two of "
                        "them share a dependency. Freeze order matters.",
                "acceptance": "A written order of freeze, agreed by each rig's witness, "
                              "with the shared dependency named explicitly.",
            },
        },
        "web_platform": {
            "wp-110": {
                "desc": "Six button variants exist across the app, and two of them "
                        "differ only in a border radius nobody chose deliberately. "
                        "Every new screen picks one at random, so the difference is "
                        "load-bearing in a handful of places and cosmetic in the rest "
                        "— which is why this cannot be a find-and-replace.\n\n"
                        "The work is to land two variants, primary and quiet, behind "
                        "shared tokens, and then migrate call sites screen by screen "
                        "rather than in one sweep, so any regression is always "
                        "traceable to a single screen's diff.\n\n"
                        "Scope explicitly excludes the marketing site, which has its "
                        "own design system and its own team.",
                "design": "Tokens first (wp-142), then repoint the shared Button "
                          "component at them (wp-141), then migrate screens, then "
                          "delete the dead variants last (wp-140). Deleting first "
                          "would strand every unmigrated screen.",
                "acceptance": "Two variants remain in the component library; no screen "
                              "imports a deleted variant; the visual diff on each "
                              "migrated screen is reviewed by its owner.",
            },
            "wp-120": {
                "desc": "A session cookie survives a privilege change, so a token "
                        "minted before an account was granted admin still carries the "
                        "old claims until it expires.",
                "design": "Rotate on every privilege transition rather than on "
                          "elevation only — demotion is the case that actually leaks, "
                          "and it is the one nobody writes the test for. The rotation "
                          "hook goes in the session middleware, not in each caller.",
                "acceptance": "A privilege change issues a new session id; the old id "
                              "is rejected immediately; a test covers demotion as well "
                              "as elevation.",
                "notes": "Toast: middleware hook is in. Writing the demotion test now.",
            },
            "wp-122": {
                "desc": "Checkout retries can double-charge when the network drops "
                        "between the authorisation and the confirmation.",
                "acceptance": "A replayed retry with the same idempotency key returns "
                              "the first result rather than charging twice.",
                "notes": "Waiting on wp-120: the key is derived from the session id, "
                         "so the rotation has to land first or the key changes under "
                         "the retry.",
            },
            "wp-90": {
                "reason": "Closed without a change: the second copy is the one every "
                          "screen imports, and the 'original' has no call sites left.\n"
                          "Deleting the original instead — filed as wp-111.",
                "notes": "Checked all 41 import sites by hand before closing this. The "
                         "two copies had drifted: the 'original' still parsed two-digit "
                         "years, which is why nothing imports it.",
            },
        },
        "billing_api": {
            "ba-30": {
                "desc": "Three separate reports of totals drifting by a cent, all of "
                        "them on refunds split across two payment methods. Treat the "
                        "rounding rule as the deliverable, not each symptom.",
                "design": "One rounding rule, applied at the ledger boundary rather "
                          "than per payment method. Each method rounding its own share "
                          "is what produces the drift.",
                "acceptance": "A split refund reconciles to the cent against the "
                              "ledger for every split the fixtures cover.",
            },
            "ba-40": {
                "desc": "Reconcile the split-refund rounding against the ledger and "
                        "write down which side is authoritative.",
                "notes": "Toast: the ledger is authoritative. Two of the three reports "
                         "are the same bug seen from different currencies.",
            },
        },
        "mobile_app": {
            "ma-18": {
                "desc": "Push tokens are not re-registered after a device restore, so "
                        "a restored phone silently stops receiving notifications.",
                "notes": "Marked blocked by hand — waiting on the platform team to say "
                         "whether the restore hook fires at all on Android 14. No bead "
                         "to point at yet.",
            },
        },
    }
    return {r["rig"]: {b["id"]: written.get(r["rig"], {}).get(b["id"], {})
                       for b in r["beads"]}
            for r in backlog_block["rigs"]}


def _tracked(id_, title, status, assignee=""):
    """One entry of a convoy's `tracked` list, as `gt convoy list --json` carries it."""
    return {"id": id_, "title": title, "status": status, "assignee": assignee,
            "dependency_type": "tracks", "issue_type": "task"}


def fixtures():
    # mobile_app is parked: a healthy state that used to be indistinguishable from a
    # crash, so the demo has to contain one. Its agents are stopped and stay stopped.
    rigs_meta = [
        ("web_platform", "wp", 3, "operational"),
        ("billing_api", "ba", 1, "operational"),
        ("mobile_app", "ma", 0, "parked"),
    ]

    rig_blocks = []
    for name, prefix, polecats, rig_status in rigs_meta:
        up = rig_status == "operational"
        agents = [
            _agent("witness", f"{name}/witness", "witness", f"{prefix}-witness", running=up),
            _agent("refinery", f"{name}/refinery", "refinery", f"{prefix}-refinery",
                   running=up, work=bool(polecats)),
        ]
        for i in range(polecats):
            pc = ["Toast", "Slit", "Nux"][i]
            # A finished polecat reports state="done" with its process gone; keep one
            # in the fixture so --demo shows the Done group, not just working/idle.
            done = pc == "Nux"
            agents.append(_agent(pc, f"{name}/{pc}", "polecat", f"{prefix}-{pc.lower()}",
                                 running=not done, state="done" if done else "idle",
                                 work=not done, mail=1 if i == 0 else 0,
                                 subject="PR ready: session rotation fix" if i == 0 else None))
        if polecats:
            # billing_api's crew workspace exists but was never started — no session,
            # no pane, nothing wrong. It must not read like the parked rig or a crash.
            started = name == "web_platform"
            agents.append(_agent("joel", f"{name}/crew/joel", "crew",
                                 f"{prefix}-crew-joel", running=started))
        # `gt status --json` names the polecats and the crew as well as counting them —
        # verified against a live town. The names go under the fold on the Rigs card,
        # so a fixture that carried only the counts would leave that panel half empty.
        rig_blocks.append({
            "name": name,
            "polecats": [a["name"] for a in agents if a["role"] == "polecat"],
            "polecat_count": polecats,
            "crews": [a["name"] for a in agents if a["role"] == "crew"],
            "crew_count": 1 if polecats else 0, "has_witness": True, "has_refinery": True,
            "hooks": [{"agent": f"{name}/{a['name']}", "role": a["role"],
                       "has_work": a["has_work"]} for a in agents],
            "agents": agents,
        })

    status = {
        "name": "gt", "location": "~/gt",
        "overseer": {"name": "Demo Overseer", "email": "demo@example.com",
                     "username": "demo", "source": "git-config", "unread_mail": 2},
        "daemon": {"running": True, "pid": 4242},
        "dolt": {"running": True, "pid": 4243, "port": 3307, "data_dir": "~/gt/.dolt-data"},
        "tmux": {"socket": "gt-demo", "running": True, "pid": 4244, "session_count": 11},
        # The mayor and the deacon are the demo's whole argument: gt reports both as
        # state=idle with an empty hook, and their panes (below) say one is mid-turn
        # and the other stranded on an unsent answer. Do not "fix" these to working —
        # reading idle here while the tab reads Working is the point.
        "agents": [_agent("mayor", "mayor/", "coordinator", "hq-mayor", mail=2,
                          subject="Escalation: invoice totals drift on split refunds"),
                   _agent("deacon", "deacon/", "health-check", "hq-deacon")],
        "rigs": rig_blocks,
        "summary": {"rig_count": 3, "polecat_count": 4, "crew_count": 2, "witness_count": 3,
                    "refinery_count": 3, "active_hooks": 6},
    }

    rigs = [{"name": n, "beads_prefix": p, "status": st,
             "witness": "running" if st == "operational" else "stopped",
             "refinery": "running" if st == "operational" else "stopped",
             "polecats": c, "crew": 1 if c else 0}
            for n, p, c, st in rigs_meta]

    # The deacon's dog pack. `gt dog list --json` names no tmux session, so the front
    # end matches a dog to one by name — charlie is registered but has no session at
    # all, which is how a dog that was never started should read.
    dogs = [
        {"name": "alpha", "state": "working", "last_active": _ago(minutes=1),
         "worktrees": {"web_platform": "~/gt/deacon/dogs/alpha/web_platform"}},
        {"name": "bravo", "state": "idle", "last_active": _ago(hours=2),
         "worktrees": {"web_platform": "~/gt/deacon/dogs/bravo/web_platform"}},
        {"name": "charlie", "state": "idle", "last_active": _ago(days=1), "worktrees": {}},
    ]

    # Keyed by tmux session, exactly as panes.by_session() returns it. Every session
    # a demo agent claims appears here; a stopped agent has none. hq-boot claims none
    # of them — it is the unclaimed-session case, an agent no `gt` read lists at all.
    # ("unknown" — a session whose screen we could not read — has no fixture; it is a
    # failure mode, not a state of the town.)
    panes = {
        "hq-mayor": _pane("working", "✳ Deliberating… (4m 12s · ↓ 18.2k tokens)"),
        "hq-deacon": _pane("staged", "✻ Brewed for 5m 7s",
                           "run continuously until something needs me"),
        "hq-boot": _pane("idle", "✻ Sautéed for 23s"),
        "hq-dog-alpha": _pane("working", "✻ Reaping… (48s · ↓ 2.1k tokens)"),
        "hq-dog-bravo": _pane("idle", "✻ Simmered for 1m 4s"),
        "wp-witness": _pane("working", "✽ Julienning… (11m 6s · ↓ 31.1k tokens)"),
        "wp-refinery": _pane("idle", "✻ Cooked for 19s · 1 shell still running"),
        "wp-toast": _pane("working", "✻ Churning… (2m 38s · ↓ 9.4k tokens)"),
        # Assigned but not thinking: a bead on its hook and an empty prompt. Before
        # gc-vy3 this and wp-toast were the same row.
        "wp-slit": _pane("idle", "✻ Cooked for 6s"),
        # Attached — someone is sitting in this pane, so unsent text is as likely to
        # be a human mid-sentence as a stranding, and the row says so.
        "wp-crew-joel": _pane("staged", "✻ Sautéed for 12s", "take wp-111", attached=True),
        "ba-witness": _pane("idle", "✻ Brewed for 3s"),
        "ba-refinery": _pane("idle", "✻ Cooked for 41s"),
        "ba-toast": _pane("working", "✳ Percolating… (55s · ↓ 3.7k tokens)"),
    }

    # The `watch` read: one agent's whole screen, keyed by tmux session exactly as
    # panes.watched() returns it. Every session above gets one, because the terminal
    # affordance appears on every session the panes read knows about — a demo where
    # half the icons open an empty panel would read as a bug in the feature.
    transcripts = {
        "hq-mayor": [
            "● I'll work out which rig should take the split-refund bug.",
            "",
            "● Bash(gt rig list --json)",
            "  ⎿  3 rigs · billing_api operational, 1 polecat idle",
            "",
            "● billing_api owns the ledger code, so it goes there. Slinging ba-31.",
        ],
        "hq-deacon": [
            "● Patrol complete. 3 rigs checked, no stalled sessions.",
            "",
            "  Next patrol would normally start on its own, but you asked me to",
            "  confirm the cadence first.",
        ],
        "wp-toast": [
            "● Read(app/session.py)",
            "  ⎿  Read 214 lines",
            "",
            "● The cookie is reissued on login but not on privilege change — that is",
            "  the whole bug. Rotating in _elevate() covers both call sites.",
            "",
            "● Update(app/session.py)",
            "  ⎿  Updated with 6 additions and 1 removal",
            "",
            "● Bash(pytest tests/test_session.py -q)",
            "  ⎿  14 passed in 1.82s",
        ],
        "wp-witness": [
            "● Bash(gt mq list --json)",
            "  ⎿  2 MRs queued · wp-120 pre-verified, wp-118 needs gates",
            "",
            "● Verifying wp-118 before the refinery batches it.",
        ],
        "wp-crew-joel": [
            "● Anything else you want picked up this afternoon?",
        ],
    }
    generic = [
        "● Bash(gt hook)",
        "  ⎿  Nothing on the hook.",
        "",
        "● Standing by.",
    ]
    watch = {s: _screen(p, *transcripts.get(s, generic)) for s, p in panes.items()}

    ready = {
        "sources": [
            {"name": "town", "issues": [
                _issue("hq-e2u", "Patrol wisps invisible to hook reporting", 1, "bug", hours=1),
                _issue("hq-48m", "Adopting an existing repo skips provisioning", 2, "bug", hours=6),
            ]},
            {"name": "web_platform", "issues": [
                _issue("wp-110", "Design system: consolidate 6 button variants into 2", 2, "epic", hours=9),
                _issue("wp-101", "Session cookie is not rotated after privilege change", 1, "bug", hours=2),
                _issue("wp-111", "Replace hand-rolled date parsing with the shared helper", 3, "task", "wp-110", 20),
                _issue("wp-104", "Checkout flow loses cart on slow networks", 1, "bug", hours=4),
            ]},
            {"name": "billing_api", "issues": [
                _issue("ba-31", "Invoice totals drift by a cent on split refunds", 0, "bug", hours=1),
                _issue("ba-34", "Retry webhook deliveries with exponential backoff", 2, "feature", hours=12),
                _issue("ba-38", "Drop the legacy /v1 pricing endpoint", 3, "chore", hours=30),
            ]},
            {"name": "mobile_app", "issues": [
                _issue("ma-12", "Cold start regressed to 2.4s on mid-tier Android", 1, "bug", hours=5),
                _issue("ma-15", "Offline queue replays out of order", 2, "bug", hours=26),
            ]},
        ],
    }
    counts = {f"p{i}_count": 0 for i in range(5)}
    for s in ready["sources"]:
        for i in s["issues"]:
            counts[f"p{i['priority']}_count"] += 1
    ready["summary"] = {"total": sum(counts.values()),
                        "by_source": {s["name"]: len(s["issues"]) for s in ready["sources"]},
                        **counts}

    # The models panel, keyed by agent address exactly as models.by_agent() returns it.
    # Demo never opens a real transcript. Slit is deliberately left out: an agent the
    # server cannot map to a transcript with certainty shows no model at all, and the
    # demo is the only place a contributor sees that case.
    by_role = {"coordinator": "claude-opus-5", "health-check": "claude-haiku-4-5-20251001",
               "witness": "claude-opus-5", "refinery": "claude-sonnet-5",
               "polecat": "claude-opus-5"}
    models = {a["address"]: by_role[a["role"]]
              for a in [*status["agents"], *(a for r in rig_blocks for a in r["agents"])]
              if a["role"] in by_role}
    models.pop("web_platform/Slit", None)

    # The `backlog` read: the whole planned shape, per rig, as backlog.by_rig() returns
    # it. Four things in here are load-bearing and none of them are decoration:
    #
    #   wp-110 and ba-30 are epics with children, so the tree has something to expand
    #     and the child counts have something to count. wp-110 carries a clipped
    #     description (more:True) — the only place a contributor sees that case.
    #   wp-122 is blocked by wp-120, which is hooked, so the Blocked section has a
    #     genuine unmet blocker to name.
    #   wp-111 is blocked by wp-98, which is CLOSED — so it must NOT appear as blocked.
    #     A viewer that reads the edge without reading the blocker's status shows this
    #     one as stuck forever, which is the bug this fixture exists to catch.
    #   The in-flight statuses match the `flight` fixture below bead for bead, because
    #     the tab's In progress section is that read, not a second copy of it.
    wp_epic = (
        "Six button variants exist across the app, and two of them differ only in a\n"
        "border radius nobody chose deliberately. Every new screen picks one at random,\n"
        "so the difference is load-bearing in a handful of places and cosmetic in the\n"
        "rest — which is why this cannot be a find-and-replace.\n\n"
        "The work is to land two variants, primary and quiet, behind shared tokens, and\n"
        "then migrate call sites screen by screen rather than in one sweep, so any\n"
        "regression is always traceable to a single…")
    backlog = {"rigs": [
        _backlog_rig("town", [
            _bead("hq-51c", "Draft the cross-rig freeze plan for the release", "feature",
                  1, "in_progress", assignee="mayor/", plan=True, minutes=3),
            _bead("hq-e2u", "Patrol wisps invisible to hook reporting", "bug", 1, hours=1),
            _bead("hq-48m", "Adopting an existing repo skips provisioning", "bug", 2, hours=6),
            _bead("hq-33p", "Escalations were mailed twice on every retry", "bug", 1,
                  "closed", reason="Fixed in gt 0.9.4 — the retry loop was re-sending "
                  "the notification instead of the escalation.", days=2),
        ], scaffolding=2),
        _backlog_rig("web_platform", [
            _bead("wp-110", "Design system: consolidate 6 button variants into 2", "epic",
                  2, desc=wp_epic, more=True, plan=True, hours=9),
            _bead("wp-120", "Rotate the session cookie on privilege change", "bug", 1,
                  "hooked", parent="wp-110", assignee="web_platform/polecats/Toast",
                  plan=True, minutes=6),
            _bead("wp-121", "Consolidate the button variants behind shared tokens", "task",
                  2, "hooked", parent="wp-110", assignee="web_platform/Slit", minutes=52),
            _bead("wp-122", "Checkout retry needs the new idempotency key", "task", 2,
                  "blocked", parent="wp-110", blocked_by=["wp-120"], plan=True,
                  hours=4),
            _bead("wp-111", "Replace hand-rolled date parsing with the shared helper",
                  "task", 3, parent="wp-110", blocked_by=["wp-98"], hours=20),
            # A chain of three under one epic: wp-141 cannot start until wp-142 does,
            # and wp-140 waits on both. This is the shape the map exists for — in the
            # lists it is three rows in three places that each name one id.
            _bead("wp-142", "Land the primary and quiet tokens in the theme file", "task",
                  1, "in_progress", parent="wp-110", assignee="web_platform/Toast",
                  minutes=18),
            _bead("wp-141", "Point the shared Button at the new tokens", "task", 1,
                  parent="wp-110", blocked_by=["wp-142"], hours=7),
            _bead("wp-140", "Delete the four dead button variants", "task", 2,
                  parent="wp-110", blocked_by=["wp-141"], hours=8),
            # The expensive surprise: a dependency that leaves the epic. wp-104 is a
            # top-level bug, so this edge crosses two plans and draws as a crossing.
            _bead("wp-143", "Restyle the checkout call to action", "task", 2,
                  parent="wp-110", blocked_by=["wp-104"], hours=11),
            # And the crowded case — the one a five-child fixture never tests. Nineteen
            # children under one epic is what a screen-by-screen migration actually
            # looks like, and what the biggest epic in this town holds.
            *[_bead(f"wp-{150 + i}", f"Migrate {screen} to the shared button tokens",
                    "task", 3, status, parent="wp-110",
                    reason=f"Merged in #48{i}." if status == "closed" else "",
                    hours=12 + i * 3)
              for i, (screen, status) in enumerate([
                  ("the settings screens", "closed"), ("the onboarding flow", "closed"),
                  ("the profile editor", "closed"), ("search", "open"),
                  ("the admin console", "open"), ("billing", "open"),
                  ("the empty states", "open"), ("the mobile nav", "open"),
                  ("the marketing pages", "open"), ("the help centre", "open")])],
            _bead("wp-101", "Session cookie is not rotated after privilege change", "bug",
                  1, hours=2),
            _bead("wp-104", "Checkout flow loses cart on slow networks", "bug", 1, hours=4),
            _bead("wp-98", "Cache the pricing table per request", "task", 2, "closed",
                  parent="wp-110", reason="Merged in #479.", hours=3),
            _bead("wp-90", "Drop the second copy of the date formatter", "chore", 3,
                  "closed", reason="Closed without a change: the second copy is the one\n"
                  "every screen imports, and the 'original' has no call sites left.\n"
                  "Deleting the original instead — filed as wp-111.", days=3),
        ], scaffolding=1),
        _backlog_rig("billing_api", [
            _bead("ba-30", "Ledger correctness for split refunds", "epic", 1,
                  desc="Three separate reports of totals drifting by a cent, all of them "
                  "on refunds split across two payment methods. Treat the rounding rule "
                  "as the deliverable, not each symptom.", plan=True, hours=1),
            _bead("ba-40", "Reconcile split-refund rounding against the ledger", "bug", 0,
                  "in_progress", parent="ba-30", assignee="billing_api/Toast", minutes=22),
            _bead("ba-31", "Invoice totals drift by a cent on split refunds", "bug", 0,
                  parent="ba-30", blocked_by=["ba-40"], hours=1),
            _bead("ba-34", "Retry webhook deliveries with exponential backoff", "feature",
                  2, hours=12),
            _bead("ba-38", "Drop the legacy /v1 pricing endpoint", "chore", 3, hours=30),
            _bead("ba-29", "Backfill missing customer tax ids", "chore", 2, "closed",
                  parent="ba-30", reason="Merged in #477.", hours=7),
        ]),
        # A parked rig still has a backlog, and a ceremony is exactly when somebody
        # wants to look at it.
        _backlog_rig("mobile_app", [
            _bead("ma-12", "Cold start regressed to 2.4s on mid-tier Android", "bug", 1,
                  hours=5),
            _bead("ma-15", "Offline queue replays out of order", "bug", 2,
                  blocked_by=["ma-12"], hours=26),
            # Marked blocked by hand, with no edge to say by what. A common shape and
            # the one a viewer that only reads edges misses entirely.
            _bead("ma-18", "Push tokens are not re-registered after a restore", "bug", 2,
                  "blocked", hours=30),
            _bead("ma-9", "Fix crash on empty push payload", "bug", 1, "closed",
                  reason="Merged in #471.", days=1),
            # Closed with no reason recorded — most beads are. It has nothing under the
            # fold, so it must draw as a row rather than as a button onto an empty box.
            _bead("ma-4", "Bump the crash reporter past the 3.x deprecations", "chore", 3,
                  "closed", days=4),
        ]),
    ]}

    return {
        "status": status,
        "rigs": rigs,
        "ready": ready,
        "dogs": dogs,
        "models": models,
        "panes": panes,
        "watch": watch,
        "backlog": backlog,
        # Every list below arrives deliberately out of order — the console sorts each one
        # newest-first itself (gc-feh), and a pre-sorted fixture would hide a regression.
        # `gt mail inbox --json`, real shape — verified against a live town, and richer
        # than this fixture used to admit. The body is the message and it is multi-line;
        # the routing (to, thread_id, reply_to) and the delivery receipt (state, who
        # acked it, when) all arrive on every row. gt dates these with `timestamp`, not
        # `created_at`. One message deliberately has no body at all — mail a wisp raised
        # often carries only a subject — so the detail panel's "no message to show" path
        # is exercised rather than only its happy one.
        "mail": [
            _mail("m-9c1", "deacon/", "Nightly patrol clean across 3 rigs", hours=8,
                  read=True, thread="thread-4b21c0", body=(
                      "Patrol complete. 3 rigs, 11 sessions, no stalls.\n\n"
                      "  web_platform   ok   5 sessions\n"
                      "  billing_api    ok   3 sessions\n"
                      "  mobile_app     parked (expected)\n\n"
                      "Next patrol in 6h.")),
            _mail("m-9e7", "billing_api/refinery", "Merge queue drained — 3 landed",
                  minutes=41, thread="thread-8f0d91", reply_to="m-9b3", type="reply",
                  body=("Queue is empty. Landed ba-29, ba-30 and wp-98 in that order; "
                        "ba-31 held back, it wants the escalation answered first.")),
            _mail("m-9f2", "web_platform/Toast", "PR ready: session rotation fix",
                  minutes=6, type="task", priority="high", thread="thread-8f0d91", body=(
                      "PR #482 is up and green.\n\n"
                      "WHAT CHANGED. The session cookie is now rotated on every "
                      "privilege change rather than only at login, which closes the "
                      "window where an escalated session kept its pre-escalation id.\n\n"
                      "WHAT I COULD NOT TEST. The SSO path — the staging IdP has been "
                      "down since yesterday. Everything else is covered.\n\n"
                      "Needs a review before it can go in the queue.")),
            _mail("m-9g8", "hq/wisp-2ka", "Wisp raised: stale hook on mobile_app/Nux",
                  minutes=18, wisp=True, thread="hq-wisp-2ka"),
        ],
        "escalations": [
            {"id": "ba-31", "title": "[HIGH] Invoice totals drift on split refunds — needs a human call",
             "created_at": _ago(hours=1)},
        ],
        "trail": [
            {"title": "slung ma-12 to Nux", "agent": "mayor/", "rig": "mobile_app", "at": _ago(minutes=35)},
            {"title": "restarted a stalled session", "agent": "web_platform/witness",
             "rig": "web_platform", "at": _ago(hours=2)},
            {"title": "opened PR #482 — rotate session cookie on privilege change",
             "agent": "web_platform/Toast", "rig": "web_platform", "at": _ago(minutes=4)},
            {"title": "merged #479 into main", "agent": "billing_api/refinery",
             "rig": "billing_api", "at": _ago(minutes=22)},
        ],
        # `gt changelog --json` carries `close_reason` on every row, and in a real town
        # those run from three words to three paragraphs — which is why the card clips
        # one to a line and puts the whole of it under the fold. Both lengths are here,
        # and so is a closure that gave no reason at all.
        "changelog": [
            {"id": "ma-9", "title": "Fix crash on empty push payload", "type": "bug",
             "rig": "mobile_app", "closed_at": _ago(days=1), "close_reason": "Merged in #471"},
            {"id": "wp-98", "title": "Cache the pricing table per request", "type": "task",
             "rig": "web_platform", "closed_at": _ago(hours=3), "close_reason": (
                 "Merged in #479, but not the way the bead described.\n\n"
                 "The per-request cache turned out to be the wrong layer — two requests "
                 "in the same checkout still paid for the lookup twice. It is cached per "
                 "connection instead, invalidated on the pricing table's own version "
                 "column, which is what the ledger already keys on.\n\n"
                 "FOLLOW-UP FILED: wp-131, the same treatment for the tax table.")},
            {"id": "ba-29", "title": "Backfill missing customer tax ids", "type": "chore",
             "rig": "billing_api", "closed_at": _ago(hours=7), "close_reason": "Merged in #477"},
            {"id": "ba-27", "title": "Retire the v1 invoice renderer", "type": "task",
             "rig": "billing_api", "closed_at": _ago(days=2)},
        ],
        # `gt convoy list --json`, real shape: a convoy carries its own progress and
        # the beads it tracks, each with the agent holding it. The tracked ids are the
        # in-flight ones above on purpose — expanding a convoy must land on the same
        # beads the In flight list is showing, or the tab is two widgets, not one view.
        "convoys": [
            {"id": "hq-cv-8kq", "title": "Work: checkout hardening", "status": "open",
             "created_at": _ago(days=1), "completed": 1, "total": 3,
             "tracked": [
                 _tracked("wp-120", "Rotate the session cookie on privilege change",
                          "hooked", "web_platform/polecats/Toast"),
                 _tracked("wp-122", "Checkout retry needs the new idempotency key", "blocked"),
                 _tracked("wp-98", "Cache the pricing table per request", "closed"),
             ]},
            {"id": "hq-cv-2rd", "title": "Work: split-refund rounding", "status": "open",
             "created_at": _ago(hours=5), "completed": 0, "total": 1,
             "tracked": [_tracked("ba-40", "Reconcile split-refund rounding against the ledger",
                                  "in_progress", "billing_api/Toast")]},
        ],
        # The `flight` read: not open, not closed — see flight.py. Two things the demo
        # has to contain, because both are load-bearing and neither is obvious:
        # wp-120's assignee is spelled web_platform/polecats/Toast while the agent's
        # own address is web_platform/Toast, which is the real spelling mismatch
        # addrKeys() exists to bridge; and wp-121 sits with Slit, whose pane is idle —
        # a bead on a hook is not the same as a turn in flight, and the row says both.
        "flight": [
            _flight("wp-120", "Rotate the session cookie on privilege change", 1,
                    "hooked", "web_platform/polecats/Toast", "web_platform", "bug", minutes=6),
            _flight("wp-121", "Consolidate the button variants behind shared tokens", 2,
                    "hooked", "web_platform/Slit", "web_platform", minutes=52),
            _flight("ba-40", "Reconcile split-refund rounding against the ledger", 0,
                    "in_progress", "billing_api/Toast", "billing_api", "bug", minutes=22),
            _flight("hq-51c", "Draft the cross-rig freeze plan for the release", 1,
                    "in_progress", "mayor/", "town", minutes=3),
            _flight("wp-122", "Checkout retry needs the new idempotency key", 2,
                    "blocked", "", "web_platform", hours=4),
            # The head of the three-deep chain in the backlog fixture. It is here as
            # well as there because the two reads must agree bead for bead — see above.
            _flight("wp-142", "Land the primary and quiet tokens in the theme file", 1,
                    "in_progress", "web_platform/Toast", "web_platform", minutes=18),
        ],
    }
