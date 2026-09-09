"""
ChampPDF Sign orchestration.

The lifecycle, in the order a document lives it:

  create_and_send   sender picks a template, names a counterparty, we render,
                    store the exact draft every signer will see, mint a
                    32-byte link token per recipient and email the first
                    signer (through ChampBeam when configured)
  landing           the signer opens the link: identity of the sender, what
                    the document is, how long the link lives. No signing
                    rights yet.
  request_otp /     six digits to the invited address, ten-minute expiry,
  verify_otp        five attempts then the token locks and the sender is told.
                    Success mints a 30-minute signer session.
  get_pdf           the draft, byte-identical to what was hashed at creation
  record_scrolled   the read gate; the sign control needs this server-side too
  sign              typed or drawn signature stamped by the provider, then
                    when every required party has signed:
  execute           certificate of completion appended, PAdES seal applied,
                    SHA-256 recorded in the database (a different system from
                    the bucket), sealed PDF stored write-once, both parties
                    emailed the file.

Every step is an audit event on the document's hash chain. State changes and
their events commit in the same transaction wherever possible.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import re
from dataclasses import dataclass
from datetime import timedelta
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException

from . import beam
from . import mailer as mail
from . import store
from . import templates as tpl
from . import tokens
from .auth import Sender
from .providers import (
    ProviderError,
    ProviderNotSupported,
    RecipientSpec,
    SignatureInput,
    get_provider,
    provider_name,
)
from .seal import CertificateContext, seal_info, verify_seal_sync
from .storage import StorageError, get_storage

logger = logging.getLogger(__name__)

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
MAX_EXPIRY_DAYS = 90
MIN_EXPIRY_DAYS = 1
DEFAULT_EXPIRY_DAYS = 14
IP_PAGE_LOADS_PER_HOUR = 60
REQUIRED_ROLES = ("signer", "countersigner")

_locks: Dict[str, asyncio.Lock] = {}


def _lock(doc_id: str) -> asyncio.Lock:
    lock = _locks.get(doc_id)
    if lock is None:
        lock = _locks[doc_id] = asyncio.Lock()
    return lock


# --------------------------------------------------------------------------
# Errors and config
# --------------------------------------------------------------------------


def err(status: int, code: str, message: str, **extra: Any) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message, **extra})


def sign_enabled() -> bool:
    if os.environ.get("ENABLE_SIGN", "true").strip().lower() == "false":
        return False
    try:
        import pymupdf  # noqa: F401
        import pyhanko  # noqa: F401
    except ImportError:
        return False
    return True


def public_base_url(request_origin: Optional[str]) -> str:
    env = os.environ.get("SIGN_PUBLIC_BASE_URL", "").strip().rstrip("/")
    if env:
        return env
    return (request_origin or "").rstrip("/") or "http://localhost:5173"


def signing_url(base_url: str, raw_token: str) -> str:
    return f"{base_url}/s/{raw_token}"


def console_url(base_url: str) -> str:
    return f"{base_url}/sign.html"


def status_summary() -> Dict[str, Any]:
    info = seal_info() if sign_enabled() else None
    prov: Dict[str, Any] = {"name": provider_name()}
    try:
        prov = get_provider().describe()
    except ProviderError as e:
        prov["error"] = str(e)
    return {
        "enabled": sign_enabled(),
        "provider": prov,
        "mail_configured": mail.mail_configured(),
        "beam_configured": beam.beam_configured(),
        "storage": get_storage().name,
        "seal_self_signed": bool(info.get("self_signed", True)) if info else None,
        "seal_subject": info.get("subject") if info else None,
        "entity": tpl.entity_fields()["champions_entity"],
        "sender_domains": os.environ.get("SIGN_SENDER_EMAIL_DOMAINS", "championsmail.com"),
        "templates": [t["id"] for t in tpl.list_templates()],
    }


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


def mask_email(email: str) -> str:
    local, _, domain = email.partition("@")
    if not domain:
        return "***"
    shown = local[:1] if len(local) > 2 else ""
    return f"{shown}***@{domain}"


def _safe_filename(title: str) -> str:
    base = re.sub(r"[^A-Za-z0-9._ -]+", "", title).strip().replace(" ", "_")[:80] or "document"
    return f"{base}.pdf"


def _fmt_human(iso_ts: Optional[str]) -> str:
    dt = store.parse_iso(iso_ts)
    return dt.strftime("%d %B %Y, %H:%M UTC") if dt else "-"


def _recipient_view(r: Dict[str, Any], include_email: bool = True) -> Dict[str, Any]:
    now = store.utcnow()
    session_ok = bool(r.get("session_expires_at")) and (store.parse_iso(r["session_expires_at"]) or now) > now
    return {
        "id": r["id"],
        "role": r["role"],
        "signing_order": r["signing_order"],
        "name": r["name"],
        "email": r["email"] if include_email else mask_email(r["email"]),
        "designation": r.get("designation"),
        "status": r["status"],
        "locked": bool(r.get("token_locked_at")),
        "link_opened_at": r.get("link_opened_at"),
        "otp_verified_at": r.get("otp_verified_at"),
        "viewed_at": r.get("viewed_at"),
        "scrolled_to_end_at": r.get("scrolled_to_end_at"),
        "signed_at": r.get("signed_at"),
        "signature_kind": r.get("signature_kind"),
        "session_active": session_ok,
    }


def document_view(doc: Dict[str, Any], recipients: List[Dict[str, Any]], events: Optional[List[Dict[str, Any]]] = None,
                  chain: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    merge = json.loads(doc.get("merge_fields_json") or "{}")
    view: Dict[str, Any] = {
        "id": doc["id"],
        "title": doc["title"],
        "status": doc["status"],
        "template_id": doc["template_id"],
        "template_version": doc["template_version"],
        "template_sha256": doc["template_sha256"],
        "provider": doc["provider"],
        "counterparty_entity": doc["counterparty_entity"],
        "counterparty_cin": doc.get("counterparty_cin"),
        "fields": merge,
        "sender": {"user_id": doc["sender_user_id"], "email": doc.get("sender_email"), "name": doc.get("sender_name")},
        "beam_id": doc.get("beam_id"),
        "page_count": doc.get("page_count"),
        "draft_sha256": doc.get("draft_sha256"),
        "content_sha256": doc.get("content_sha256"),
        "chain_head_at_execution": doc.get("chain_head_at_execution"),
        "seal": json.loads(doc["seal_info_json"]) if doc.get("seal_info_json") else None,
        "expires_at": doc["expires_at"],
        "created_at": doc["created_at"],
        "sent_at": doc.get("sent_at"),
        "executed_at": doc.get("executed_at"),
        "voided_at": doc.get("voided_at"),
        "void_reason": doc.get("void_reason"),
        "recipients": [_recipient_view(r) for r in recipients],
    }
    if events is not None:
        view["events"] = [
            {k: e.get(k) for k in ("id", "event_type", "occurred_at", "recipient_id", "actor_email", "ip_address", "metadata", "event_hash", "prev_hash")}
            for e in events
        ]
    if chain is not None:
        view["chain"] = chain
    return view


def _validate_recipient(raw: Dict[str, Any], role: str, order: int) -> Dict[str, Any]:
    name = str(raw.get("name") or "").strip()
    email = str(raw.get("email") or "").strip().lower()
    designation = (str(raw.get("designation") or "").strip() or None)
    if len(name) < 2 or len(name) > 120:
        raise err(422, "invalid_recipient", f"{role}: name must be 2 to 120 characters", field=f"{role}.name")
    if not EMAIL_RE.match(email) or len(email) > 254:
        raise err(422, "invalid_recipient", f"{role}: a valid email address is required", field=f"{role}.email")
    if designation and len(designation) > 120:
        raise err(422, "invalid_recipient", f"{role}: designation is too long", field=f"{role}.designation")
    return {"id": store.new_id(), "role": role, "signing_order": order, "name": name, "email": email, "designation": designation}


def _client_meta(ip: Optional[str], ua: Optional[str]) -> Dict[str, Optional[str]]:
    return {"ip_address": ip, "user_agent": ua}


# --------------------------------------------------------------------------
# Sender side
# --------------------------------------------------------------------------


async def preview(sender: Sender, template_id: str, values: Dict[str, Any], signer: Optional[Dict[str, Any]]) -> bytes:
    """Render the filled instrument without creating anything. Sender only."""
    _require_enabled()
    template = _template(template_id)
    clean = _values(template, values)
    recipients = []
    if signer and (signer.get("name") or signer.get("email")):
        recipients.append({"role": "signer", "name": str(signer.get("name") or ""), "email": str(signer.get("email") or ""),
                           "designation": str(signer.get("designation") or "")})
    try:
        result = await tpl.render_pdf(template, clean, recipients, footer_label="PREVIEW, not for signature")
    except tpl.TemplateError as e:
        raise err(422, "invalid_field", str(e), field=e.field_key)
    return result.pdf


async def create_and_send(
    sender: Sender,
    *,
    template_id: str,
    values: Dict[str, Any],
    signer: Dict[str, Any],
    countersigner: Optional[Dict[str, Any]],
    cc: Optional[List[Dict[str, Any]]],
    expires_in_days: int,
    base_url: str,
    ip: Optional[str],
    ua: Optional[str],
) -> Dict[str, Any]:
    _require_enabled()
    template = _template(template_id)
    clean = _values(template, values)
    if not (MIN_EXPIRY_DAYS <= int(expires_in_days) <= MAX_EXPIRY_DAYS):
        raise err(422, "invalid_expiry", f"expires_in_days must be between {MIN_EXPIRY_DAYS} and {MAX_EXPIRY_DAYS}")

    recipients = [_validate_recipient(signer, "signer", 1)]
    if countersigner:
        recipients.append(_validate_recipient(countersigner, "countersigner", 2))
    for i, c in enumerate(cc or []):
        recipients.append(_validate_recipient(c, "cc", 99 + i))
    if len({r["email"] for r in recipients}) != len(recipients):
        raise err(422, "invalid_recipient", "each recipient needs a distinct email address")

    doc_id = store.new_id()
    ctx = tpl.build_merge_context(template, clean, recipients)
    title = template.title_for(ctx)
    provider = get_provider()
    specs = [RecipientSpec(id=r["id"], role=r["role"], signing_order=r["signing_order"], name=r["name"], email=r["email"],
                           designation=r["designation"]) for r in recipients]
    try:
        pdoc = await provider.create_from_template(template, clean, specs, document_id=doc_id, title=title,
                                                   footer_label=f"Document {doc_id[:8]}")
    except tpl.TemplateError as e:
        raise err(422, "invalid_field", str(e), field=e.field_key)
    except ProviderError as e:
        logger.exception("provider create failed")
        raise err(502, "provider_error", str(e))

    draft_sha = hashlib.sha256(pdoc.draft_pdf).hexdigest()
    draft_key = f"sign/{doc_id}/draft.pdf"
    try:
        get_storage().put(draft_key, pdoc.draft_pdf)
    except StorageError as e:
        raise err(500, "storage_error", str(e))

    now = store.utcnow_iso()
    doc = {
        "id": doc_id,
        "title": title,
        "sender_user_id": sender.user_id,
        "sender_email": sender.email,
        "sender_name": sender.name,
        "sender_org_id": sender.org_id,
        "template_id": template.id,
        "template_version": template.version,
        "template_sha256": template.sha256,
        "provider": provider.name,
        "provider_doc_id": pdoc.provider_doc_id,
        "counterparty_entity": clean.get("counterparty_entity") or "",
        "counterparty_cin": clean.get("counterparty_cin") or None,
        "merge_fields_json": json.dumps(clean, sort_keys=True),
        "anchors_json": json.dumps(pdoc.anchors),
        "provider_meta_json": json.dumps({"signing_urls": pdoc.signing_urls, "source": pdoc.source}),
        "page_count": pdoc.page_count,
        "status": "draft",
        "draft_storage_key": draft_key,
        "draft_sha256": draft_sha,
        "working_storage_key": draft_key,
        "expires_at": store.iso(store.utcnow() + timedelta(days=int(expires_in_days))),
        "created_at": now,
    }
    raw_tokens: Dict[str, str] = {}
    with store.connect(immediate=True) as c:
        store.insert_document(doc, conn=c)
        for r in recipients:
            raw = tokens.new_link_token()
            raw_tokens[r["id"]] = raw
            store.insert_recipient(
                {**r, "document_id": doc_id, "status": "pending", "token_hash": tokens.hash_token(raw), "created_at": now},
                conn=c,
            )
        store.append_event(
            doc_id, "document.created", actor_email=sender.email, conn=c, **_client_meta(ip, ua),
            metadata={
                "template_id": template.id, "template_version": template.version, "template_sha256": template.sha256,
                "provider": provider.name, "draft_sha256": draft_sha, "page_count": pdoc.page_count,
                "source": pdoc.source, "expires_at": doc["expires_at"], "sender_role": sender.role,
            },
        )

    dev_links = await _send_invitations(doc, [r for r in recipients if r["signing_order"] == 1 and r["role"] != "cc"],
                                        raw_tokens, base_url, ip, ua)
    fresh = store.get_document(doc_id)
    view = document_view(fresh, store.get_recipients(doc_id))
    if dev_links:
        view["dev_links"] = dev_links
    return view


async def _send_invitations(doc: Dict[str, Any], recipients: List[Dict[str, Any]], raw_tokens: Dict[str, str],
                            base_url: str, ip: Optional[str], ua: Optional[str]) -> Dict[str, str]:
    """Wrap, email and record. Returns raw links only when mail is not configured (dry-run convenience)."""
    mailer = mail.get_mailer()
    dev_links: Dict[str, str] = {}
    entity = tpl.entity_fields()["champions_entity"]
    for r in recipients:
        raw = raw_tokens[r["id"]]
        url = signing_url(base_url, raw)
        wrapped = await beam.wrap_link(url, label=f"sign:{doc['id'][:8]}:{r['role']}", tags=["champdf-sign", doc["template_id"]])
        email = mail.invitation_email(
            to=r["email"], recipient_name=r["name"], sender_name=doc.get("sender_name") or "Champions",
            sender_email=doc.get("sender_email"), entity=entity, title=doc["title"], link=wrapped["url"],
            expires_at_text=_fmt_human(doc["expires_at"]), document_id=doc["id"], recipient_id=r["id"],
        )
        message_id: Optional[str] = None
        send_error: Optional[str] = None
        try:
            message_id = await mailer.send(email)
        except mail.MailError as e:
            send_error = str(e)
            logger.error("invitation to %s failed: %s", r["email"], e)
        with store.connect(immediate=True) as c:
            store.update_recipient(r["id"], conn=c, invite_message_id=message_id)
            current = store.get_document(doc["id"], conn=c) or doc
            fields: Dict[str, Any] = {"beam_id": wrapped.get("id") or current.get("beam_id")}
            if current["status"] == "draft":
                # First send only. Inviting the next party after a signature, or a
                # resend, must not roll a signed / viewed document back to "sent".
                fields.update(status="sent", sent_at=store.utcnow_iso())
            store.update_document(doc["id"], conn=c, **fields)
            store.append_event(
                doc["id"], "document.sent", recipient_id=r["id"], actor_email=doc.get("sender_email"), conn=c,
                **_client_meta(ip, ua),
                metadata={"to": r["email"], "mailer": mailer.name, "message_id": message_id, "beam_id": wrapped.get("id"),
                          "error": send_error},
            )
        if not mail.mail_configured():
            dev_links[r["id"]] = url
    return dev_links


def list_for(sender: Sender) -> List[Dict[str, Any]]:
    _expire_due()
    docs = store.list_documents() if sender.is_admin else store.list_documents(sender_user_id=sender.user_id)
    return [document_view(d, store.get_recipients(d["id"])) for d in docs]


def _owned(sender: Sender, doc_id: str) -> Dict[str, Any]:
    doc = store.get_document(doc_id)
    if not doc or (not sender.is_admin and doc["sender_user_id"] != sender.user_id):
        raise err(404, "not_found", "Document not found")
    return doc


def get_for(sender: Sender, doc_id: str) -> Dict[str, Any]:
    _expire_due()
    doc = _owned(sender, doc_id)
    return document_view(doc, store.get_recipients(doc_id), events=store.list_events(doc_id), chain=store.verify_chain(doc_id))


def download_for(sender: Sender, doc_id: str) -> Tuple[bytes, str, str]:
    doc = _owned(sender, doc_id)
    key = doc.get("storage_key") if doc["status"] == "executed" else doc.get("working_storage_key") or doc.get("draft_storage_key")
    if not key:
        raise err(404, "not_found", "No file for this document yet")
    data = get_storage().get(key)
    store.append_event(doc_id, "copy.downloaded", actor_email=sender.email,
                       metadata={"key": key, "sha256": hashlib.sha256(data).hexdigest(), "by": "sender"})
    kind = "executed" if doc["status"] == "executed" else "draft"
    return data, _safe_filename(f"{doc['title']}_{kind}"), kind


async def void(sender: Sender, doc_id: str, reason: Optional[str], ip: Optional[str], ua: Optional[str]) -> Dict[str, Any]:
    doc = _owned(sender, doc_id)
    if doc["status"] in ("executed", "voided"):
        raise err(409, "invalid_state", f"A document that is {doc['status']} cannot be voided")
    try:
        await get_provider().void(doc.get("provider_doc_id") or doc_id, reason or "")
    except ProviderError as e:
        logger.warning("provider void failed for %s: %s", doc_id, e)
    with store.connect(immediate=True) as c:
        store.update_document(doc_id, conn=c, status="voided", voided_at=store.utcnow_iso(), void_reason=(reason or "")[:500] or None)
        store.append_event(doc_id, "document.voided", actor_email=sender.email, conn=c, **_client_meta(ip, ua),
                           metadata={"reason": (reason or "")[:500], "by_role": sender.role})
    return document_view(store.get_document(doc_id), store.get_recipients(doc_id))


async def resend(sender: Sender, doc_id: str, recipient_id: Optional[str], base_url: str, ip: Optional[str],
                 ua: Optional[str]) -> Dict[str, Any]:
    """Rotate the recipient's link token (old link dies) and send a fresh invitation."""
    doc = _owned(sender, doc_id)
    if doc["status"] not in ("sent", "viewed", "signed", "countersigned"):
        raise err(409, "invalid_state", f"Cannot resend a document that is {doc['status']}")
    recs = store.get_recipients(doc_id)
    pending = [r for r in recs if r["status"] != "signed" and r["role"] != "cc"]
    if recipient_id:
        pending = [r for r in pending if r["id"] == recipient_id]
    if not pending:
        raise err(409, "invalid_state", "No pending recipient to resend to")
    target = sorted(pending, key=lambda r: r["signing_order"])[0]
    raw = tokens.new_link_token()
    with store.connect(immediate=True) as c:
        store.update_recipient(
            target["id"], conn=c, token_hash=tokens.hash_token(raw), token_locked_at=None, otp_hash=None,
            otp_expires_at=None, otp_attempts=0, otp_request_count=0, otp_window_start=None,
            session_token_hash=None, session_expires_at=None,
        )
        store.append_event(doc_id, "token.rotated", recipient_id=target["id"], actor_email=sender.email, conn=c,
                           **_client_meta(ip, ua), metadata={"reason": "resend"})
    dev_links = await _send_invitations(doc, [target], {target["id"]: raw}, base_url, ip, ua)
    view = document_view(store.get_document(doc_id), store.get_recipients(doc_id))
    if dev_links:
        view["dev_links"] = dev_links
    return view


