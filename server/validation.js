import { z } from 'zod'

const isoDate = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'Enter a valid date.')
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/, 'Enter a valid time.')
const preferenceTags = z.array(z.string().trim().min(2).max(60)).max(40)
const preferredDays = z.array(z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'])).max(7)

export const profileUpdateSchema = z.object({
  full_name: z.string().trim().min(2).max(120),
  phone: z.string().trim().max(40).optional().or(z.literal('')),
  location: z.string().trim().max(120).optional().or(z.literal('')),
  skills: preferenceTags.optional(),
  interests: preferenceTags.optional(),
  preferred_categories: preferenceTags.optional(),
  province: z.string().trim().max(100).optional().or(z.literal('')),
  city: z.string().trim().max(100).optional().or(z.literal('')),
  service_area: z.string().trim().max(160).optional().or(z.literal('')),
  available_days: preferredDays.optional(),
  available_time_start: time.optional().or(z.literal('')).transform((value) => value || null),
  available_time_end: time.optional().or(z.literal('')).transform((value) => value || null),
  availability_notes: z.string().trim().max(500).optional().or(z.literal('')),
  experience: z.string().trim().max(2000).optional().or(z.literal('')),
  participation_type: z.enum(['in_person', 'remote', 'hybrid']).optional().or(z.literal('')).transform((value) => value || null),
  preferred_distance_km: z.coerce.number().min(0).max(500).nullable().optional(),
  share_with_organisations: z.boolean().optional()
}).superRefine((value, ctx) => {
  if (value.available_time_start && value.available_time_end && value.available_time_start >= value.available_time_end) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['available_time_end'], message: 'Availability end time must be later than start time.' })
  }
})

export const volunteerPreferencesSchema = z.object({
  skills: preferenceTags.default([]),
  interests: preferenceTags.default([]),
  preferred_categories: preferenceTags.default([]),
  province: z.string().trim().max(100).optional().or(z.literal('')),
  city: z.string().trim().max(100).optional().or(z.literal('')),
  service_area: z.string().trim().max(160).optional().or(z.literal('')),
  available_days: preferredDays.default([]),
  available_time_start: time.optional().or(z.literal('')),
  available_time_end: time.optional().or(z.literal('')),
  availability_notes: z.string().trim().max(500).optional().or(z.literal('')),
  experience: z.string().trim().max(2000).optional().or(z.literal('')),
  participation_type: z.enum(['in_person', 'remote', 'hybrid']).optional().or(z.literal('')).transform((value) => value || null),
  preferred_distance_km: z.coerce.number().min(0).max(500).nullable().optional(),
  share_with_organisations: z.boolean().default(false)
})

export const organisationSchema = z.object({
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().min(20).max(2000),
  registration_number: z.string().trim().max(80).optional().or(z.literal('')),
  contact_email: z.string().email(),
  contact_phone: z.string().trim().max(40).optional().or(z.literal('')),
  location: z.string().trim().min(2).max(160),
  province: z.string().trim().max(100).optional().or(z.literal('')),
  city: z.string().trim().max(100).optional().or(z.literal('')),
  address: z.string().trim().max(240).optional().or(z.literal('')),
  service_area: z.string().trim().max(160).optional().or(z.literal('')),
  website: z.string().url().optional().or(z.literal('')),
  image_url: z.string().url().refine((value) => value.startsWith('https://'), 'Use a secure HTTPS image URL.').optional().or(z.literal(''))
})

const registrationFields = {
  full_name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(8).max(128)
}

export const signupSchema = z.discriminatedUnion('role', [
  z.object({ ...registrationFields, role: z.literal('volunteer') }),
  z.object({ ...registrationFields, role: z.literal('organisation'), organisation: organisationSchema })
])

export const adminSignupSchema = z.object({
  ...registrationFields,
  invite_code: z.string().min(1).max(256)
})

export const eventSchema = z.object({
  title: z.string().trim().min(5).max(160),
  description: z.string().trim().min(30).max(3000),
  category: z.string().trim().min(2).max(80),
  location: z.string().trim().min(2).max(160),
  event_date: isoDate,
  start_time: time,
  end_time: time,
  capacity: z.coerce.number().int().positive().max(100000),
  required_skills: z.preprocess((value) => typeof value === 'string' ? value.split(',').map((skill) => skill.trim().toLocaleLowerCase()).filter(Boolean) : value, preferenceTags.default([])),
  participation_type: z.enum(['in_person', 'remote', 'hybrid']).default('in_person'),
  eligibility: z.string().trim().max(1000).optional().or(z.literal('')),
  application_deadline: isoDate.nullable().optional().or(z.literal('')).transform((value) => value || null),
  status: z.enum(['draft', 'published', 'cancelled', 'completed'])
}).superRefine((value, ctx) => {
  if (value.end_time <= value.start_time) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['end_time'], message: 'End time must be later than start time.' })
  if (value.status === 'published' && new Date(`${value.event_date}T${value.start_time}`) <= new Date()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['event_date'], message: 'Published events must be in the future.' })
  }
  if (value.application_deadline && value.application_deadline > value.event_date) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['application_deadline'], message: 'The application deadline must be on or before the event date.' })
  }
})

