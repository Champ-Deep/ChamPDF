"""
ChampPDF Sign — system of record.

Our own tables, independent of whatever the signing engine keeps internally.
The DPRD asks for Postgres; this backend already runs SQLite on a persistent
volume (the v1 API key store lives in the same file), so Sign shares it. The
SQL is written to lift to Postgres with type substitutions only (TEXT ->
uuid / citext / timestamptz, INTEGER PRIMARY KEY -> bigserial); the only
engine-specific piece is the append-only trigger pair, which Postgres
expresses with an equivalent trigger function.

Tables
  sign_documents     one row per document sent for signature
  sign_recipients    signer / countersigner / cc rows: link-token hash, OTP
                     state, signer session, signature record
  sign_audit_events  append-only, hash-chained event log. This is the product.
  sign_rate_hits     sliding-window counters shared across uvicorn workers

Hash chain
  event_hash = sha256(prev_hash || canonical_json(event))
  prev_hash of the first event for a document is 64 zeros. Any edit or
  deletion of a past row breaks every hash after it, and the DB-level
  triggers refuse UPDATE / DELETE on the table outright. At execution the
  chain head is embedded in the certificate of completion.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import sqlite3
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

logger = logging.getLogger(__name__)

DB_PATH_ENV = "CHAMPDF_DB_PATH"
DATA_DIR_ENV = "CHAMPDF_SIGN_DATA_DIR"
GENESIS_HASH = "0" * 64

DOCUMENT_STATUSES = (
    "draft",
    "sent",
    "viewed",
    "signed",
    "countersigned",
    "executed",
    "voided",
    "expired",
)
RECIPIENT_STATUSES = ("pending", "viewed", "signed", "declined")
RECIPIENT_ROLES = ("signer", "countersigner", "cc")

# Every event type Sign emits. The list is deliberately explicit: an event
# that is not in the taxonomy is a bug, not a feature.
EVENT_TYPES = frozenset(
    {
        "document.created",
        "document.sent",
        "invitation.delivered",
        "invitation.bounced",
        "invitation.complained",
        "link.opened",
        "link.rejected",
        "otp.requested",
        "otp.verified",
        "otp.failed",
        "token.locked",
        "token.rotated",
        "document.viewed",
        "document.scrolled_to_end",
        "signature.applied",
        "document.signed",
        "document.countersigned",
        "document.executed",
        "document.declined",
        "document.voided",
        "document.expired",
        "seal.timestamp_unavailable",
        "copy.downloaded",
        "rate.limited",
    }
)


# --------------------------------------------------------------------------
# Paths, time
# --------------------------------------------------------------------------


def db_path() -> Path:
    """SQLite path — same file as the v1 key store (Railway volume by default)."""
    raw = os.environ.get(DB_PATH_ENV) or "/app/data/champdf.db"
    p = Path(raw)
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def data_dir() -> Path:
    """Directory for Sign's local artefacts (seal cert, local object store)."""
    raw = os.environ.get(DATA_DIR_ENV)
    p = Path(raw) if raw else db_path().parent / "sign"
    p.mkdir(parents=True, exist_ok=True)
    return p


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="microseconds").replace(
        "+00:00", "Z"
    )


def utcnow_iso() -> str:
    return iso(utcnow())


def parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    v = value[:-1] + "+00:00" if value.endswith("Z") else value
    dt = datetime.fromisoformat(v)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def new_id() -> str:
    return str(uuid.uuid4())


# --------------------------------------------------------------------------
# Connections
# --------------------------------------------------------------------------


