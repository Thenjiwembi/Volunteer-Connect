import test from 'node:test'
import assert from 'node:assert/strict'
import { scoreOpportunityMatch } from '../server/matching.js'

const event = {
  required_skills: ['first aid', 'driving'],
  category: 'Community',
  location: 'Cape Town',
  event_date: '2026-10-31',
  start_time: '09:00',
  end_time: '12:00',
  participation_type: 'in_person',
  eligibility: ''
}

const profile = {
  skills: ['first aid', 'driving'],
  interests: ['community'],
  city: 'Cape Town',
  available_days: ['saturday'],
  available_time_start: '08:00',
  available_time_end: '13:00',
  participation_type: 'in_person'
}

test('opportunity matching explains full criteria matches', () => {
  const match = scoreOpportunityMatch(profile, event)
  assert.equal(match.score, 100)
  assert.equal(match.incomplete, false)
  assert.equal(match.reasons.length, 6)
})

test('opportunity matching handles missing preferences and eligibility cautiously', () => {
  const match = scoreOpportunityMatch({}, { ...event, eligibility: 'Applicants must be over 18.' })
  assert.equal(match.score, 0)
  assert.equal(match.incomplete, true)
  assert.equal(match.eligibility_review_required, true)
  assert.ok(match.score < 50)
})

test('event eligibility requirements cap unverified match scores', () => {
  const match = scoreOpportunityMatch(profile, { ...event, eligibility: 'Applicants must be over 18.' })
  assert.equal(match.score, 49)
  assert.ok(match.reasons.some((reason) => reason.includes('eligibility')))
})
