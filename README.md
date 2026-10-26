# Volunteer Connect

Volunteer Connect is a full-stack volunteer management platform for volunteers, community organisations, and administrators. It demonstrates the CAPACITI Week 6 requirements: relational data modelling, authentication, authorisation, CRUD operations, role-based access control, validation, secure API design, and responsible handling of personal information.

## What is implemented

The frontend is made of separate HTML pages with a shared stylesheet at `src/styles.css`; it does not use React. Vite builds each HTML page as a separate document, and the Express server continues to provide the REST API. Supabase PostgreSQL owns profiles, organisations, events, registrations, indexes, constraints, triggers, RLS policies, and transaction-safe database functions.

The standalone pages include the home page, event catalogue and detail view, About, How It Works, Contact, volunteer and organisation registration, login/password reset, role-specific dashboards, and a not-found page. Supabase Auth powers signup, email verification, sign-in, password reset, and logout. The Express API enforces verified email, account approval, role, and organisation approval before serving protected data. Admins can review applications, suspend/reactivate accounts, and view the audit trail.

## Stack and structure

| Area | Choice |
| --- | --- |
| Frontend | Standalone HTML pages, Vite, shared responsive CSS |
| Backend | Node.js, Express 5, Helmet, CORS, rate limiting, Zod, Nodemailer |
| Auth and database | Supabase Auth, Supabase PostgreSQL, PostgreSQL RLS |
| Runtime | Express serves Vite middleware in development and `dist/` in production |
| Tests | Node's built-in test runner for validation and permission helpers |

The HTML documents live at the project root (for example `index.html`, `events.html`, and `dashboard-volunteer.html`); they all link to `src/styles.css`. `server/` contains the API and middleware, `supabase/migrations/` contains the schema and RLS, `supabase/seed.sql` contains safe development seed guidance, `tests/` contains executable checks, and `public/manus-routes.json` contains the page route manifest.

## Database relationships and security

`profiles.id` references `auth.users.id` and stores the non-secret application role, account status, email-verification timestamp, and approval metadata. A single organisation belongs to an owner profile. Events belong to organisations. Registrations join volunteers to events with a unique event/volunteer constraint. The schema includes indexes for dates, statuses, ownership, and registration lookups, plus UTC timestamps and update triggers.

New Auth users are copied into `profiles` by a security-definer trigger with a fixed volunteer role and pending account status; user-controlled Auth metadata is not trusted for role assignment. Signup role selection is validated by the server, which uses the Supabase service key to assign the role and save organisation details. The service key is never sent to the browser. The user must verify their email and then receive separate administrator approval before protected access. Administrator access must be assigned by a trusted operator and cannot be self-selected.

The API validates each Supabase bearer token and checks email verification, active account status, role, and organisation approval before protected requests. The approval RPCs require an active administrator and verified target email, write account status and organisation approval atomically, and insert administrator audit records. The forward migration returns all existing active non-admin accounts to pending so they receive an explicit review under the new policy; existing suspended accounts remain suspended. RLS blocks direct client changes to account roles/statuses and organisation approval fields; critical changes are only possible through administrator-only RPCs. Supabase Auth sends signup verification and password-reset emails. App SMTP credentials are optional and are used only for administrator decision-notification emails. Configure Supabase Auth email confirmation and redirect URLs for the deployed origin.

The `apply_to_event` function locks the target event row, checks that it is published and in the future, rejects duplicate active applications, counts accepted/attended registrations, and inserts or reopens an application without exceeding capacity. `update_registration_status` uses the same locked event-row pattern for atomic accept/reject decisions, while `record_registration_attendance` requires an accepted volunteer and an event date that has arrived. `withdraw_registration` is the only volunteer withdrawal path. These security-definer RPCs are granted to authenticated users while direct registration table inserts/updates have no client RLS policy, preserving database-side protection against forged status changes and concurrent overbooking.

## Local setup

1. Create a Supabase project. Configure Auth email verification and add `http://localhost:3000/login.html` and `http://localhost:3000/reset-password.html` to the allowed redirect URLs. Replace localhost with the production origin when deploying.
2. Copy `.env.example` to `.env`. Set the server-side `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` values from Supabase. The app supplies only the public URL and anon key to the browser through `GET /api/config`; alternatively, set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` when building a static client. Never put the service-role key in a `VITE_` variable. Set `APP_URL` to the public app origin.
3. Enable email confirmation in Supabase Auth and configure its email provider/SMTP. This is required for signup verification and password-reset delivery. Optionally configure the app SMTP settings for administrator approval/rejection notification emails; without these, account decisions still save and the dashboard indicates that an email was not sent.
4. To create a fresh database in one step, run `supabase/schema.sql` in the Supabase SQL Editor. Alternatively, apply `supabase/migrations/001_volunteer_connect.sql`, `supabase/migrations/002_account_rejection_status.sql`, and `supabase/migrations/003_secure_auth_approval.sql` in order. The schema file is for a new project only; do not run it on an existing installation. For development seed data only, create verified Auth users using the two `.test` addresses documented in `supabase/seed.sql`, then run that seed file. It assigns demo roles and active state; do not run it in production.
5. Install and run the standalone pages:

```bash
corepack enable
pnpm install
pnpm run dev
```

The pages run on `http://localhost:3000`. Use the `.html` links to navigate between documents. The health endpoint is `GET /api/health`; it reports whether Supabase values are present without revealing any secret. The project also serves `GET /manus-routes.json` for route-aware Preview tooling. Auth pages must be served by the app (not opened as `file://`) because browser authentication requires the public config endpoint and same-origin API.

