# Audit status and implementation roadmap

This document records the current local audit results. Passing local tests do not establish production readiness or verify external services.

## Verified status

| Area | Status | Evidence and limits |
|---|---|---|
| Backend API and regression suite | PASS | 129 passed, 1 skipped. Tests use isolated demo storage and synthetic data; one upstream Starlette deprecation warning remains. |
| Frontend build and logic tests | PASS | Production build succeeded; 11 logic tests passed. |
| Browser student journey | PASS | 28 checks passed, including application-data export, deletion confirmation, chatbot presence on Interview Practice, and 360px, 768px, and 1280px layouts. |
| Mobile static/build checks | PASS | TypeScript check and Android JavaScript export succeeded; this is not a device or UI end-to-end test. |
| Desktop client | PARTIAL | Dependency audit passed. It is an Electron shell; OS packaging and desktop runtime were not tested. |
| Local Ollama | PASS | The installed `llama3.2:3b` completed a profile-intake smoke test and an authenticated chat request. The browser journey uses a synthetic Ollama service. |
| MongoDB persistence | BLOCKED | No authorized transaction-capable MongoDB deployment was available. Mongo cascade behavior was tested with mocks, not a live database. Local app tests use demo storage. |
| Hosted OpenAI inference | BLOCKED | No provider credentials or authorized hosted endpoint were available. |
| npm dependency audit | PASS | Zero reported vulnerabilities in frontend, mobile, and desktop lockfiles. |
| Python dependency audit | PASS | `pip-audit` reported no known vulnerabilities in `backend/requirements.txt`; `pip check` reported no broken requirements. |
| Python imports and editor diagnostics | PASS | No unresolved imports; Pylance reported hint-level diagnostics only, with no errors or warnings. |
| Mobile UI and production deployment | NOT TESTED | No device/simulator journey or hosted deployment was available. |
| Localization | PARTIAL | Language selection exists; translated coverage is limited. |

## Security and data integrity changes

- Production startup rejects the built-in development JWT signing key.
- Account deletion reports document-cleanup failures instead of claiming success, and the Mongo cascade targets the actual allocation collection within a transaction.
- Account data export includes applications and allocation history.
- The frontend toolchain was upgraded to patched Vite and React plugin releases.
- Uploaded college rows are retained. The source directory contains 732 rows and does not provide verified city, course, application URL, or fee-period details.
- The separate cutoff dataset contains 134 partial, secondary-unverified 2026 records for CAP rounds 3 and 4, only General/Open category. It is labeled historical and is not used to guarantee eligibility or admission.
- No source or data files were removed. Private uploaded document contents were not inspected.

These checks do not constitute a guarantee that the application is free of security vulnerabilities. Production secrets, live database authorization, deployment controls, and external provider configuration still require deployment-specific verification.

## Known limitations and follow-up

1. Configure and verify a transaction-capable MongoDB deployment before using persistent student data in production.
2. Verify production JWT secrets, CORS origins, file-storage permissions, backups, and monitoring in the deployment environment.
3. Run authorized database integration and end-to-end tests against staging without using production student records.
4. Complete mobile device and desktop runtime/package verification.
5. Expand translations and verify language coverage across all pages.
6. Replace or clearly isolate any remaining demo-only workflow behavior before exposing it as a production feature.

## Reproducible checks

See [TESTING.md](./TESTING.md) for the commands used to run backend tests, frontend build and tests, browser journeys, mobile checks, and dependency audits.
