# Architecture

## System overview

UniApply-AI uses a shared backend API consumed by a web application, with desktop and mobile clients scaffolded to reuse the same flows. The backend exposes endpoints for authentication, student profile management, document review, recommendations, interview practice, and seat-allocation simulation.

## Runtime components

- Backend API: FastAPI service with routers and validation models
- Agents: modular services that coordinate profile extraction, document normalization, recommendation ranking, interview scoring, and allocation simulation
- Data stores: environment-configurable MongoDB or local in-memory fallback for demo workflows
- Frontend: React dashboard with a single-page admissions funnel

## Multi-agent architecture

1. Profile agent: converts intake chat or structured student responses into normalized profile data.
2. Document agent: validates upload metadata, normalizes marks, and flags extraction uncertainty.
3. Recommendation agent: ranks colleges using academic, preference, and budget criteria.
4. Interview agent: scores mock interview answers and gives actionable feedback.
5. Allocation agent: applies a stable matching-style simulation for seat allocation.

## Security and compliance notes

- Passwords are hashed before persistence.
- JWT authentication protects student and university views.
- OCR and document acceptance are described as normalization, not official verification.
- Demo data is clearly labeled as estimated or practice output.
