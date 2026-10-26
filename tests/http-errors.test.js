import test from 'node:test'
import assert from 'node:assert/strict'
import { getPublicErrorMessage } from '../server/http-errors.js'

test('signup configuration failures have actionable messages without exposing other server errors', () => {
  assert.match(getPublicErrorMessage({ code: 'ADMIN_REGISTRATION_DISABLED', message: 'Configure a strong ADMIN_INVITE_CODE on the server.' }, 503), /ADMIN_INVITE_CODE/)
  assert.match(getPublicErrorMessage({ code: 'APP_URL_NOT_CONFIGURED', message: 'Set APP_URL.' }, 503), /APP_URL/)
  assert.match(getPublicErrorMessage({ code: 'SIGNUP_ORGANISATION_FAILED', message: 'The organisation application could not be saved.' }, 500), /organisation application/)
  assert.equal(getPublicErrorMessage({ code: 'DATABASE_ERROR', message: 'private database details' }, 500), 'Something went wrong on the server.')
})
