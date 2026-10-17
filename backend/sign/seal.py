"""
Sealing for ChampPDF Sign.

Three jobs:

1. Seal certificate. The PAdES seal is applied with an organisation
   certificate, never the signer's (signers have no certificate; their
   identity is proven by the OTP + audit chain, not by PKI). Configure a real
   certificate with SIGN_SEAL_P12_B64 (or SIGN_SEAL_P12_PATH) and
   SIGN_SEAL_P12_PASSWORD. With nothing configured a self-signed seal is
   generated once and persisted under the data directory, so hashes stay
   verifiable across restarts. That is fine for the dry run and is reported
   as ``self_signed`` in /api/capabilities so nobody mistakes it for a
   trusted chain.

2. The PAdES seal itself, via the existing pyHanko path in pdf_signer.py
   (invisible signature field, optional RFC 3161 timestamp).

3. The certificate of completion: pages appended before sealing that record
   who was invited, who proved control of which mailbox, from where, when,
   what exact document they viewed (its hash), and the audit-chain head.
"""

from __future__ import annotations

import base64
import logging
import os
import secrets
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .store import data_dir

logger = logging.getLogger(__name__)

SEAL_FIELD_NAME = "ChampPDFSignSeal"


class SealError(Exception):
    pass


# --------------------------------------------------------------------------
# Seal certificate
# --------------------------------------------------------------------------


def _generate_self_signed(entity: str) -> Tuple[bytes, str]:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives.serialization import pkcs12
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name(
        [
            x509.NameAttribute(NameOID.COMMON_NAME, f"ChampPDF Sign Seal ({entity})"[:64]),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, entity[:64]),
            x509.NameAttribute(NameOID.COUNTRY_NAME, "IN"),
        ]
    )
    now = datetime.now(timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=5 * 365))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=True,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .sign(key, hashes.SHA256())
    )
    passphrase = secrets.token_urlsafe(24)
    p12 = pkcs12.serialize_key_and_certificates(
        b"champdf-sign-seal",
        key,
        cert,
        None,
        serialization.BestAvailableEncryption(passphrase.encode("utf-8")),
    )
    return p12, passphrase


def _cert_summary(p12_bytes: bytes, passphrase: str, self_signed: bool, source: str) -> Dict[str, Any]:
    from cryptography.hazmat.primitives.serialization import pkcs12
    from cryptography.x509.oid import NameOID

    _key, cert, _extra = pkcs12.load_key_and_certificates(p12_bytes, passphrase.encode("utf-8"))
    if cert is None:
        raise SealError("seal PKCS#12 contains no certificate")
    cn = cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME)
    org = cert.subject.get_attributes_for_oid(NameOID.ORGANIZATION_NAME)
    not_after = getattr(cert, "not_valid_after_utc", None) or cert.not_valid_after
    return {
        "subject": cn[0].value if cn else cert.subject.rfc4514_string(),
        "organization": org[0].value if org else None,
        "not_after": not_after.isoformat(),
        "self_signed": self_signed,
        "source": source,
        "serial": format(cert.serial_number, "x"),
    }


@dataclass
class SealMaterial:
    p12: bytes
    passphrase: str
    info: Dict[str, Any] = field(default_factory=dict)


_material: Optional[SealMaterial] = None


def load_seal(entity: str = "Champions Superior Capital") -> SealMaterial:
    """Env-configured certificate first; else a persisted self-signed one."""
    global _material
    if _material is not None:
        return _material

    b64 = os.environ.get("SIGN_SEAL_P12_B64", "").strip()
    path = os.environ.get("SIGN_SEAL_P12_PATH", "").strip()
    passphrase = os.environ.get("SIGN_SEAL_P12_PASSWORD", "")
    if b64:
        p12 = base64.b64decode(b64)
        _material = SealMaterial(p12, passphrase, _cert_summary(p12, passphrase, False, "env:SIGN_SEAL_P12_B64"))
        return _material
    if path:
        p12 = Path(path).read_bytes()
        _material = SealMaterial(p12, passphrase, _cert_summary(p12, passphrase, False, f"file:{path}"))
        return _material

    d = data_dir()
    p12_path, pass_path = d / "seal.p12", d / "seal.pass"
    if p12_path.exists() and pass_path.exists():
        p12, pw = p12_path.read_bytes(), pass_path.read_text(encoding="utf-8").strip()
    else:
        logger.warning(
            "No seal certificate configured (SIGN_SEAL_P12_B64 / SIGN_SEAL_P12_PATH). "
            "Generating a self-signed seal at %s. Fine for a dry run; replace before external use.",
            p12_path,
        )
        p12, pw = _generate_self_signed(entity)
        p12_path.write_bytes(p12)
        pass_path.write_text(pw, encoding="utf-8")
        try:
            os.chmod(pass_path, 0o600)
            os.chmod(p12_path, 0o600)
        except OSError:
            pass
    _material = SealMaterial(p12, pw, _cert_summary(p12, pw, True, f"generated:{p12_path}"))
    return _material


