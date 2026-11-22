# UniApply-AI

UniApply-AI is an AI-native college admissions platform for India, built as a monorepo MVP covering a FastAPI backend, React + Vite web frontend, and scaffolding for desktop/mobile clients. The project follows the supplied RFP with five core modules: profile engine, document normalizer, cutoff matcher, assessment simulator, and decentralized allocation.

## Quick start

### Backend

```powershell
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
if (!(Test-Path .env)) { Copy-Item .env.example .env }
uvicorn app.main:app --reload
```

Set `LLM_PROVIDER=ollama`, `OLLAMA_BASE_URL=http://localhost:11434`, and `OLLAMA_MODEL=llama3.2:3b` to use the local Ollama model. Set `LLM_PROVIDER=openai` with `OPENAI_API_KEY` for supported hosted inference. Use `LLM_PROVIDER=demo` to explicitly enable deterministic demo mode; provider failures do not silently switch to demo.

The student profile-intake workflow is stricter: it runs only against Ollama on a loopback address (`localhost`, `127.0.0.1`, or `::1`) and never uses an external provider or deterministic fallback. In the web dashboard, submit academic background, interests, preferred courses, and budget for extraction. The returned fields are validated and shown for review; they are not saved unless the student explicitly chooses **Apply these reviewed fields to my profile**. Do not enter passwords, government identifiers, or other sensitive personal information.

The authenticated `GET /api/ai/status` endpoint reports the configured/active provider and whether deterministic demo mode is active. `POST /api/profile/intake` returns model-generated data only on successful local Ollama inference; otherwise it returns a non-success status without a fallback profile.

### AI College Predictor and admission chat

The authenticated **AI College Predictor** page uses the student's saved profile and rank, the uploaded college directory, partial historical cutoff records, and institution criteria explicitly marked verified. The student can save supported MHT-CET and JEE Main ranks to `POST /api/profile`, generate results with `POST /api/ai/recommendations/generate`, read the latest run at `GET /api/ai/recommendations`, and review the bounded history at `GET /api/ai/recommendations/history`. Runs are based only on exact exam/category/course rows or matching verified criteria. “Safe,” “Moderate,” and “Ambitious” describe historical rank comparisons only; they are not current eligibility outcomes, admission probabilities, seat availability, or guarantees. Official application buttons appear only for verified HTTPS application links.

The floating **Ask AI** assistant uses the authenticated `/api/ai/chat` endpoint and the server-configured Ollama model. It is intentionally limited to loopback Ollama because the retrieved context includes private student profile and application information; it will not send that context to a remote provider or invent an answer when no relevant record is available. Responses cite retrieved college records and, when available, their source links. Chat history is account-scoped, limited to 50 sessions and 200 messages per session, and can be cleared in the widget. Saved colleges and up to 20 recommendation runs are account-scoped as well. The privacy export includes application records, allocation history, and AI history but excludes uploaded source-file contents; account deletion removes these owned records.

Database configuration is environment-driven through `MONGODB_URI` and `MONGODB_DATABASE`. If those values are absent, the app remains in the demo-safe in-memory mode and reports `storage_backend: demo` so the runtime does not incorrectly claim Atlas persistence. `STORAGE_BACKEND=demo` explicitly selects that in-memory store without attempting a MongoDB connection; this mode is rejected in production. The default `auto` mode preserves the normal Mongo-first behavior.

### Student document uploads

Authenticated students can upload one PDF, JPEG, or PNG at `POST /api/documents/upload` using multipart form data with a `file` part and an optional `document_type` (`academic_marksheet`, `school_leaving_certificate`, `identity_proof`, `entrance_scorecard`, `category_certificate`, or `other`). The server enforces `DOCUMENT_MAX_BYTES` (default 10 MiB), `DOCUMENT_ALLOWED_MIME_TYPES` (comma-separated; defaults to `application/pdf,image/jpeg,image/png`), validates the file signature and decodes the PDF/image before accepting it, and generates a document ID and SHA-256 hash. Document bytes are stored outside the frontend in the private `backend/private_documents` directory by default in development. Set `DOCUMENT_STORAGE_DIR` to use another path. Production requires this setting and checks that the configured directory already exists and is writable at startup; it will not create or silently fall back to an ephemeral directory. MongoDB stores document metadata only. The authenticated `GET /api/documents`, `GET /api/documents/{document_id}`, and `GET /api/documents/{document_id}/content` endpoints are scoped to the current student.

