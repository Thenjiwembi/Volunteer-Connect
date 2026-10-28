import 'dotenv/config'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { createClient } from '@supabase/supabase-js'
import nodemailer from 'nodemailer'
import { getPublicErrorMessage } from './http-errors.js'
import { calculateOrganisationImpact } from './impact.js'
import { scoreOpportunityMatch } from './matching.js'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import {
  profileUpdateSchema,
  organisationSchema,
  eventSchema,
  eventFilterSchema,
  organisationFilterSchema,
  applicationSchema,
  organisationApplicationStatusSchema,
  approvalSchema,
  registrationStatusSchema,
  attendanceSchema,
  accountStatusSchema,
  organisationVerificationReviewSchema,
  verificationFilterSchema,
  verificationDocumentSchema,
  impactFilterSchema,
  attendanceRosterFilterSchema,
  signupSchema,
  adminSignupSchema,
  getAccountAccessFailure,
  canAccessOrganisationReview,
  isOwner,
  canPublish,
  isAllowedEventTransition
} from './validation.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const port = Number(process.env.PORT || 3000)
const supabaseUrl = process.env.SUPABASE_URL
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const hasSupabase = Boolean(supabaseUrl && supabaseAnonKey)
const publicDb = hasSupabase ? createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } }) : null
const adminDb = hasSupabase && serviceRoleKey ? createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } }) : null
const smtpConfigured = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD && process.env.SMTP_FROM)
const mailer = smtpConfigured ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === 'true',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 20000
}) : null

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', 1)
app.use(helmet({
  contentSecurityPolicy: process.env.NODE_ENV === 'production' ? {
    directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'], imgSrc: ["'self'", 'https:', 'data:', 'blob:'],
      connectSrc: ["'self'", 'https://*.supabase.co', 'wss://*.supabase.co']
    }
  } : false,
  crossOriginEmbedderPolicy: false,
  frameguard: process.env.NODE_ENV === 'production' ? { action: 'deny' } : false
}))
app.use(cors((req, callback) => {
  const origin = req.header('Origin')
  if (!origin || process.env.NODE_ENV !== 'production') return callback(null, { origin: true, credentials: true })
  const requestOrigin = `${req.protocol}://${req.get('host')}`
  if (origin === requestOrigin) return callback(null, { origin: true, credentials: true })
  const allowed = (process.env.CLIENT_ORIGIN || '').split(',').map((item) => item.trim()).filter(Boolean)
  if (!allowed.length) return callback(new Error('CLIENT_ORIGIN must be configured in production.'))
  return callback(null, { origin: allowed.includes(origin), credentials: true })
}))
app.use(express.json({ limit: '100kb' }))
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 180, standardHeaders: true, legacyHeaders: false }))

const fail = (message, status = 400, code = 'BAD_REQUEST') => Object.assign(new Error(message), { status, code })
const requireConfigured = (req, _res, next) => {
  if (!hasSupabase) return next(fail('Supabase is not configured. Add the required values from .env.example before using live data.', 503, 'SUPABASE_NOT_CONFIGURED'))
  next()
}
const parseBody = (schema, body) => {
  const result = schema.safeParse(body)
  if (!result.success) throw fail(result.error.issues.map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; '), 400, 'VALIDATION_ERROR')
  return result.data
}
const dbForToken = (token) => createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { Authorization: `Bearer ${token}` } }
})
const privilegedDb = () => adminDb || publicDb

async function loadProfile(db, userId) {
  const { data, error } = await db.from('profiles').select('*').eq('id', userId).single()
  if (error || !data) throw fail('Your account profile could not be loaded.', 403, 'PROFILE_NOT_FOUND')
  return data
}

async function requireAuth(req, _res, next) {
  try {
    if (!hasSupabase) return next(fail('Supabase is not configured. Add the required values from .env.example before using live data.', 503, 'SUPABASE_NOT_CONFIGURED'))
    const header = req.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!token) return next(fail('A valid sign-in session is required.', 401, 'UNAUTHENTICATED'))
    const db = dbForToken(token)
    const { data: userData, error } = await db.auth.getUser(token)
    if (error || !userData.user) return next(fail('Your sign-in session is no longer valid.', 401, 'UNAUTHENTICATED'))
    const profile = await loadProfile(db, userData.user.id)
    req.auth = { token, db, user: userData.user, profile }
    const accessFailure = getAccountAccessFailure(userData.user, profile)
    if (accessFailure && !canAccessOrganisationReview(userData.user, profile)) return next(fail(accessFailure.message, 403, accessFailure.code))
    if (profile.role === 'organisation') {
      const { data: organisation, error: organisationError } = await db.from('organisations').select('approval_status').eq('owner_user_id', profile.id).maybeSingle()
      if (organisationError) return next(fail('Organisation approval could not be verified.', 500, 'ORGANISATION_STATUS_QUERY_FAILED'))
      req.auth.organisationApproved = organisation?.approval_status === 'approved'
    }
    next()
  } catch (error) { next(error) }
}
const requireRole = (...roles) => (req, _res, next) => {
  if (!roles.includes(req.auth?.profile?.role)) return next(fail('You do not have permission to perform this action.', 403, 'FORBIDDEN'))
  next()
}
const requireApprovedOrganisation = (req, _res, next) => {
  if (req.auth?.profile?.role === 'organisation' && !req.auth.organisationApproved) {
    return next(fail('Organisation verification approval is required for this action.', 403, 'ORGANISATION_NOT_APPROVED'))
  }
  next()
}
const sensitiveLimit = rateLimit({ windowMs: 10 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false })
const signupLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false })
const adminInviteCode = process.env.ADMIN_INVITE_CODE || ''

function verifyAdminInvite(code) {
  const expected = Buffer.from(adminInviteCode)
  const provided = Buffer.from(code)
  if (expected.length < 32) {
    throw fail('Administrator registration is disabled. Configure a strong ADMIN_INVITE_CODE on the server.', 503, 'ADMIN_REGISTRATION_DISABLED')
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw fail('The administrator invite code is invalid.', 403, 'INVALID_ADMIN_INVITE')
  }
}

function appUrl() {
  const value = process.env.APP_URL || (process.env.NODE_ENV === 'production'
    ? process.env.RENDER_EXTERNAL_URL || ''
    : 'http://localhost:3000')
  if (!value) throw fail('APP_URL must be configured before account registration is enabled.', 503, 'APP_URL_NOT_CONFIGURED')
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw fail('APP_URL must be a valid absolute URL.', 503, 'APP_URL_INVALID')
  }
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    throw fail('APP_URL must use HTTPS in production.', 503, 'APP_URL_INSECURE')
  }
  return parsed.origin
}

async function sendMail({ to, subject, text }) {
  if (!mailer) throw fail('Email delivery is not configured. Set the SMTP values in .env before using this action.', 503, 'SMTP_NOT_CONFIGURED')
  const result = await mailer.sendMail({ from: process.env.SMTP_FROM, to, subject, text })
  const accepted = (result.accepted || []).some((address) => String(address).toLowerCase() === to.toLowerCase())
  if (!accepted) throw fail('The email provider did not accept the message.', 502, 'EMAIL_NOT_ACCEPTED')
}