def reset_seal_for_tests() -> None:
    global _material
    _material = None


def seal_info() -> Optional[Dict[str, Any]]:
    try:
        return load_seal().info
    except Exception as e:  # noqa: BLE001
        logger.error("seal unavailable: %s", e)
        return None


# --------------------------------------------------------------------------
# PAdES seal
# --------------------------------------------------------------------------


def seal_pdf_sync(pdf_bytes: bytes, *, reason: str, location: Optional[str], tsa_url: Optional[str]) -> Tuple[bytes, Dict[str, Any]]:
    """Apply the organisation seal. Blocking; call via asyncio.to_thread."""
    from pdf_signer import SignError, _sign_sync, sign_available

    if not sign_available():
        raise SealError("pyHanko is not available on this server; cannot seal documents.")

    material = load_seal()
    notes: List[str] = []
    work = tempfile.mkdtemp(prefix="champdf_seal_")
    p12_path = os.path.join(work, "seal.p12")
    try:
        Path(p12_path).write_bytes(material.p12)
        timestamped = bool(tsa_url)
        try:
            out = _sign_sync(pdf_bytes, p12_path, material.passphrase, SEAL_FIELD_NAME, reason, location, tsa_url, visible=False)
        except Exception as e:  # noqa: BLE001 — TSA unreachable is the common case
            if not tsa_url:
                raise SealError(f"sealing failed: {e}") from e
            logger.warning("TSA %s failed (%s); sealing without a timestamp", tsa_url, e)
            notes.append("timestamp_unavailable")
            timestamped = False
            try:
                out = _sign_sync(pdf_bytes, p12_path, material.passphrase, SEAL_FIELD_NAME, reason, location, None, visible=False)
            except SignError as e2:
                raise SealError(f"sealing failed: {e2}") from e2
        return out, {
            "sealed": True,
            "timestamped": timestamped,
            "tsa_url": tsa_url if timestamped else None,
            "seal_subject": material.info.get("subject"),
            "self_signed": material.info.get("self_signed", True),
            "notes": notes,
        }
    finally:
        import shutil

        shutil.rmtree(work, ignore_errors=True)


def verify_seal_sync(pdf_bytes: bytes) -> Dict[str, Any]:
    from pdf_signer import _verify_sync

    return _verify_sync(pdf_bytes)


# --------------------------------------------------------------------------
# Certificate of completion
# --------------------------------------------------------------------------


@dataclass
class CertificateContext:
    document_id: str
    title: str
    template_id: str
    template_version: int
    template_sha256: str
    champions_entity: str
    counterparty_entity: str
    sender_name: str
    sender_email: str
    created_at: str
    sent_at: Optional[str]
    executed_at: str
    draft_sha256: str
    chain_head: str
    event_count: int
    recipients: List[Dict[str, Any]]  # name, email, designation, role, milestones
    events: List[Dict[str, Any]]  # event_type, occurred_at, ip_address, actor_email
    seal_subject: Optional[str]
    seal_self_signed: bool
    verify_url: Optional[str] = None


def _fmt_ts(value: Optional[str]) -> str:
    if not value:
        return "-"
    try:
        v = value[:-1] + "+00:00" if value.endswith("Z") else value
        dt = datetime.fromisoformat(v)
        return dt.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    except ValueError:
        return value