async def verify(sender: Sender, doc_id: str) -> Dict[str, Any]:
    """Recompute the chain, rehash the stored file, and check the PAdES seal."""
    doc = _owned(sender, doc_id)
    report: Dict[str, Any] = {"document_id": doc_id, "status": doc["status"], "chain": store.verify_chain(doc_id)}
    storage = get_storage()
    if doc.get("draft_storage_key"):
        try:
            data = storage.get(doc["draft_storage_key"])
            report["draft"] = {"sha256": hashlib.sha256(data).hexdigest(), "recorded": doc.get("draft_sha256")}
            report["draft"]["ok"] = report["draft"]["sha256"] == doc.get("draft_sha256")
        except StorageError as e:
            report["draft"] = {"ok": False, "error": str(e)}
    if doc["status"] == "executed" and doc.get("storage_key"):
        try:
            data = storage.get(doc["storage_key"])
            sha = hashlib.sha256(data).hexdigest()
            sealed = {"sha256": sha, "recorded": doc.get("content_sha256"), "ok": sha == doc.get("content_sha256")}
            try:
                sealed["signatures"] = await asyncio.to_thread(verify_seal_sync, data)
                sigs = sealed["signatures"].get("signatures", [])
                sealed["seal_intact"] = bool(sigs) and all(s.get("intact") for s in sigs)
            except Exception as e:  # noqa: BLE001
                sealed["seal_intact"] = None
                sealed["seal_error"] = str(e)
            report["sealed"] = sealed
        except StorageError as e:
            report["sealed"] = {"ok": False, "error": str(e)}
        report["chain_head_at_execution"] = doc.get("chain_head_at_execution")
    report["ok"] = bool(report["chain"]["ok"]) and report.get("draft", {}).get("ok", True) and report.get("sealed", {}).get("ok", True)
    return report


