const inPeriod = (value, filters) => {
  const date = String(value || '').slice(0, 10)
  return (!filters.from || date >= filters.from) && (!filters.to || date <= filters.to)
}

export function calculateOrganisationImpact({ organisationName, events, registrations, organisationApplications, filters, generatedAt = new Date().toISOString() }) {
  const periodRegistrations = registrations.filter((row) => inPeriod(row.applied_at, filters))
  const periodOrganisationApplications = filters.category
    ? []
    : organisationApplications.filter((row) => inPeriod(row.applied_at, filters))
  const allApplications = [...periodRegistrations, ...periodOrganisationApplications]
  const acceptedApplications = allApplications.filter((row) => ['accepted', 'attended'].includes(row.status))
  const eventById = new Map(events.map((event) => [event.id, event]))
  const today = new Date().toISOString().slice(0, 10)
  const eligibleAttendance = registrations.filter((row) =>
    ['accepted', 'attended'].includes(row.status) && (eventById.get(row.event_id)?.event_date || '') <= today
  )
  const presentAttendance = eligibleAttendance.filter((row) => row.attendance_status === 'present')
  const confirmedHours = registrations.reduce((total, row) => total + (
    row.attendance_status === 'present' && row.hours_confirmed ? Number(row.completed_hours) : 0
  ), 0)
  const monthly = new Map()
  const monthRecord = (month) => {
    if (!monthly.has(month)) monthly.set(month, { month, applications: 0, attendees: 0, confirmed_hours: 0, completed_events: 0 })
    return monthly.get(month)
  }
  for (const application of allApplications) monthRecord(String(application.applied_at).slice(0, 7)).applications += 1
  for (const registration of registrations) {
    const event = eventById.get(registration.event_id)
    if (!event) continue
    const row = monthRecord(event.event_date.slice(0, 7))
    if (registration.attendance_status === 'present') row.attendees += 1
    if (registration.attendance_status === 'present' && registration.hours_confirmed) row.confirmed_hours += Number(registration.completed_hours)
  }
  for (const event of events) {
    if (event.status === 'completed') monthRecord(event.event_date.slice(0, 7)).completed_events += 1
  }
  const categories = new Map()
  for (const event of events) categories.set(event.category, (categories.get(event.category) || 0) + 1)

  return {
    organisation_name: organisationName,
    period: { from: filters.from || null, to: filters.to || null, category: filters.category || null },
    generated_at: generatedAt,
    totals: {
      published_opportunities: events.filter((event) => event.status === 'published').length,
      applications_received: allApplications.length,
      accepted_applications: acceptedApplications.length,
      unique_applicants: new Set(allApplications.map((row) => row.volunteer_id)).size,
      completed_events: events.filter((event) => event.status === 'completed').length,
      unique_attendees: new Set(presentAttendance.map((row) => row.volunteer_id)).size,
      confirmed_volunteer_hours: confirmedHours,
      attendance_rate: eligibleAttendance.length ? Math.round(presentAttendance.length / eligibleAttendance.length * 100) : null,
      acceptance_rate: allApplications.length ? Math.round(acceptedApplications.length / allApplications.length * 100) : null
    },
    monthly: [...monthly.values()].sort((left, right) => left.month.localeCompare(right.month)),
    categories: [...categories.entries()].map(([category, count]) => ({ category, events: count })),
    definitions: {
      accepted_applications: 'Accepted event and organisation applications; this is an application count, not a unique-person count.',
      attendance_rate: 'Present attendance divided by accepted registrations for events on or before today.',
      confirmed_volunteer_hours: 'Sum of hours marked present and explicitly confirmed by the organisation.'
    }
  }
}
