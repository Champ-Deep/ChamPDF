# ChamPDF: tester guide

Run the whole product on your own machine and exercise it end to end. No
developer help, no API keys needed for the core path. Verified on macOS,
Node 24, Python 3.11 (the version CI uses).

## 1. Prerequisites

- Node 22 or newer, `npm`
- Python 3.11 or 3.12 (not 3.13: Real-ESRGAN's build needs `pkg_resources`)
- `ffmpeg` (`brew install ffmpeg`, Windows: `winget install Gyan.FFmpeg`)
- `uv` (`brew install uv`, Windows: `winget install astral-sh.uv`) or plain `python -m venv`
- Optional, for server OCR only: `tesseract` and `ghostscript`. Without them the
  OCR tool still works in the browser and `/api/ocr-pdf` reports "not configured".

## 2. Install

```bash
git clone https://github.com/Champ-Deep/ChamPDF.git && cd ChamPDF
git checkout v3-test-ready      # until PR #102 lands on main
npm ci

uv venv --python 3.11 --seed .venv && source .venv/bin/activate
pip install "setuptools<81" wheel
pip install --no-build-isolation -r backend/requirements.txt -r backend/requirements-dev.txt
pip install --no-deps simple-lama-inpainting==0.1.2 pdf2docx==0.5.8
```

`--seed` puts pip inside the venv. Without it, `pip` after activation is the
system Python's pip and the packages land in the wrong interpreter.

The last line matches the Dockerfile: both packages are installed without
their dependencies (their pins conflict with the rest). LaMa repaints
watermarks inside images; its model (about 200 MB) downloads on first use.

The backend install pulls torch and takes a few minutes.

On Windows (PowerShell), activate with `.venv\Scripts\Activate.ps1` and set
environment variables with `$env:NAME = "value"` before the command.

## 3. Run

Terminal 1, backend (API on :8000):

```bash
source .venv/bin/activate
cd backend
CHAMPDF_ADMIN_TOKEN=local-test-token SIGN_PUBLIC_BASE_URL=http://localhost:5173 \
  python -m uvicorn main:app --port 8000
```

Windows (PowerShell):

```powershell
.venv\Scripts\Activate.ps1
cd backend
$env:CHAMPDF_ADMIN_TOKEN = "local-test-token"; $env:SIGN_PUBLIC_BASE_URL = "http://localhost:5173"
python -m uvicorn main:app --port 8000
```

First start takes 20 to 40 seconds. State lives in `backend/data/` (ignored by
git). Delete that folder to reset.

Terminal 2, frontend (UI on :5173):

```bash
echo 'VITE_API_URL=http://localhost:8000' > .env.local
npm run dev
```

In Windows PowerShell 5, write the file with
`Set-Content .env.local 'VITE_API_URL=http://localhost:8000' -Encoding utf8`
(`echo >` writes UTF-16 there).

Open http://localhost:5173.

## 4. Check it works

```bash
source .venv/bin/activate
CHAMPDF_ADMIN_TOKEN=local-test-token python scripts/smoke_backend.py
```

Expect `ALL PASSED`. Health is `GET /health` (there is no `/api/health`).

## 5. What to click through

| Area              | Steps                                                                                                                                                                                                            | Expected                                                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client-side tools | Merge, Split, Compress, PDF to Word on any PDF                                                                                                                                                                   | Output downloads, opens, page count correct. Nothing is uploaded.                                                                                                                   |
| Watermark removal | Remove Watermark on a PDF with a visible mark. With the backend running the method defaults to the server: click Remove Watermark with no box for automatic removal, use Detect on server, or draw a box         | Mark gone from the page and from search and copy, nearby text intact and sharp. On image-only pages (scans, NotebookLM slides) draw a box: that area of the image is repainted      |
| Server tools      | Table extract, OCR, Image background removal                                                                                                                                                                     | Result returns. Needs the backend running. AI edit and GPU video tools need provider keys and show unavailable without them                                                         |
| Sign (dev mode)   | Open `/sign.html`, choose developer mode, enter `local-test-token`, fill the Mutual NDA including the Champions countersigner, preview, send                                                                     | Preview PDF renders. Send succeeds and the page shows the signer link (copy it). With no `RESEND_API_KEY` no email is sent; every would-be email is printed in the backend terminal |
| Signer side       | Open the `/s/<token>` link, request the code (read the 6 digits from the backend terminal), verify, scroll to the end, sign. Then open the countersigner's link (printed in the backend terminal) and sign again | Sealed PDF downloads after the countersignature, both signature blocks filled, certificate of completion present                                                                    |
| Admin portal      | `/sign-admin.html` with the same token                                                                                                                                                                           | The document and its event trail are listed                                                                                                                                         |

Sign sends real email only when `RESEND_API_KEY` is set (see
`backend/.env.example`). Sign-in with Clerk needs `VITE_CLERK_PUBLISHABLE_KEY`
and `CLERK_ISSUER`; skip it and use the admin token.

## 6. Automated tests

```bash
npx tsc --noEmit            # expect no output
npx vitest run              # frontend, expect 315 passed, 7 skipped (about 25s). Do not run it alongside the backend tests: under load it times out
python -m pytest backend/tests -q   # expect 149 passed, 2 skipped
```

## Known limits

- Real-ESRGAN image upscaling needs the full install above; if its build fails
  on your Python, everything else still runs.
- Without provider keys (OpenRouter, Gemini, Groq, Replicate) the AI and GPU
  tools report unavailable. That is expected.
- `champdf.com/api` returns 502 until a backend is deployed behind it. Test
  locally until then.
