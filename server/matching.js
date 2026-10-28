const normalize = (value) => String(value || '').trim().toLocaleLowerCase()
const list = (value) => Array.isArray(value) ? value.map(normalize).filter(Boolean) : []

const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

export function scoreOpportunityMatch(profile, event) {
  const reasons = []
  const missing = []
  let possible = 0
  let earned = 0

  const requiredSkills = list(event.required_skills)
  const volunteerSkills = list(profile.skills)
  if (requiredSkills.length) {
    possible += 30
    const matchedSkills = requiredSkills.filter((skill) => volunteerSkills.includes(skill))
    earned += 30 * matchedSkills.length / requiredSkills.length
    if (matchedSkills.length) reasons.push(`Matches your ${matchedSkills.join(', ')} skills`)
    if (!volunteerSkills.length) missing.push('Add skills to your profile for a better match')
    else if (matchedSkills.length < requiredSkills.length) reasons.push(`${requiredSkills.length - matchedSkills.length} required skill${requiredSkills.length - matchedSkills.length === 1 ? '' : 's'} not listed`)
  }

  const categories = [...list(profile.interests), ...list(profile.preferred_categories)]
  if (categories.length) {
    possible += 25
    const category = normalize(event.category)
    if (categories.includes(category)) {
      earned += 25
      reasons.push(`Matches your interest in ${event.category}`)
    }
  } else {
    missing.push('Add interests or categories to personalize recommendations')
  }

  const locationPreferences = [profile.city, profile.province, profile.service_area, profile.location].map(normalize).filter(Boolean)
  if (event.participation_type !== 'remote' && locationPreferences.length) {
    possible += 20
    const eventLocation = normalize(event.location)
    const matchedLocation = locationPreferences.find((preference) => eventLocation.includes(preference) || preference.includes(eventLocation))
    if (matchedLocation) {
      earned += 20
      reasons.push('Located in your preferred area')
    }
    if (profile.preferred_distance_km !== null && profile.preferred_distance_km !== undefined) {
      missing.push('Travel distance cannot be verified without mapped coordinates')
    }
  } else if (event.participation_type !== 'remote') {
    missing.push('Add your preferred area for location matching')
  }

  const availableDays = list(profile.available_days)
  if (availableDays.length) {
    possible += 10
    const eventDay = dayNames[new Date(`${event.event_date}T12:00:00Z`).getUTCDay()]
    if (availableDays.includes(eventDay)) {
      earned += 10
      reasons.push('Scheduled on a day you are available')
    }
  } else {
    missing.push('Add available days for schedule matching')
  }

  if (profile.available_time_start && profile.available_time_end) {
    possible += 5
    if (event.start_time < profile.available_time_end && event.end_time > profile.available_time_start) {
      earned += 5
      reasons.push('Event time overlaps your availability')
    }
  } else {
    missing.push('Add available times for schedule matching')
  }

  if (profile.participation_type) {
    possible += 10
    if (profile.participation_type === event.participation_type) {
      earned += 10
      reasons.push(`Matches your ${profile.participation_type.replace('_', ' ')} preference`)
    }
  } else {
    missing.push('Add a preferred participation type')
  }

  let score = possible ? Math.round(earned / possible * 100) : 0
  if (event.eligibility) {
    score = Math.min(score, 49)
    reasons.push('Review the organisation’s eligibility requirements')
  }
  if (!reasons.length) reasons.push('Based on the preferences currently in your profile')

  return {
    score,
    reasons,
    missing: [...new Set(missing)],
    incomplete: missing.length > 0 || !possible,
    eligibility_review_required: Boolean(event.eligibility)
  }
}
