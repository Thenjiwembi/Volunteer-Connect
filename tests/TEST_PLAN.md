# Volunteer Connect — CAPACITI Week 6 Test Plan

| Area | Scenario | Expected result | Evidence to capture |
| --- | --- | --- | --- |
| Registration | Valid volunteer signup | Supabase Auth account and volunteer profile are created | Auth user plus profile row |
| Registration | Invalid email, weak password, duplicate email | Clear validation/auth error; no duplicate profile | UI message and Auth result |
| Login/logout | Valid login and logout | Protected dashboard opens; session is cleared on logout | Browser flow |
| Password reset | Existing email reset request | Supabase sends reset email where configured | Auth email/log |
| Profiles | Volunteer updates own phone/location | Only own profile changes; email remains Auth source of truth | Before/after rows |
| Organisation approval | Organisation submits profile | Status is pending; organisation cannot publish | Dashboard and API response |
| Organisation approval | Admin approves/rejects | Status, reviewer, and timestamp update | Admin queue and row |
| Event CRUD | Approved organisation creates/edits/publishes/cancels an event | Valid changes persist and public visibility follows status | Event rows and catalogue |
| Event validation | Past publication, zero capacity, end before start | Write is rejected with a helpful message | Request/response |
| Discovery | Search/category/location/date/places filters | Only matching published events are returned | Catalogue screenshots |
| Applications | Volunteer applies to an eligible event | One pending registration is created | Registration row |
| Duplicate applications | Same volunteer applies twice | Second active application returns 409 | API response |
| Capacity | Applications race for last place | Accepted/attended count never exceeds capacity | Registration count |
| Ownership | Volunteer requests another user's record or organisation edits another's event | 401/403/404 safe response | API response |
| Decisions | Organisation accepts/rejects own applicant | Status changes; unrelated organisation is blocked | Dashboard and row |
| Attendance | Organisation records present/absent | Attendance and attended history update | Registration row |
| Suspension | Suspended user attempts restricted action | 403 and no write | API response and unchanged row |
| Administration | Admin reads stats/users/events and changes account status | Protected admin actions succeed only for admin role | Dashboard and API response |
| Security | Browser request attempts self-assigned admin role or approval status | Role/status cannot be escalated from frontend payload | Profile/organisation row |

Before submission, execute the automated checks with `pnpm test`, `pnpm run check`, and `pnpm run build`, then record the date, Supabase project/environment, actual result, and any defect found. Never replace “not run” with “passed”.
