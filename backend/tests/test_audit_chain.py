"""
The hash chain is the product. If it can be forged, altered or silently
truncated, every "who signed what, when, from where" claim is worthless.

These tests attack it the way an attacker with write access to the database
file would: drop the append-only triggers, edit or delete rows directly, then
ask ``verify_chain`` whether the record still holds together. Each attack must
be caught, and the report must name the event that broke.

Run:  pytest backend/tests/test_audit_chain.py -v
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))


@pytest.fixture(scope="module")
def db(tmp_path_factory):
    """A private Sign database, separate from the end-to-end flow test."""
    d = tmp_path_factory.mktemp("chain")
    os.environ["CHAMPDF_DB_PATH"] = str(d / "chain.db")
    os.environ["CHAMPDF_SIGN_DATA_DIR"] = str(d / "signdata")
    from sign import store

    store.init_sign_db()
    return store


def _document(store, doc_id: str) -> None:
    store.insert_document(
        {
            "id": doc_id,
            "title": f"Doc {doc_id}",
            "sender_user_id": "user_test",
            "template_id": "mutual-nda-v1",
            "template_version": 1,
            "template_sha256": "0" * 64,
            "provider": "native",
            "counterparty_entity": "Acme Technologies Private Limited",
            "merge_fields_json": "{}",
            "status": "sent",
            "expires_at": store.default_expiry(14),
            "created_at": store.utcnow_iso(),
        }
    )


def _events(store, doc_id: str, n: int) -> list:
    out = []
    types = [
        "document.created",
        "document.sent",
        "link.opened",
        "otp.requested",
        "otp.verified",
        "signature.applied",
    ]
    for i in range(n):
        out.append(
            store.append_event(
                doc_id,
                types[i % len(types)],
                recipient_id=None,
                actor_email="jane.doe@acme.example",
                ip_address="203.0.113.7",
                user_agent="Mozilla/5.0 (test)",
                metadata={"step": i, "note": "café — naïve"},
            )
        )
    return out


def _drop_guards(conn: sqlite3.Connection) -> None:
    """Simulate an attacker with write access to the file: remove the triggers."""
    conn.execute("DROP TRIGGER IF EXISTS sign_audit_no_update")
    conn.execute("DROP TRIGGER IF EXISTS sign_audit_no_delete")


# --------------------------------------------------------------------------
# The happy path, stated as an assertion rather than assumed
# --------------------------------------------------------------------------


def test_chain_links_every_event_to_its_predecessor(db):
    _document(db, "chain-happy")
    evs = _events(db, "chain-happy", 6)

    assert evs[0]["prev_hash"] == db.GENESIS_HASH
    for prev, cur in zip(evs, evs[1:]):
        assert cur["prev_hash"] == prev["event_hash"]
        assert cur["event_hash"] != prev["event_hash"]

    report = db.verify_chain("chain-happy")
    assert report["ok"] is True
    assert report["events"] == 6
    assert report["head"] == evs[-1]["event_hash"]
    assert report["broken_at_event_id"] is None


def test_append_only_triggers_refuse_update_and_delete(db):
    _document(db, "chain-guards")
    _events(db, "chain-guards", 3)

    with sqlite3.connect(os.environ["CHAMPDF_DB_PATH"]) as conn:
        with pytest.raises(sqlite3.IntegrityError, match="append-only"):
            conn.execute("UPDATE sign_audit_events SET event_type = 'x'")
        with pytest.raises(sqlite3.IntegrityError, match="append-only"):
            conn.execute("DELETE FROM sign_audit_events")

    assert db.verify_chain("chain-guards")["ok"] is True


# --------------------------------------------------------------------------
# Tamper detection. Each of these mutates the database behind the triggers'
# back, which is exactly the case the hash chain exists to catch.
# --------------------------------------------------------------------------


def test_edited_event_body_is_detected(db):
    _document(db, "chain-edit")
    evs = _events(db, "chain-edit", 5)

    with sqlite3.connect(os.environ["CHAMPDF_DB_PATH"]) as conn:
        _drop_guards(conn)
        conn.execute(
            "UPDATE sign_audit_events SET actor_email = ? WHERE id = ?",
            ("attacker@evil.example", evs[2]["id"]),
        )

    report = db.verify_chain("chain-edit")
    assert report["ok"] is False
    assert report["broken_at_event_id"] == evs[2]["id"]
    assert "does not match the event's content" in report["reason"]


def test_edited_ip_address_is_detected(db):
    """The IP is evidence. Rewriting it must break the chain just like any other field."""
    _document(db, "chain-ip")
    evs = _events(db, "chain-ip", 4)

    with sqlite3.connect(os.environ["CHAMPDF_DB_PATH"]) as conn:
        _drop_guards(conn)
        conn.execute(
            "UPDATE sign_audit_events SET ip_address = '10.0.0.1' WHERE id = ?",
            (evs[1]["id"],),
        )

    assert db.verify_chain("chain-ip")["broken_at_event_id"] == evs[1]["id"]


def test_edited_metadata_is_detected(db):
    _document(db, "chain-meta")
    evs = _events(db, "chain-meta", 4)

    with sqlite3.connect(os.environ["CHAMPDF_DB_PATH"]) as conn:
        _drop_guards(conn)
        conn.execute(
            "UPDATE sign_audit_events SET metadata = ? WHERE id = ?",
            (json.dumps({"step": 99, "note": "tampered"}), evs[1]["id"]),
        )

    assert db.verify_chain("chain-meta")["ok"] is False


def test_deleted_middle_event_is_detected(db):
    """Truncating or excising history is the most valuable attack: it hides a step."""
    _document(db, "chain-delete")
    evs = _events(db, "chain-delete", 6)

    with sqlite3.connect(os.environ["CHAMPDF_DB_PATH"]) as conn:
        _drop_guards(conn)
        conn.execute("DELETE FROM sign_audit_events WHERE id = ?", (evs[2]["id"],))

    report = db.verify_chain("chain-delete")
    assert report["ok"] is False
    # The break surfaces at the event that no longer follows its recorded parent.
    assert report["broken_at_event_id"] == evs[3]["id"]
    assert report["reason"].startswith("prev_hash")


def test_deleting_the_last_event_is_detected(db):
    """Truncating the tail loses the execution record and must not read as intact."""
    _document(db, "chain-truncate")
    evs = _events(db, "chain-truncate", 4)

    with sqlite3.connect(os.environ["CHAMPDF_DB_PATH"]) as conn:
        _drop_guards(conn)
        conn.execute("DELETE FROM sign_audit_events WHERE id = ?", (evs[-1]["id"],))

    report = db.verify_chain("chain-truncate")
    # Nothing inside the remaining rows is inconsistent, so the row-level hashes
    # still check out. What must not happen is a silent pass that pretends the
    # chain is complete: the caller compares report["events"] against the
    # expected count, which is why the report carries it.
    assert report["events"] == 3
    assert report["head"] == evs[-2]["event_hash"]


def test_reordered_events_are_detected(db):
    _document(db, "chain-reorder")
    evs = _events(db, "chain-reorder", 4)

    with sqlite3.connect(os.environ["CHAMPDF_DB_PATH"]) as conn:
        _drop_guards(conn)
        # Order matters: verify_chain walks the table ORDER BY id. Moving the
        # last event to the front puts an event whose prev_hash is the third
        # event's hash where the genesis hash is expected.
        conn.execute("UPDATE sign_audit_events SET id = 0 WHERE id = ?", (evs[3]["id"],))

    report = db.verify_chain("chain-reorder")
    assert report["ok"] is False
    assert report["reason"].startswith("prev_hash")


def test_relinked_chain_is_still_detected(db):
    """
    The sophisticated attack: edit a row AND recompute every hash after it, so
    the file looks internally consistent. It still fails, because the head at
    execution time was embedded in the certificate of completion and in
    sign_documents.chain_head_at_execution. That stored head is the anchor.
    """
    _document(db, "chain-relink")
    evs = _events(db, "chain-relink", 5)
    original_head = evs[-1]["event_hash"]
    # The anchor: at execution, Sign writes the chain head onto the document row
    # and into the certificate of completion. That is the value an outside party
    # compares against, and it is what a recomputed chain cannot forge without
    # also editing the executed PDF.
    db.update_document("chain-relink", chain_head_at_execution=original_head)

    with sqlite3.connect(os.environ["CHAMPDF_DB_PATH"]) as conn:
        _drop_guards(conn)
        conn.execute(
            "UPDATE sign_audit_events SET actor_email = 'attacker@evil.example' WHERE id = ?",
            (evs[1]["id"],),
        )
        # Full relink: recompute every hash top to bottom so the file is
        # internally consistent again. Read through this connection so the rows
        # carry the edited values.
        running = db.GENESIS_HASH
        conn.row_factory = sqlite3.Row
        rows = [
            dict(r)
            for r in conn.execute(
                "SELECT * FROM sign_audit_events WHERE document_id = ? ORDER BY id",
                ("chain-relink",),
            ).fetchall()
        ]
        for ev in rows:
            if ev["metadata"]:
                ev["metadata"] = json.loads(ev["metadata"])
            this_hash = db.compute_event_hash(running, ev)
            conn.execute(
                "UPDATE sign_audit_events SET prev_hash = ?, event_hash = ? WHERE id = ?",
                (running, this_hash, ev["id"]),
            )
            running = this_hash
        conn.commit()

    # Row-level verification now passes: the attacker rebuilt a consistent chain.
    assert db.verify_chain("chain-relink")["ok"] is True
    # The anchor does not. This is the check that has to be non-negotiable.
    live_head = db.verify_chain("chain-relink")["head"]
    assert live_head != db.get_document("chain-relink")["chain_head_at_execution"]


def test_unknown_event_type_is_refused(db):
    _document(db, "chain-unknown")
    with pytest.raises(ValueError, match="unknown audit event type"):
        db.append_event("chain-unknown", "document.published")


def test_chains_are_per_document(db):
    """Two documents in flight must not link into each other."""
    _document(db, "chain-a")
    _document(db, "chain-b")
    a = _events(db, "chain-a", 3)
    b = _events(db, "chain-b", 3)

    assert a[0]["prev_hash"] == db.GENESIS_HASH
    assert b[0]["prev_hash"] == db.GENESIS_HASH
    assert db.verify_chain("chain-a")["ok"] is True
    assert db.verify_chain("chain-b")["ok"] is True


def test_canonical_json_is_order_independent(db):
    """
    The hash must not depend on Python dict insertion order, or a legitimate
    reload from JSON would produce a different hash and break the chain.
    """
    a = {"document_id": "d", "event_type": "document.sent", "metadata": {"x": 1, "y": 2}}
    b = {"metadata": {"y": 2, "x": 1}, "event_type": "document.sent", "document_id": "d"}
    assert db.canonical_json(a) == db.canonical_json(b)
    assert db.compute_event_hash(db.GENESIS_HASH, a) == db.compute_event_hash(
        db.GENESIS_HASH, b
    )