async function deleteAuthUser(userId) {
  const { error } = await adminDb.auth.admin.deleteUser(userId)
  if (error) {
    console.error('Supabase could not clean up an incomplete signup:', error.message)
    throw fail('Account setup did not complete. Contact support before retrying.', 500, 'SIGNUP_CLEANUP_FAILED')
  }
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'volunteer-connect-api', supabaseConfigured: hasSupabase, serviceRoleConfigured: Boolean(adminDb) }))
app.get('/api/config', (_req, res) => res.json({
  supabaseUrl: hasSupabase ? supabaseUrl : null,
  supabaseAnonKey: hasSupabase ? supabaseAnonKey : null
}))

app.post('/api/auth/register', signupLimit, requireConfigured, async (req, res, next) => {
  try {
    if (!adminDb) throw fail('Account registration requires SUPABASE_SERVICE_ROLE_KEY.', 503, 'AUTH_ADMIN_NOT_CONFIGURED')
    const values = parseBody(signupSchema, req.body)
    const redirectTo = new URL('/login.html?verified=1', appUrl()).toString()
    const { data, error } = await publicDb.auth.signUp({
      email: values.email,
      password: values.password,
      options: {
        data: { full_name: values.full_name },
        emailRedirectTo: redirectTo
      }
    })
    if (error) {
      console.error('Supabase signup request failed:', error.code || error.status || 'unknown')
      throw fail('Supabase could not start registration. Check the project email-confirmation settings and try again.', 502, 'SIGNUP_PROVIDER_FAILED')
    }
    if (data.user?.identities?.length === 0) {
      return res.status(202).json({
        message: 'If this email can be registered, Supabase will send a verification message. Check your inbox or try signing in.'
      })
    }
    if (!data.user?.id) {
      throw fail('Supabase returned incomplete account details.', 502, 'SIGNUP_PROVIDER_FAILED')
    }
    if (data.session || data.user.email_confirmed_at) {
      await deleteAuthUser(data.user.id)
      throw fail('Email confirmation must be enabled in Supabase before accounts can be registered.', 503, 'EMAIL_CONFIRMATION_REQUIRED')
    }

    const userId = data.user.id
    try {
      const { data: profile, error: profileError } = await adminDb.from('profiles')
        .update({ full_name: values.full_name, role: values.role })
        .eq('id', userId)
        .select('id')
        .single()
      if (profileError || !profile) throw fail('The account profile could not be initialized.', 500, 'SIGNUP_PROFILE_FAILED')

      if (values.role === 'organisation') {
        const org = values.organisation
        const { error: organisationError } = await adminDb.from('organisations').insert({
          owner_user_id: userId,
          name: org.name,
          description: org.description,
          registration_number: org.registration_number || null,
          contact_email: org.contact_email,
          contact_phone: org.contact_phone || null,
          location: org.location,
          website: org.website || null
        })
        if (organisationError) throw fail('The organisation application could not be saved.', 500, 'SIGNUP_ORGANISATION_FAILED')
      }

    } catch (setupError) {
      await deleteAuthUser(userId)
      if (setupError.status) throw setupError
      console.error('Signup setup failed:', setupError.message)
      throw fail('The account could not be completed. Check the Supabase and email configuration, then try again.', 502, 'SIGNUP_SETUP_FAILED')
    }

    res.status(201).json({ message: 'Supabase has sent a verification link to your email. After verifying it, an administrator will review your account.' })
  } catch (error) { next(error) }
})

app.post('/api/auth/register-admin', signupLimit, requireConfigured, async (req, res, next) => {
  let userId
  try {
    if (!adminDb) throw fail('Account registration requires SUPABASE_SERVICE_ROLE_KEY.', 503, 'AUTH_ADMIN_NOT_CONFIGURED')
    const values = parseBody(adminSignupSchema, req.body)
    verifyAdminInvite(values.invite_code)
    const redirectTo = new URL('/admin-login.html?verified=1', appUrl()).toString()
    const { data, error } = await publicDb.auth.signUp({
      email: values.email,
      password: values.password,
      options: {
        data: { full_name: values.full_name },
        emailRedirectTo: redirectTo
      }
    })
    if (error) {
      console.error('Supabase administrator signup request failed:', error.code || error.status || 'unknown')
      throw fail('Supabase could not start registration. Check the project email-confirmation settings and try again.', 502, 'SIGNUP_PROVIDER_FAILED')
    }
    if (data.user?.identities?.length === 0) {
      return res.status(202).json({
        message: 'If this email can be registered, Supabase will send a verification message. Check your inbox or try signing in.'
      })
    }
    if (!data.user?.id) throw fail('Supabase returned incomplete account details.', 502, 'SIGNUP_PROVIDER_FAILED')
    userId = data.user.id
    if (data.session || data.user.email_confirmed_at) {
      await deleteAuthUser(userId)
      userId = undefined
      throw fail('Email confirmation must be enabled in Supabase before accounts can be registered.', 503, 'EMAIL_CONFIRMATION_REQUIRED')
    }

    const { data: profile, error: profileError } = await adminDb.from('profiles')
      .update({
        full_name: values.full_name,
        role: 'admin',
        account_status: 'active',
        approved_at: new Date().toISOString(),
        approved_by: null
      })
      .eq('id', userId)
      .select('id')
      .single()
    if (profileError || !profile) throw fail('The administrator profile could not be initialized.', 500, 'SIGNUP_PROFILE_FAILED')
    userId = undefined
    res.status(201).json({ message: 'Supabase has sent a verification link to your email. Verify it before signing in on the administrator page.' })
  } catch (error) {
    if (userId) {
      try {
        await deleteAuthUser(userId)
      } catch (cleanupError) {
        return next(cleanupError)
      }
    }
    next(error)
  }
})

app.get('/api/events', requireConfigured, requireAuth, async (req, res, next) => {
  try {
    const filters = eventFilterSchema.parse(req.query)
    const db = privilegedDb()
    let query = db.from('events').select('*, organisations!inner(id, name, location, approval_status, profiles!organisations_owner_user_id_fkey(role, account_status)), registrations(status)')
      .eq('status', 'published').eq('organisations.approval_status', 'approved')
      .gte('event_date', new Date().toISOString().slice(0, 10)).order('event_date', { ascending: true }).order('start_time', { ascending: true })
    if (filters.search) query = query.or(`title.ilike.%${filters.search}%,description.ilike.%${filters.search}%`)
    if (filters.category) query = query.eq('category', filters.category)
    if (filters.location) query = query.ilike('location', `%${filters.location}%`)
    if (filters.from) query = query.gte('event_date', filters.from)
    if (filters.to) query = query.lte('event_date', filters.to)
    if (filters.skill) query = query.contains('required_skills', [filters.skill])
    if (filters.participation_type) query = query.eq('participation_type', filters.participation_type)
    const { data, error } = await query
    if (error) throw fail('Events could not be loaded right now.', 500, 'EVENTS_QUERY_FAILED')
    const today = new Date().toISOString().slice(0, 10)
    const events = (data || []).filter((event) => (!adminDb || (
      event.organisations?.profiles?.role === 'organisation'
      && event.organisations?.profiles?.account_status === 'active'
    )) && (!event.application_deadline || event.application_deadline >= today)).map((event) => {
      const accepted = (event.registrations || []).filter((registration) => ['accepted', 'attended'].includes(registration.status)).length
      const { registrations, ...rest } = event
      const organisations = { ...rest.organisations }
      delete organisations.profiles
      return { ...rest, organisations, accepted_count: accepted, available_places: Math.max(event.capacity - accepted, 0) }
    }).filter((event) => filters.available !== 'true' || event.available_places > 0)
    res.json({ events })
  } catch (error) { next(error) }
})

