# Deployment guide

## Render blueprint

`render.yaml` defines the FastAPI API and static Vite frontend. Apply the blueprint only after supplying the
`MONGODB_URI` secret and confirming the account supports paid persistent disks.

- API health check: `/api/health`
- API start command: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- API persistent disk: 1 GB mounted at `/var/data/uniapply-documents`
- Document storage environment: `DOCUMENT_STORAGE_DIR=/var/data/uniapply-documents`
- Frontend build output: `frontend/dist`

The blueprint declaration is not evidence that Render has provisioned or attached the disk.

## Required backend settings

| Variable | Requirement |
| --- | --- |
| `APP_ENV=production` | Required by the blueprint. |
| `MONGODB_URI` | Transaction-capable MongoDB/Atlas connection string supplied as a secret. |
| `MONGODB_DATABASE=uniapply_ai` | Least-privilege database name. |
| `STORAGE_BACKEND=auto` | Never set to `demo` in production. |
| `JWT_SECRET_KEY` | Secret of at least 32 characters; no default value. |
| `CORS_ORIGINS` | Exact HTTPS frontend origin, or comma-separated HTTPS origins. Wildcards are rejected. |
| `DOCUMENT_STORAGE_DIR` | Absolute existing private mount path in production. |
| `LLM_PROVIDER` | `demo`, `ollama`, `openai`, `azure_openai`, or `provider`. |
| `LLM_MODEL` | Backend model name for hosted providers. |
| `LLM_TIMEOUT_SECONDS` | Positive inference timeout, default `30`. |
| `LLM_MAX_RETRIES` | Bounded retry count, default `2`. |
| `OPENAI_API_KEY` | Secret used only for an authorized OpenAI-compatible provider. Leave empty for demo fallback. |
| `OPENAI_BASE_URL` | Optional OpenAI-compatible provider base URL. |

`JWT_SECRET_KEY` is the exact implemented environment name. Do not confuse it with `JWT_SECRET`.

## Hosted AI behavior

- `demo`: deterministic interview fallback only; no external inference.
- `ollama`: loopback Ollama is supported for local profile and interview workflows. Render is not automatically able to reach `localhost:11434`.
- `openai`, `azure_openai`, or `provider`: uses `OPENAI_API_KEY` and optional `OPENAI_BASE_URL`.
- Missing hosted credentials select demo fallback for compatible workflows.
- Profile intake never uses hosted providers or fabricated fallback; it requires loopback Ollama.
- Eligibility and allocation decisions remain deterministic backend computations.

No hosted inference is considered verified until an authorized provider endpoint is tested with synthetic data.

## Frontend and mobile

- `VITE_API_BASE_URL` must be the public API base URL ending in `/api`.
- `EXPO_PUBLIC_API_BASE_URL` must be reachable from the mobile device, emulator or simulator and end in `/api`.
- Neither variable should be committed with credentials.

## Manual deployment checklist

1. Create an Atlas transaction-capable deployment and least-privilege database user.
2. Restrict Atlas network access to the authorized Render network path.
3. Attach the Render disk and verify `/var/data/uniapply-documents` is mounted and writable.
4. Set the MongoDB URI, database name, JWT secret, HTTPS CORS origin and storage path.
5. Configure hosted AI only if an authorized provider and budget decision exist.
6. Deploy the API first and verify `/api/health`.
7. Configure the frontend API URL and verify HTTPS browser requests.
8. Upload a synthetic file and verify metadata, private download and account deletion.
9. Restart or redeploy once, then verify synthetic document persistence only after the real disk is attached.
10. Exercise one synthetic allocation cycle, duplicate submission and stale-cycle conflict.
