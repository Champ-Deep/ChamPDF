"""
Transactional email for ChampPDF Sign.

Signing invitations are legally significant mail. They go through a
dedicated transactional sender on an isolated subdomain, never through cold
outbound infrastructure (InboxKit or similar): a blocklisted cold domain
would silently stop contracts arriving. See DPRD section 07.

Backends
  ResendMailer   when RESEND_API_KEY is set. Uses Resend's HTTP API with no
                 extra dependency. Delivery / bounce / complaint webhooks are
                 verified in ``verify_resend_webhook`` and recorded as audit
                 events by the router.
  LogMailer      default. Logs the message and keeps the last 200 in memory
                 (the dry run and the tests read OTPs from here).

Env
  RESEND_API_KEY          switches on ResendMailer
  SIGN_EMAIL_FROM         default "Champions Superior Capital <notifications@sign.championsmail.com>"
  SIGN_EMAIL_REPLY_TO     optional fallback reply-to; the sender's own address wins when known
  RESEND_WEBHOOK_SECRET   Svix signing secret (whsec_...) for /api/sign/webhooks/resend
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import html
import json
import logging
import os
import time
import urllib.error
import urllib.request
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Deque, Dict, List, Mapping, Optional

logger = logging.getLogger(__name__)

DEFAULT_FROM = "Champions Superior Capital <notifications@sign.championsmail.com>"


class MailError(Exception):
    pass


@dataclass
class Attachment:
    filename: str
    content: bytes
    content_type: str = "application/pdf"


@dataclass
class Email:
    to: List[str]
    subject: str
    html: str
    text: str
    reply_to: Optional[str] = None
    tags: Dict[str, str] = field(default_factory=dict)
    attachments: List[Attachment] = field(default_factory=list)


class LogMailer:
    name = "log"
    configured = False

    def __init__(self) -> None:
        self.sent: Deque[Email] = deque(maxlen=200)

    async def send(self, email: Email) -> Optional[str]:
        self.sent.append(email)
        logger.info(
            "[sign mail: not delivered, no RESEND_API_KEY] to=%s subject=%r attachments=%d\n%s",
            email.to, email.subject, len(email.attachments), email.text,
        )
        return f"log-{int(time.time() * 1000)}"


class ResendMailer:
    name = "resend"
    configured = True

    def __init__(self, api_key: str, from_addr: str) -> None:
        self.api_key = api_key
        self.from_addr = from_addr

    def _send_sync(self, email: Email) -> Optional[str]:
        body: Dict[str, Any] = {
            "from": self.from_addr,
            "to": email.to,
            "subject": email.subject,
            "html": email.html,
            "text": email.text,
            "headers": {"X-Entity-Ref-ID": email.tags.get("document_id", "")},
        }
        if email.reply_to:
            body["reply_to"] = email.reply_to
        if email.tags:
            body["tags"] = [{"name": k, "value": _tag_value(v)} for k, v in email.tags.items()]
        if email.attachments:
            body["attachments"] = [
                {"filename": a.filename, "content": base64.b64encode(a.content).decode("ascii")}
                for a in email.attachments
            ]
        req = urllib.request.Request(
            "https://api.resend.com/emails",
            data=json.dumps(body).encode("utf-8"),
            method="POST",
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:  # nosec - fixed host
                data = json.loads(resp.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:300]
            raise MailError(f"Resend rejected the message ({e.code}): {detail}") from e
        except urllib.error.URLError as e:
            raise MailError(f"Resend unreachable: {e.reason}") from e
        return data.get("id")

    async def send(self, email: Email) -> Optional[str]:
        return await asyncio.to_thread(self._send_sync, email)


def _tag_value(v: str) -> str:
    # Resend tag values: ASCII letters, numbers, underscores, dashes.
    return "".join(c if (c.isascii() and (c.isalnum() or c in "_-")) else "_" for c in str(v))[:256]


_mailer: Optional[Any] = None


def get_mailer() -> Any:
    global _mailer
    if _mailer is None:
        key = os.environ.get("RESEND_API_KEY", "").strip()
        if key:
            _mailer = ResendMailer(key, os.environ.get("SIGN_EMAIL_FROM", "").strip() or DEFAULT_FROM)
            logger.info("Sign mailer: Resend as %s", _mailer.from_addr)
        else:
            _mailer = LogMailer()
            logger.warning("Sign mailer: LOG ONLY (set RESEND_API_KEY to deliver mail)")
    return _mailer


def mail_configured() -> bool:
    return bool(os.environ.get("RESEND_API_KEY", "").strip())


def reset_mailer_for_tests() -> None:
    global _mailer
    _mailer = None


# --------------------------------------------------------------------------
# Resend webhook verification (Svix signature scheme)
# --------------------------------------------------------------------------


def verify_resend_webhook(headers: Mapping[str, str], body: bytes, secret: str, tolerance_s: int = 300) -> bool:
    """Standard Svix verification: HMAC-SHA256 over "id.timestamp.body" with the base64 secret."""
    h = {k.lower(): v for k, v in headers.items()}
    msg_id, ts, sigs = h.get("svix-id"), h.get("svix-timestamp"), h.get("svix-signature")
    if not (msg_id and ts and sigs and secret):
        return False
    try:
        if abs(time.time() - int(ts)) > tolerance_s:
            return False
    except ValueError:
        return False
    raw_secret = secret.split("_", 1)[1] if secret.startswith("whsec_") else secret
    try:
        key = base64.b64decode(raw_secret)
    except Exception:  # noqa: BLE001
        return False
    signed = f"{msg_id}.{ts}.".encode("utf-8") + body
    expected = base64.b64encode(hmac.new(key, signed, hashlib.sha256).digest()).decode("ascii")
    for part in sigs.split():
        version, _, sig = part.partition(",")
        if version == "v1" and hmac.compare_digest(sig, expected):
            return True
    return False


# --------------------------------------------------------------------------
# Messages
# --------------------------------------------------------------------------

_BRAND = "#FF6B35"


def _layout(title: str, body_html: str, footer: str) -> str:
    return f"""<!doctype html><html><body style="margin:0;background:#f4f5f8;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#141926">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f5f8;padding:32px 12px">
