"""
Tokens for ChampPDF Sign.

- Link token: 32 bytes from the OS CSPRNG, URL-safe, scoped to one recipient
  of one document. Only its SHA-256 is stored, so a database read never
  yields a usable link.
- OTP: six digits, hashed with the recipient id as salt, ten-minute expiry.
- Signer session: another 32-byte token issued after OTP verification, hashed
  at rest, 30-minute expiry. Possession of the link alone never grants the
  right to see or sign the document.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets

LINK_TOKEN_BYTES = 32
OTP_DIGITS = 6
OTP_TTL_SECONDS = 10 * 60
OTP_MAX_ATTEMPTS = 5
OTP_MAX_REQUESTS_PER_HOUR = 5
SESSION_TTL_SECONDS = 30 * 60


def new_link_token() -> str:
    return secrets.token_urlsafe(LINK_TOKEN_BYTES)


def new_session_token() -> str:
    return secrets.token_urlsafe(LINK_TOKEN_BYTES)


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def new_otp() -> str:
    return f"{secrets.randbelow(10 ** OTP_DIGITS):0{OTP_DIGITS}d}"


def hash_otp(otp: str, recipient_id: str) -> str:
    return hashlib.sha256(f"{recipient_id}:{otp.strip()}".encode("utf-8")).hexdigest()


def constant_time_equals(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


def looks_like_link_token(raw: str) -> bool:
    """Cheap shape check before touching the database."""
    if not raw or len(raw) < 32 or len(raw) > 64:
        return False
    return all(c.isalnum() or c in "-_" for c in raw)
