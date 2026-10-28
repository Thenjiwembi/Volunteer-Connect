# Implementation status

## Delivered in this workspace

- Stage 1: schema, relationships, indexes, triggers, RLS, and capacity-safe registration function are present in `supabase/migrations/001_volunteer_connect.sql`.
- Stage 2: browser Supabase Auth client, registration/login/reset/logout flows, bearer-token API middleware, profile retrieval/update, suspended-account checks, and protected routes are implemented.
- Stage 3: organisation profile submission/editing, admin review queue, approval metadata, and publish gate are implemented.
- Stage 4: public approved-organization directory with search and direct volunteer applications is implemented. Event management and event-based APIs remain available for organizations that use them.
- Stage 5: volunteer applications, duplicate/capacity protection, atomic organisation status decisions, attendance/withdrawal RPCs, and dashboard views are implemented.
- Stage 6: public pages and volunteer/organisation/admin dashboards are implemented with responsive states and role-aware routing.
- Stage 7: Helmet hardening with production CSP/clickjacking protection, fail-closed production CORS, rate limiting, safe errors, Zod validation, non-recursive RLS, RPC-only registration mutations, and ownership checks are implemented.
- Stage 8: automated validation tests, test matrix, README, Dockerfile, seed guidance, and route manifest are present.

## Environment-dependent work still required

- Configure a real Supabase project using `.env`; run the migration and create safe `.test` accounts.
- Execute `pnpm test` and the authenticated integration scenarios in `tests/TEST_PLAN.md` against that configured project.
- Assign the first administrator through a trusted database/operations process; public signup intentionally cannot create admins.
