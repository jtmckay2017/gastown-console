"""Synthetic fixtures for `--demo`, so the console can be explored (and screenshotted)
without a live Gas Town workspace."""

import time
from datetime import datetime, timedelta, timezone


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
        rig_blocks.append({
            "name": name, "polecats": None, "polecat_count": polecats, "crews": None,
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

    return {
        "status": status,
        "rigs": rigs,
        "ready": ready,
        "dogs": dogs,
        "models": models,
        "panes": panes,
        "watch": watch,
        # Every list below arrives deliberately out of order — the console sorts each one
        # newest-first itself (gc-feh), and a pre-sorted fixture would hide a regression.
        "mail": [
            {"id": "m-9c1", "from": "deacon/", "subject": "Nightly patrol clean across 3 rigs",
             "type": "notification", "read": True, "created_at": _ago(hours=8)},
            {"id": "m-9e7", "from": "billing_api/refinery", "subject": "Merge queue drained — 3 landed",
             "type": "notification", "read": False, "created_at": _ago(minutes=41)},
            {"id": "m-9f2", "from": "web_platform/Toast", "subject": "PR ready: session rotation fix",
             "type": "task", "read": False, "created_at": _ago(minutes=6)},
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
        "changelog": [
            {"id": "ma-9", "title": "Fix crash on empty push payload", "type": "bug",
             "rig": "mobile_app", "closed_at": _ago(days=1), "close_reason": "Merged in #471"},
            {"id": "wp-98", "title": "Cache the pricing table per request", "type": "task",
             "rig": "web_platform", "closed_at": _ago(hours=3), "close_reason": "Merged in #479"},
            {"id": "ba-29", "title": "Backfill missing customer tax ids", "type": "chore",
             "rig": "billing_api", "closed_at": _ago(hours=7), "close_reason": "Merged in #477"},
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
        ],
    }
