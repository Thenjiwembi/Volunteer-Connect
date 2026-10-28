import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateOrganisationImpact } from '../server/impact.js'

const filters = { from: '', to: '', category: '' }

test('impact totals count confirmed attendance and hours from records only', () => {
  const events = [
    { id: 'event-1', event_date: '2026-01-10', status: 'completed', category: 'Community' },
    { id: 'event-2', event_date: '2026-02-10', status: 'published', category: 'Education' }
  ]
  const registrations = [
    { event_id: 'event-1', volunteer_id: 'volunteer-1', status: 'attended', attendance_status: 'present', completed_hours: 3, hours_confirmed: true, applied_at: '2026-01-01' },
    { event_id: 'event-1', volunteer_id: 'volunteer-2', status: 'accepted', attendance_status: 'absent', completed_hours: 0, hours_confirmed: false, applied_at: '2026-01-02' },
    { event_id: 'event-2', volunteer_id: 'volunteer-1', status: 'accepted', attendance_status: 'present', completed_hours: 5, hours_confirmed: false, applied_at: '2026-02-01' },
    { event_id: 'event-2', volunteer_id: 'volunteer-3', status: 'pending', attendance_status: 'not_recorded', completed_hours: 0, hours_confirmed: false, applied_at: '2026-02-02' }
  ]
  const report = calculateOrganisationImpact({
    organisationName: 'Community Works', events, registrations,
    organisationApplications: [{ volunteer_id: 'volunteer-3', status: 'accepted', applied_at: '2026-01-03' }],
    filters,
    generatedAt: '2026-03-01T00:00:00Z'
  })
  assert.equal(report.totals.applications_received, 5)
  assert.equal(report.totals.accepted_applications, 4)
  assert.equal(report.totals.unique_applicants, 3)
  assert.equal(report.totals.completed_events, 1)
  assert.equal(report.totals.unique_attendees, 1)
  assert.equal(report.totals.confirmed_volunteer_hours, 3)
  assert.equal(report.totals.attendance_rate, 67)
  assert.equal(report.totals.acceptance_rate, 80)
})

test('impact rates are null with zero denominator and category reports exclude uncategorised applications', () => {
  const report = calculateOrganisationImpact({
    organisationName: 'Community Works',
    events: [{ id: 'event-1', event_date: '2026-01-10', status: 'published', category: 'Community' }],
    registrations: [],
    organisationApplications: [{ volunteer_id: 'volunteer-1', status: 'pending', applied_at: '2026-01-01' }],
    filters: { ...filters, category: 'Community' }
  })
  assert.equal(report.totals.applications_received, 0)
  assert.equal(report.totals.attendance_rate, null)
  assert.equal(report.totals.acceptance_rate, null)
})
