const publicServerErrorCodes = new Set([
  'SUPABASE_NOT_CONFIGURED',
  'AUTH_ADMIN_NOT_CONFIGURED',
  'APP_URL_NOT_CONFIGURED',
  'APP_URL_INVALID',
  'APP_URL_INSECURE',
  'ADMIN_REGISTRATION_DISABLED',
  'EMAIL_CONFIRMATION_REQUIRED',
  'SIGNUP_PROVIDER_FAILED',
  'SIGNUP_PROFILE_FAILED',
  'SIGNUP_ORGANISATION_FAILED',
  'SIGNUP_SETUP_FAILED',
  'SIGNUP_CLEANUP_FAILED'
])

export function getPublicErrorMessage(error, status) {
  if (status < 500 || publicServerErrorCodes.has(error.code)) return error.message
  return 'Something went wrong on the server.'
}
