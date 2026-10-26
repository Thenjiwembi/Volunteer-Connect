import test from 'node:test'
import assert from 'node:assert/strict'
import { eventSchema, profileUpdateSchema, organisationSchema, signupSchema, adminSignupSchema, getAccountAccessFailure, canPublish, isAllowedEventTransition } from '../server/validation.js'

test('profile validation accepts a clear profile and rejects a too-short name', () => {
  assert.equal(profileUpdateSchema.safeParse({ full_name: 'Amina Ndlovu', phone: '', location: 'Cape Town' }).success, true)
  assert.equal(profileUpdateSchema.safeParse({ full_name: 'A' }).success, false)
})

test('organisation validation requires a real contact email and meaningful description', () => {
  assert.equal(organisationSchema.safeParse({ name: 'Neighbourhood Pantry', description: 'A community pantry supporting families with weekly food parcels.', contact_email: 'team@example.test', location: 'Cape Town' }).success, true)
  assert.equal(organisationSchema.safeParse({ name: 'Pantry', description: 'Short', contact_email: 'not-an-email', location: '' }).success, false)
})

test('signup validation accepts supported roles and requires organisation review details', () => {
  const shared = { full_name: 'Amina Ndlovu', email: 'AMINA@example.test', password: 'safe-password-1' }
  assert.equal(signupSchema.safeParse({ ...shared, role: 'volunteer' }).success, true)
  const organisation = { name: 'Neighbourhood Pantry', description: 'A community pantry supporting families with weekly food parcels.', contact_email: 'team@example.test', location: 'Cape Town' }
  const result = signupSchema.safeParse({ ...shared, role: 'organisation', organisation })
  assert.equal(result.success, true)
  if (result.success) assert.equal(result.data.email, 'amina@example.test')
  assert.equal(signupSchema.safeParse({ ...shared, role: 'admin' }).success, false)
  assert.equal(signupSchema.safeParse({ ...shared, role: 'organisation' }).success, false)
})

test('administrator signup requires an invite code and valid account details', () => {
  const account = { full_name: 'Amina Ndlovu', email: 'AMINA@example.test', password: 'safe-password-1' }
  assert.equal(adminSignupSchema.safeParse({ ...account, invite_code: 'long-private-invite-code' }).success, true)
  assert.equal(adminSignupSchema.safeParse(account).success, false)
  assert.equal(adminSignupSchema.safeParse({ ...account, invite_code: '' }).success, false)
  assert.equal(signupSchema.safeParse({ ...account, role: 'admin' }).success, false)
})

test('account access requires verified email and administrator approval', () => {
  const verifiedUser = { email_confirmed_at: '2025-01-01T00:00:00Z' }
  assert.equal(getAccountAccessFailure(verifiedUser, { account_status: 'active' }), null)
  assert.equal(getAccountAccessFailure({}, { account_status: 'active' }).code, 'EMAIL_NOT_VERIFIED')
  assert.equal(getAccountAccessFailure(verifiedUser, { account_status: 'pending' }).code, 'ACCOUNT_PENDING')
  assert.equal(getAccountAccessFailure(verifiedUser, { account_status: 'rejected' }).code, 'ACCOUNT_REJECTED')
  assert.equal(getAccountAccessFailure(verifiedUser, { account_status: 'suspended' }).code, 'ACCOUNT_SUSPENDED')
})

test('event validation protects capacity and time ordering', () => {
  const valid = { title: 'Saturday garden repair', description: 'Help restore raised beds and prepare the community garden for the new season.', category: 'Environment', location: 'Cape Town', event_date: '2099-06-14', start_time: '09:00', end_time: '12:00', capacity: 12, status: 'published' }
  assert.equal(eventSchema.safeParse(valid).success, true)
  assert.equal(eventSchema.safeParse({ ...valid, capacity: 0 }).success, false)
  assert.equal(eventSchema.safeParse({ ...valid, start_time: '13:00', end_time: '12:00' }).success, false)
})

test('publication requires an active approved organisation profile', () => {
  const profile = { role: 'organisation', account_status: 'active' }
  assert.equal(canPublish(profile, { approval_status: 'approved' }), true)
  assert.equal(canPublish(profile, { approval_status: 'pending' }), false)
  assert.equal(canPublish({ ...profile, account_status: 'suspended' }, { approval_status: 'approved' }), false)
  assert.equal(canPublish({ role: 'volunteer', account_status: 'active' }, { approval_status: 'approved' }), false)
})

test('event status transitions follow the lifecycle', () => {
  assert.equal(isAllowedEventTransition('draft', 'published'), true)
  assert.equal(isAllowedEventTransition('published', 'completed'), true)
  assert.equal(isAllowedEventTransition('completed', 'draft'), false)
  assert.equal(isAllowedEventTransition('cancelled', 'published'), false)
})