Text-based PDFs are parsed with `pypdf`; malformed or empty-page PDFs are rejected, while encrypted PDFs are retained with an explicit extraction-failed status and no extracted fields. Only labeled name, institution, qualification, marks, maximum marks, percentage, examination year, and CGPA values are drafted. A percentage is calculated only when explicit marks and a positive maximum are both present; CGPA is never converted using an assumed scale. Missing values remain `null`. Bounded source-line excerpts and the extraction method are returned for review; full document text is not stored in metadata or logged, and no calibrated confidence score is claimed.

Images and scanned PDFs use the local Tesseract OCR engine when it is installed; document contents are not sent to an external OCR service. PDF pages are rendered locally with PyMuPDF. OCR is bounded to 10 pages, 20 megapixels per page/image, and a 12-second Tesseract timeout per page. Install Tesseract on Windows with `winget install --id UB-Mannheim.TesseractOCR --exact`, then restart the backend. The Render build installs `tesseract-ocr`; CI installs it for OCR tests. If the Tesseract executable is unavailable, uploads explicitly report `ocr_not_configured`. Existing unreviewed uploads can be processed again with **Retry local OCR** after the engine is installed. Uploads and student-reviewed extraction fields are never considered institution-verified. After an application is submitted, its assigned documents can be opened and manually marked verified or rejected by the receiving institution; this review does not certify the underlying document. Students can edit the extraction draft and submit it to `POST /api/documents/{document_id}/apply`; only then is the reviewed record added to their profile, and an explicitly reviewed percentage updates the profile score. Uploading alone never changes profile data.

Local file storage is single-host and is not encrypted by the application; use an encrypted private volume and a persistent path appropriate for the deployment. On Render, the blueprint declares a 1 GB disk for the API service at `/var/data/uniapply-documents` and sets `DOCUMENT_STORAGE_DIR` to that exact mount path. Render persistent disks require a paid service plan; the blueprint explicitly selects `starter`, which may incur charges. The disk is attached to one service instance; do not horizontally scale this backend with local disk storage. Before deploying, confirm the selected account/region supports the disk and that Render reports it attached at the configured path. For manual setup, open the backend web service in Render, select a paid plan that supports persistent disks, add a private disk mounted at `/var/data/uniapply-documents`, and set the service environment variable `DOCUMENT_STORAGE_DIR=/var/data/uniapply-documents`. Save/redeploy only after confirming the disk is attached. If the mount is missing or unwritable, production startup fails rather than falling back to local ephemeral storage. Local tests use temporary directories and do not verify persistence across Render restarts or actual disk durability. There is no malware scanning, retention policy, or automatic document deletion yet.

### Eligibility matching

`GET /api/eligibility` compares the authenticated student's saved profile with configured program criteria and returns `eligible`, `ineligible`, `insufficient_data`, or `criteria_unavailable` plus each rule, the available profile value, and an explanation. Criteria that are illustrative or have no explicit hard eligibility rule fail closed as `criteria_unavailable`. The response also lists required document types, uploaded/verified readiness, application mode/cycle/deadline/fee, and `can_apply`. `GET /api/recommendations` remains as a compatibility alias and returns the same eligibility results; it does not report a rank, match score, admission probability, or competitiveness.

The demo in-memory store contains a small, synthetic criteria catalog clearly marked as illustrative. MongoDB starts with no program criteria unless an authorized university account configures them. University accounts can review and replace only their institution's catalog through `GET` and `PUT /api/university/program-criteria`; program IDs are globally unique. Configured rules can cover percentages, reviewed marks normalized to an explicit scale, reviewed qualifications, recorded required subjects, exam-score cutoffs (minimum or maximum), admission year, and explicit category/domicile conditions. Category and domicile are never inferred. Subject scores and intended admission year can be supplied through the profile API/editor. Missing student values produce `insufficient_data`; illustrative, unverified, or rule-free criteria never produce a positive eligibility decision.

These results are guidance only. A `verified` status means only that an authorized university account marked the criteria that way; the application does not independently verify sources or connect to official admissions data. Exam scores are modeled on a 0-100 scale and do not support rank-style cutoffs. If no criteria are configured, the student UI explains that eligibility cannot be assessed.