<tr><td align="center">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border-radius:12px;border:1px solid #e2e6ef">
<tr><td style="padding:28px 32px 8px 32px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#646c82">ChampPDF Sign</td></tr>
<tr><td style="padding:0 32px 8px 32px;font-size:20px;font-weight:600;line-height:1.3">{html.escape(title)}</td></tr>
<tr><td style="padding:8px 32px 28px 32px;font-size:15px;line-height:1.6;color:#3b4256">{body_html}</td></tr>
<tr><td style="padding:16px 32px 24px 32px;border-top:1px solid #e2e6ef;font-size:12px;line-height:1.5;color:#8a93ab">{footer}</td></tr>
</table>
<p style="font-size:11px;color:#8a93ab;margin-top:16px">This message was sent by ChampPDF Sign on behalf of the sender named above. If you were not expecting it, you can ignore it; nothing happens without the verification code.</p>
</td></tr></table></body></html>"""


def _button(url: str, label: str) -> str:
    return (
        f'<p style="margin:24px 0"><a href="{html.escape(url, quote=True)}" '
        f'style="display:inline-block;background:{_BRAND};color:#ffffff;text-decoration:none;font-weight:600;'
        f'padding:12px 22px;border-radius:8px">{html.escape(label)}</a></p>'
    )


def invitation_email(*, to: str, recipient_name: str, sender_name: str, sender_email: Optional[str], entity: str,
                     title: str, link: str, expires_at_text: str, document_id: str, recipient_id: str) -> Email:
    subject = f"{sender_name} has sent you a document to sign: {title}"
    body = (
        f"<p>Hello {html.escape(recipient_name)},</p>"
        f"<p>{html.escape(sender_name)} at {html.escape(entity)} has sent you <b>{html.escape(title)}</b> for electronic signature.</p>"
        f"{_button(link, 'Review and sign')}"
        f"<p>The link is valid until <b>{html.escape(expires_at_text)}</b>. When you open it we will email a six-digit verification code to this address before anything can be signed.</p>"
    )
    text = (
        f"Hello {recipient_name},\n\n{sender_name} at {entity} has sent you \"{title}\" for electronic signature.\n\n"
        f"Review and sign: {link}\n\nValid until {expires_at_text}. A six-digit verification code will be emailed to this address when you open the link.\n"
    )
    footer = f"Questions about the document? Reply to this email to reach {html.escape(sender_name)}."
    return Email(
        to=[to], subject=subject, html=_layout("A document is waiting for your signature", body, footer), text=text,
        reply_to=sender_email, tags={"kind": "invitation", "document_id": document_id, "recipient_id": recipient_id},
    )


def otp_email(*, to: str, code: str, title: str, minutes: int, document_id: str, recipient_id: str) -> Email:
    subject = f"{code} is your ChampPDF Sign verification code"
    body = (
        f"<p>Use this code to continue to <b>{html.escape(title)}</b>:</p>"
        f'<p style="font-size:32px;letter-spacing:.3em;font-weight:700;font-family:Menlo,Consolas,monospace;margin:20px 0">{html.escape(code)}</p>'
        f"<p>It expires in {minutes} minutes and can only be used from the signing page you opened.</p>"
    )
    text = f"Your ChampPDF Sign verification code for \"{title}\" is {code}. It expires in {minutes} minutes.\n"
    footer = "If you did not request this code, ignore this email. Nobody can sign without it."
    return Email(
        to=[to], subject=subject, html=_layout("Your verification code", body, footer), text=text,
        tags={"kind": "otp", "document_id": document_id, "recipient_id": recipient_id},
    )


def executed_email(*, to: str, name: str, title: str, entity: str, counterparty: str, executed_at_text: str,
                   content_sha256: str, pdf: bytes, filename: str, document_id: str, recipient_id: str,
                   reply_to: Optional[str] = None) -> Email:
    subject = f"Executed: {title}"
    body = (
        f"<p>Hello {html.escape(name)},</p>"
        f"<p><b>{html.escape(title)}</b> between {html.escape(entity)} and {html.escape(counterparty)} was fully executed on {html.escape(executed_at_text)}.</p>"
        f"<p>The sealed PDF is attached, with its certificate of completion on the final pages. "
        f"Keep it: the seal makes any later edit detectable.</p>"
        f'<p style="font-size:12px;color:#646c82">SHA-256 of the attached file:<br><code style="font-size:11px">{html.escape(content_sha256)}</code></p>'
    )
    text = (
        f"Hello {name},\n\n\"{title}\" between {entity} and {counterparty} was fully executed on {executed_at_text}.\n"
        f"The sealed PDF is attached. SHA-256: {content_sha256}\n"
    )
    footer = "The certificate of completion records who signed, from where, and when, and the hash of the document each party viewed."
    return Email(
        to=[to], subject=subject, html=_layout("Your executed document", body, footer), text=text, reply_to=reply_to,
        tags={"kind": "executed", "document_id": document_id, "recipient_id": recipient_id},
        attachments=[Attachment(filename=filename, content=pdf)],
    )


def otp_locked_email(*, to: str, sender_name: str, recipient_name: str, recipient_email: str, title: str,
                     console_url: Optional[str], document_id: str) -> Email:
    subject = f"Signing link locked after failed verification attempts: {title}"
    body = (
        f"<p>Hello {html.escape(sender_name)},</p>"
        f"<p>The signing link for <b>{html.escape(title)}</b> sent to {html.escape(recipient_name)} "
        f"({html.escape(recipient_email)}) has been locked after five failed verification-code attempts.</p>"
        f"<p>Nothing was signed. If this was the intended signer, use <b>Resend</b> in the Sign console to issue a fresh link.</p>"
        + (_button(console_url, "Open the Sign console") if console_url else "")
    )
    text = (
        f"The signing link for \"{title}\" sent to {recipient_name} ({recipient_email}) was locked after five failed "
        f"verification attempts. Nothing was signed. Resend from the Sign console to issue a fresh link.\n"
    )
    return Email(
        to=[to], subject=subject, html=_layout("A signing link was locked", body, "Security notice from ChampPDF Sign."),
        text=text, tags={"kind": "otp_locked", "document_id": document_id},
    )
