"""Synthetic fixtures for `--demo`, so the console can be explored (and screenshotted)
without a live Gas Town workspace."""

import time
from datetime import datetime, timedelta, timezone


def _ago(**kw):
    return (datetime.now(timezone.utc) - timedelta(**kw)).isoformat().replace("+00:00", "Z")


def _agent(name, address, role, session, running=True, state="idle", work=False, mail=0):
    return {"name": name, "address": address, "session": session, "role": role,
            "running": running, "acp": False, "has_work": work, "state": state,
            "unread_mail": mail, "agent_alias": "claude", "agent_info": "claude"}


def _issue(id_, title, priority, type_="task", parent=None, hours=3):
    return {"id": id_, "title": title, "priority": priority, "issue_type": type_,
            "status": "open", "parent": parent, "created_at": _ago(days=2),
            "updated_at": _ago(hours=hours), "description": ""}


def fixtures():
    rigs_meta = [
        ("web_platform", "wp", 3), ("billing_api", "ba", 1), ("mobile_app", "ma", 0),
    ]

    rig_blocks = []
    for name, prefix, polecats in rigs_meta:
        agents = [
            _agent("witness", f"{name}/witness", "witness", f"{prefix}-witness"),
            _agent("refinery", f"{name}/refinery", "refinery", f"{prefix}-refinery",
                   state="working" if polecats else "idle", work=bool(polecats)),
        ]
        for i in range(polecats):
            pc = ["Toast", "Slit", "Nux"][i]
            agents.append(_agent(pc, f"{name}/{pc}", "polecat", f"{prefix}-{pc.lower()}",
                                 state="working", work=True, mail=1 if i == 0 else 0))
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
        "agents": [_agent("mayor", "mayor/", "coordinator", "hq-mayor", state="working", mail=2),
                   _agent("deacon", "deacon/", "health-check", "hq-deacon")],
        "rigs": rig_blocks,
        "summary": {"rig_count": 3, "polecat_count": 4, "crew_count": 2, "witness_count": 3,
                    "refinery_count": 3, "active_hooks": 6},
    }

    rigs = [{"name": n, "beads_prefix": p, "status": "operational", "witness": "running",
             "refinery": "running", "polecats": c, "crew": 1 if c else 0}
            for n, p, c in rigs_meta]

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

    return {
        "status": status,
        "rigs": rigs,
        "ready": ready,
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
        "convoys": [
            {"id": "cv-3", "name": "checkout-hardening", "rig": "web_platform",
             "issues": 4, "done": 2, "created_at": _ago(days=1)},
        ],
    }
