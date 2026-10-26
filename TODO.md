# Volunteer Connect — Delivery Checklist

## 1. Secure foundation and data model

- [ ] The project uses React with Vite, Node.js with Express, Supabase Auth, and Supabase PostgreSQL through environment variables.
- [ ] `.env` is ignored and `.env.example` contains placeholders only; no service-role key, database password, or private credential is exposed to frontend code.
- [ ] The PostgreSQL schema includes `profiles`, `organisations`, `events`, and `registrations` with UUID keys, foreign keys, required fields, timestamps, constraints, indexes, and consistent timestamp handling.
- [ ] `registrations` has a unique `(event_id, volunteer_id)` constraint, indexed event date/status/organisation/volunteer/registration fields, and a database-side capacity-safe application operation.
- [ ] RLS policies allow users to access only permitted records and prevent unauthorised approval-status, role, ownership, or cross-user changes.

## 2. Authentication, profiles, and account status

- [ ] Volunteers and organisations can register and log in through Supabase Auth; logout, email verification where supported, and password reset are provided.
- [ ] Protected frontend routes and Express authentication middleware validate the authenticated Supabase identity and role before access.
- [ ] New public registrations cannot assign themselves administrator privileges or alter role/account status; suspended accounts cannot perform restricted operations.
- [ ] Users can retrieve and update only their own profile; profile email is sourced from the authenticated account and is not client-editable.
- [ ] Authentication and sensitive endpoints have rate limiting, secure CORS, safe errors, and no internal stack traces or credentials in responses.

## 3. Organisation approval workflow

- [ ] Organisation users can create/edit an organisation profile and submit it for administrator approval.
- [ ] Administrators can review, approve, or reject organisations; approval metadata records the reviewer and review time.
- [ ] Unapproved organisations cannot publish public events, and approval status cannot be changed by unauthorised users.
- [ ] An organisation can access and manage only its own profile, events, applications, attendance, and participation statistics.

## 4. Event discovery and CRUD

- [ ] Public users can browse approved, published volunteering events and view event details.
- [ ] Event discovery supports search and filters for category, location, date, and available places.
- [ ] Approved organisations can create, edit, publish, cancel, complete, and delete their own events only.
- [ ] Backend validation enforces required fields, positive capacity, valid dates, future dates for newly published events, end time after start time, and valid status transitions.
- [ ] Event listings expose loading, empty, error, and success states without non-functional buttons.

## 5. Volunteer applications and attendance

- [ ] Volunteers can apply to eligible published events, see their own application statuses, withdraw when permitted, and view volunteering history and attendance.
- [ ] Applications cannot target cancelled, completed, unpublished, or unavailable events; duplicate applications return a suitable conflict response.
- [ ] Capacity cannot be exceeded under concurrent applications; accepted registrations are counted safely in the database operation.
- [ ] Organisations can view applications for their own events, accept or reject applicants, and record present/absent attendance for accepted volunteers.
- [ ] Registrations and attendance are protected from cross-user and cross-organisation access.

## 6. Role-based interfaces

- [ ] Public pages include Home, Browse Events, Event Details, About Us, How It Works, Organisation Registration, Volunteer Registration, Login, and Contact.
- [ ] Volunteer dashboard includes welcome/profile management, recommended or upcoming events, My Applications, application status indicators, volunteering history, and attendance records.
- [ ] Organisation dashboard includes profile/approval status, event creation, event management, applications, decisions, attendance management, and participation statistics.
- [ ] Administrator dashboard includes platform statistics, pending organisation approvals, user management, event management, organisation review details, search, filters, and pagination where appropriate.
- [ ] Role permissions are enforced in both UI navigation and backend/database authorization, not only by hiding links.

## 7. Testing, documentation, and delivery

- [ ] Tests cover registration, login/logout, profiles, event CRUD, applications, duplicate registrations, overbooking, organisation approval, role restrictions, cross-user record access, invalid data, and suspended accounts.
- [ ] Test documentation distinguishes executed checks from environment-dependent checks and does not claim unexecuted tests passed.
- [ ] README documents architecture, relationships, authentication, authorisation, API endpoints, setup, environment variables, migrations, safe sample data, local running, and deployment.
- [ ] The route manifest matches all application page routes and the project has a working health endpoint.
- [ ] The application builds and starts on the configured runtime port with no actionable TypeScript/JavaScript diagnostics.
