"""
ChampPDF Sign — the document execution layer.

Templates in, a legally defensible electronic signature out, with a
hash-chained audit trail we own regardless of which signing engine sits
behind the ``SigningProvider`` seam (see ``sign/providers``).

Package layout
  store.py        system of record (SQLite today, Postgres-portable SQL)
  tokens.py       CSPRNG link tokens, OTPs, signer sessions
  storage.py      write-once object storage (local disk, S3 / R2)
  templates.py    template registry + PDF rendering, First Schedule block
  seal.py         seal certificate + PAdES seal + certificate of completion
  providers/      SigningProvider interface, native and Documenso adapters
  mailer.py       transactional email (Resend), never cold-outbound infra
  beam.py         ChampBeam tracked-link wrapper (instrumentation only)
  auth.py         sender identity (Clerk JWT or admin token) and roles
  service.py      orchestration of the send / sign / seal lifecycle
  router.py       FastAPI routes under /api/sign

Everything is env-gated: with nothing configured the feature still works
locally (log mailer, self-signed seal, local storage) so the spine can be
exercised end to end before any infrastructure exists.
"""
