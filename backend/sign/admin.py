"""
Admin portal for ChampPDF Sign.

Read model over the system of record for Champions Group admins and legal.
The sender console shows a sender their own documents; the admin portal shows
everything: every document, every recipient, the full hash-chained audit log,
and, where a raw IP was recorded, its MaxMind geo context (country, city,
ASN) resolved at read time. It also holds the access-control switch that sets
which templates senders may use, and surfaces the send-outs that still await
a signature so they can be re-sent.

Authorisation is enforced at the router (require_role); every function here
re-checks the minimum role defensively so a mis-wired route can never widen
what the portal exposes.

No em dashes in this file. Use periods and commas.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from . import geoip, service, store
from . import templates as tpl
from .auth import Sender


def _geo(ip: Optional[str]) -> Dict[str, Any]:
    return geoip.resolve(ip)


def _days_between(earlier: Optional[str], later: Optional[str]) -> Optional[int]:
    a, b = store.parse_iso(earlier), store.parse_iso(later)
    if not a or not b:
        return None
    return (b - a).days


def _recipient_admin_view(r: Dict[str, Any]) -> Dict[str, Any]:
    view = service._recipient_view(r, include_email=True)
    view["ip"] = r.get("signer_ip")
    view["user_agent"] = r.get("signer_user_agent")
    view["geo"] = _geo(r.get("signer_ip")) if r.get("signer_ip") else {"provider": "none", "ip": None}
    return view


def _event_admin_view(e: Dict[str, Any]) -> Dict[str, Any]:
    out = {
        "id": e["id"],
        "event_type": e["event_type"],
        "occurred_at": e["occurred_at"],
        "recipient_id": e.get("recipient_id"),
        "actor_email": e.get("actor_email"),
        "ip_address": e.get("ip_address"),
        "user_agent": e.get("user_agent"),
        "metadata": e.get("metadata"),
        "geo": _geo(e.get("ip_address")) if e.get("ip_address") else {"provider": "none", "ip": None},
    }
    return out


def _strip(doc: Dict[str, Any]) -> Dict[str, Any]:
    """Remove parasocial fields: the token hashes and OTP digests never leave
    the server, even to an admin session."""
    return {k: v for k, v in doc.items() if "hash" not in k}


def summary(sender: Sender) -> Dict[str, Any]:
    statuses = store.documents_by_status()
    recs = store.count_recipients()
    templates = tpl.list_templates()
    active = sum(1 for t in templates if store.template_available(t["id"], t["version"]))
    pending = store.needs_resend_documents()
    return {
        "role": sender.role,
        "documents": {
            "total": sum(statuses.values()),
            "by_status": statuses,
        },
        "recipients": recs,
        "templates": {"total": len(templates), "active": active, "inactive": len(templates) - active},
        "outstanding": {
            "needs_resend": len(pending),
            "documents_pending": len(pending),
        },
        "geo": {"provider": geoip.provider()},
        "recent_event_count": 0,
        "now": store.utcnow_iso(),
    }


def list_documents(sender: Sender, status: Optional[str] = None, q: Optional[str] = None, limit: int = 200) -> List[Dict[str, Any]]:
    docs = store.admin_documents(status=status, limit=limit)
    out = []
    for d in docs:
        recs = store.get_recipients(d["id"])
        base = service.document_view(d, recs)
        base["recipients"] = [_recipient_admin_view(r) for r in recs]
        base["days_to_expiry"] = _days_between(store.utcnow_iso(), d["expires_at"])
        base["needs_resend"] = any(r["role"] != "cc" and r["status"] != "signed" for r in recs)
        if q and q.lower() not in (d["title"] + (d.get("sender_name") or "") + " " + " ".join(r.get("email", "") for r in recs)).lower():
            continue
        out.append(base)
    return out


def get_document(sender: Sender, doc_id: str) -> Dict[str, Any]:
    doc = store.get_document(doc_id)
    if not doc:
        raise service.err(404, "not_found", "Document not found")
    recs = store.get_recipients(doc_id)
    events = store.list_events(doc_id)
    view = service.document_view(doc, recs, events=events, chain=store.verify_chain(doc_id))
    view["recipients"] = [_recipient_admin_view(r) for r in recs]
    view["events"] = [_event_admin_view(e) for e in events]
    return view


def templates(sender: Sender) -> Dict[str, Any]:
    flags = store.template_flags()
    usage = store.template_usage()
    reg = tpl.list_templates()
    out = []
    for t in reg:
        flag = flags.get(t["id"])
        is_active = bool(flag["is_active"]) if flag else True
        out.append(
            {
                **t,
                "is_active": is_active,
                "approved_by": flag["approved_by"] if flag else None,
                "updated_at": flag["updated_at"] if flag else None,
                "used": usage.get(t["id"], 0),
            }
        )
    return {"templates": out, "role": sender.role}


def set_template_active(sender: Sender, template_id: str, active: bool) -> Dict[str, Any]:
    try:
        t = tpl.get_template(template_id)
    except tpl.TemplateError as e:
        raise service.err(404, "not_found", str(e), field=e.field_key)
    row = store.set_template_available(t.id, t.version, active, sender.email or sender.name)
    return {
        "template_id": t.id,
        "version": t.version,
        "name": t.name,
        "is_active": bool(row["is_active"]),
        "approved_by": row["approved_by"],
        "updated_at": row["updated_at"],
    }


def needs_resend(sender: Sender) -> List[Dict[str, Any]]:
    now = store.utcnow_iso()
    out = []
    for entry in store.needs_resend_documents():
        d, pending = entry["document"], entry["pending"]
        sent_at = d.get("sent_at") or d["created_at"]
        item = {
            "id": d["id"],
            "title": d["title"],
            "status": d["status"],
            "template_id": d["template_id"],
            "sender": {"name": d.get("sender_name"), "email": d.get("sender_email")},
            "sent_at": sent_at,
            "expires_at": d["expires_at"],
            "created_at": d["created_at"],
            "days_since_sent": _days_between(sent_at, now),
            "days_to_expiry": _days_between(now, d["expires_at"]),
            "overdue": (store.parse_iso(d["expires_at"]) or datetime.max.replace(tzinfo=timezone.utc)) < (store.parse_iso(now) or datetime.now(timezone.utc)),
            "pending": [_recipient_admin_view(r) for r in pending],
        }
        # Last activity on the document drives how loud the send-out is.
        latest = store.list_events(d["id"])
        item["last_activity_at"] = latest[-1]["occurred_at"] if latest else None
        out.append(item)
    return out


def recent_events(sender: Sender, limit: int = 100) -> Dict[str, Any]:
    events = store.recent_events(limit=limit)
    return {"events": [_event_admin_view(e) for e in events], "count": len(events)}
