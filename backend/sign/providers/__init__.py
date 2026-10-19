"""
The SigningProvider seam.

ChampPDF Sign never talks to a signing engine directly; it talks to a
``SigningProvider``. Two adapters ship:

  native      PyMuPDF + pyHanko, in this process. Our UI collects the
              signature, our code stamps it, appends the certificate of
              completion and applies the organisation seal. Works with zero
              external infrastructure, which is what makes the dry run
              possible on day one. Default.

  documenso   An unmodified, self-hosted Documenso reached over HTTP with a
              service token (see docs/sign/README.md for the AGPL reasoning).
              Documenso hosts the signing UI, so the adapter reports
              ``hosted_signing = True`` and hands back a per-recipient signing
              URL that our OTP-gated page embeds. Selected with
              SIGN_PROVIDER=documenso.

Swapping engines is a config change. Nothing above this package knows which
one is running.
"""

from __future__ import annotations

import logging
import os
from typing import Optional

from .base import (
    ProviderDocument,
    ProviderError,
    ProviderNotSupported,
    ProviderStatus,
    RecipientSpec,
    SealOutcome,
    SignatureInput,
    SigningProvider,
)

logger = logging.getLogger(__name__)

_provider: Optional[SigningProvider] = None


def provider_name() -> str:
    return (os.environ.get("SIGN_PROVIDER") or "native").strip().lower()


def get_provider() -> SigningProvider:
    global _provider
    if _provider is None:
        name = provider_name()
        if name == "documenso":
            from .documenso import DocumensoProvider

            _provider = DocumensoProvider.from_env()
        elif name == "native":
            from .native import NativeProvider

            _provider = NativeProvider()
        else:
            raise ProviderError(f"unknown SIGN_PROVIDER: {name}")
        logger.info("Sign provider: %s (hosted_signing=%s)", _provider.name, _provider.hosted_signing)
    return _provider


def reset_provider_for_tests() -> None:
    global _provider
    _provider = None


__all__ = [
    "ProviderDocument",
    "ProviderError",
    "ProviderNotSupported",
    "ProviderStatus",
    "RecipientSpec",
    "SealOutcome",
    "SignatureInput",
    "SigningProvider",
    "get_provider",
    "provider_name",
    "reset_provider_for_tests",
]