app.get('/api/events/:id', requireConfigured, requireAuth, async (req, res, next) => {
  try {
    if (req.params.id === 'recommended') return next()
    let query = privilegedDb().from('events')
      .select('*, organisations!inner(id, name, description, location, website, approval_status, profiles!organisations_owner_user_id_fkey(role, account_status)), registrations(status)')
      .eq('id', req.params.id).eq('status', 'published').eq('organisations.approval_status', 'approved')
    const { data, error } = await query.single()
    if (error || !data) throw fail('Event not found.', 404, 'NOT_FOUND')
    if (adminDb && (data.organisations?.profiles?.role !== 'organisation' || data.organisations?.profiles?.account_status !== 'active')) {
      throw fail('Event not found.', 404, 'NOT_FOUND')
    }
    const accepted = (data.registrations || []).filter((registration) => ['accepted', 'attended'].includes(registration.status)).length
    const { registrations, ...event } = data
    const organisations = { ...event.organisations }
    delete organisations.profiles
    res.json({ event: { ...event, organisations, accepted_count: accepted, available_places: Math.max(event.capacity - accepted, 0) } })
  } catch (error) { next(error) }
})

app.get('/api/organisations', requireConfigured, requireAuth, async (req, res, next) => {
  try {
    const filters = organisationFilterSchema.parse(req.query)
    const { data, error } = await privilegedDb().from('organisations')
      .select('id, name, description, location, website, image_url')
      .eq('approval_status', 'approved')
      .order('name', { ascending: true })
    if (error) throw fail('Organisations could not be loaded right now.', 500, 'ORGANISATIONS_QUERY_FAILED')
    const search = filters.search?.toLocaleLowerCase()
    const location = filters.location?.toLocaleLowerCase()
    const organisations = (data || []).filter((organisation) => {
      const searchable = `${organisation.name} ${organisation.description || ''} ${organisation.location}`.toLocaleLowerCase()
      return (!search || searchable.includes(search))
        && (!location || organisation.location.toLocaleLowerCase().includes(location))
    })
    res.json({ organisations })
  } catch (error) { next(error) }
})

app.get('/api/organisations/:id', requireConfigured, requireAuth, async (req, res, next) => {
  try {
    if (req.params.id === 'me') return next()
    const { data, error } = await privilegedDb().from('organisations')
      .select('id, name, description, location, website, image_url')
      .eq('id', req.params.id)
      .eq('approval_status', 'approved')
      .maybeSingle()
    if (error || !data) throw fail('Organisation not found.', 404, 'NOT_FOUND')
    res.json({ organisation: data })
  } catch (error) { next(error) }
})

app.use('/api', requireAuth)

app.get('/api/profile/me', (req, res) => res.json({ profile: req.auth.profile, user: { id: req.auth.user.id, email: req.auth.user.email } }))
app.get('/api/events/recommended', requireRole('volunteer'), async (req, res, next) => {
  try {
    const filters = eventFilterSchema.parse(req.query)
    const today = new Date().toISOString().slice(0, 10)
    let query = privilegedDb().from('events')
      .select('*, organisations!inner(id,name,location,approval_status,profiles!organisations_owner_user_id_fkey(role,account_status)), registrations(status)')
      .eq('status', 'published')
      .eq('organisations.approval_status', 'approved')
      .gte('event_date', today)
      .order('event_date', { ascending: true })
      .order('start_time', { ascending: true })
    if (filters.category) query = query.eq('category', filters.category)
    if (filters.location) query = query.ilike('location', `%${filters.location}%`)
    if (filters.from) query = query.gte('event_date', filters.from)
    if (filters.to) query = query.lte('event_date', filters.to)
    if (filters.skill) query = query.contains('required_skills', [filters.skill])
    if (filters.participation_type) query = query.eq('participation_type', filters.participation_type)
    const { data, error } = await query
    if (error) throw fail('Recommended events could not be loaded.', 500, 'RECOMMENDATIONS_QUERY_FAILED')
    const events = (data || []).filter((event) =>
      (!event.application_deadline || event.application_deadline >= today)
      && (!adminDb || (event.organisations?.profiles?.role === 'organisation' && event.organisations?.profiles?.account_status === 'active'))
    ).map((event) => {
      const accepted = (event.registrations || []).filter((registration) => ['accepted', 'attended'].includes(registration.status)).length
      const { registrations, ...rest } = event
      const organisations = { ...rest.organisations }
      delete organisations.profiles
      return {
        ...rest,
        organisations,
        available_places: Math.max(event.capacity - accepted, 0),
        match: scoreOpportunityMatch(req.auth.profile, event)
      }
    }).filter((event) => filters.available !== 'true' || event.available_places > 0)
      .sort((left, right) => right.match.score - left.match.score || left.event_date.localeCompare(right.event_date))
    res.json({ events, incomplete_profile: events.some((event) => event.match.incomplete) })
  } catch (error) { next(error) }
})
app.put('/api/profile/me', sensitiveLimit, async (req, res, next) => {
  try {
    const values = parseBody(profileUpdateSchema, req.body)
    const { data, error } = await req.auth.db.from('profiles').update(values).eq('id', req.auth.profile.id).select('*').single()
    if (error) throw fail('Profile could not be updated.', 500, 'PROFILE_UPDATE_FAILED')
    req.auth.profile = data
    res.json({ profile: data })
  } catch (error) { next(error) }
})

app.post('/api/organisations/:id/applications', sensitiveLimit, requireRole('volunteer'), async (req, res, next) => {
  try {
    const values = parseBody(applicationSchema, req.body)
    const { data, error } = await req.auth.db.rpc('apply_to_organisation', {
      p_organisation_id: req.params.id,
      p_message: values.application_message || null
    })
    if (error) {
      const status = error.code === '23505' ? 409 : error.code === '42501' ? 403 : error.code === 'P0002' ? 404 : 400
      throw fail(error.message || 'Your application could not be submitted.', status, error.code || 'APPLICATION_REJECTED')
    }
    res.status(201).json({ application: data })
  } catch (error) { next(error) }
})
app.get('/api/organisation-applications/me', requireRole('volunteer'), async (req, res, next) => {
  try {
    const { data, error } = await privilegedDb().from('organisation_applications')
      .select('id,organisation_id,volunteer_id,application_message,status,applied_at,updated_at,organisations(id,name,location,website)')
      .eq('volunteer_id', req.auth.profile.id)
      .order('applied_at', { ascending: false })
    if (error) throw fail('Your organisation applications could not be loaded.', 500, 'ORGANISATION_APPLICATIONS_QUERY_FAILED')
    res.json({ applications: data || [] })
  } catch (error) { next(error) }
})
app.get('/api/organisations/me/volunteer-applications', requireRole('organisation'), requireApprovedOrganisation, async (req, res, next) => {
  try {
    const { data, error } = await req.auth.db.rpc('get_organisation_volunteer_applications')
    if (error) throw fail('Volunteer applications could not be loaded.', 500, 'ORGANISATION_APPLICATIONS_QUERY_FAILED')
    const applications = (data || []).map((application) => ({
      ...application,
      profiles: {
        id: application.volunteer_id,
        full_name: application.full_name,
        email: application.email,
        location: application.location,
        skills: application.skills || [],
        interests: application.interests || [],
        preferred_categories: application.preferred_categories || [],
        province: application.province,
        city: application.city,
        service_area: application.service_area,
        available_days: application.available_days || [],
        available_time_start: application.available_time_start,
        available_time_end: application.available_time_end,
        availability_notes: application.availability_notes,
        experience: application.experience,
        participation_type: application.participation_type
      }
    }))
    res.json({ applications })
  } catch (error) { next(error) }
})
app.patch('/api/organisation-applications/:id/status', sensitiveLimit, requireRole('organisation'), requireApprovedOrganisation, async (req, res, next) => {
  try {
    const { status } = parseBody(organisationApplicationStatusSchema, req.body)
    const { data, error } = await req.auth.db.rpc('update_organisation_application_status', {
      p_application_id: req.params.id,
      p_status: status
    })
    if (error) throw fail(error.message || 'Application status could not be updated.', error.code === 'P0001' ? 409 : error.code === 'P0002' ? 404 : 403, error.code || 'APPLICATION_UPDATE_FAILED')
    res.json({ application: data })
  } catch (error) { next(error) }
})
app.patch('/api/organisation-applications/:id/withdraw', sensitiveLimit, requireRole('volunteer'), async (req, res, next) => {
  try {
    const { data, error } = await req.auth.db.rpc('withdraw_organisation_application', { p_application_id: req.params.id })
    if (error) throw fail(error.message || 'This application could not be withdrawn.', error.code === 'P0001' ? 409 : error.code === 'P0002' ? 404 : 403, error.code || 'WITHDRAWAL_FAILED')
    res.json({ application: data })
  } catch (error) { next(error) }
})

