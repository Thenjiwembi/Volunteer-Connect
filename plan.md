# Volunteer Connect — Implementation Plan

## Scope and approach

Volunteer Connect is a responsive full-stack web application for volunteers, community organisations, and administrators. The frontend uses separate Vite-built HTML pages with a shared stylesheet and browser Supabase Auth client; Express provides the REST API and Supabase Auth/PostgreSQL is the source of truth. The browser only receives the public Supabase URL/anon key; privileged operations remain server-side and every protected write is checked against the authenticated identity, role, email-verification state, account approval, and ownership.

The build is organised around a small repository boundary in the Express server. It uses Supabase Auth for registration/login/reset flows and PostgreSQL tables, constraints, RPCs, and RLS for durable application data. The SQL migration is repeatable and includes triggers, indexes, RLS policies, a capacity-safe registration function, and seed data that contains no real personal information. When Supabase environment variables are missing, the server remains safe and reports a configuration error for data/auth operations rather than silently using browser storage or fake production data.

## Project structure

- `src/` — shared stylesheet, reusable artwork, and browser-side Supabase Auth client for standalone HTML pages.
- `server/` — Express app, Supabase clients, auth middleware, validation schemas, REST routes, and central error handling.
- `supabase/migrations/` — PostgreSQL schema, constraints, triggers, RLS policies, and safe sample development seed SQL.
- `tests/` — API/security test plan and executable unit tests for pure validation/permission helpers.
- `public/` — route manifest and static metadata.
- `README.md` — setup, architecture, deployment, API, security, and CAPACITI Week 6 testing guidance.

## Delivery stages

1. Schema and relationships: create profiles, organisations, events, registrations, constraints, indexes, RLS, and the capacity-safe registration RPC.
2. Authentication and profiles: wire Supabase Auth, session restoration, registration, login, logout, password reset, protected routes, profile retrieval/update, and server identity validation.
3. Organisation approval: create organisation profile flows, admin review endpoints, approval-state enforcement, and organisation dashboard status.
4. Event CRUD: implement browse/detail/search/filter APIs and organisation-owned event create/update/publish/cancel/delete operations.
5. Registrations and attendance: implement volunteer applications, duplicate and capacity protection, organisation decisions, attendance, withdrawal, and participation statistics.
6. Dashboards and route protection: ship public pages plus volunteer, organisation, and admin dashboards with loading, empty, error, and success states.
7. Validation and security: apply Zod validation, rate limits, secure CORS/headers, RLS, safe errors, and role/ownership checks on every protected endpoint.
8. Tests, docs, and deployment: run the available checks, record actual results, document any environment-dependent checks, and provide safe local/published deployment instructions.

## Design direction

Three candidate directions were considered: Civic Editorial (0.07), Neighbourhood Utility (0.05), and Soft Institutional (0.04). The selected direction is **Civic Editorial**.

- **Design movement:** Contemporary civic editorial design with the warmth of a community noticeboard and the clarity of a trusted public service.
- **Core principles:** Human-first clarity, optimistic momentum, visible trust, and low-friction action.
- **Color philosophy:** Deep ink and teal establish trust and stewardship; marigold highlights signal action and contribution; mist neutrals keep dense operational screens calm and readable.
- **Layout paradigm:** A left-anchored editorial layout with an asymmetric hero, a narrow content rail, and horizontal event lanes instead of generic centered card grids.
- **Signature elements:** A hand-drawn-looking “VC” loop mark, marigold underline accents, and compact status pills that make progress legible.
- **Interaction philosophy:** Every action explains its consequence. Primary actions are bold but not noisy; destructive or irreversible actions require clear confirmation and status feedback.
- **Animation:** Use short 160–220ms ease-out transitions for cards, pills, and navigation; reveal hero copy with a gentle upward fade; avoid looping movement that distracts from forms or dashboards.
- **Typography system:** Use `Inter` for utility and data, with `Newsreader` for editorial display headlines. Headings are tight and expressive; labels are sentence case, never all caps except tiny metadata.
- **Brand essence:** A practical bridge between people who want to help and the organisations doing the work — trustworthy, hopeful, grounded.
- **Brand voice:** Direct, warm, and specific. Example lines: “Find a good next step.” and “Your time can move a neighbourhood forward.”
- **Wordmark & logo:** A compact looped “VC” mark paired with a lowercase wordmark; the loop represents a volunteer handoff from person to project.
- **Signature brand color:** Marigold `#F4C95D`, used sparingly for active actions and moments of human warmth.

## Data and security decisions

The API verifies bearer tokens through Supabase Auth before any protected route proceeds. Role and account status are read from `profiles` and never trusted from public Auth metadata. Signup assigns a server-validated volunteer or organisation role and starts accounts pending. Verified email and separate administrator approval are both required for protected access. The service-role client is used only for account creation and is never sent to the browser. RLS policies provide a second authorization boundary; approval and suspension RPCs enforce administrator access and write audit records.

Registration overbooking is prevented by the `apply_to_event` PostgreSQL function, which locks the event row, counts accepted registrations, validates event state/capacity, and inserts or returns a conflict. Event publication and status transitions are validated in the API and constrained in SQL. Email remains sourced from the authenticated account; the profile email field is not client-editable.

## Serving and environment

The client is served by Vite during development and built to `dist/`. Express serves `/api/*`, health, and the built client in production. `PORT` defaults to 3000. Supabase values are loaded only through environment variables; `.env.example` contains placeholders and `.env` remains ignored. The route manifest is served from `/manus-routes.json` and kept aligned with client routes.