def append_certificate_sync(pdf_bytes: bytes, ctx: CertificateContext) -> bytes:
    """Append the certificate of completion page(s). Blocking; run in a thread."""
    import pymupdf

    W, H = 595.0, 842.0
    M = 54.0
    doc = pymupdf.open("pdf", pdf_bytes)
    ink = (0.08, 0.1, 0.15)
    muted = (0.4, 0.42, 0.5)
    rule = (0.82, 0.84, 0.89)

    state = {"page": None, "y": 0.0}

    def new_page() -> None:
        state["page"] = doc.new_page(width=W, height=H)
        state["y"] = M
        p = state["page"]
        p.insert_text((M, state["y"] + 8), "CERTIFICATE OF COMPLETION", fontname="hebo", fontsize=12.5, color=ink)
        p.insert_text((M, state["y"] + 22), "ChampPDF Sign  |  electronic signature record under s.3A / s.10A IT Act 2000",
                      fontname="helv", fontsize=7.5, color=muted)
        p.draw_line((M, state["y"] + 30), (W - M, state["y"] + 30), color=rule, width=0.6)
        state["y"] += 44

    def ensure(space: float) -> None:
        if state["page"] is None or state["y"] + space > H - M:
            new_page()

    def heading(text: str) -> None:
        ensure(30)
        state["page"].insert_text((M, state["y"] + 6), text.upper(), fontname="helv", fontsize=7.5, color=muted)
        state["y"] += 16

    def kv(label: str, value: str, mono: bool = False) -> None:
        ensure(16)
        p = state["page"]
        p.insert_text((M, state["y"] + 4), label, fontname="helv", fontsize=8.5, color=muted)
        p.insert_textbox(pymupdf.Rect(M + 150, state["y"] - 4, W - M, state["y"] + 26), value,
                         fontname="cour" if mono else "helv", fontsize=8.5 if not mono else 7.6, color=ink)
        state["y"] += 15

    def paragraph(text: str, size: float = 8.5) -> None:
        ensure(50)
        r = pymupdf.Rect(M, state["y"] - 2, W - M, state["y"] + 60)
        used = state["page"].insert_textbox(r, text, fontname="helv", fontsize=size, color=ink, lineheight=1.35)
        state["y"] += (60 - used) + 6 if used >= 0 else 60

    new_page()
    heading("Document")
    kv("Title", ctx.title)
    kv("Document ID", ctx.document_id, mono=True)
    kv("Template", f"{ctx.template_id} v{ctx.template_version}")
    kv("Template SHA-256", ctx.template_sha256, mono=True)
    kv("Parties", f"{ctx.champions_entity}  and  {ctx.counterparty_entity}")
    kv("Sent by", f"{ctx.sender_name} <{ctx.sender_email}>" if ctx.sender_email else ctx.sender_name)
    kv("Created", _fmt_ts(ctx.created_at))
    kv("Sent", _fmt_ts(ctx.sent_at))
    kv("Executed", _fmt_ts(ctx.executed_at))
    state["y"] += 6

    heading("Signers")
    for r in ctx.recipients:
        ensure(120)
        p = state["page"]
        p.insert_text((M, state["y"] + 6), f"{r.get('name', '')}  ({r.get('role', 'signer')})", fontname="hebo", fontsize=9.5, color=ink)
        state["y"] += 14
        kv("Email (invited address)", r.get("email", ""))
        if r.get("designation"):
            kv("Designation", r["designation"])
        kv("Signature", f"{r.get('signature_kind') or '-'}  as \"{r.get('signature_name') or '-'}\"")
        kv("Link opened", _fmt_ts(r.get("link_opened_at")))
        kv("OTP verified", _fmt_ts(r.get("otp_verified_at")))
        kv("Document viewed", _fmt_ts(r.get("viewed_at")))
        kv("Read to end", _fmt_ts(r.get("scrolled_to_end_at")))
        kv("Signed", _fmt_ts(r.get("signed_at")))
        kv("IP address", r.get("signer_ip") or "-")
        kv("User agent", (r.get("signer_user_agent") or "-")[:110])
        state["y"] += 6

    heading("Integrity")
    kv("Document as viewed (SHA-256)", ctx.draft_sha256, mono=True)
    kv("Audit chain head", ctx.chain_head, mono=True)
    kv("Audit events", str(ctx.event_count))
    kv("Seal", (ctx.seal_subject or "-") + ("  [self-signed seal]" if ctx.seal_self_signed else ""))
    state["y"] += 4
    paragraph(
        "The SHA-256 above is the hash of the document exactly as presented to each signer before this "
        "certificate was appended. The audit chain head is the hash of the last audit event for this "
        "document at execution; every event stores the hash of the one before it, so a record that has "
        "been altered or removed can be detected. The hash of this sealed file is stored separately in the "
        "ChampPDF Sign system of record"
        + (f" and can be checked at {ctx.verify_url}." if ctx.verify_url else ".")
    )

    heading("Audit trail")
    ensure(20)
    p = state["page"]
    p.insert_text((M, state["y"] + 4), "Time (UTC)", fontname="helv", fontsize=7.5, color=muted)
    p.insert_text((M + 130, state["y"] + 4), "Event", fontname="helv", fontsize=7.5, color=muted)
    p.insert_text((M + 300, state["y"] + 4), "Actor / address", fontname="helv", fontsize=7.5, color=muted)
    state["y"] += 12
    for ev in ctx.events:
        ensure(12)
        p = state["page"]
        p.insert_text((M, state["y"] + 4), _fmt_ts(ev.get("occurred_at")).replace(" UTC", ""), fontname="cour", fontsize=7.2, color=ink)
        p.insert_text((M + 130, state["y"] + 4), ev.get("event_type", ""), fontname="helv", fontsize=7.8, color=ink)
        who = ev.get("actor_email") or ""
        ip = ev.get("ip_address") or ""
        p.insert_text((M + 300, state["y"] + 4), (f"{who}  {ip}").strip()[:60], fontname="helv", fontsize=7.4, color=muted)
        state["y"] += 11

    total = doc.page_count
    for pg in doc:
        if pg.number >= total - len([1 for _ in range(1)]) and False:  # placeholder to keep footer loop simple
            pass
    out = doc.tobytes(garbage=3, deflate=True)
    doc.close()
    return out
