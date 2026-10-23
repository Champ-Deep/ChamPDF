# ChamPDF: tester guide

Run the whole product on your own machine and exercise it end to end. No
developer help, no API keys needed for the core path. Verified on macOS,
Node 24, Python 3.11 (the version CI uses).

## 1. Prerequisites

- Node 22 or newer, `npm`
- Python 3.11 or 3.12 (not 3.13: Real-ESRGAN's build needs `pkg_resources`)
- `ffmpeg` (`brew install ffmpeg`)
- `uv` (`brew install uv`) or plain `python -m venv`

## 2. Install

```bash
git clone https://github.com/Champ-Deep/ChamPDF.git && cd ChamPDF
git checkout v3-test-ready      # until PR #102 lands on main
npm ci

uv venv --python 3.11 .venv && source .venv/bin/activate
pip install "setuptools<81" wheel
pip install --no-build-isolation -r backend/requirements.txt -r backend/requirements-dev.txt
```

The backend install pulls torch and takes a few minutes.

## 3. Run

Terminal 1, backend (API on :8000):

```bash
source .venv/bin/activate
cd backend
CHAMPDF_ADMIN_TOKEN=local-test-token SIGN_PUBLIC_BASE_URL=http://localhost:5173 \
  python -m uvicorn main:app --port 8000
```

First start takes 20 to 40 seconds. State lives in `backend/data/` (ignored by
git). Delete that folder to reset.

Terminal 2, frontend (UI on :5173):

```bash
echo 'VITE_API_URL=http://localhost:8000' > .env.local
npm run dev
```

Open http://localhost:5173.

## 4. Check it works

```bash
source .venv/bin/activate
CHAMPDF_ADMIN_TOKEN=local-test-token python scripts/smoke_backend.py
```

Expect `ALL PASSED`. Health is `GET /health` (there is no `/api/health`).

## 5. What to click through

| Area              | Steps                                                                                                                       | Expected                                                                                                                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client-side tools | Merge, Split, Compress, PDF to Word on any PDF                                                                              | Output downloads, opens, page count correct. Nothing is uploaded.                                                                                                                   |
| Watermark removal | Remove Watermark on a PDF with a visible mark                                                                               | Mark gone, nearby text intact                                                                                                                                                       |
| Server tools      | Table extract, OCR, Image background removal                                                                                | Result returns. Needs the backend running. AI edit and GPU video tools need provider keys and show unavailable without them                                                         |
| Sign (dev mode)   | Open `/sign.html`, choose developer mode, enter `local-test-token`, fill the Mutual NDA, preview, send                      | Preview PDF renders. Send succeeds and the page shows the signer link (copy it). With no `RESEND_API_KEY` no email is sent; every would-be email is printed in the backend terminal |
| Signer side       | Open the `/s/<token>` link, request the code (read the 6 digits from the backend terminal), verify, scroll to the end, sign | Sealed PDF downloads, certificate of completion present                                                                                                                             |
| Admin portal      | `/sign-admin.html` with the same token                                                                                      | The document and its event trail are listed                                                                                                                                         |

Sign sends real email only when `RESEND_API_KEY` is set (see
`backend/.env.example`). Sign-in with Clerk needs `VITE_CLERK_PUBLISHABLE_KEY`
and `CLERK_ISSUER`; skip it and use the admin token.

## 6. Automated tests

```bash
npx tsc --noEmit            # expect no output
npx vitest run              # frontend, expect 317 passed (about 10s). Do not run it alongside the backend tests: under load it times out
python -m pytest backend/tests -q   # expect 130 passed, 3 skipped
```

## Known limits

- Real-ESRGAN image upscaling needs the full install above; if its build fails
  on your Python, everything else still runs.
- Without provider keys (OpenRouter, Gemini, Groq, Replicate) the AI and GPU
  tools report unavailable. That is expected.
- `champdf.com/api` returns 502 until a backend is deployed behind it. Test
  locally until then.