async def sync_from_provider(sender: Sender, doc_id: str, base_url: str) -> Dict[str, Any]:
    """Hosted engines (Documenso): pull status, and when complete, the sealed file."""
    doc = _owned(sender, doc_id)
    provider = get_provider()
    if not provider.hosted_signing or doc["status"] in ("executed", "voided", "expired"):
        return document_view(doc, store.get_recipients(doc_id))
    try:
        status = await provider.get_status(doc.get("provider_doc_id") or doc_id)
    except ProviderError as e:
        raise err(502, "provider_error", str(e))
    recs = store.get_recipients(doc_id)
    for r in recs:
        theirs = status.recipients.get(r["email"].lower())
        if theirs == "signed" and r["status"] != "signed":
            with store.connect(immediate=True) as c:
                store.update_recipient(r["id"], conn=c, status="signed", signed_at=store.utcnow_iso(), signature_kind="hosted")
                store.append_event(doc_id, "document.signed" if r["role"] == "signer" else "document.countersigned",
                                   recipient_id=r["id"], actor_email=r["email"], conn=c,
                                   metadata={"via": provider.name, "provider_status": status.status})
    if status.sealed_available and status.status == "executed":
        try:
            sealed = await provider.get_sealed_document(doc.get("provider_doc_id") or doc_id)
        except ProviderError as e:
            raise err(502, "provider_error", str(e))
        await _finalize_executed(doc_id, sealed, {"sealed": True, "timestamped": None, "seal_subject": provider.name,
                                                  "self_signed": None, "notes": ["sealed_by_provider"]}, base_url)
    return document_view(store.get_document(doc_id), store.get_recipients(doc_id))