app.get('/api/organisations/me', requireRole('organisation'), async (req, res, next) => {
  try {
    const { data, error } = await req.auth.db.from('organisations').select('*').eq('owner_user_id', req.auth.profile.id).maybeSingle()
    if (error) throw fail('Organisation profile could not be loaded.', 500, 'ORGANISATION_QUERY_FAILED')
    res.json({ organisation: data })
  } catch (error) { next(error) }
})
app.post('/api/organisations', sensitiveLimit, requireRole('organisation'), async (req, res, next) => {
  try {
    const values = parseBody(organisationSchema, req.body)
    const { data, error } = await req.auth.db.from('organisations').insert({ ...values, owner_user_id: req.auth.profile.id, approval_status: 'pending' }).select('*').single()
    if (error) throw fail(error.code === '23505' ? 'You already have an organisation profile.' : 'Organisation profile could not be created.', error.code === '23505' ? 409 : 500, 'ORGANISATION_CREATE_FAILED')
    res.status(201).json({ organisation: data })
  } catch (error) { next(error) }
})
app.put('/api/organisations/me', sensitiveLimit, requireRole('organisation'), async (req, res, next) => {
  try {
    const values = parseBody(organisationSchema, req.body)
    const { data, error } = await req.auth.db.from('organisations').update(values).eq('owner_user_id', req.auth.profile.id).select('*').single()
    if (error) throw fail('Organisation profile could not be updated.', 500, 'ORGANISATION_UPDATE_FAILED')
    res.json({ organisation: data })
  } catch (error) { next(error) }
})

app.get('/api/organisations/me/verification', requireRole('organisation'), async (req, res, next) => {
  try {
    const { data: organisation, error } = await req.auth.db.from('organisations')
      .select('id,verification_status,verification_feedback,verification_submitted_at,verification_reviewed_at,province,city,address,service_area')
      .eq('owner_user_id', req.auth.profile.id)
      .maybeSingle()
    if (error || !organisation) throw fail('Organisation verification details could not be loaded.', 500, 'VERIFICATION_QUERY_FAILED')
    const { data: documents, error: documentError } = await req.auth.db.from('organisation_verification_documents')
      .select('id,file_name,content_type,file_size_bytes,created_at,storage_path')
      .eq('organisation_id', organisation.id)
      .order('created_at', { ascending: false })
    if (documentError) throw fail('Verification documents could not be loaded.', 500, 'VERIFICATION_DOCUMENT_QUERY_FAILED')
    const linkedDocuments = await Promise.all((documents || []).map(async (document) => {
      const { storage_path, ...metadata } = document
      const { data, error: signedUrlError } = await req.auth.db.storage.from('verification-documents').createSignedUrl(storage_path, 300)
      return { ...metadata, download_url: signedUrlError ? null : data?.signedUrl || null }
    }))
    res.json({ organisation, documents: linkedDocuments })
  } catch (error) { next(error) }
})

app.post('/api/organisations/me/verification-documents', sensitiveLimit, requireRole('organisation'), express.raw({ type: ['application/pdf', 'image/jpeg', 'image/png'], limit: '10mb' }), async (req, res, next) => {
  try {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw fail('Choose a verification document to upload.', 400, 'DOCUMENT_REQUIRED')
    const contentType = (req.get('Content-Type') || '').split(';')[0].toLowerCase()
    const signatures = {
      'application/pdf': req.body.subarray(0, 5).toString() === '%PDF-',
      'image/jpeg': req.body[0] === 0xff && req.body[1] === 0xd8 && req.body[2] === 0xff,
      'image/png': req.body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    }
    if (!signatures[contentType]) throw fail('The document file type does not match its content.', 400, 'INVALID_DOCUMENT_CONTENT')
    const extension = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' }[contentType]
    const values = parseBody(verificationDocumentSchema, {
      file_name: req.query.file_name,
      content_type: contentType,
      file_size_bytes: req.body.length
    })
    const { data: organisation, error: organisationError } = await req.auth.db.from('organisations')
      .select('id').eq('owner_user_id', req.auth.profile.id).single()
    if (organisationError || !organisation) throw fail('Organisation profile could not be loaded.', 404, 'ORGANISATION_NOT_FOUND')
    const storagePath = `${req.auth.user.id}/${randomUUID()}.${extension}`
    const { error: storageError } = await req.auth.db.storage.from('verification-documents')
      .upload(storagePath, req.body, { contentType, upsert: false })
    if (storageError) throw fail('Verification document could not be uploaded.', 400, 'VERIFICATION_DOCUMENT_UPLOAD_FAILED')
    const { data, error } = await req.auth.db.from('organisation_verification_documents').insert({
      organisation_id: organisation.id,
      uploaded_by: req.auth.user.id,
      storage_path: storagePath,
      ...values
    }).select('id,file_name,content_type,file_size_bytes,created_at').single()
    if (error) {
      await req.auth.db.storage.from('verification-documents').remove([storagePath])
      throw fail('Verification document metadata could not be saved.', 500, 'VERIFICATION_DOCUMENT_SAVE_FAILED')
    }
    res.status(201).json({ document: data })
  } catch (error) { next(error) }
})

app.delete('/api/organisations/me/verification-documents/:id', sensitiveLimit, requireRole('organisation'), async (req, res, next) => {
  try {
    const { data: organisation } = await req.auth.db.from('organisations').select('id').eq('owner_user_id', req.auth.profile.id).single()
    if (!organisation) throw fail('Organisation profile could not be loaded.', 404, 'ORGANISATION_NOT_FOUND')
    const { data: document, error: lookupError } = await req.auth.db.from('organisation_verification_documents')
      .select('id,storage_path').eq('id', req.params.id).eq('organisation_id', organisation.id).maybeSingle()
    if (lookupError || !document) throw fail('Verification document not found.', 404, 'NOT_FOUND')
    const { error: storageError } = await req.auth.db.storage.from('verification-documents').remove([document.storage_path])
    if (storageError) throw fail('Verification document could not be removed from storage.', 500, 'VERIFICATION_DOCUMENT_REMOVE_FAILED')
    const { error } = await req.auth.db.from('organisation_verification_documents').delete().eq('id', document.id)
    if (error) throw fail('Verification document metadata could not be removed.', 500, 'VERIFICATION_DOCUMENT_REMOVE_FAILED')
    res.status(204).end()
  } catch (error) { next(error) }
})