The separate MHT-CET CAP comparison uses the processed historical cutoff dataset and only compares MHT-CET ranks with State seat-pool rows. If exact branch, city, and round filters return no rows, the response offers only filter relaxations that have matching rows in the dataset; choosing one updates the filters before showing those results. The supplied cutoff data is partial and secondary-unverified, so these comparisons do not predict or guarantee admission.

### Applications and institution review

Students can create and edit direct-application drafts at `/api/applications`, assign only their own typed document uploads, review prefilled applicant details, and submit with explicit consent. Submission rechecks eligibility, ownership, program cycle, and required-document assignment on the server. Each student can create only one application per program and cycle; submission returns a reference ID. Students can track status, respond to requested documents, and withdraw where permitted. External applications are shown only when verified criteria explicitly include a cycle and an HTTPS official application URL; the platform does not invent links or submit data to external sites.

University accounts can see submitted applications only for their provisioned `institution_id`, review documents explicitly attached to those applications, change statuses through the supported workflow, and request required documents. Drafts remain private to the student. Public registration creates student accounts only. Production university accounts must be provisioned by a trusted administrator and include an institution identifier; selecting an institution during public registration is not supported. The bundled demo criteria are synthetic and not application-enabled, so real applications require institution-provided verified criteria, application cycles, requirements, and (for external mode) official HTTPS links.

### Interactive interview practice

Authenticated students can create an owned practice session for a selected program and interview type. Sessions progress from `created` to `in_progress` to `completed`, persist in Demo or MongoDB storage, and expose one unanswered question at a time. Available local-loopback Ollama is used to generate the next question or rubric feedback; malformed model output, timeouts, and unavailable Ollama fall back to clearly labelled deterministic practice prompts. The fallback is never presented as AI-generated.

Video-mode practice provides a browser camera preview on the student's device and speaks each generated question using browser speech synthesis. It is an AI-led practice room, not a live call with another person: video is not recorded, uploaded, or analyzed. Optional voice answers use the browser's speech-recognition service; the resulting submitted text is sent to the backend for practice feedback. Camera access is optional and requires the student's browser permission.

Practice feedback is scored across relevance, clarity, reasoning, and completeness, with evidence copied from the submitted answers. It is subjective practice guidance only and is never used to infer protected traits or admission eligibility. University and other user roles cannot create or read student interview sessions.

### Frontend

```bash
cd frontend
npm install
npm run dev -- --host 0.0.0.0
```

### Tests and CI

The normal test suite uses the explicit in-memory `STORAGE_BACKEND=demo` store and demo/mock AI providers. Run backend tests from an empty temporary working directory so application settings cannot load a project `.env` file:

```powershell
$repo = (Get-Location).Path
$testDir = Join-Path ([System.IO.Path]::GetTempPath()) ("uniapply-pytest-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $testDir | Out-Null
$env:APP_ENV = "development"
$env:STORAGE_BACKEND = "demo"
$env:MONGODB_URI = "mongodb://127.0.0.1:1/uniapply-test-guard"
$env:RUN_OLLAMA_SMOKE = "0"
$env:PYTHONPATH = Join-Path $repo "backend"
Push-Location $testDir
try {
    python -m pytest -q -c (Join-Path $repo "backend\pytest.ini") (Join-Path $repo "backend\tests")
} finally {
    Pop-Location
    Remove-Item -LiteralPath $testDir -Recurse -Force
}
```

Document upload tests generate synthetic PDF and image bytes and use a temporary private storage directory; they do not use applicant documents or a MongoDB database.

Install frontend and mobile dependencies with `npm ci` in each directory. Build the web frontend and check the mobile TypeScript from the project root:

```powershell
$emptyEnvDir = Join-Path ([System.IO.Path]::GetTempPath()) ("uniapply-vite-env-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $emptyEnvDir | Out-Null
try {
    $env:UNIAPPLY_VITE_ENV_DIR = $emptyEnvDir
    $env:VITE_API_BASE_URL = "http://127.0.0.1:8000/api"
    Push-Location frontend
    try { npm ci } finally { Pop-Location }
    Push-Location mobile
    try { npm ci } finally { Pop-Location }
    Push-Location frontend
    try { npm run build } finally { Pop-Location }
    Push-Location mobile
    try { npx tsc --noEmit } finally { Pop-Location }
} finally {
    Remove-Item -LiteralPath $emptyEnvDir -Recurse -Force
}
```

Run the repeatable browser journey with Node.js 22, the backend Python dependencies, and Chrome or Edge installed:

