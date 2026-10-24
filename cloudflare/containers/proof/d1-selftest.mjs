// D1 semantics the Sign store depends on, run against the real workerd D1 (miniflare) from wrangler.
//   node proof/d1-selftest.mjs      (exit 1 on any failed expectation)
import { getPlatformProxy } from "wrangler";
import { readFileSync } from "node:fs";

const { env, dispose } = await getPlatformProxy({ configPath: new URL("../wrangler.json", import.meta.url).pathname, environment: "local", persist: false });
const db = env.DB;
const results = [];
const check = async (name, fn) => {
  try { results.push({ name, ...(await fn()) }); } catch (e) { results.push({ name, ok: false, error: String(e.message ?? e) }); }
};

const schema = readFileSync(new URL("../migrations/0001_champdf_init.sql", import.meta.url), "utf8");
await db.exec(schema.replace(/^--.*$/gm, "").replace(/\s*\n\s*/g, " ")); // exec is line-oriented; drop comments, one statement list per line

const doc = (id) => db.prepare("INSERT INTO sign_documents (id,title,sender_user_id,template_id,template_version,template_sha256,provider,counterparty_entity,merge_fields_json,status,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
  .bind(id, "t", "u", "tpl", 1, "x", "native", "c", "{}", "draft", "2027-01-01", "2026-10-24");
const ev = (docId, prev, hash) => db.prepare("INSERT INTO sign_audit_events (document_id,event_type,occurred_at,prev_hash,event_hash) VALUES (?,?,?,?,?)").bind(docId, "created", "2026-10-24", prev, hash);

await db.batch([doc("d1")]);

await check("interactive BEGIN is rejected (store.connect(immediate=True) cannot be ported 1:1)", async () => {
  try { await db.exec("BEGIN IMMEDIATE"); return { ok: false, note: "BEGIN unexpectedly accepted" }; }
  catch (e) { return { ok: /transaction/i.test(String(e.message ?? e)), error: String(e.message ?? e).slice(0, 120) }; }
});

await check("batch() is atomic: a failing 2nd statement rolls back the 1st", async () => {
  try { await db.batch([doc("d2"), db.prepare("INSERT INTO sign_audit_events (document_id) VALUES ('d2')")]); } catch {}
  const row = await db.prepare("SELECT count(*) c FROM sign_documents WHERE id='d2'").first();
  return { ok: row.c === 0, rows_left: row.c };
});

await check("append-only trigger blocks UPDATE of an audit row", async () => {
  await db.batch([ev("d1", "GENESIS", "h1")]);
  try { await db.prepare("UPDATE sign_audit_events SET event_type='x' WHERE event_hash='h1'").run(); return { ok: false }; }
  catch (e) { return { ok: /append-only/.test(String(e.message ?? e)) }; }
});

await check("append-only trigger blocks DELETE of an audit row", async () => {
  try { await db.prepare("DELETE FROM sign_audit_events WHERE event_hash='h1'").run(); return { ok: false }; }
  catch (e) { return { ok: /append-only/.test(String(e.message ?? e)) }; }
});

await check("two appends on the same chain head: second is rejected (optimistic retry needed)", async () => {
  try { await db.batch([ev("d1", "h1", "h2a")]); await db.batch([ev("d1", "h1", "h2b")]); return { ok: false, note: "fork accepted" }; }
  catch (e) { return { ok: /UNIQUE/.test(String(e.message ?? e)), error: String(e.message ?? e).slice(0, 100) }; }
});

await check("same race WITHOUT the candidate unique index forks the chain", async () => {
  await db.exec("DROP INDEX uq_sign_audit_chain");
  await db.batch([ev("d1", "h1", "h2c")]);
  const n = await db.prepare("SELECT count(*) c FROM sign_audit_events WHERE document_id='d1' AND prev_hash='h1'").first();
  return { ok: n.c >= 2, children_of_h1: n.c };
});

await dispose();
console.log(JSON.stringify(results, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