def record_delivery_event(event_type: str, document_id: str, recipient_id: Optional[str], metadata: Dict[str, Any]) -> bool:
    if event_type not in ("invitation.delivered", "invitation.bounced", "invitation.complained"):
        return False
    doc = store.get_document(document_id)
    if not doc:
        return False
    store.append_event(document_id, event_type, recipient_id=recipient_id, metadata=metadata)
    return True


def find_recipient_by_message_id(message_id: str) -> Optional[Dict[str, Any]]:
    with store.connect() as c:
        row = c.execute("SELECT * FROM sign_recipients WHERE invite_message_id = ?", (message_id,)).fetchone()
    return dict(row) if row else None


# --------------------------------------------------------------------------
# Signer side
# --------------------------------------------------------------------------


def _load_by_token(raw_token: str) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    if not tokens.looks_like_link_token(raw_token):
        raise err(404, "not_found", "This signing link is not valid")
    rec = store.get_recipient_by_token_hash(tokens.hash_token(raw_token))
    if not rec:
        raise err(404, "not_found", "This signing link is not valid")
    doc = store.get_document(rec["document_id"])
    if not doc:
        raise err(404, "not_found", "This signing link is not valid")
    return doc, rec


def _gate(doc: Dict[str, Any], rec: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """Refuse links that are void, expired or locked. Returns possibly-updated rows."""
    if doc["status"] in ("sent", "viewed") and (store.parse_iso(doc["expires_at"]) or store.utcnow()) < store.utcnow():
        _mark_expired(doc)
        doc = store.get_document(doc["id"]) or doc
    if doc["status"] == "voided":
        raise err(410, "voided", "This document has been withdrawn by the sender.")
    if doc["status"] == "expired":
        raise err(410, "expired", "This signing link has expired. Ask the sender for a new one.")
    if rec.get("token_locked_at"):
        raise err(423, "locked", "This link was locked after too many failed verification attempts. Ask the sender to resend.")
    return doc, rec


def _mark_expired(doc: Dict[str, Any]) -> None:
    with store.connect(immediate=True) as c:
        current = store.get_document(doc["id"], conn=c)
        if current and current["status"] in ("sent", "viewed"):
            store.update_document(doc["id"], conn=c, status="expired")
            store.append_event(doc["id"], "document.expired", conn=c, metadata={"expires_at": current["expires_at"]})


def _expire_due() -> None:
    for d in store.documents_past_expiry(store.utcnow_iso()):
        _mark_expired(d)


def _session_valid(rec: Dict[str, Any], session_token: Optional[str]) -> bool:
    if not session_token or not rec.get("session_token_hash") or not rec.get("session_expires_at"):
        return False
    if (store.parse_iso(rec["session_expires_at"]) or store.utcnow()) <= store.utcnow():
        return False
    return tokens.constant_time_equals(tokens.hash_token(session_token), rec["session_token_hash"])


def _require_session(rec: Dict[str, Any], session_token: Optional[str]) -> None:
    if not _session_valid(rec, session_token):
        raise err(401, "session_invalid", "Verify the code sent to your email to continue.")


def _next_step(doc: Dict[str, Any], rec: Dict[str, Any], session_ok: bool) -> str:
    if doc["status"] == "executed":
        return "done"
    if rec["status"] == "signed":
        return "awaiting_others"
    if rec["role"] == "cc":
        return "done"
    return "view" if session_ok else "otp"


def landing(raw_token: str, ip: Optional[str], ua: Optional[str], session_token: Optional[str]) -> Dict[str, Any]:
    _require_enabled()
    doc, rec = _load_by_token(raw_token)
    if ip and not store.rate_hit(f"ip:{ip}", IP_PAGE_LOADS_PER_HOUR, 3600):
        store.append_event(doc["id"], "rate.limited", recipient_id=rec["id"], **_client_meta(ip, ua), metadata={"what": "page_load"})
        raise err(429, "rate_limited", "Too many requests. Try again in a little while.")
    try:
        doc, rec = _gate(doc, rec)
    except HTTPException as e:
        store.append_event(doc["id"], "link.rejected", recipient_id=rec["id"], **_client_meta(ip, ua),
                           metadata={"reason": e.detail.get("code") if isinstance(e.detail, dict) else str(e.detail)})
        raise
    with store.connect(immediate=True) as c:
        if not rec.get("link_opened_at"):
            store.update_recipient(rec["id"], conn=c, link_opened_at=store.utcnow_iso())
        store.append_event(doc["id"], "link.opened", recipient_id=rec["id"], actor_email=rec["email"], conn=c, **_client_meta(ip, ua))
    session_ok = _session_valid(rec, session_token)
    provider = get_provider()
    meta = json.loads(doc.get("provider_meta_json") or "{}")
    return {
        "document": {
            "id": doc["id"], "title": doc["title"], "status": doc["status"], "template_id": doc["template_id"],
            "entity": tpl.entity_fields()["champions_entity"], "counterparty_entity": doc["counterparty_entity"],
            "sender_name": doc.get("sender_name"), "expires_at": doc["expires_at"], "page_count": doc.get("page_count"),
            "executed_at": doc.get("executed_at"),
        },
        "recipient": {
            "id": rec["id"], "name": rec["name"], "role": rec["role"], "email_masked": mask_email(rec["email"]),
            "designation": rec.get("designation"), "status": rec["status"], "otp_verified": session_ok,
            "scrolled_to_end": bool(rec.get("scrolled_to_end_at")), "signed_at": rec.get("signed_at"),
        },
        "provider": {"name": provider.name, "hosted_signing": provider.hosted_signing,
                     "signing_url": (meta.get("signing_urls") or {}).get(rec["id"]) if provider.hosted_signing and session_ok else None},
        "next": _next_step(doc, rec, session_ok),
    }


async def request_otp(raw_token: str, ip: Optional[str], ua: Optional[str]) -> Dict[str, Any]:
    _require_enabled()
    doc, rec = _gate(*_load_by_token(raw_token))
    if rec["status"] == "signed" or rec["role"] == "cc":
        raise err(409, "already_signed", "Nothing left to sign on this link.")
    now = store.utcnow()
    window_start = store.parse_iso(rec.get("otp_window_start"))
    count = int(rec.get("otp_request_count") or 0)
    if not window_start or now - window_start > timedelta(hours=1):
        window_start, count = now, 0
    if count >= tokens.OTP_MAX_REQUESTS_PER_HOUR:
        store.append_event(doc["id"], "rate.limited", recipient_id=rec["id"], **_client_meta(ip, ua), metadata={"what": "otp_request"})
        raise err(429, "otp_rate_limited", "Too many codes requested. Wait an hour or ask the sender to resend.")
    code = tokens.new_otp()
    expires = store.iso(now + timedelta(seconds=tokens.OTP_TTL_SECONDS))
    with store.connect(immediate=True) as c:
        store.update_recipient(rec["id"], conn=c, otp_hash=tokens.hash_otp(code, rec["id"]), otp_expires_at=expires,
                               otp_attempts=0, otp_request_count=count + 1, otp_window_start=store.iso(window_start))
        store.append_event(doc["id"], "otp.requested", recipient_id=rec["id"], actor_email=rec["email"], conn=c,
                           **_client_meta(ip, ua), metadata={"request_number": count + 1, "expires_at": expires})
    email = mail.otp_email(to=rec["email"], code=code, title=doc["title"], minutes=tokens.OTP_TTL_SECONDS // 60,
                           document_id=doc["id"], recipient_id=rec["id"])
    try:
        await mail.get_mailer().send(email)
    except mail.MailError as e:
        logger.error("OTP email failed: %s", e)
        raise err(502, "mail_error", "We could not send the verification code. Try again in a moment.")
    return {"sent_to": mask_email(rec["email"]), "expires_in": tokens.OTP_TTL_SECONDS, "attempts_allowed": tokens.OTP_MAX_ATTEMPTS}


async def verify_otp(raw_token: str, code: str, ip: Optional[str], ua: Optional[str], base_url: str) -> Dict[str, Any]:
    _require_enabled()
    doc, rec = _gate(*_load_by_token(raw_token))
    code = re.sub(r"\D", "", code or "")
    if not rec.get("otp_hash") or not rec.get("otp_expires_at"):
        raise err(400, "otp_missing", "Request a verification code first.")
    if (store.parse_iso(rec["otp_expires_at"]) or store.utcnow()) <= store.utcnow():
        raise err(400, "otp_expired", "That code has expired. Request a new one.")
    if len(code) != tokens.OTP_DIGITS or not tokens.constant_time_equals(tokens.hash_otp(code, rec["id"]), rec["otp_hash"]):
        attempts = int(rec.get("otp_attempts") or 0) + 1
        with store.connect(immediate=True) as c:
            fields: Dict[str, Any] = {"otp_attempts": attempts}
            locked = attempts >= tokens.OTP_MAX_ATTEMPTS
            if locked:
                fields.update(token_locked_at=store.utcnow_iso(), otp_hash=None, otp_expires_at=None)
            store.update_recipient(rec["id"], conn=c, **fields)
            store.append_event(doc["id"], "otp.failed", recipient_id=rec["id"], actor_email=rec["email"], conn=c,
                               **_client_meta(ip, ua), metadata={"attempt": attempts})
            if locked:
                store.append_event(doc["id"], "token.locked", recipient_id=rec["id"], actor_email=rec["email"], conn=c,
                                   **_client_meta(ip, ua), metadata={"reason": "otp_attempts_exhausted"})
        if locked:
            await _notify_locked(doc, rec, base_url)
            raise err(423, "locked", "Too many incorrect codes. This link is now locked; the sender has been notified.")
        left = tokens.OTP_MAX_ATTEMPTS - attempts
        raise err(400, "otp_invalid", f"That code is not right. {left} attempt{'s' if left != 1 else ''} left.", attempts_left=left)

    session = tokens.new_session_token()
    session_exp = store.iso(store.utcnow() + timedelta(seconds=tokens.SESSION_TTL_SECONDS))
    with store.connect(immediate=True) as c:
        store.update_recipient(rec["id"], conn=c, otp_verified_at=store.utcnow_iso(), otp_hash=None, otp_expires_at=None,
                               otp_attempts=0, session_token_hash=tokens.hash_token(session), session_expires_at=session_exp)
        store.append_event(doc["id"], "otp.verified", recipient_id=rec["id"], actor_email=rec["email"], conn=c, **_client_meta(ip, ua))
    rec = store.get_recipient(rec["id"]) or rec
    meta = json.loads(doc.get("provider_meta_json") or "{}")
    provider = get_provider()
    return {
        "session_token": session,
        "expires_at": session_exp,
        "next": _next_step(doc, rec, True),
        "signing_url": (meta.get("signing_urls") or {}).get(rec["id"]) if provider.hosted_signing else None,
    }


async def _notify_locked(doc: Dict[str, Any], rec: Dict[str, Any], base_url: str) -> None:
    if not doc.get("sender_email"):
        return
    email = mail.otp_locked_email(to=doc["sender_email"], sender_name=doc.get("sender_name") or "there",
                                  recipient_name=rec["name"], recipient_email=rec["email"], title=doc["title"],
                                  console_url=console_url(base_url), document_id=doc["id"])
    try:
        await mail.get_mailer().send(email)
    except mail.MailError as e:
        logger.error("lock notification failed: %s", e)


def get_pdf(raw_token: str, session_token: Optional[str], ip: Optional[str], ua: Optional[str]) -> Tuple[bytes, str]:
    _require_enabled()
    doc, rec = _gate(*_load_by_token(raw_token))
    _require_session(rec, session_token)
    if doc["status"] == "executed" and doc.get("storage_key"):
        data = get_storage().get(doc["storage_key"])
        return data, _safe_filename(f"{doc['title']}_executed")
    key = doc.get("working_storage_key") or doc.get("draft_storage_key")
    data = get_storage().get(key)
    with store.connect(immediate=True) as c:
        fields: Dict[str, Any] = {}
        if not rec.get("viewed_at"):
            fields["viewed_at"] = store.utcnow_iso()
        if rec["status"] == "pending":
            fields["status"] = "viewed"
        if fields:
            store.update_recipient(rec["id"], conn=c, **fields)
        current = store.get_document(doc["id"], conn=c)
        if current and current["status"] == "sent":
            store.update_document(doc["id"], conn=c, status="viewed")
        store.append_event(doc["id"], "document.viewed", recipient_id=rec["id"], actor_email=rec["email"], conn=c,
                           **_client_meta(ip, ua), metadata={"sha256": hashlib.sha256(data).hexdigest(), "key": key})
    return data, _safe_filename(doc["title"])


def record_scrolled(raw_token: str, session_token: Optional[str], ip: Optional[str], ua: Optional[str]) -> Dict[str, Any]:
    _require_enabled()
    doc, rec = _gate(*_load_by_token(raw_token))
    _require_session(rec, session_token)
    if rec.get("scrolled_to_end_at"):
        return {"ok": True, "already": True}
    with store.connect(immediate=True) as c:
        store.update_recipient(rec["id"], conn=c, scrolled_to_end_at=store.utcnow_iso())
        store.append_event(doc["id"], "document.scrolled_to_end", recipient_id=rec["id"], actor_email=rec["email"], conn=c,
                           **_client_meta(ip, ua))
    return {"ok": True, "already": False}


async def sign(raw_token: str, session_token: Optional[str], payload: Dict[str, Any], ip: Optional[str], ua: Optional[str],
               base_url: str) -> Dict[str, Any]:
    _require_enabled()
    doc, rec = _gate(*_load_by_token(raw_token))
    _require_session(rec, session_token)
    if rec["status"] == "signed":
        raise err(409, "already_signed", "You have already signed this document.")
    if rec["role"] == "cc":
        raise err(403, "not_a_signer", "This link is a copy for information only.")
    if not rec.get("scrolled_to_end_at"):
        raise err(409, "read_required", "Please read to the end of the document before signing.")
    # Sequential order: an earlier party must have signed first.
    earlier = [r for r in store.get_recipients(doc["id"]) if r["role"] in REQUIRED_ROLES and r["signing_order"] < rec["signing_order"]]
    if any(r["status"] != "signed" for r in earlier):
        raise err(409, "awaiting_others", "Another party has to sign before you.")

    provider = get_provider()
    if provider.hosted_signing:
        meta = json.loads(doc.get("provider_meta_json") or "{}")
        raise err(409, "hosted_signing", "This engine hosts its own signing step.",
                  signing_url=(meta.get("signing_urls") or {}).get(rec["id"]))

    kind = str(payload.get("kind") or "").strip()
    name = str(payload.get("name") or "").strip()
    designation = (str(payload.get("designation") or "").strip() or rec.get("designation") or None)
    if kind not in ("typed", "drawn"):
        raise err(422, "invalid_signature", "kind must be 'typed' or 'drawn'", field="kind")
    if len(name) < 2 or len(name) > 120:
        raise err(422, "invalid_signature", "Confirm your full name (2 to 120 characters)", field="name")
    if payload.get("intent") is not True:
        raise err(422, "intent_required", "Tick the statement confirming you intend to sign electronically", field="intent")
    image_png: Optional[bytes] = None
    if kind == "drawn":
        b64 = str(payload.get("image_png_b64") or "")
        if b64.startswith("data:"):
            b64 = b64.split(",", 1)[-1]
        try:
            image_png = base64.b64decode(b64, validate=True)
        except Exception:  # noqa: BLE001
            raise err(422, "invalid_signature", "Drawn signature image is not valid base64 PNG", field="image_png_b64")
        if not image_png or len(image_png) > 300 * 1024:
            raise err(422, "invalid_signature", "Drawn signature must be a PNG under 300 KB", field="image_png_b64")

    async with _lock(doc["id"]):
        rec = store.get_recipient(rec["id"]) or rec
        if rec["status"] == "signed":
            raise err(409, "already_signed", "You have already signed this document.")
        doc = store.get_document(doc["id"]) or doc
        signed_at = store.utcnow_iso()
        sig = SignatureInput(recipient_id=rec["id"], role=rec["role"], kind=kind, name=name, designation=designation,
                             signed_at=signed_at, ip_address=ip, user_agent=ua, image_png=image_png)
        working = get_storage().get(doc.get("working_storage_key") or doc["draft_storage_key"])
        try:
            stamped = await provider.apply_signature(working, json.loads(doc.get("anchors_json") or "{}"), sig)
        except ProviderNotSupported as e:
            raise err(409, "hosted_signing", str(e))
        except ProviderError as e:
            raise err(422, "invalid_signature", str(e))
        key = f"sign/{doc['id']}/signed-{rec['id']}.pdf"
        try:
            get_storage().put(key, stamped)
        except StorageError as e:
            raise err(500, "storage_error", str(e))
        signed_event = "document.signed" if rec["role"] == "signer" else "document.countersigned"
        with store.connect(immediate=True) as c:
            store.update_recipient(rec["id"], conn=c, status="signed", signed_at=signed_at, signature_kind=kind,
                                   signature_name=name, signer_ip=ip, signer_user_agent=(ua or "")[:512] or None,
                                   designation=designation)
            store.update_document(doc["id"], conn=c, working_storage_key=key,
                                  status="signed" if rec["role"] == "signer" else "countersigned")
            store.append_event(doc["id"], "signature.applied", recipient_id=rec["id"], actor_email=rec["email"], conn=c,
                               **_client_meta(ip, ua),
                               metadata={"kind": kind, "name": name, "designation": designation,
                                         "sha256": hashlib.sha256(stamped).hexdigest(), "key": key})
            store.append_event(doc["id"], signed_event, recipient_id=rec["id"], actor_email=rec["email"], conn=c,
                               **_client_meta(ip, ua), metadata={"signed_at": signed_at})

        recs = store.get_recipients(doc["id"])
        required = [r for r in recs if r["role"] in REQUIRED_ROLES]
        if all(r["status"] == "signed" for r in required):
            await execute(doc["id"], base_url)
            return {"status": "executed", "executed": True, "download_available": True}

        # Invite whoever is next in order.
        nxt = sorted([r for r in required if r["status"] != "signed"], key=lambda r: r["signing_order"])
        if nxt:
            raw = tokens.new_link_token()
            with store.connect(immediate=True) as c:
                store.update_recipient(nxt[0]["id"], conn=c, token_hash=tokens.hash_token(raw))
            await _send_invitations(store.get_document(doc["id"]), [nxt[0]], {nxt[0]["id"]: raw}, base_url, ip, ua)
        return {"status": store.get_document(doc["id"])["status"], "executed": False, "download_available": False}


def download_for_recipient(raw_token: str, session_token: Optional[str], ip: Optional[str], ua: Optional[str]) -> Tuple[bytes, str]:
    _require_enabled()
    doc, rec = _load_by_token(raw_token)
    if doc["status"] != "executed" or not doc.get("storage_key"):
        raise err(409, "not_executed", "The executed document is not available yet.")
    _require_session(rec, session_token)
    data = get_storage().get(doc["storage_key"])
    store.append_event(doc["id"], "copy.downloaded", recipient_id=rec["id"], actor_email=rec["email"], **_client_meta(ip, ua),
                       metadata={"sha256": hashlib.sha256(data).hexdigest(), "by": "recipient"})
    return data, _safe_filename(f"{doc['title']}_executed")


# --------------------------------------------------------------------------
# Execution
# --------------------------------------------------------------------------


async def execute(doc_id: str, base_url: str) -> Dict[str, Any]:
    doc = store.get_document(doc_id)
    if not doc:
        raise err(404, "not_found", "Document not found")
    if doc["status"] == "executed":
        return document_view(doc, store.get_recipients(doc_id))
    provider = get_provider()
    recs = store.get_recipients(doc_id)
    events = store.list_events(doc_id)
    chain = store.verify_chain(doc_id)
    if not chain["ok"]:
        raise err(500, "chain_broken", "Audit chain verification failed; refusing to execute", chain=chain)
    entity = tpl.entity_fields()["champions_entity"]
    info = seal_info() or {}
    executed_at = store.utcnow_iso()
    ctx = CertificateContext(
        document_id=doc_id, title=doc["title"], template_id=doc["template_id"], template_version=doc["template_version"],
        template_sha256=doc["template_sha256"], champions_entity=entity, counterparty_entity=doc["counterparty_entity"],
        sender_name=doc.get("sender_name") or "", sender_email=doc.get("sender_email") or "", created_at=doc["created_at"],
        sent_at=doc.get("sent_at"), executed_at=executed_at, draft_sha256=doc.get("draft_sha256") or "",
        chain_head=chain["head"], event_count=chain["events"],
        recipients=[{k: r.get(k) for k in ("name", "email", "designation", "role", "signature_kind", "signature_name",
                                           "link_opened_at", "otp_verified_at", "viewed_at", "scrolled_to_end_at",
                                           "signed_at", "signer_ip", "signer_user_agent")} for r in recs if r["role"] != "cc"],
        events=[{k: e.get(k) for k in ("event_type", "occurred_at", "ip_address", "actor_email")} for e in events],
        seal_subject=info.get("subject"), seal_self_signed=bool(info.get("self_signed", True)),
        verify_url=f"{base_url}/sign.html?verify={doc_id}",
    )
    working = get_storage().get(doc.get("working_storage_key") or doc["draft_storage_key"])
    try:
        outcome = await provider.seal(working, ctx, reason=f"Executed via ChampPDF Sign for {entity}", location="Bengaluru, India")
    except ProviderError as e:
        logger.exception("seal failed for %s", doc_id)
        raise err(502, "seal_error", str(e))
    meta = {"sealed": outcome.sealed, "timestamped": outcome.timestamped, "seal_subject": outcome.seal_subject,
            "self_signed": outcome.self_signed, "notes": outcome.notes, "chain_head": chain["head"], "executed_at": executed_at}
    return await _finalize_executed(doc_id, outcome.pdf, meta, base_url)


async def _finalize_executed(doc_id: str, sealed_pdf: bytes, meta: Dict[str, Any], base_url: str) -> Dict[str, Any]:
    sha = hashlib.sha256(sealed_pdf).hexdigest()
    key = f"sign/{doc_id}/executed.pdf"
    try:
        get_storage().put(key, sealed_pdf)
    except StorageError as e:
        raise err(500, "storage_error", str(e))
    executed_at = meta.get("executed_at") or store.utcnow_iso()
    with store.connect(immediate=True) as c:
        chain_head = store.chain_head(doc_id, c)
        store.update_document(doc_id, conn=c, status="executed", executed_at=executed_at, storage_key=key, content_sha256=sha,
                              chain_head_at_execution=meta.get("chain_head") or chain_head, seal_info_json=json.dumps(meta))
        if "timestamp_unavailable" in (meta.get("notes") or []):
            store.append_event(doc_id, "seal.timestamp_unavailable", conn=c, metadata={"tsa": os.environ.get("PDF_TSA_URL")})
        store.append_event(doc_id, "document.executed", conn=c,
                           metadata={"content_sha256": sha, "storage_key": key, "sealed": meta.get("sealed"),
                                     "timestamped": meta.get("timestamped"), "seal_subject": meta.get("seal_subject"),
                                     "self_signed": meta.get("self_signed")})
    doc = store.get_document(doc_id)
    recs = store.get_recipients(doc_id)
    await _send_executed_emails(doc, recs, sealed_pdf, sha)
    return document_view(doc, recs)


async def _send_executed_emails(doc: Dict[str, Any], recs: List[Dict[str, Any]], pdf: bytes, sha: str) -> None:
    mailer = mail.get_mailer()
    entity = tpl.entity_fields()["champions_entity"]
    filename = _safe_filename(f"{doc['title']}_executed")
    targets: List[Tuple[str, str, Optional[str]]] = [(r["email"], r["name"], r["id"]) for r in recs]
    if doc.get("sender_email") and doc["sender_email"].lower() not in {t[0].lower() for t in targets}:
        targets.append((doc["sender_email"], doc.get("sender_name") or "there", None))
    for to, name, rid in targets:
        email = mail.executed_email(to=to, name=name, title=doc["title"], entity=entity, counterparty=doc["counterparty_entity"],
                                    executed_at_text=_fmt_human(doc["executed_at"]), content_sha256=sha, pdf=pdf,
                                    filename=filename, document_id=doc["id"], recipient_id=rid or "sender",
                                    reply_to=doc.get("sender_email"))
        try:
            await mailer.send(email)
        except mail.MailError as e:
            logger.error("executed email to %s failed: %s", to, e)


# --------------------------------------------------------------------------
# Small guards
# --------------------------------------------------------------------------


def _require_enabled() -> None:
    if not sign_enabled():
        raise err(503, "sign_disabled", "ChampPDF Sign is not enabled on this server (pyHanko / PyMuPDF missing or ENABLE_SIGN=false).")


def _template(template_id: str) -> tpl.Template:
    try:
        return tpl.get_template(template_id)
    except tpl.TemplateError as e:
        raise err(404, "unknown_template", str(e))


def _values(template: tpl.Template, values: Dict[str, Any]) -> Dict[str, str]:
    try:
        return tpl.validate_merge_fields(template, values or {})
    except tpl.TemplateError as e:
        raise err(422, "invalid_field", str(e), field=e.field_key)
