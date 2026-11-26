#!/usr/bin/env python3
"""Export api_keys from a SQLite file (opened read only) to D1-ready INSERT statements.
request_log is not exported. Key hashes are never printed to stdout."""
import argparse
import sqlite3
import sys

COLS = ["id", "key_hash", "label", "monthly_quota", "month_bucket", "requests_used",
        "created_at", "last_used_at", "disabled_at", "clerk_user_id", "scopes"]
# Same defaults init_db in backend/api_v1.py gives pre-migration databases.
MISSING = {"clerk_user_id": "NULL", "scopes": "'*'"}


def lit(v):
    if v is None:
        return "NULL"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, str):
        return "'" + v.replace("'", "''") + "'"
    raise SystemExit(f"unsupported value type {type(v).__name__}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    conn = sqlite3.connect(f"file:{a.db}?mode=ro", uri=True)
    have = {r[1] for r in conn.execute("PRAGMA table_info(api_keys)")}
    sel = ", ".join(c if c in have else "NULL" for c in COLS)
    rows = conn.execute(f"SELECT {sel} FROM api_keys ORDER BY id").fetchall()
    with open(a.out, "w") as f:
        for row in rows:
            vals = [MISSING[c] if c in MISSING and c not in have else lit(v) for c, v in zip(COLS, row)]
            f.write(f"INSERT INTO api_keys ({', '.join(COLS)}) VALUES ({', '.join(vals)});\n")
    print(f"exported {len(rows)} keys", file=sys.stderr)


if __name__ == "__main__":
    main()
