"""
Write-once object storage for ChampPDF Sign.

Sealed PDFs are immutable evidence: a key is written exactly once and never
overwritten. Two backends:

  LocalStorage   <data dir>/objects/<key>, created with O_EXCL. Default.
  S3Storage      any S3-compatible bucket (AWS S3, Cloudflare R2). Enabled
                 when SIGN_STORAGE_BUCKET is set and boto3 is importable.
                 Turn on bucket versioning and deny deletes on the
                 ``sign/executed/`` prefix at the bucket policy level; the
                 application never issues a delete.

Env
  SIGN_STORAGE_BUCKET      bucket name (switches on S3Storage)
  SIGN_STORAGE_PREFIX      optional key prefix, e.g. "champdf-sign"
  SIGN_STORAGE_ENDPOINT    optional endpoint URL (R2: https://<acct>.r2.cloudflarestorage.com)
  SIGN_STORAGE_REGION      optional region (R2: "auto")
  AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY   credentials (boto3 standard)
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Optional, Protocol

from .store import data_dir

logger = logging.getLogger(__name__)


class StorageError(Exception):
    pass


class Storage(Protocol):
    name: str

    def put(self, key: str, data: bytes, content_type: str = "application/pdf") -> None: ...

    def get(self, key: str) -> bytes: ...

    def exists(self, key: str) -> bool: ...


def _safe_key(key: str) -> str:
    parts = [p for p in key.split("/") if p]
    if not parts or any(p in ("..", ".") for p in parts):
        raise StorageError(f"unsafe storage key: {key!r}")
    return "/".join(parts)


class LocalStorage:
    name = "local"

    def __init__(self, root: Optional[Path] = None) -> None:
        self.root = (root or (data_dir() / "objects")).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        p = (self.root / _safe_key(key)).resolve()
        if self.root not in p.parents:
            raise StorageError(f"key escapes storage root: {key!r}")
        return p

    def put(self, key: str, data: bytes, content_type: str = "application/pdf") -> None:
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        try:
            fd = os.open(str(p), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o440)
        except FileExistsError as e:
            raise StorageError(f"refusing to overwrite existing object {key}") from e
        with os.fdopen(fd, "wb") as f:
            f.write(data)

    def get(self, key: str) -> bytes:
        p = self._path(key)
        if not p.exists():
            raise StorageError(f"object not found: {key}")
        return p.read_bytes()

    def exists(self, key: str) -> bool:
        return self._path(key).exists()


class S3Storage:
    name = "s3"

    def __init__(self, bucket: str, prefix: str = "", endpoint_url: Optional[str] = None,
                 region: Optional[str] = None) -> None:
        try:
            import boto3  # type: ignore
        except ImportError as e:  # pragma: no cover - optional dependency
            raise StorageError("boto3 is not installed; cannot use S3 storage") from e
        kwargs = {}
        if endpoint_url:
            kwargs["endpoint_url"] = endpoint_url
        if region:
            kwargs["region_name"] = region
        self.client = boto3.client("s3", **kwargs)
        self.bucket = bucket
        self.prefix = prefix.strip("/")

    def _key(self, key: str) -> str:
        k = _safe_key(key)
        return f"{self.prefix}/{k}" if self.prefix else k

    def put(self, key: str, data: bytes, content_type: str = "application/pdf") -> None:
        k = self._key(key)
        if self.exists(key):
            raise StorageError(f"refusing to overwrite existing object {k}")
        params = {
            "Bucket": self.bucket,
            "Key": k,
            "Body": data,
            "ContentType": content_type,
        }
        try:
            # Conditional write where the backend supports it (S3 and R2 both do).
            self.client.put_object(IfNoneMatch="*", **params)
        except Exception as e:  # noqa: BLE001 — some S3 clones reject IfNoneMatch
            if "IfNoneMatch" in str(e) or "PreconditionFailed" in type(e).__name__:
                raise StorageError(f"object already exists: {k}") from e
            self.client.put_object(**params)

    def get(self, key: str) -> bytes:
        obj = self.client.get_object(Bucket=self.bucket, Key=self._key(key))
        return obj["Body"].read()

    def exists(self, key: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=self._key(key))
            return True
        except Exception:  # noqa: BLE001 — 404 surfaces as ClientError
            return False


_storage: Optional[Storage] = None


def get_storage() -> Storage:
    global _storage
    if _storage is None:
        bucket = os.environ.get("SIGN_STORAGE_BUCKET", "").strip()
        if bucket:
            _storage = S3Storage(
                bucket=bucket,
                prefix=os.environ.get("SIGN_STORAGE_PREFIX", ""),
                endpoint_url=os.environ.get("SIGN_STORAGE_ENDPOINT") or None,
                region=os.environ.get("SIGN_STORAGE_REGION") or None,
            )
            logger.info("Sign storage: S3-compatible bucket %s", bucket)
        else:
            _storage = LocalStorage()
            logger.info("Sign storage: local disk at %s", _storage.root)
    return _storage


def reset_storage_for_tests() -> None:
    global _storage
    _storage = None