app.post('/api/organisations/me/verification/submit', sensitiveLimit, requireRole('organisation'), async (req, res, next) => {
  try {
    const { data: organisation, error } = await req.auth.db.from('organisations').select('id').eq('owner_user_id', req.auth.profile.id).single()
    if (error || !organisation) throw fail('Organisation profile could not be loaded.', 404, 'ORGANISATION_NOT_FOUND')
    const { data, error: submitError } = await req.auth.db.rpc('submit_organisation_verification', { p_organisation_id: organisation.id })
    if (submitError) throw fail(submitError.message || 'Verification could not be submitted.', submitError.code === 'P0001' ? 409 : submitError.code === 'P0002' ? 404 : 403, submitError.code || 'VERIFICATION_SUBMIT_FAILED')
    res.json({ organisation: data })
  } catch (error) { next(error) }
})

app.get('/api/organisations/me/events', requireRole('organisation'), async (req, res, next) => {
  try {
    const { data: organisation } = await req.auth.db.from('organisations').select('id').eq('owner_user_id', req.auth.profile.id).single()
    if (!organisation) return res.json({ events: [] })
    const { data, error } = await req.auth.db.from('events').select('*').eq('organisation_id', organisation.id).order('event_date', { ascending: true })
    if (error) throw fail('Your events could not be loaded.', 500, 'EVENTS_QUERY_FAILED')
    res.json({ events: data || [] })
  } catch (error) { next(error) }
})

app.post('/api/events', sensitiveLimit, requireRole('organisation'), async (req, res, next) => {
  try {
    const values = parseBody(eventSchema, req.body)
    values.application_deadline = values.application_deadline || null
    const { data: organisation } = await req.auth.db.from('organisations').select('*').eq('owner_user_id', req.auth.profile.id).single()
    if (!organisation) throw fail('Create your organisation profile before creating events.', 409, 'ORGANISATION_REQUIRED')
    if (values.status === 'published' && !canPublish(req.auth.profile, organisation)) throw fail('Your organisation must be approved before publishing events.', 403, 'ORGANISATION_NOT_APPROVED')
    const { data, error } = await req.auth.db.from('events').insert({ ...values, organisation_id: organisation.id }).select('*').single()
    if (error) throw fail('Event could not be created.', 500, 'EVENT_CREATE_FAILED')
    res.status(201).json({ event: data })
  } catch (error) { next(error) }
})
app.put('/api/events/:id', sensitiveLimit, requireRole('organisation'), async (req, res, next) => {
  try {
    const values = parseBody(eventSchema, req.body)
    values.application_deadline = values.application_deadline || null
    const { data: current } = await req.auth.db.from('events').select('*, organisations(*)').eq('id', req.params.id).single()
    if (!current || !isOwner(req.auth.profile, current.organisations)) throw fail('You can only manage your own events.', 403, 'FORBIDDEN')
    if (!isAllowedEventTransition(current.status, values.status)) throw fail(`Events cannot move from ${current.status} to ${values.status}.`, 400, 'INVALID_STATUS_TRANSITION')
    if (values.status === 'published' && !canPublish(req.auth.profile, current.organisations)) throw fail('Your organisation must be approved before publishing events.', 403, 'ORGANISATION_NOT_APPROVED')
    const { data, error } = await req.auth.db.from('events').update(values).eq('id', req.params.id).select('*').single()
    if (error) throw fail('Event could not be updated.', 500, 'EVENT_UPDATE_FAILED')
    res.json({ event: data })
  } catch (error) { next(error) }
})
app.delete('/api/events/:id', sensitiveLimit, requireRole('organisation', 'admin'), async (req, res, next) => {
  try {
    if (req.auth.profile.role === 'organisation') {
      const { data: current } = await req.auth.db.from('events').select('*, organisations(*)').eq('id', req.params.id).single()
      if (!current || !isOwner(req.auth.profile, current.organisations)) throw fail('You can only manage your own events.', 403, 'FORBIDDEN')
    }
    const { error } = await req.auth.db.from('events').delete().eq('id', req.params.id)
    if (error) throw fail('Event could not be deleted.', 500, 'EVENT_DELETE_FAILED')
    res.status(204).end()
  } catch (error) { next(error) }
})

