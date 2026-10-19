"""
Sender identity for ChampPDF Sign.

Two ways in:

  Clerk session JWT     Authorization: Bearer <token>. Verified server-side
                        against Clerk's JWKS (clerk_auth.py); the client's
                        role claims are never trusted without that
                        signature check. This is the production path.
  Admin token           X-Admin-Token: <CHAMPDF_ADMIN_TOKEN>. Server-to-
                        server and the local dry run. Acts as ``admin``.

Roles (DPRD section 06): ``member`` sends approved templates, ``legal`` may
also manage templates, ``admin`` sees everything and can void. The role is
read from the verified token: Clerk organisation role (``org_role`` or the
v2 ``o.rol`` claim) maps org:admin -> admin; a custom ``champdf_sign_role``
claim (add it to the Clerk JWT template from public metadata) can set any of
the three. Default is ``member``.

Who may send at all: SIGN_SENDER_EMAIL_DOMAINS (comma-separated). It
defaults to ``championsmail.com`` because champdf.com sign-up is public and
an unrestricted default would let any visitor send NDAs in Champions' name.
"""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass
from typing import Any, Dict, Optional

from fastapi import Header, HTTPException

ROLE_RANK = {"member": 0, "legal": 1, "admin": 2}
DEFAULT_SENDER_DOMAINS = "championsmail.com"


@dataclass
class Sender:
    user_id: str
    email: Optional[str]
    name: str
    org_id: Optional[str]
    role: str  # member | legal | admin

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"

    def at_least(self, role: str) -> bool:
        return ROLE_RANK.get(self.role, 0) >= ROLE_RANK.get(role, 0)


def sender_domains() -> list[str]:
    raw = os.environ.get("SIGN_SENDER_EMAIL_DOMAINS")
    if raw is None:
        raw = DEFAULT_SENDER_DOMAINS
    return [d.strip().lower().lstrip("@") for d in raw.split(",") if d.strip()]


def _role_from_claims(claims: Dict[str, Any]) -> str:
    custom = claims.get("champdf_sign_role")
    if isinstance(custom, str) and custom in ROLE_RANK:
        return custom
    meta = claims.get("public_metadata") or {}
    if isinstance(meta, dict) and meta.get("champdf_sign_role") in ROLE_RANK:
        return str(meta["champdf_sign_role"])
    org_role = claims.get("org_role")
    if not org_role and isinstance(claims.get("o"), dict):
        org_role = claims["o"].get("rol")
    if isinstance(org_role, str) and org_role.split(":")[-1] == "admin":
        return "admin"
    return "member"


def _name_from_claims(claims: Dict[str, Any], email: Optional[str]) -> str:
    for key in ("name", "full_name"):
        if isinstance(claims.get(key), str) and claims[key].strip():
            return claims[key].strip()
    first, last = claims.get("first_name"), claims.get("last_name")
    if first or last:
        return " ".join(p for p in (first, last) if p).strip()
    return (email or "").split("@")[0] or "ChampPDF user"


def _org_from_claims(claims: Dict[str, Any]) -> Optional[str]:
    if isinstance(claims.get("org_id"), str):
        return claims["org_id"]
    if isinstance(claims.get("o"), dict) and isinstance(claims["o"].get("id"), str):
        return claims["o"]["id"]
    return None


async def require_sender(
    authorization: Optional[str] = Header(None),
    x_admin_token: Optional[str] = Header(None),
) -> Sender:
    admin_expected = os.environ.get("CHAMPDF_ADMIN_TOKEN", "")
    if x_admin_token is not None:
        if admin_expected and secrets.compare_digest(x_admin_token, admin_expected):
            return Sender(
                user_id="admin",
                email=os.environ.get("SIGN_ADMIN_EMAIL", "").strip() or None,
                name=os.environ.get("SIGN_ADMIN_NAME", "").strip() or "ChampPDF Admin",
                org_id=None,
                role="admin",
            )
        raise HTTPException(status_code=401, detail="Invalid admin token")

    from clerk_auth import ClerkAuthError, clerk_configured, resolve_email, verify_clerk_token

    if not clerk_configured():
        raise HTTPException(
            status_code=503,
            detail="Sign-in is not configured on this server (CLERK_ISSUER unset). Use X-Admin-Token for local testing.",
        )
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Sign in to use ChampPDF Sign")
    try:
        claims = verify_clerk_token(authorization[7:].strip())
    except ClerkAuthError as e:
        raise HTTPException(status_code=401, detail=str(e))

    email = resolve_email(claims)
    domains = sender_domains()
    if domains:
        if not email:
            raise HTTPException(
                status_code=403,
                detail="Your account's email could not be determined; sending is restricted by email domain.",
            )
        if email.rsplit("@", 1)[-1].lower() not in domains:
            raise HTTPException(
                status_code=403,
                detail=f"{email} is not permitted to send documents (allowed: {', '.join(domains)}).",
            )
    return Sender(
        user_id=str(claims["sub"]),
        email=email,
        name=_name_from_claims(claims, email),
        org_id=_org_from_claims(claims),
        role=_role_from_claims(claims),
    )


def require_role(min_role: str):
    async def dependency(
        authorization: Optional[str] = Header(None),
        x_admin_token: Optional[str] = Header(None),
    ) -> Sender:
        sender = await require_sender(authorization, x_admin_token)
        if not sender.at_least(min_role):
            raise HTTPException(status_code=403, detail=f"This action requires the {min_role} role")
        return sender

    return dependency
