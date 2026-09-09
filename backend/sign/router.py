"""
HTTP surface for ChampPDF Sign, all under /api/sign.

Sender routes (Clerk session JWT or X-Admin-Token):
  GET    /status                       feature status for the pages
  GET    /templates                    approved templates and their fields
  POST   /documents/preview            filled PDF, nothing created
  POST   /documents                    create + send
  GET    /documents                    mine (admin: all)
  GET    /documents/{id}               detail with events and chain check
  GET    /documents/{id}/download      sealed PDF (or the current draft)
  GET    /documents/{id}/verify        chain + hash + seal report
  POST   /documents/{id}/void
  POST   /documents/{id}/resend        rotates the link token
  POST   /documents/{id}/sync          hosted engines only

Signer routes (public, the 32-byte link token is the capability):
  GET    /s/{token}                    landing
  POST   /s/{token}/otp                request a code
  POST   /s/{token}/otp/verify         -> signer session
  GET    /s/{token}/document.pdf       Bearer <session>
  POST   /s/{token}/events             Bearer <session>  {"type": "scrolled_to_end"}
  POST   /s/{token}/sign               Bearer <session>
  GET    /s/{token}/download           Bearer <session>, executed only

Webhooks:
  POST   /webhooks/resend              delivery / bounce / complaint -> audit events

Every signer response carries X-Robots-Tag: noindex, Referrer-Policy:
no-referrer and Cache-Control: no-store so the token never leaks through an
index or a referer header.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from fastapi.responses import JSONResponse, Response as RawResponse
from pydantic import BaseModel, Field

from . import service
from . import templates as tpl
from .auth import Sender, require_sender
from .mailer import verify_resend_webhook

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/sign", tags=["sign"])

SIGNER_HEADERS = {
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
}


# --------------------------------------------------------------------------
# Models
# --------------------------------------------------------------------------


class RecipientIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: str = Field(min_length=3, max_length=254)
    designation: Optional[str] = Field(default=None, max_length=120)


class PreviewIn(BaseModel):
    template_id: str = Field(min_length=1, max_length=80)
    fields: Dict[str, Any] = Field(default_factory=dict)
    signer: Optional[RecipientIn] = None


class CreateDocumentIn(BaseModel):
    template_id: str = Field(min_length=1, max_length=80)
    fields: Dict[str, Any] = Field(default_factory=dict)
    signer: RecipientIn
    countersigner: Optional[RecipientIn] = None
    cc: Optional[List[RecipientIn]] = None
    expires_in_days: int = Field(default=service.DEFAULT_EXPIRY_DAYS, ge=1, le=service.MAX_EXPIRY_DAYS)


class VoidIn(BaseModel):
    reason: Optional[str] = Field(default=None, max_length=500)


class ResendIn(BaseModel):
    recipient_id: Optional[str] = None


class OtpVerifyIn(BaseModel):
    code: str = Field(min_length=1, max_length=16)


class EventIn(BaseModel):
    type: str = Field(min_length=1, max_length=40)


class SignIn(BaseModel):
    kind: str = Field(pattern="^(typed|drawn)$")
    name: str = Field(min_length=1, max_length=120)
    designation: Optional[str] = Field(default=None, max_length=120)
    intent: bool = False
    image_png_b64: Optional[str] = Field(default=None, max_length=420_000)


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


def _ip(request: Request) -> Optional[str]:
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()[:64]
    return request.client.host if request.client else None


def _ua(request: Request) -> Optional[str]:
    return (request.headers.get("user-agent") or "")[:512] or None


def _origin(request: Request) -> Optional[str]:
    origin = request.headers.get("origin")
    if origin:
        return origin
    host = request.headers.get("x-forwarded-host") or request.headers.get("host")
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    return f"{proto}://{host}" if host else None


def _bearer(authorization: Optional[str]) -> Optional[str]:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return None


def _pdf(data: bytes, filename: str, inline: bool = True, extra: Optional[Dict[str, str]] = None) -> Response:
    headers = {
        "Content-Disposition": f"{'inline' if inline else 'attachment'}; filename=\"{filename}\"",
        "X-Content-Type-Options": "nosniff",
        **(extra or {}),
    }
    return RawResponse(content=data, media_type="application/pdf", headers=headers)


def _signer_json(payload: Dict[str, Any], status: int = 200) -> JSONResponse:
    return JSONResponse(payload, status_code=status, headers=SIGNER_HEADERS)


# --------------------------------------------------------------------------
# Sender routes
# --------------------------------------------------------------------------


@router.get("/status", summary="Sign feature status")
async def sign_status() -> Dict[str, Any]:
    return service.status_summary()


@router.get("/templates", summary="Approved templates")
async def sign_templates(sender: Sender = Depends(require_sender)) -> Dict[str, Any]:
    return {"templates": tpl.list_templates(), "entity": tpl.entity_fields(), "role": sender.role}


@router.post("/documents/preview", summary="Render a filled template without sending")
async def sign_preview(body: PreviewIn, sender: Sender = Depends(require_sender)) -> Response:
    pdf = await service.preview(sender, body.template_id, body.fields, body.signer.model_dump() if body.signer else None)
    return _pdf(pdf, "preview.pdf", inline=True, extra={"Cache-Control": "no-store"})


@router.post("/documents", summary="Create a document from a template and send it for signature", status_code=201)
async def sign_create(body: CreateDocumentIn, request: Request, sender: Sender = Depends(require_sender)) -> Dict[str, Any]:
    return await service.create_and_send(
        sender,
        template_id=body.template_id,
        values=body.fields,
        signer=body.signer.model_dump(),
        countersigner=body.countersigner.model_dump() if body.countersigner else None,
        cc=[c.model_dump() for c in body.cc] if body.cc else None,
        expires_in_days=body.expires_in_days,
        base_url=service.public_base_url(_origin(request)),
        ip=_ip(request),
        ua=_ua(request),
    )


@router.get("/documents", summary="List documents (yours; all for admins)")
async def sign_list(sender: Sender = Depends(require_sender)) -> Dict[str, Any]:
    return {"documents": service.list_for(sender), "role": sender.role}


@router.get("/documents/{doc_id}", summary="Document detail with audit trail")
async def sign_get(doc_id: str, sender: Sender = Depends(require_sender)) -> Dict[str, Any]:
    return service.get_for(sender, doc_id)


@router.get("/documents/{doc_id}/download", summary="Download the sealed PDF (or current draft)")
async def sign_download(doc_id: str, sender: Sender = Depends(require_sender)) -> Response:
    data, filename, kind = service.download_for(sender, doc_id)
    return _pdf(data, filename, inline=False, extra={"X-ChamPDF-Sign-File": kind, "Cache-Control": "no-store"})


@router.get("/documents/{doc_id}/verify", summary="Verify the audit chain, file hash and seal")
async def sign_verify(doc_id: str, sender: Sender = Depends(require_sender)) -> Dict[str, Any]:
    return await service.verify(sender, doc_id)


@router.post("/documents/{doc_id}/void", summary="Withdraw a document; its links return 410")
async def sign_void(doc_id: str, body: VoidIn, request: Request, sender: Sender = Depends(require_sender)) -> Dict[str, Any]:
    return await service.void(sender, doc_id, body.reason, _ip(request), _ua(request))


@router.post("/documents/{doc_id}/resend", summary="Rotate the link and resend the invitation")
async def sign_resend(doc_id: str, body: ResendIn, request: Request, sender: Sender = Depends(require_sender)) -> Dict[str, Any]:
    return await service.resend(sender, doc_id, body.recipient_id, service.public_base_url(_origin(request)), _ip(request), _ua(request))


@router.post("/documents/{doc_id}/sync", summary="Hosted engines: pull status and the sealed file")
async def sign_sync(doc_id: str, request: Request, sender: Sender = Depends(require_sender)) -> Dict[str, Any]:
    return await service.sync_from_provider(sender, doc_id, service.public_base_url(_origin(request)))


# --------------------------------------------------------------------------
# Signer routes
# --------------------------------------------------------------------------


@router.get("/s/{token}", summary="Signing link landing")
async def signer_landing(token: str, request: Request, authorization: Optional[str] = Header(None)) -> JSONResponse:
    try:
        payload = service.landing(token, _ip(request), _ua(request), _bearer(authorization))
    except HTTPException as e:
        return _signer_json({"detail": e.detail}, e.status_code)
    return _signer_json(payload)


@router.post("/s/{token}/otp", summary="Email a verification code to the invited address")
async def signer_otp(token: str, request: Request) -> JSONResponse:
    try:
        payload = await service.request_otp(token, _ip(request), _ua(request))
    except HTTPException as e:
        return _signer_json({"detail": e.detail}, e.status_code)
    return _signer_json(payload)


@router.post("/s/{token}/otp/verify", summary="Verify the code; returns a signer session")
async def signer_otp_verify(token: str, body: OtpVerifyIn, request: Request) -> JSONResponse:
    try:
        payload = await service.verify_otp(token, body.code, _ip(request), _ua(request), service.public_base_url(_origin(request)))
    except HTTPException as e:
        return _signer_json({"detail": e.detail}, e.status_code)
    return _signer_json(payload)


@router.get("/s/{token}/document.pdf", summary="The document to read (signer session required)")
async def signer_pdf(token: str, request: Request, authorization: Optional[str] = Header(None)) -> Response:
    try:
        data, filename = service.get_pdf(token, _bearer(authorization), _ip(request), _ua(request))
    except HTTPException as e:
        return _signer_json({"detail": e.detail}, e.status_code)
    return _pdf(data, filename, inline=True, extra=SIGNER_HEADERS)


@router.post("/s/{token}/events", summary="Signer-side events (read gate)")
async def signer_event(token: str, body: EventIn, request: Request, authorization: Optional[str] = Header(None)) -> JSONResponse:
    if body.type != "scrolled_to_end":
        return _signer_json({"detail": {"code": "unknown_event", "message": "unsupported event type"}}, 422)
    try:
        payload = service.record_scrolled(token, _bearer(authorization), _ip(request), _ua(request))
    except HTTPException as e:
        return _signer_json({"detail": e.detail}, e.status_code)
    return _signer_json(payload)


@router.post("/s/{token}/sign", summary="Apply the signature")
async def signer_sign(token: str, body: SignIn, request: Request, authorization: Optional[str] = Header(None)) -> JSONResponse:
    try:
        payload = await service.sign(token, _bearer(authorization), body.model_dump(), _ip(request), _ua(request),
                                     service.public_base_url(_origin(request)))
    except HTTPException as e:
        return _signer_json({"detail": e.detail}, e.status_code)
    return _signer_json(payload)


@router.get("/s/{token}/download", summary="Download the executed PDF (signer session required)")
async def signer_download(token: str, request: Request, authorization: Optional[str] = Header(None)) -> Response:
    try:
        data, filename = service.download_for_recipient(token, _bearer(authorization), _ip(request), _ua(request))
    except HTTPException as e:
        return _signer_json({"detail": e.detail}, e.status_code)
    return _pdf(data, filename, inline=False, extra=SIGNER_HEADERS)


# --------------------------------------------------------------------------
# Webhooks
# --------------------------------------------------------------------------

_RESEND_EVENTS = {
    "email.delivered": "invitation.delivered",
    "email.bounced": "invitation.bounced",
    "email.complained": "invitation.complained",
}


@router.post("/webhooks/resend", summary="Resend delivery webhooks -> audit events")
async def resend_webhook(request: Request) -> Dict[str, Any]:
    secret = os.environ.get("RESEND_WEBHOOK_SECRET", "").strip()
    body = await request.body()
    if not secret:
        raise HTTPException(status_code=503, detail="RESEND_WEBHOOK_SECRET is not set")
    if not verify_resend_webhook(request.headers, body, secret):
        raise HTTPException(status_code=401, detail="invalid webhook signature")
    try:
        payload = json.loads(body.decode("utf-8"))
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid JSON")
    event_type = _RESEND_EVENTS.get(str(payload.get("type", "")))
    if not event_type:
        return {"ok": True, "ignored": payload.get("type")}
    data = payload.get("data") or {}
    tags = data.get("tags") or {}
    if isinstance(tags, list):  # some payloads use [{name, value}]
        tags = {t.get("name"): t.get("value") for t in tags if isinstance(t, dict)}
    document_id = tags.get("document_id")
    recipient_id = tags.get("recipient_id")
    if not document_id and data.get("email_id"):
        rec = service.find_recipient_by_message_id(str(data["email_id"]))
        if rec:
            document_id, recipient_id = rec["document_id"], rec["id"]
    if not document_id:
        return {"ok": True, "ignored": "no document reference"}
    recorded = service.record_delivery_event(
        event_type, document_id, recipient_id,
        {"message_id": data.get("email_id"), "kind": tags.get("kind"), "provider_event": payload.get("type"),
         "created_at": payload.get("created_at"), "bounce": data.get("bounce")},
    )
    return {"ok": True, "recorded": recorded}