```powershell
node frontend\tests\student-journey.mjs
```

The journey creates a temporary working directory, starts the backend in explicit in-memory demo mode, starts Vite with an empty environment directory, and uses a synthetic loopback Ollama stub. It verifies the backend health reports `storage_backend: demo` before opening Chrome, exercises the student application page's no-verified-data state, then configures only synthetic verified criteria and checks direct submission and the institution-scoped university review portal. All service URLs are checked for loopback hosts; Chrome also blocks external DNS resolution. The script captures service logs on failure and cleans up only its own processes and temporary directory. Set `PYTHON` or `CHROME_PATH` if the required executable is not on `PATH` or in a standard location.

GitHub Actions workflow: [`.github/workflows/ci.yml`](./.github/workflows/ci.yml). It runs backend tests, the frontend build, the mobile TypeScript check, and the Chrome journey using Python 3.13, Node.js 22, locked npm dependencies, and a synthetic AI stub. The browser test itself starts and health-checks its isolated backend before use. The workflow does not use MongoDB, Redis, live Ollama, production credentials, or real applicant data. GitHub Actions logs contain the command output and a final job summary. This workspace has no Git repository, so the workflow is prepared but cannot be run here; it will execute after the project is placed in an authorized GitHub repository.

The live Ollama smoke test is opt-in and excluded from normal CI. Run it separately only with an installed model and Ollama listening on loopback:

```powershell
$env:RUN_OLLAMA_SMOKE = "1"
$env:STORAGE_BACKEND = "demo"
$env:MONGODB_URI = "mongodb://127.0.0.1:1/uniapply-test-guard"
$env:LLM_PROVIDER = "ollama"
$env:OLLAMA_BASE_URL = "http://127.0.0.1:11434"
$env:OLLAMA_MODEL = "llama3.2:3b"
$repo = (Get-Location).Path
$testDir = Join-Path ([System.IO.Path]::GetTempPath()) ("uniapply-ollama-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $testDir | Out-Null
$env:PYTHONPATH = Join-Path $repo "backend"
Push-Location $testDir
try {
    python -m pytest -q -c (Join-Path $repo "backend\pytest.ini") (Join-Path $repo "backend\tests") -k local_ollama_profile_intake_smoke
} finally {
    Pop-Location
    Remove-Item -LiteralPath $testDir -Recurse -Force
    $env:RUN_OLLAMA_SMOKE = $null
}
```

Troubleshooting: install dependencies from the lockfiles with `npm ci`; ensure Python can import `uvicorn`; use `PYTHON` and `CHROME_PATH` to select local executables; and allow loopback port binding. The browser test intentionally fails rather than accepting a non-demo storage backend. Live Ollama tests may skip when the opt-in flag is absent or the local service is unavailable.

### Desktop and mobile clients

See [desktop/README.md](./desktop/README.md) for running the Electron client and [mobile/README.md](./mobile/README.md) for Expo setup and device-specific API URL configuration.

## Highlights

- JWT auth and secure password hashing
- Pydantic-backed API contracts and validation
- Demo data-based recommendation and seat allocation engines
- AI agent workflow stubs compatible with a higher-level orchestration layer
- React dashboard for admissions journey visibility

## Deployment note

`render.yaml` describes an un-deployed Render demo with a FastAPI service and static React site. Review it before authorizing deployment. The backend requires a MongoDB Atlas URI and a strong JWT secret supplied as hosting-platform environment secrets; never put either in frontend/mobile settings. Restrict Atlas network access to the hosting provider's documented outbound addresses or a private network, and use a least-privilege database user. The hosted backend must connect to Atlas, not the MongoDB process on a development computer.

The Render backend sets `APP_ENV=production`: it refuses to start without MongoDB, a non-default JWT secret of at least 32 characters, and an explicit HTTPS CORS origin. Its health endpoint returns HTTP 503 if MongoDB becomes unavailable. Public registration is student-only; a university account for dashboard review must be provisioned through a trusted administrative process.

The local Ollama endpoint is not exposed or reachable from a hosted service. The profile-intake and admission-chat workflows require loopback Ollama and therefore remain unavailable unless Ollama runs beside the backend. Other supported hosted inference requires a server-side provider API key stored in the backend hosting environment or a separately hosted Ollama service reachable over a private network. Do not put provider credentials in web/mobile environment variables.
