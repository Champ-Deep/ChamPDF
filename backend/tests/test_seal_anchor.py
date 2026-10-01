"""
The seal and the anchor.

Two independent claims are made to a counterparty holding only the executed
PDF:

  1. the audit trail has not been rewritten since execution, and
  2. the PAdES seal on the file is still intact.

The hash chain alone cannot prove (1). An attacker with write access to the
database can edit a row and recompute every hash after it, and ``verify_chain``
will happily report ``ok: true``, because the file is once again internally
consistent. What stops that is the anchor: the chain head recorded at execution
onto the document row and printed into the certificate of completion. This
module tests that anchor is actually enforced by the verify endpoint, and that
a modified sealed PDF is reported as not intact.

Run:  pytest backend/tests/test_seal_anchor.py -v
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


@pytest.fixture(scope="module", autouse=True)
def _isolated_db(tmp_path_factory):
    """Sign's store module resolves its SQLite path from the environment at import
    time, so give this module its own database rather than sharing another test's."""
    d = tmp_path_factory.mktemp("anchor")
    os.environ["CHAMPDF_DB_PATH"] = str(d / "anchor.db")
    os.environ["CHAMPDF_SIGN_DATA_DIR"] = str(d / "signdata")
    from sign import store

    store.init_sign_db()
    yield


# --------------------------------------------------------------------------
# Unit level: the anchor comparison and the tamper check on the seal
# --------------------------------------------------------------------------


def test_verify_reports_anchor_mismatch_when_chain_was_rewritten():
    """
    RED first: verify() returned chain_head_at_execution but never compared it.
    A rewritten chain therefore reported ok: true. It must not.
    """
    from sign import service, store

    doc_id = "anchor-doc"
    store.insert_document(
        {
            "id": doc_id,
            "title": "Anchor doc",
            "sender_user_id": "user_test",
            "template_id": "mutual-nda-v1",
            "template_version": 1,
            "template_sha256": "0" * 64,
            "provider": "native",
            "counterparty_entity": "Acme Technologies Private Limited",
            "merge_fields_json": "{}",
            "status": "executed",
            "expires_at": store.default_expiry(14),
            "created_at": store.utcnow_iso(),
        }
    )
    events = [
        store.append_event(doc_id, t, actor_email="jane.doe@acme.example")
        for t in ("document.created", "document.sent")
    ]
    # Production order (service.execute -> _finalize_executed): the head is
    # captured from the verified chain, then document.executed is appended.
    head_at_execution = events[-1]["event_hash"]
    store.update_document(doc_id, chain_head_at_execution=head_at_execution)
    store.append_event(doc_id, "document.executed", metadata={"content_sha256": "0" * 64})

    class _Sender:
        user_id = "user_test"
        email = "deep@championsmail.com"
        name = "Deep"
        is_admin = True

    # Baseline: nothing rewritten, the anchor matches and the report is clean.
    import asyncio

    report = asyncio.run(service.verify(_Sender(), doc_id))  # type: ignore[arg-type]
    assert report["chain"]["ok"] is True
    # The live head has grown past the anchor by exactly the one appended event.
    assert report["chain"]["head"] != head_at_execution
    assert report["chain"]["events"] == 3
    assert report["anchor"]["ok"] is True
    assert report["anchor"]["event_type"] == "document.executed"
    assert report["ok"] is True

    # Now forge: rewrite an event and relink every hash after it.
    with sqlite3.connect(os.environ["CHAMPDF_DB_PATH"]) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("DROP TRIGGER IF EXISTS sign_audit_no_update")
        conn.execute("DROP TRIGGER IF EXISTS sign_audit_no_delete")
        conn.execute(
            "UPDATE sign_audit_events SET actor_email = ? WHERE id = ?",
            ("attacker@evil.example", events[0]["id"]),
        )
        running = store.GENESIS_HASH
        conn.row_factory = sqlite3.Row
        for ev in [
            dict(r)
            for r in conn.execute(
                "SELECT * FROM sign_audit_events WHERE document_id = ? ORDER BY id",
                (doc_id,),
            ).fetchall()
        ]:
            if ev["metadata"]:
                ev["metadata"] = json.loads(ev["metadata"])
            this_hash = store.compute_event_hash(running, ev)
            conn.execute(
                "UPDATE sign_audit_events SET prev_hash = ?, event_hash = ? WHERE id = ?",
                (running, this_hash, ev["id"]),
            )
            running = this_hash
        conn.commit()

    forged = asyncio.run(service.verify(_Sender(), doc_id))  # type: ignore[arg-type]
    # The chain is self-consistent again, so this assertion documents the limit
    # of row-level verification.
    assert forged["chain"]["ok"] is True
    # The anchor is not fooled: document.executed no longer hangs off the head
    # recorded at execution, which is the value printed in the certificate.
    assert forged["anchor"]["ok"] is False
    assert forged["anchor"]["recorded"] == head_at_execution
    assert forged["anchor"]["found_prev_hash"] != head_at_execution
    # And the top-level verdict fails, which is the only field a dispute uses.
    assert forged["ok"] is False


def test_seal_verification_detects_a_modified_pdf():
    """
    Seal an actual PDF, then change one byte of its content stream. The
    signature must stop validating. If this ever passes, the seal is decorative.
    """
    pymupdf = pytest.importorskip("pymupdf")
    pytest.importorskip("pyhanko")

    from sign import seal

    seal.reset_seal_for_tests()
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((72, 100), "Champions Superior Capital - executed document")
    raw = doc.tobytes()
    doc.close()

    sealed, info = seal.seal_pdf_sync(raw, reason="execution", location="IN", tsa_url=None)
    assert info["sealed"] is True
    assert sealed != raw

    verified = seal.verify_seal_sync(sealed)
    assert verified.get("signature_count") == 1
    assert all(s["intact"] for s in verified.get("signatures", []))

    # Tamper: append a page after the seal was applied. The signed byte range
    # no longer matches the document.
    tampered = pymupdf.open("pdf", sealed)
    p2 = tampered.new_page()
    p2.insert_text((72, 100), "injected page added after signing")
    tampered_bytes = tampered.tobytes()
    tampered.close()

    after = seal.verify_seal_sync(tampered_bytes)
    sigs = after.get("signatures", [])
    assert not any(s["intact"] for s in sigs) or after.get("signature_count") != 1