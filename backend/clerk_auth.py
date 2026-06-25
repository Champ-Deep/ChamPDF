"""
Clerk session-token verification (optional, env-gated).

The frontend signs users in with Clerk (see src/js/components/clerk-auth.ts).
When those users want a ChamPDF API key for their AI assistant, the browser
calls /api/v1/keys/me with the Clerk session JWT in the Authorization header.
This module verifies that JWT server-side against Clerk's JWKS so the key
issued is provably tied to a real signed-in user.

Everything here is dormant until CLERK_ISSUER (or CLERK_JWKS_URL) is set —
mirroring the other optional backend features. With no config, clerk_configured()
is False and the self-serve key endpoints return 503 (the admin-token path keeps
working regardless).

Env:
  CLERK_ISSUER        e.g. https://clerk.champdf.com or https://xxx.clerk.accounts.dev
                      (the Clerk Frontend API URL; also the JWT `iss`).
  CLERK_JWKS_URL      Optional explicit JWKS URL. Defaults to
                      <CLERK_ISSUER>/.well-known/jwks.json.
  CLERK_SECRET_KEY    Optional. Only needed for email-domain gating when the
                      session token has no `email` claim — used to look the
                      user's primary email up via Clerk's Backend API.
  CHAMPDF_API_KEY_EMAIL_DOMAINS
                      Optional comma-separated allowlist (e.g.
                      "championsmail.com,champions.com"). Empty => any signed-in
                      user may mint a key.
"""

from __future__ import annotations

import json
import os
import urllib.request
from typing import Any, Dict, Optional

ISSUER_ENV = "CLERK_ISSUER"
JWKS_URL_ENV = "CLERK_JWKS_URL"
SECRET_KEY_ENV = "CLERK_SECRET_KEY"
EMAIL_DOMAINS_ENV = "CHAMPDF_API_KEY_EMAIL_DOMAINS"

# Clock-skew tolerance when validating exp/nbf/iat (seconds).
_LEEWAY = 30


class ClerkAuthError(Exception):
    """Raised when a Clerk token is missing, malformed, or fails verification."""


def _issuer() -> Optional[str]:
    raw = os.environ.get(ISSUER_ENV, "").strip()
    return raw.rstrip("/") if raw else None


def _jwks_url() -> Optional[str]:
    explicit = os.environ.get(JWKS_URL_ENV, "").strip()
    if explicit:
        return explicit
    iss = _issuer()
    return f"{iss}/.well-known/jwks.json" if iss else None


def clerk_configured() -> bool:
    """True iff enough env is present to verify Clerk tokens."""
    return _jwks_url() is not None


# PyJWKClient instances are cached per JWKS URL (they cache the keys internally).
_jwk_clients: Dict[str, Any] = {}


def _jwk_client(url: str):
    client = _jwk_clients.get(url)
    if client is None:
        from jwt import PyJWKClient  # lazy: keeps import cost off the hot path

        client = PyJWKClient(url, cache_keys=True, lifespan=3600)
        _jwk_clients[url] = client
    return client


def verify_clerk_token(token: str) -> Dict[str, Any]:
    """
    Verify a Clerk session JWT and return its claims.

    Raises ClerkAuthError on any problem (not configured, bad signature,
    expired, wrong issuer, missing `sub`).
    """
    jwks_url = _jwks_url()
    if not jwks_url:
        raise ClerkAuthError(
            f"Clerk auth is not configured (set {ISSUER_ENV} or {JWKS_URL_ENV})."
        )
    if not token:
        raise ClerkAuthError("Empty token.")

    try:
        import jwt  # PyJWT
    except ImportError as e:  # pragma: no cover - dependency missing
        raise ClerkAuthError(
            "PyJWT is not installed on the server; cannot verify Clerk tokens."
        ) from e

    try:
        signing_key = _jwk_client(jwks_url).get_signing_key_from_jwt(token)
    except Exception as e:
        raise ClerkAuthError(f"Could not resolve signing key: {e}") from e

    issuer = _issuer()
    decode_kwargs: Dict[str, Any] = {
        "algorithms": ["RS256"],
        "leeway": _LEEWAY,
        # Clerk session tokens carry no `aud` by default.
        "options": {"verify_aud": False},
    }
    if issuer:
        decode_kwargs["issuer"] = issuer

    try:
        claims = jwt.decode(token, signing_key.key, **decode_kwargs)
    except Exception as e:
        raise ClerkAuthError(f"Token verification failed: {e}") from e

    if not claims.get("sub"):
        raise ClerkAuthError("Token has no subject (sub) claim.")
    return claims


# --------------------------------------------------------------------------
# Email + domain gating
# --------------------------------------------------------------------------

# Tiny in-process cache of user_id -> email so domain gating doesn't hit the
# Clerk API on every request. Keys are immutable per user for our purposes.
_email_cache: Dict[str, Optional[str]] = {}


def allowed_email_domains() -> list[str]:
    raw = os.environ.get(EMAIL_DOMAINS_ENV, "")
    return [d.strip().lower().lstrip("@") for d in raw.split(",") if d.strip()]


def _email_from_claims(claims: Dict[str, Any]) -> Optional[str]:
    """Pull an email from the token if a JWT template exposes one."""
    for key in ("email", "email_address", "primary_email"):
        val = claims.get(key)
        if isinstance(val, str) and "@" in val:
            return val.lower()
    return None


def _email_from_clerk_api(user_id: str) -> Optional[str]:
    """Look up the user's primary email via Clerk's Backend API (needs secret)."""
    secret = os.environ.get(SECRET_KEY_ENV, "").strip()
    if not secret:
        return None
    if user_id in _email_cache:
        return _email_cache[user_id]

    req = urllib.request.Request(
        f"https://api.clerk.com/v1/users/{user_id}",
        headers={"Authorization": f"Bearer {secret}"},
    )
    email: Optional[str] = None
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:  # nosec - fixed host
            data = json.loads(resp.read().decode("utf-8"))
        primary_id = data.get("primary_email_address_id")
        for entry in data.get("email_addresses", []) or []:
            if entry.get("id") == primary_id:
                email = (entry.get("email_address") or "").lower() or None
                break
        if email is None and data.get("email_addresses"):
            email = (data["email_addresses"][0].get("email_address") or "").lower() or None
    except Exception:
        email = None

    _email_cache[user_id] = email
    return email


def resolve_email(claims: Dict[str, Any]) -> Optional[str]:
    """Best-effort email for the authenticated user (claim first, API fallback)."""
    return _email_from_claims(claims) or _email_from_clerk_api(claims["sub"])


def check_domain_allowed(claims: Dict[str, Any]) -> None:
    """
    Enforce the optional email-domain allowlist.

    No allowlist configured => allow everyone. With an allowlist set we must be
    able to determine the user's email; if we can't, we fail closed so the gate
    can't be bypassed by simply omitting the email claim.
    """
    domains = allowed_email_domains()
    if not domains:
        return
    email = resolve_email(claims)
    if not email:
        raise ClerkAuthError(
            "API key issuance is restricted by email domain, but this account's "
            f"email could not be determined. Set {SECRET_KEY_ENV} on the backend "
            "or add an `email` claim to your Clerk JWT template."
        )
    domain = email.rsplit("@", 1)[-1]
    if domain not in domains:
        raise ClerkAuthError(
            f"Account {email} is not permitted to create API keys "
            f"(allowed domains: {', '.join(domains)})."
        )