app.post('/api/events/:id/registrations', sensitiveLimit, requireRole('volunteer'), async (req, res, next) => {
  try {
    const values = parseBody(applicationSchema, req.body)
    const { data, error } = await req.auth.db.rpc('apply_to_event', { p_event_id: req.params.id, p_message: values.application_message || null })
    if (error) {
      const status = error.code === '23505' ? 409 : 400
      throw fail(error.message || 'Your application could not be submitted.', status, error.code === '23505' ? 'DUPLICATE_APPLICATION' : 'APPLICATION_REJECTED')
    }
    res.status(201).json({ registration: data })
  } catch (error) { next(error) }
})
app.get('/api/registrations/me', requireRole('volunteer'), async (req, res, next) => {
  try {
    const { data, error } = await privilegedDb().from('registrations')
      .select('id,event_id,volunteer_id,application_message,status,attendance_status,completed_hours,hours_confirmed,applied_at,updated_at,events(id,title,description,category,location,event_date,start_time,end_time,capacity,status,organisations(name))')
      .eq('volunteer_id', req.auth.profile.id).order('applied_at', { ascending: false })
    if (error) throw fail('Your applications could not be loaded.', 500, 'REGISTRATIONS_QUERY_FAILED')
    res.json({ registrations: data || [] })
  } catch (error) { next(error) }
})
app.get('/api/organisations/me/registrations', requireRole('organisation'), requireApprovedOrganisation, async (req, res, next) => {
  try {
    const { data: organisation } = await req.auth.db.from('organisations').select('id').eq('owner_user_id', req.auth.profile.id).single()
    if (!organisation) return res.json({ registrations: [] })
    const { data, error } = await (adminDb || req.auth.db).from('registrations').select('*, profiles(id, full_name, email, location), events!inner(id, title, event_date, location, organisation_id)').eq('events.organisation_id', organisation.id).order('applied_at', { ascending: false })
    if (error) throw fail('Applications could not be loaded.', 500, 'REGISTRATIONS_QUERY_FAILED')
    res.json({ registrations: data || [] })
  } catch (error) { next(error) }
})
app.patch('/api/registrations/:id/status', sensitiveLimit, requireRole('organisation'), requireApprovedOrganisation, async (req, res, next) => {
  try {
    const { status } = parseBody(registrationStatusSchema, req.body)
    const { data, error } = await req.auth.db.rpc('update_registration_status', { p_registration_id: req.params.id, p_status: status })
    if (error) throw fail(error.message || 'Application status could not be updated.', error.code === 'P0001' ? 409 : 403, error.code || 'REGISTRATION_UPDATE_FAILED')
    res.json({ registration: data })
  } catch (error) { next(error) }
})
app.patch('/api/registrations/:id/attendance', sensitiveLimit, requireRole('organisation'), requireApprovedOrganisation, async (req, res, next) => {
  try {
    const values = parseBody(attendanceSchema, req.body)
    const { data, error } = await req.auth.db.rpc('record_registration_attendance', {
      p_registration_id: req.params.id,
      p_attendance_status: values.attendance_status,
      p_completed_hours: values.completed_hours,
      p_hours_confirmed: values.hours_confirmed
    })
    if (error) throw fail(error.message || 'Attendance could not be recorded.', error.code === 'P0001' ? 409 : 403, error.code || 'ATTENDANCE_UPDATE_FAILED')
    res.json({ registration: data })
  } catch (error) { next(error) }
})
app.get('/api/attendance/me', requireRole('volunteer'), async (req, res, next) => {
  try {
    const { data, error } = await privilegedDb().from('registrations')
      .select('id,status,attendance_status,completed_hours,hours_confirmed,attendance_updated_at,events(id,title,category,location,event_date,start_time,end_time,organisations(name))')
      .eq('volunteer_id', req.auth.profile.id)
      .neq('attendance_status', 'not_recorded')
      .order('applied_at', { ascending: false })
    if (error) throw fail('Your attendance history could not be loaded.', 500, 'ATTENDANCE_QUERY_FAILED')
    const history = data || []
    const confirmedHours = history.reduce((total, record) => total + (
      record.attendance_status === 'present' && record.hours_confirmed ? Number(record.completed_hours) : 0
    ), 0)
    res.json({ history, confirmed_hours: confirmedHours })
  } catch (error) { next(error) }
})
app.get('/api/organisations/me/attendance', requireRole('organisation'), requireApprovedOrganisation, async (req, res, next) => {
  try {
    const filters = parseBody(attendanceRosterFilterSchema, req.query)
    const { data: organisation, error: organisationError } = await req.auth.db.from('organisations')
      .select('id').eq('owner_user_id', req.auth.profile.id).single()
    if (organisationError || !organisation) throw fail('Organisation profile could not be loaded.', 404, 'ORGANISATION_NOT_FOUND')
    let eventQuery = req.auth.db.from('events').select('id,title,category,event_date,status')
      .eq('organisation_id', organisation.id)
    if (filters.event_id) eventQuery = eventQuery.eq('id', filters.event_id)
    if (filters.from) eventQuery = eventQuery.gte('event_date', filters.from)
    if (filters.to) eventQuery = eventQuery.lte('event_date', filters.to)
    const { data: events, error: eventsError } = await eventQuery.order('event_date', { ascending: false })
    if (eventsError) throw fail('Organisation events could not be loaded.', 500, 'ATTENDANCE_QUERY_FAILED')
    const eventIds = (events || []).map((item) => item.id)
    if (!eventIds.length) return res.json({ events: events || [], attendance: [] })
    const db = adminDb || req.auth.db
    let attendanceQuery = db.from('registrations')
      .select('id,event_id,volunteer_id,application_message,status,attendance_status,completed_hours,hours_confirmed,attendance_updated_by,attendance_updated_at,profiles(id,full_name,share_with_organisations,skills,interests,preferred_categories,province,city,service_area,available_days,availability_notes,experience,participation_type)')
      .in('event_id', eventIds)
      .in('status', ['accepted', 'attended'])
    if (filters.attendance_status) attendanceQuery = attendanceQuery.eq('attendance_status', filters.attendance_status)
    const { data, error } = await attendanceQuery.order('applied_at', { ascending: true })
    if (error) throw fail('Attendance roster could not be loaded.', 500, 'ATTENDANCE_QUERY_FAILED')
    const editorIds = [...new Set((data || []).map((row) => row.attendance_updated_by).filter(Boolean))]
    let editorNames = new Map()
    if (adminDb && editorIds.length) {
      const { data: editors } = await adminDb.from('profiles').select('id,full_name').in('id', editorIds)
      editorNames = new Map((editors || []).map((editor) => [editor.id, editor.full_name]))
    }
    const eventById = new Map((events || []).map((item) => [item.id, item]))
    const attendance = (data || []).map((row) => {
      const { profiles, ...registration } = row
      const profile = profiles || {}
      const shared = profile.share_with_organisations === true
      return {
        ...registration,
        attendance_updated_by_name: editorNames.get(row.attendance_updated_by) || null,
        volunteer: {
          id: profile.id,
          full_name: profile.full_name,
          ...(shared ? {
            skills: profile.skills || [],
            interests: profile.interests || [],
            preferred_categories: profile.preferred_categories || [],
            province: profile.province,
            city: profile.city,
            service_area: profile.service_area,
            available_days: profile.available_days || [],
            availability_notes: profile.availability_notes,
            experience: profile.experience,
            participation_type: profile.participation_type
          } : {})
        },
        event: eventById.get(row.event_id)
      }
    })
    res.json({ events: events || [], attendance })
  } catch (error) { next(error) }
})
async function loadOrganisationImpact(req, filters) {
  const { data: organisation, error: organisationError } = await req.auth.db.from('organisations')
    .select('id,name').eq('owner_user_id', req.auth.profile.id).single()
  if (organisationError || !organisation) throw fail('Organisation profile could not be loaded.', 404, 'ORGANISATION_NOT_FOUND')

  let eventQuery = req.auth.db.from('events')
    .select('id,title,category,event_date,status,created_at')
    .eq('organisation_id', organisation.id)
    .order('event_date', { ascending: true })
  if (filters.from) eventQuery = eventQuery.gte('event_date', filters.from)
  if (filters.to) eventQuery = eventQuery.lte('event_date', filters.to)
  if (filters.category) eventQuery = eventQuery.eq('category', filters.category)
  const { data: events, error: eventsError } = await eventQuery
  if (eventsError) throw fail('Organisation events could not be loaded for reporting.', 500, 'IMPACT_QUERY_FAILED')
  const eventIds = (events || []).map((event) => event.id)
  let registrations = []
  let organisationApplications = []
  if (eventIds.length) {
    const [registrationResult, applicationResult] = await Promise.all([
      req.auth.db.from('registrations').select('event_id,volunteer_id,status,attendance_status,completed_hours,hours_confirmed,applied_at').in('event_id', eventIds),
      req.auth.db.from('organisation_applications').select('volunteer_id,status,applied_at').eq('organisation_id', organisation.id)
    ])
    if (registrationResult.error || applicationResult.error) throw fail('Organisation applications could not be loaded for reporting.', 500, 'IMPACT_QUERY_FAILED')
    registrations = registrationResult.data || []
    organisationApplications = applicationResult.data || []
  } else {
    const { data, error } = await req.auth.db.from('organisation_applications')
      .select('volunteer_id,status,applied_at').eq('organisation_id', organisation.id)
    if (error) throw fail('Organisation applications could not be loaded for reporting.', 500, 'IMPACT_QUERY_FAILED')
    organisationApplications = data || []
  }

  return calculateOrganisationImpact({
    organisationName: organisation.name,
    events: events || [],
    registrations,
    organisationApplications,
    filters
  })
}