export const eventFilterSchema = z.object({
  search: z.string().trim().max(120).optional(),
  category: z.string().trim().max(80).optional(),
  location: z.string().trim().max(120).optional(),
  skill: z.string().trim().max(60).transform((value) => value.toLocaleLowerCase()).optional(),
  participation_type: z.enum(['in_person', 'remote', 'hybrid']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  available: z.string().optional()
}).superRefine((value, ctx) => {
  if (value.from && value.to && value.from > value.to) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['from'], message: 'Start date must be on or before end date.' })
  }
})

export const organisationFilterSchema = z.object({
  search: z.string().trim().max(120).optional(),
  location: z.string().trim().max(120).optional()
})

export const applicationSchema = z.object({
  application_message: z.string().trim().max(1000).optional().or(z.literal(''))
})

export const organisationApplicationStatusSchema = z.object({ status: z.enum(['accepted', 'rejected']) })
export const approvalSchema = z.object({ approval_status: z.enum(['approved', 'rejected']) })
export const organisationVerificationReviewSchema = z.object({
  verification_status: z.enum(['approved', 'rejected', 'more_information_required']),
  feedback: z.string().trim().max(2000).optional().or(z.literal('')),
  internal_notes: z.string().trim().max(4000).optional().or(z.literal(''))
}).superRefine((value, ctx) => {
  if (value.verification_status !== 'approved' && !value.feedback) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['feedback'], message: 'Add feedback for the organisation.' })
  }
})
export const verificationFilterSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'more_information_required']).optional(),
  search: z.string().trim().max(120).optional()
})
export const verificationDocumentSchema = z.object({
  file_name: z.string().trim().min(1).max(180),
  content_type: z.enum(['application/pdf', 'image/jpeg', 'image/png']),
  file_size_bytes: z.coerce.number().int().min(1).max(10485760)
})
export const registrationStatusSchema = z.object({ status: z.enum(['accepted', 'rejected', 'withdrawn']) })
export const attendanceSchema = z.object({
  attendance_status: z.enum(['present', 'absent', 'excused']),
  completed_hours: z.coerce.number().min(0).max(24).default(0),
  hours_confirmed: z.boolean().default(false)
}).superRefine((value, ctx) => {
  if (value.attendance_status !== 'present' && (value.completed_hours > 0 || value.hours_confirmed)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['completed_hours'], message: 'Only attended volunteers can have confirmed hours.' })
  }
})
export const accountStatusSchema = z.object({ account_status: z.enum(['active', 'suspended']) })
export const impactFilterSchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  category: z.string().trim().max(80).optional()
}).superRefine((value, ctx) => {
  if (value.from && value.to && value.from > value.to) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['from'], message: 'Start date must be on or before end date.' })
  }
})
export const attendanceRosterFilterSchema = z.object({
  event_id: z.string().uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  attendance_status: z.enum(['not_recorded', 'present', 'absent', 'excused']).optional()
}).superRefine((value, ctx) => {
  if (value.from && value.to && value.from > value.to) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['from'], message: 'Start date must be on or before end date.' })
  }
})

export function getAccountAccessFailure(user, profile) {
  if (!user?.email_confirmed_at) return { code: 'EMAIL_NOT_VERIFIED', message: 'Verify your email before signing in.' }
  if (profile?.account_status === 'pending') return { code: 'ACCOUNT_PENDING', message: 'Your account is awaiting administrator approval.' }
  if (profile?.account_status === 'rejected') return { code: 'ACCOUNT_REJECTED', message: 'Your account application was not approved. Contact support for help.' }
  if (profile?.account_status === 'suspended') return { code: 'ACCOUNT_SUSPENDED', message: 'This account is suspended. Contact an administrator for help.' }
  if (profile?.account_status !== 'active') return { code: 'ACCOUNT_INACTIVE', message: 'This account is not active.' }
  return null
}

export function canAccessOrganisationReview(user, profile) {
  return profile?.role === 'organisation'
    && profile?.account_status === 'pending'
    && Boolean(user?.email_confirmed_at)
}

export function isAllowedEventTransition(currentStatus, nextStatus) {
  const transitions = {
    draft: ['draft', 'published', 'cancelled'],
    published: ['published', 'cancelled', 'completed'],
    cancelled: ['cancelled'],
    completed: ['completed']
  }
  return transitions[currentStatus]?.includes(nextStatus) ?? false
}

export function isOwner(profile, organisation) {
  return Boolean(profile?.id && organisation?.owner_user_id === profile.id)
}

export function canPublish(profile, organisation) {
  return profile?.role === 'organisation' && profile?.account_status === 'active' && organisation?.approval_status === 'approved'
}