@contextmanager
def connect(immediate: bool = False) -> Iterator[sqlite3.Connection]:
    """
    One transaction per context. ``immediate=True`` takes the write lock up
    front, which is what the audit chain needs so two appends can't read the
    same head.
    """
    conn = sqlite3.connect(str(db_path()), timeout=30, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    started = False
    try:
        conn.execute("BEGIN IMMEDIATE" if immediate else "BEGIN")
        started = True
        yield conn
        conn.execute("COMMIT")
        started = False
    except BaseException:
        if started:
            try:
                conn.execute("ROLLBACK")
            except sqlite3.Error:
                pass
        raise
    finally:
        conn.close()


def _row(r: Optional[sqlite3.Row]) -> Optional[Dict[str, Any]]:
    return dict(r) if r is not None else None


# --------------------------------------------------------------------------
# Schema
# --------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS sign_documents (
    id                   TEXT PRIMARY KEY,
    title                TEXT NOT NULL,
    sender_user_id       TEXT NOT NULL,
    sender_email         TEXT,
    sender_name          TEXT,
    sender_org_id        TEXT,
    template_id          TEXT NOT NULL,
    template_version     INTEGER NOT NULL,
    template_sha256      TEXT NOT NULL,
    provider             TEXT NOT NULL,
    provider_doc_id      TEXT,
    counterparty_entity  TEXT NOT NULL,
    counterparty_cin     TEXT,
    merge_fields_json    TEXT NOT NULL,
    anchors_json         TEXT,
    provider_meta_json   TEXT,
    page_count           INTEGER,
    status               TEXT NOT NULL,
    beam_id              TEXT,
    beam_url             TEXT,
    draft_storage_key    TEXT,
    draft_sha256         TEXT,
    working_storage_key  TEXT,
    storage_key          TEXT,
    content_sha256       TEXT,
    chain_head_at_execution TEXT,
    seal_info_json       TEXT,
    expires_at           TEXT NOT NULL,
    created_at           TEXT NOT NULL,
    sent_at              TEXT,
    executed_at          TEXT,
    voided_at            TEXT,
    void_reason          TEXT
);
CREATE INDEX IF NOT EXISTS idx_sign_documents_sender ON sign_documents(sender_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sign_documents_status ON sign_documents(status, expires_at);

CREATE TABLE IF NOT EXISTS sign_recipients (
    id                   TEXT PRIMARY KEY,
    document_id          TEXT NOT NULL REFERENCES sign_documents(id),
    role                 TEXT NOT NULL,
    signing_order        INTEGER NOT NULL DEFAULT 1,
    name                 TEXT NOT NULL,
    email                TEXT NOT NULL,
    designation          TEXT,
    status               TEXT NOT NULL DEFAULT 'pending',
    token_hash           TEXT UNIQUE,
    token_locked_at      TEXT,
    otp_hash             TEXT,
    otp_expires_at       TEXT,
    otp_attempts         INTEGER NOT NULL DEFAULT 0,
    otp_request_count    INTEGER NOT NULL DEFAULT 0,
    otp_window_start     TEXT,
    otp_verified_at      TEXT,
    session_token_hash   TEXT,
    session_expires_at   TEXT,
    invite_message_id    TEXT,
    link_opened_at       TEXT,
    viewed_at            TEXT,
    scrolled_to_end_at   TEXT,
    signed_at            TEXT,
    signature_kind       TEXT,
    signature_name       TEXT,
    signer_ip            TEXT,
    signer_user_agent    TEXT,
    created_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sign_recipients_doc ON sign_recipients(document_id, signing_order);

CREATE TABLE IF NOT EXISTS sign_audit_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id   TEXT NOT NULL REFERENCES sign_documents(id),
    recipient_id  TEXT,
    event_type    TEXT NOT NULL,
    occurred_at   TEXT NOT NULL,
    actor_email   TEXT,
    ip_address    TEXT,
    user_agent    TEXT,
    metadata      TEXT,
    prev_hash     TEXT NOT NULL,
    event_hash    TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_sign_audit_doc ON sign_audit_events(document_id, id);

-- Append-only. The application role never gets UPDATE / DELETE on this table
-- in Postgres; SQLite has no grants, so the triggers do the same job.
CREATE TRIGGER IF NOT EXISTS sign_audit_no_update
BEFORE UPDATE ON sign_audit_events
BEGIN
    SELECT RAISE(ABORT, 'sign_audit_events is append-only');
END;
CREATE TRIGGER IF NOT EXISTS sign_audit_no_delete
BEFORE DELETE ON sign_audit_events
BEGIN
    SELECT RAISE(ABORT, 'sign_audit_events is append-only');
END;

CREATE TABLE IF NOT EXISTS sign_rate_hits (
    bucket  TEXT NOT NULL,
    ts      REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sign_rate_hits ON sign_rate_hits(bucket, ts);
"""


def init_sign_db() -> None:
    """Create Sign's tables, indexes and append-only triggers if missing."""
    conn = sqlite3.connect(str(db_path()), timeout=30)
    try:
        try:
            conn.execute("PRAGMA journal_mode=WAL")
        except sqlite3.Error:  # read-only or network FS: not fatal
            pass
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()


# --------------------------------------------------------------------------
# Generic helpers
# --------------------------------------------------------------------------

_COLUMNS: Dict[str, frozenset] = {}


def _columns(conn: sqlite3.Connection, table: str) -> frozenset:
    cols = _COLUMNS.get(table)
    if cols is None:
        cols = frozenset(r[1] for r in conn.execute(f"PRAGMA table_info({table})"))
        _COLUMNS[table] = cols
    return cols


def _update(conn: sqlite3.Connection, table: str, row_id: str, fields: Dict[str, Any]) -> None:
    if not fields:
        return
    allowed = _columns(conn, table)
    bad = [k for k in fields if k not in allowed]
    if bad:
        raise ValueError(f"unknown column(s) for {table}: {bad}")
    sets = ", ".join(f"{k} = ?" for k in fields)
    conn.execute(f"UPDATE {table} SET {sets} WHERE id = ?", [*fields.values(), row_id])


# --------------------------------------------------------------------------
# Documents
# --------------------------------------------------------------------------


def insert_document(doc: Dict[str, Any], conn: Optional[sqlite3.Connection] = None) -> None:
    def _do(c: sqlite3.Connection) -> None:
        cols = list(doc.keys())
        c.execute(
            f"INSERT INTO sign_documents ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})",
            [doc[k] for k in cols],
        )

    if conn is not None:
        _do(conn)
    else:
        with connect(immediate=True) as c:
            _do(c)


def get_document(doc_id: str, conn: Optional[sqlite3.Connection] = None) -> Optional[Dict[str, Any]]:
    q = "SELECT * FROM sign_documents WHERE id = ?"
    if conn is not None:
        return _row(conn.execute(q, (doc_id,)).fetchone())
    with connect() as c:
        return _row(c.execute(q, (doc_id,)).fetchone())


def update_document(doc_id: str, conn: Optional[sqlite3.Connection] = None, **fields: Any) -> None:
    if conn is not None:
        _update(conn, "sign_documents", doc_id, fields)
        return
    with connect(immediate=True) as c:
        _update(c, "sign_documents", doc_id, fields)


def list_documents(
    sender_user_id: Optional[str] = None,
    org_id: Optional[str] = None,
    limit: int = 200,
) -> List[Dict[str, Any]]:
    clauses, params = [], []
    if sender_user_id is not None:
        clauses.append("sender_user_id = ?")
        params.append(sender_user_id)
    if org_id is not None:
        clauses.append("sender_org_id = ?")
        params.append(org_id)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with connect() as c:
        rows = c.execute(
            f"SELECT * FROM sign_documents {where} ORDER BY created_at DESC LIMIT ?",
            [*params, limit],
        ).fetchall()
    return [dict(r) for r in rows]


def documents_past_expiry(now_iso: str, limit: int = 500) -> List[Dict[str, Any]]:
    with connect() as c:
        rows = c.execute(
            "SELECT * FROM sign_documents WHERE status IN ('sent','viewed') AND expires_at < ? LIMIT ?",
            (now_iso, limit),
        ).fetchall()
    return [dict(r) for r in rows]


# --------------------------------------------------------------------------
# Recipients
# --------------------------------------------------------------------------


def insert_recipient(rec: Dict[str, Any], conn: Optional[sqlite3.Connection] = None) -> None:
    def _do(c: sqlite3.Connection) -> None:
        cols = list(rec.keys())
        c.execute(
            f"INSERT INTO sign_recipients ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})",
            [rec[k] for k in cols],
        )

    if conn is not None:
        _do(conn)
    else:
        with connect(immediate=True) as c:
            _do(c)


def get_recipient(rec_id: str, conn: Optional[sqlite3.Connection] = None) -> Optional[Dict[str, Any]]:
    q = "SELECT * FROM sign_recipients WHERE id = ?"
    if conn is not None:
        return _row(conn.execute(q, (rec_id,)).fetchone())
    with connect() as c:
        return _row(c.execute(q, (rec_id,)).fetchone())


def get_recipient_by_token_hash(token_hash: str) -> Optional[Dict[str, Any]]:
    with connect() as c:
        return _row(
            c.execute("SELECT * FROM sign_recipients WHERE token_hash = ?", (token_hash,)).fetchone()
        )


def get_recipients(document_id: str, conn: Optional[sqlite3.Connection] = None) -> List[Dict[str, Any]]:
    q = "SELECT * FROM sign_recipients WHERE document_id = ? ORDER BY signing_order, created_at"
    if conn is not None:
        return [dict(r) for r in conn.execute(q, (document_id,)).fetchall()]
    with connect() as c:
        return [dict(r) for r in c.execute(q, (document_id,)).fetchall()]


def update_recipient(rec_id: str, conn: Optional[sqlite3.Connection] = None, **fields: Any) -> None:
    if conn is not None:
        _update(conn, "sign_recipients", rec_id, fields)
        return
    with connect(immediate=True) as c:
        _update(c, "sign_recipients", rec_id, fields)


# --------------------------------------------------------------------------
# Audit chain
# --------------------------------------------------------------------------

CANONICAL_FIELDS = (
    "document_id",
    "recipient_id",
    "event_type",
    "occurred_at",
    "actor_email",
    "ip_address",
    "user_agent",
    "metadata",
)


def canonical_json(event: Dict[str, Any]) -> str:
    """Deterministic serialisation of the hashed fields (sorted keys, no whitespace)."""
    return json.dumps(
        {k: event.get(k) for k in CANONICAL_FIELDS},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )


def compute_event_hash(prev_hash: str, event: Dict[str, Any]) -> str:
    return hashlib.sha256((prev_hash + canonical_json(event)).encode("utf-8")).hexdigest()


def chain_head(document_id: str, conn: sqlite3.Connection) -> str:
    row = conn.execute(
        "SELECT event_hash FROM sign_audit_events WHERE document_id = ? ORDER BY id DESC LIMIT 1",
        (document_id,),
    ).fetchone()
    return row[0] if row else GENESIS_HASH


def append_event(
    document_id: str,
    event_type: str,
    *,
    recipient_id: Optional[str] = None,
    actor_email: Optional[str] = None,
    ip_address: Optional[str] = None,
    user_agent: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
    conn: Optional[sqlite3.Connection] = None,
) -> Dict[str, Any]:
    """
    Append one event to a document's chain. Runs inside the caller's
    transaction when ``conn`` is given (so a state change and its event
    commit together), otherwise in its own IMMEDIATE transaction.
    """
    if event_type not in EVENT_TYPES:
        raise ValueError(f"unknown audit event type: {event_type}")
    # Round-trip through JSON so what we hash is exactly what we store.
    meta = json.loads(json.dumps(metadata)) if metadata is not None else None
    event: Dict[str, Any] = {
        "document_id": document_id,
        "recipient_id": recipient_id,
        "event_type": event_type,
        "occurred_at": utcnow_iso(),
        "actor_email": actor_email.lower() if actor_email else None,
        "ip_address": ip_address,
        "user_agent": (user_agent or "")[:512] or None,
        "metadata": meta,
    }

    def _do(c: sqlite3.Connection) -> Dict[str, Any]:
        prev = chain_head(document_id, c)
        h = compute_event_hash(prev, event)
        cur = c.execute(
            """
            INSERT INTO sign_audit_events
              (document_id, recipient_id, event_type, occurred_at, actor_email,
               ip_address, user_agent, metadata, prev_hash, event_hash)
            VALUES (?,?,?,?,?,?,?,?,?,?)
            """,
            (
                event["document_id"],
                event["recipient_id"],
                event["event_type"],
                event["occurred_at"],
                event["actor_email"],
                event["ip_address"],
                event["user_agent"],
                json.dumps(meta, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
                if meta is not None
                else None,
                prev,
                h,
            ),
        )
        return {**event, "id": cur.lastrowid, "prev_hash": prev, "event_hash": h}

    if conn is not None:
        return _do(conn)
    with connect(immediate=True) as c:
        return _do(c)


def list_events(document_id: str, conn: Optional[sqlite3.Connection] = None) -> List[Dict[str, Any]]:
    q = "SELECT * FROM sign_audit_events WHERE document_id = ? ORDER BY id"
    if conn is not None:
        rows = conn.execute(q, (document_id,)).fetchall()
    else:
        with connect() as c:
            rows = c.execute(q, (document_id,)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["metadata"] = json.loads(d["metadata"]) if d.get("metadata") else None
        out.append(d)
    return out


def verify_chain(document_id: str) -> Dict[str, Any]:
    """
    Recompute every hash for a document and confirm each row links to the one
    before it. Returns a report; ``ok`` is the only field that matters in a
    dispute.
    """
    events = list_events(document_id)
    running = GENESIS_HASH
    for ev in events:
        if ev["prev_hash"] != running:
            return {
                "ok": False,
                "events": len(events),
                "head": running,
                "broken_at_event_id": ev["id"],
                "reason": "prev_hash does not match the preceding event",
            }
        expected = compute_event_hash(running, ev)
        if expected != ev["event_hash"]:
            return {
                "ok": False,
                "events": len(events),
                "head": running,
                "broken_at_event_id": ev["id"],
                "reason": "event_hash does not match the event's content",
            }
        running = ev["event_hash"]
    return {"ok": True, "events": len(events), "head": running, "broken_at_event_id": None}


# --------------------------------------------------------------------------
# Rate limiting (shared across workers)
# --------------------------------------------------------------------------


def rate_hit(bucket: str, limit: int, window_s: int) -> bool:
    """
    Record a hit in ``bucket`` and return False when the window is full.
    Backed by the DB so the count is correct with several uvicorn workers.
    """
    now = time.time()
    with connect(immediate=True) as c:
        # Opportunistic cleanup of anything older than the longest window we use.
        c.execute("DELETE FROM sign_rate_hits WHERE ts < ?", (now - max(window_s, 3600),))
        n = c.execute(
            "SELECT COUNT(*) FROM sign_rate_hits WHERE bucket = ? AND ts >= ?",
            (bucket, now - window_s),
        ).fetchone()[0]
        if n >= limit:
            return False
        c.execute("INSERT INTO sign_rate_hits (bucket, ts) VALUES (?, ?)", (bucket, now))
    return True


def default_expiry(days: int = 14) -> str:
    return iso(utcnow() + timedelta(days=days))