app.get('/api/organisations/me/impact', requireRole('organisation'), requireApprovedOrganisation, async (req, res, next) => {
  try {
    const filters = parseBody(impactFilterSchema, req.query)
    res.json({ impact: await loadOrganisationImpact(req, filters) })
  } catch (error) { next(error) }
})
app.get('/api/organisations/me/impact.csv', requireRole('organisation'), requireApprovedOrganisation, async (req, res, next) => {
  try {
    const filters = parseBody(impactFilterSchema, req.query)
    const report = await loadOrganisationImpact(req, filters)
    const safeCell = (value) => {
      let text = String(value ?? '')
      if (/^[=+\-@]/.test(text)) text = `'${text}`
      return `"${text.replaceAll('"', '""')}"`
    }
    const rows = [
      ['Organisation', report.organisation_name],
      ['Period from', report.period.from || 'All time'],
      ['Period to', report.period.to || 'All time'],
      ['Category', report.period.category || 'All categories'],
      ['Generated at', report.generated_at],
      [],
      ['Metric', 'Value'],
      ...Object.entries(report.totals),
      [],
      ['Month', 'Applications', 'Attendees', 'Confirmed hours', 'Completed events'],
      ...report.monthly.map((row) => [row.month, row.applications, row.attendees, row.confirmed_hours, row.completed_events])
    ]
    res.type('text/csv').set('Content-Disposition', 'attachment; filename="volunteer-connect-impact.csv"')
      .send(rows.map((row) => row.map(safeCell).join(',')).join('\r\n'))
  } catch (error) { next(error) }
})
app.patch('/api/registrations/:id/withdraw', sensitiveLimit, requireRole('volunteer'), async (req, res, next) => {
  try {
    const { data, error } = await req.auth.db.rpc('withdraw_registration', { p_registration_id: req.params.id })
    if (error) throw fail(error.message || 'This application could not be withdrawn.', error.code === 'P0001' ? 409 : 403, error.code || 'WITHDRAWAL_FAILED')
    res.json({ registration: data })
  } catch (error) { next(error) }
})

