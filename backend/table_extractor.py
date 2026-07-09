"""
Server-side table extraction via PyMuPDF's find_tables() (fitz).

The frontend's mupdf.js (client-side) engine has no table finder — find_tables
was a PyMuPDF Python-layer feature never ported to MuPDF core / mupdf.js. So
extract-tables, pdf-to-csv, and pdf-to-excel upload the PDF here instead of
running fully client-side. Runs the blocking PyMuPDF call in a worker thread.
"""

from __future__ import annotations

import asyncio
from typing import Any, Dict, List


class TableExtractionError(Exception):
    """Raised when table extraction is unavailable or fails."""


def table_extraction_available() -> bool:
    """True iff PyMuPDF (fitz) with find_tables support is importable."""
    try:
        import fitz  # noqa: F401

        return hasattr(fitz.Page, "find_tables")
    except ImportError:
        return False


def _extract(pdf_bytes: bytes) -> List[Dict[str, Any]]:
    import fitz

    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        tables: List[Dict[str, Any]] = []
        for page_index in range(doc.page_count):
            page = doc[page_index]
            for table_index, table in enumerate(page.find_tables().tables):
                rows = table.extract()
                tables.append(
                    {
                        "page": page_index + 1,
                        "tableIndex": table_index + 1,
                        "rows": rows,
                        "rowCount": len(rows),
                        "colCount": len(rows[0]) if rows else 0,
                        "markdown": table.to_markdown(clean=False),
                    }
                )
        return tables
    finally:
        doc.close()


async def extract_tables(pdf_bytes: bytes) -> List[Dict[str, Any]]:
    """Find all tables in a PDF, page by page. Returns [] if none found."""
    if not table_extraction_available():
        raise TableExtractionError("Server table extraction is not configured on this server")
    return await asyncio.to_thread(_extract, pdf_bytes)
