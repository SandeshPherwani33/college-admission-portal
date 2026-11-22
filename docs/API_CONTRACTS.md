# API contracts

## Auth

### POST /api/auth/register

Request body:

```json
{
  "full_name": "Aanya Sharma",
  "email": "aanya@example.com",
  "password": "StrongPassword123!",
  "role": "student"
}
```

Response:

```json
{
  "token": "jwt-token",
  "user": {
    "id": "uuid",
    "full_name": "Aanya Sharma",
    "email": "aanya@example.com",
    "role": "student"
  }
}
```

### POST /api/auth/login

Request body:

```json
{
  "email": "aanya@example.com",
  "password": "StrongPassword123!"
}
```

## Profile

### GET /api/profile

Returns the current student profile and completion status.

### POST /api/profile

Request body includes academic, exam, budget, interests, preferences, and goals.

## Documents

### POST /api/documents/upload

Accepts metadata such as filename, optional file_hash, and extracted normalized fields.

## Recommendations

### GET /api/recommendations

Returns ranked college matches with reasons and estimated competitiveness.

## Interviews

### POST /api/interviews

Starts or updates a mock interview session. Response contains scorecard, strengths, and improvement areas.

## Allocation

### POST /api/allocation/simulate

Students may run a private simulation for their own profile. `preferences` is an ordered list of configured `program_id` values. The response preserves the legacy allocation fields and adds a unique run ID, reproducible input hash, timestamp, algorithm version, preference rank, explanation, and unallocated reason. Students can retrieve only their own result with `GET /api/allocation/runs/{run_id}`; other students receive a not-found response.

### POST /api/university/allocation-runs

University-role accounts must provide an explicit `cycle_id` and a batch of `{student_id, preferences}` entries. The API reads each profile and configured program criteria through the storage abstraction, evaluates eligibility, runs the same simulator, and persists the run. Within a cycle, committed runs reserve seats cumulatively, a student can receive at most one seat, and program criteria are frozen by an input hash. An identical submission is idempotent and returns its existing run; stale concurrent submissions receive HTTP 409 and can be retried against current cycle state. A new cycle ID starts with fresh capacity. `GET /api/university/allocation-runs/{run_id}` is university-role-only.

University program criteria may explicitly define `seat_capacity` and ordered `priority_rules` (academic score or a named exam score, with highest/lowest direction). Missing capacity is unknown and never treated as seats. Category and domicile conditions are applied only when configured in program criteria and are matched only against explicitly supplied profile values. The existing matcher controls eligibility; insufficient data cannot receive a seat.

The versioned `preference-rank-greedy-v1` algorithm processes preferences in declared rank order. Within a program and preference rank, it orders only by that program's configured priority rules; missing priority values sort after recorded values, and student ID breaks remaining ties. Student `/api/allocation/simulate` requests are private previews and do not reserve seats; university cycle runs do reserve capacity in their cycle. The legacy `budget` field is accepted by the student endpoint for compatibility but does not affect eligibility or priority. The allocator is a deterministic greedy simulation, not Gale–Shapley, a stability guarantee, or a globally optimal allocation. Configured capacities and criteria are inputs, not verified admission rules. Every result is simulated and is not an official admission offer.
