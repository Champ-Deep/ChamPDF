"""
SigningProvider interface.

Roughly two hundred lines including the data classes, and it is the line
that protects the rest of the product from whichever engine is behind it.
Keep it engine-agnostic: nothing here may mention Documenso, pyHanko or
PyMuPDF.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from ..seal import CertificateContext
from ..templates import Template


class ProviderError(Exception):
    """The engine failed or is misconfigured."""


class ProviderNotSupported(ProviderError):
    """The engine does not support this operation (e.g. hosted engines cannot accept a raw signature)."""


@dataclass
class RecipientSpec:
    id: str
    role: str  # signer | countersigner | cc
    signing_order: int
    name: str
    email: str
    designation: Optional[str] = None


@dataclass
class ProviderDocument:
    """What ``create_from_template`` returns."""

    provider_doc_id: str
    draft_pdf: bytes  # the exact bytes every signer will see; hashed and stored by the service
    anchors: Dict[str, Dict[str, Any]]  # role -> geometry of the signature block
    page_count: int
    source: str  # html | docx
    signing_urls: Dict[str, str] = field(default_factory=dict)  # recipient_id -> hosted signing URL


@dataclass
class SignatureInput:
    recipient_id: str
    role: str
    kind: str  # typed | drawn
    name: str
    designation: Optional[str]
    signed_at: str  # ISO-8601 UTC
    ip_address: Optional[str]
    user_agent: Optional[str]
    image_png: Optional[bytes] = None  # drawn signatures only


@dataclass
class ProviderStatus:
    status: str  # draft | sent | viewed | signed | executed | voided | unknown
    recipients: Dict[str, str] = field(default_factory=dict)  # recipient_id -> pending | viewed | signed
    sealed_available: bool = False
    raw: Any = None


@dataclass
class SealOutcome:
    pdf: bytes
    sha256: str
    sealed: bool
    timestamped: bool
    seal_subject: Optional[str]
    self_signed: bool
    notes: List[str] = field(default_factory=list)


class SigningProvider(ABC):
    name: str = "abstract"
    #: True when the engine hosts the signing UI itself. The service then
    #: returns ``signing_urls`` to the OTP-verified signer instead of
    #: accepting a signature payload.
    hosted_signing: bool = False

    @abstractmethod
    async def create_from_template(
        self,
        template: Template,
        merge_values: Dict[str, str],
        recipients: List[RecipientSpec],
        *,
        document_id: str,
        title: str,
        footer_label: str,
    ) -> ProviderDocument:
        """Render the filled instrument and register it with the engine."""

    async def apply_signature(self, pdf: bytes, anchors: Dict[str, Dict[str, Any]], signature: SignatureInput) -> bytes:
        """Stamp one recipient's signature onto the PDF. Native engines only."""
        raise ProviderNotSupported(f"{self.name} does not accept signatures directly")

    async def seal(self, pdf: bytes, certificate: CertificateContext, *, reason: str, location: Optional[str]) -> SealOutcome:
        """Append the certificate of completion and apply the organisation seal. Native engines only."""
        raise ProviderNotSupported(f"{self.name} does not seal documents directly")

    @abstractmethod
    async def get_status(self, provider_doc_id: str) -> ProviderStatus:
        """The engine's view of the document. The service reconciles it with ours."""

    async def get_sealed_document(self, provider_doc_id: str) -> bytes:
        """Fetch the engine's sealed output. Hosted engines only; native documents live in our storage."""
        raise ProviderNotSupported(f"{self.name} keeps no copy; read from storage")

    @abstractmethod
    async def void(self, provider_doc_id: str, reason: str) -> None:
        """Cancel the document in the engine. Must be idempotent."""

    def describe(self) -> Dict[str, Any]:
        return {"name": self.name, "hosted_signing": self.hosted_signing}