### Administrator registration

Set `ADMIN_INVITE_CODE` in the server's private `.env` to a unique random value of at least 32 characters. Share it only with the person being authorized, through a secure channel. From `/login.html`, choose **Register an admin profile**, enter the invite code and account details, then verify the email before signing in at `/admin-login.html`. The server checks the invite code and assigns the administrator role; it is never sent to the browser or stored in the database. Rotate the invite code in `.env` and restart the server after each registration. Do not use a public or committed invite code. If no invite code is configured, administrator registration is disabled.

## REST API

Public endpoints are `GET /api/health`, `GET /api/config` (public Supabase URL and anon key only), `POST /api/auth/register`, `GET /api/events`, and `GET /api/events/:id`. Authenticated profile endpoints are `GET /api/profile/me` and `PUT /api/profile/me`. Organisation endpoints are `POST /api/organisations`, `GET /api/organisations/me`, `PUT /api/organisations/me`, and `GET /api/organisations/me/events`. Event management uses `POST /api/events`, `PUT /api/events/:id`, and `DELETE /api/events/:id`. Volunteer applications use `POST /api/events/:id/registrations`, `GET /api/registrations/me`, and `PATCH /api/registrations/:id/withdraw`. Organisation application management uses `GET /api/organisations/me/registrations`, `PATCH /api/registrations/:id/status`, and `PATCH /api/registrations/:id/attendance`. Administrators use `GET /api/admin/dashboard`, `GET /api/admin/accounts`, `PATCH /api/admin/accounts/:id/review`, `GET /api/admin/audit`, `GET /api/admin/users`, and `PATCH /api/admin/users/:id/status`.

Protected calls use `Authorization: Bearer <supabase access token>`. Responses use standard status codes including 200, 201, 204, 400, 401, 403, 404, 409, 500, and 503 when external Supabase configuration is missing. Server error responses use a stable code and safe message; stack traces are only logged server-side.

## Testing and actual results

The current executed checks are:

```text
pnpm run check   PASS — Node syntax checks for server/index.js, server/validation.js, and src/auth.js
pnpm run build   PASS — separate HTML documents and shared CSS generated in dist/
pnpm test       PASS — 7 pure validation/permission tests executed in this workspace
GET /api/health PASS — HTTP 200; reports configuration state without secrets
GET /manus-routes.json PASS — HTTP 200; valid JSON route manifest
GET /api/events without Supabase PASS — safe HTTP 503 configuration response; no mock data returned
```

Run the executable validation tests with `pnpm test`. They cover signup role/details validation, verified-email and approval gates, profile and organisation data, event capacity/time rules, and the rule that only active approved organisations may publish. A configured Supabase project should additionally be tested manually or through an authenticated integration test matrix covering Supabase email delivery, verification, account approval/rejection, login/logout, password reset, admin audit records, cross-user RLS access, event and application operations, and suspend/reactivate permissions.

## Safe deployment

Build the static client with `pnpm run build`, then run the container with `docker build -t volunteer-connect .` and `docker run --env-file .env -p 3000:3000 volunteer-connect`. The Docker image builds the client and starts the Express server; it reads Supabase credentials at runtime. Configure the deployment health check to `GET /api/health` and set `PORT` if the hosting provider supplies one. In a published environment, set `NODE_ENV=production`, use exact `CLIENT_ORIGIN` values for any cross-origin clients (same-origin requests are allowed automatically), enable Supabase email verification, configure the Supabase redirect URLs for the deployed origin, and rotate any key that has been accidentally exposed. Do not allow broad CORS origins in production.

## CAPACITI Week 6 evidence checklist

Demonstrate the schema and relationships in the Supabase table editor and migration file; show Auth users and profile trigger behaviour; show volunteer and organisation signup; show that an unapproved organisation cannot publish; show event CRUD and filters; show a volunteer application, duplicate rejection, acceptance, attendance, and history; show that one organisation cannot edit another's records; show the protected admin dashboard and approval queue; show suspended-account blocking; and attach the executed `pnpm run check`, `pnpm run build`, `pnpm test`, health, and route-manifest outputs. Keep screenshots or exported logs from the configured environment as assessment evidence, and distinguish those from the checks already executed in this workspace.