app.get('/api/admin/dashboard', requireRole('admin'), async (req, res, next) => {
  try {
    const db = req.auth.db
    const [volunteers, organisations, events, pending, applications] = await Promise.all([
      db.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'volunteer'),
      db.from('organisations').select('id', { count: 'exact', head: true }).eq('approval_status', 'approved'),
      db.from('events').select('id', { count: 'exact', head: true }).eq('status', 'published').gte('event_date', new Date().toISOString().slice(0, 10)),
      db.from('profiles').select('id', { count: 'exact', head: true }).eq('account_status', 'pending'),
      db.from('registrations').select('id', { count: 'exact', head: true })
    ])
    const queryError = [volunteers, organisations, events, pending, applications].find((result) => result.error)
    if (queryError) throw fail('Administrator dashboard data could not be loaded.', 500, 'ADMIN_QUERY_FAILED')
    res.json({ stats: { volunteers: volunteers.count || 0, approved_organisations: organisations.count || 0, upcoming_events: events.count || 0, applications: applications.count || 0, pending_accounts: pending.count || 0 } })
  } catch (error) { next(error) }
})
app.get('/api/admin/organisations', requireRole('admin'), async (req, res, next) => {
  try {
    const { data, error } = await req.auth.db.from('organisations').select('*, profiles!organisations_owner_user_id_fkey(full_name, email)').order('created_at', { ascending: false })
    if (error) throw fail('Organisation reviews could not be loaded.', 500, 'ADMIN_QUERY_FAILED')
    res.json({ organisations: data || [] })
  } catch (error) { next(error) }
})
app.get('/api/admin/organisations/verification', requireRole('admin'), async (req, res, next) => {
  try {
    const filters = verificationFilterSchema.parse(req.query)
    let query = req.auth.db.from('organisations')
      .select('*, profiles!organisations_owner_user_id_fkey(full_name,email,email_verified_at)')
      .order('verification_submitted_at', { ascending: false, nullsFirst: false })
    if (filters.status) query = query.eq('verification_status', filters.status)
    const { data, error } = await query
    if (error) throw fail('Organisation verification queue could not be loaded.', 500, 'VERIFICATION_QUEUE_FAILED')
    const search = filters.search?.toLocaleLowerCase()
    const matchingOrganisations = (data || []).filter((organisation) => !search ||
      `${organisation.name} ${organisation.location} ${organisation.contact_email} ${organisation.profiles?.email || ''}`.toLocaleLowerCase().includes(search)
    )
    const organisations = await Promise.all(matchingOrganisations.map(async (organisation) => {
      const { data: documents, error: documentError } = await req.auth.db.from('organisation_verification_documents')
        .select('id,file_name,content_type,file_size_bytes,created_at,storage_path')
        .eq('organisation_id', organisation.id)
        .order('created_at', { ascending: false })
      if (documentError) throw fail('Verification documents could not be loaded.', 500, 'VERIFICATION_DOCUMENT_QUERY_FAILED')
      const linkedDocuments = await Promise.all((documents || []).map(async (document) => {
        const { storage_path, ...metadata } = document
        const { data: signed, error: signedError } = await req.auth.db.storage.from('verification-documents').createSignedUrl(storage_path, 300)
        return { ...metadata, download_url: signedError ? null : signed?.signedUrl || null }
      }))
      const { data: latestReview, error: reviewError } = await req.auth.db.from('organisation_verification_reviews')
        .select('verification_status,feedback,internal_notes,created_at').eq('organisation_id', organisation.id)
        .order('created_at', { ascending: false }).limit(1).maybeSingle()
      if (reviewError) throw fail('Verification review history could not be loaded.', 500, 'VERIFICATION_REVIEW_QUERY_FAILED')
      return { ...organisation, documents: linkedDocuments, latest_review: latestReview }
    }))
    res.json({ organisations })
  } catch (error) { next(error) }
})
app.patch('/api/admin/organisations/:id/verification', sensitiveLimit, requireRole('admin'), async (req, res, next) => {
  try {
    const values = parseBody(organisationVerificationReviewSchema, req.body)
    const { data, error } = await req.auth.db.rpc('review_organisation_verification', {
      p_organisation_id: req.params.id,
      p_status: values.verification_status,
      p_feedback: values.feedback || null,
      p_internal_notes: values.internal_notes || null
    })
    if (error) throw fail(error.message || 'Organisation verification could not be updated.', error.code === '42501' ? 403 : error.code === 'P0002' ? 404 : error.code === 'P0001' ? 409 : 400, error.code || 'VERIFICATION_REVIEW_FAILED')
    res.json({ organisation: data })
  } catch (error) { next(error) }
})
app.patch('/api/admin/organisations/:id/approval', sensitiveLimit, requireRole('admin'), async (req, res, next) => {
  try {
    const { approval_status } = parseBody(approvalSchema, req.body)
    const { data: userRow, error: lookupError } = await req.auth.db.from('organisations')
      .select('id,owner_user_id,profiles!organisations_owner_user_id_fkey(email)').eq('id', req.params.id).maybeSingle()
    if (lookupError) throw fail('Organisation could not be loaded for review.', 500, 'ADMIN_QUERY_FAILED')
    if (!userRow) throw fail('Organisation not found.', 404, 'NOT_FOUND')
    const { data: organisation, error } = await req.auth.db.rpc('review_organisation_verification', {
      p_organisation_id: req.params.id,
      p_status: approval_status,
      p_feedback: approval_status === 'rejected' ? 'Your organisation was not approved. Contact the administrator if you need more information.' : null,
      p_internal_notes: null
    })
    if (error) throw fail(error.message || 'Organisation approval could not be updated.', error.code === '42501' ? 403 : error.code === 'P0001' ? 409 : 500, error.code || 'APPROVAL_UPDATE_FAILED')
    let notificationSent = false
    let notificationMessage = 'Email notification was not sent.'
    try {
      await sendMail({
        to: userRow.profiles.email,
        subject: `Your Volunteer Connect organisation application was ${approval_status}`,
        text: approval_status === 'approved'
          ? 'Your organisation account has been approved. Sign in to manage your Volunteer Connect organisation.'
          : 'Your organisation application was not approved. Contact Volunteer Connect support if you need more information.'
      })
      notificationSent = true
      notificationMessage = 'Email notification sent.'
    } catch (mailError) {
      console.error('Organisation decision email could not be delivered:', mailError.message)
    }
    res.json({ organisation, notification_sent: notificationSent, notification_message: notificationMessage })
  } catch (error) { next(error) }
})
app.get('/api/admin/accounts', requireRole('admin'), async (req, res, next) => {
  try {
    const { data: profiles, error } = await req.auth.db.from('profiles')
      .select('id,full_name,email,role,account_status,email_verified_at,created_at,approved_at')
      .order('created_at', { ascending: false })
    if (error) throw fail('Accounts could not be loaded.', 500, 'ADMIN_QUERY_FAILED')
    const organisationProfiles = (profiles || []).filter((profile) => profile.role === 'organisation')
    let organisations = []
    if (organisationProfiles.length) {
      const { data, error: organisationError } = await req.auth.db.from('organisations')
        .select('id,owner_user_id,name,description,registration_number,contact_email,contact_phone,location,website,approval_status')
        .in('owner_user_id', organisationProfiles.map((profile) => profile.id))
      if (organisationError) throw fail('Organisation applications could not be loaded.', 500, 'ADMIN_QUERY_FAILED')
      organisations = data || []
    }
    const byOwner = new Map(organisations.map((organisation) => [organisation.owner_user_id, organisation]))
    res.json({ accounts: (profiles || []).map((profile) => ({ ...profile, organisation: byOwner.get(profile.id) || null })) })
  } catch (error) { next(error) }
})
app.get('/api/admin/audit', requireRole('admin'), async (req, res, next) => {
  try {
    const { data, error } = await req.auth.db.from('admin_audit_log')
      .select('id,actor_user_id,target_user_id,action,previous_status,next_status,created_at')
      .order('created_at', { ascending: false })
      .limit(100)
    if (error) throw fail('Administrator audit history could not be loaded.', 500, 'ADMIN_AUDIT_QUERY_FAILED')
    const profileIds = [...new Set((data || []).flatMap((entry) => [entry.actor_user_id, entry.target_user_id].filter(Boolean)))]
    let profiles = []
    if (profileIds.length) {
      const { data: profileData, error: profileError } = await req.auth.db.from('profiles')
        .select('id,full_name,email')
        .in('id', profileIds)
      if (profileError) throw fail('Administrator audit participants could not be loaded.', 500, 'ADMIN_AUDIT_QUERY_FAILED')
      profiles = profileData || []
    }
    const byId = new Map(profiles.map((profile) => [profile.id, profile]))
    res.json({
      audit: (data || []).map((entry) => ({
        ...entry,
        actor: byId.get(entry.actor_user_id)?.full_name || 'Administrator',
        target: byId.get(entry.target_user_id)?.full_name || 'Deleted account'
      }))
    })
  } catch (error) { next(error) }
})
app.get('/api/admin/users', requireRole('admin'), async (req, res, next) => {
  try {
    const { data, error } = await req.auth.db.from('profiles').select('id,full_name,email,role,account_status,email_verified_at,created_at,approved_at').order('created_at', { ascending: false })
    if (error) throw fail('Users could not be loaded.', 500, 'ADMIN_QUERY_FAILED')
    res.json({ users: data || [] })
  } catch (error) { next(error) }
})
app.patch('/api/admin/accounts/:id/review', sensitiveLimit, requireRole('admin'), async (req, res, next) => {
  try {
    const { approval_status } = parseBody(approvalSchema, req.body)
    const { data: account } = await req.auth.db.from('profiles').select('role').eq('id', req.params.id).maybeSingle()
    if (account?.role === 'organisation') throw fail('Use the organisation verification review workflow.', 409, 'ORGANISATION_VERIFICATION_REQUIRED')
    const { data: user, error } = await req.auth.db.rpc('review_account', { p_user_id: req.params.id, p_decision: approval_status })
    if (error) throw fail(error.message || 'Account review could not be completed.', error.code === '42501' ? 403 : error.code === 'P0001' ? 409 : 500, error.code || 'ACCOUNT_REVIEW_FAILED')
    let notificationSent = false
    let notificationMessage = 'Email notification was not sent.'
    try {
      await sendMail({
        to: user.email,
        subject: `Your Volunteer Connect account was ${approval_status}`,
        text: approval_status === 'approved'
          ? 'Your Volunteer Connect account has been approved. You can now sign in.'
          : 'Your Volunteer Connect account application was not approved. Contact support if you need more information.'
      })
      notificationSent = true
      notificationMessage = 'Email notification sent.'
    } catch (mailError) {
      console.error('Account decision email could not be delivered:', mailError.message)
    }
    res.json({ user, notification_sent: notificationSent, notification_message: notificationMessage })
  } catch (error) { next(error) }
})
app.patch('/api/admin/users/:id/status', sensitiveLimit, requireRole('admin'), async (req, res, next) => {
  try {
    const { account_status } = parseBody(accountStatusSchema, req.body)
    if (req.params.id === req.auth.profile.id && account_status === 'suspended') throw fail('You cannot suspend your own administrator account.', 400, 'SELF_SUSPENSION_BLOCKED')
    const { data, error } = await req.auth.db.rpc('set_account_suspension', { p_user_id: req.params.id, p_suspend: account_status === 'suspended' })
    if (error) throw fail(error.message || 'Account status could not be updated.', error.code === '42501' ? 403 : error.code === 'P0001' ? 409 : 500, error.code || 'ACCOUNT_UPDATE_FAILED')
    res.json({ user: data })
  } catch (error) { next(error) }
})

app.use('/api', (_req, _res, next) => next(fail('API route not found.', 404, 'NOT_FOUND')))

if (process.env.NODE_ENV !== 'production') {
  const { createServer: createViteServer } = await import('vite')
  const vite = await createViteServer({ root, server: { middlewareMode: true }, appType: 'spa' })
  app.use(vite.middlewares)
} else {
  app.use(express.static(path.join(root, 'dist'), { index: false }))
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) return next()
    const indexFile = path.join(root, 'dist', 'index.html')
    if (req.path === '/' && fs.existsSync(indexFile)) return res.sendFile(indexFile)
    const notFoundFile = path.join(root, 'dist', '404.html')
    if (fs.existsSync(notFoundFile)) return res.status(404).sendFile(notFoundFile)
    next()
  })
}

app.use((error, _req, res, _next) => {
  const status = Number(error.status) || 500
  if (status >= 500) console.error(error)
  res.status(status).json({ error: { code: error.code || 'INTERNAL_ERROR', message: getPublicErrorMessage(error, status) } })
})

app.listen(port, '0.0.0.0', () => console.log(`Volunteer Connect listening on http://0.0.0.0:${port}`))
