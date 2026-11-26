#!/usr/bin/env bash
# Local only: fixture SQLite -> export-keys.py -> local D1 -> parity + AUTOINCREMENT. Never uses --remote.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
cd "$HERE"
W=(npx wrangler d1)
D=(champdf-local --local --env local --persist-to "$T/state")
Q="SELECT id, key_hash, label, monthly_quota, disabled_at, clerk_user_id, scopes FROM api_keys ORDER BY id"

fx() { CHAMPDF_DB_PATH="$T/src.db" PYTHONPATH="$HERE/../../backend" python3 -c "$1"; }
fx 'import api_v1; api_v1.init_db()'
K1=$(fx 'import api_v1; print(api_v1.create_key("admin-issued")["key"])')
K2=$(fx 'import api_v1; print(api_v1.create_key("clerk-issued", clerk_user_id="user_fixture", scopes=["pdf"])["key"])')
K3=$(fx 'import api_v1; print(api_v1.create_key("to-revoke", monthly_quota=50)["key"])')
fx 'import api_v1; assert api_v1.revoke_key(3)'
: "${K1:?}" "${K2:?}" "${K3:?}"  # raw keys stay in shell variables only

python3 scripts/export-keys.py --db "$T/src.db" --out "$T/keys.sql"
[ -n "${DROP_ROW:-}" ] && sed -i.bak "${DROP_ROW}d" "$T/keys.sql"   # negative control hook

"${W[@]}" migrations apply "${D[@]}" >/dev/null
"${W[@]}" execute "${D[@]}" --file "$T/keys.sql" >/dev/null

python3 - "$T" "$Q" <<'PY'
import json, sqlite3, subprocess, sys
t, q = sys.argv[1], sys.argv[2]
src = {tuple(r) for r in sqlite3.connect(f"file:{t}/src.db?mode=ro", uri=True).execute(q)}
out = subprocess.run(["npx", "wrangler", "d1", "execute", "champdf-local", "--local", "--env", "local",
                      "--persist-to", f"{t}/state", "--json", "--command", q],
                     check=True, capture_output=True, text=True).stdout
cols = ["id", "key_hash", "label", "monthly_quota", "disabled_at", "clerk_user_id", "scopes"]
d1 = {tuple(r[c] for c in cols) for r in json.loads(out)[0]["results"]}
if src == d1:
    print(f"PARITY OK {len(d1)}/{len(src)}")
else:
    # ids only in diff output so hashes are not printed
    print("PARITY FAIL: ids only in source", sorted(r[0] for r in src - d1), "ids only in D1", sorted(r[0] for r in d1 - src))
    print("rows differing by id:", sorted({r[0] for r in src ^ d1}))
    sys.exit(1)
PY

"${W[@]}" execute "${D[@]}" --command "INSERT INTO api_keys (key_hash, label, month_bucket, created_at) VALUES ('fixture-new', 'new', '2026-11', '2026-11-26')" >/dev/null
MAXID=3
NEWID=$("${W[@]}" execute "${D[@]}" --json --command "SELECT id FROM api_keys WHERE key_hash='fixture-new'" | python3 -c 'import json,sys;print(json.load(sys.stdin)[0]["results"][0]["id"])')
[ "$NEWID" -gt "$MAXID" ] && echo "AUTOINCREMENT OK: new id $NEWID > max imported id $MAXID" || { echo "AUTOINCREMENT FAIL: $NEWID"; exit 1; }
