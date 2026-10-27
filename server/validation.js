import { z } from 'zod'

const isoDate = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'Enter a valid date.')
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Enter a valid time.')

export const profileUpdateSchema = z.object({
  full_name: z.string().trim().min(2).max(120),
  phone: z.string().trim().max(40).optional().or(z.literal('')),
  location: z.string().trim().max(120).optional().or(z.literal(''))
})

export const organisationSchema = z.object({
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().min(20).max(2000),
  registration_number: z.string().trim().max(80).optional().or(z.literal('')),
  contact_email: z.string().email(),
  contact_phone: z.string().trim().max(40).optional().or(z.literal('')),
  location: z.string().trim().min(2).max(160),
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
  status: z.enum(['draft', 'published', 'cancelled', 'completed'])
}).superRefine((value, ctx) => {
  if (value.end_time <= value.start_time) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['end_time'], message: 'End time must be later than start time.' })
  if (value.status === 'published' && new Date(`${value.event_date}T${value.start_time}`) <= new Date()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['event_date'], message: 'Published events must be in the future.' })
  }
})

export const eventFilterSchema = z.object({
  search: z.string().trim().max(120).optional(),
  category: z.string().trim().max(80).optional(),
  location: z.string().trim().max(120).optional(),
  from: z.string().optional(),
  available: z.string().optional()
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
export const registrationStatusSchema = z.object({ status: z.enum(['accepted', 'rejected', 'withdrawn']) })
export const attendanceSchema = z.object({ attendance_status: z.enum(['present', 'absent', 'not_recorded']) })
export const accountStatusSchema = z.object({ account_status: z.enum(['active', 'suspended']) })

export function getAccountAccessFailure(user, profile) {
  if (!user?.email_confirmed_at) return { code: 'EMAIL_NOT_VERIFIED', message: 'Verify your email before signing in.' }
  if (profile?.account_status === 'pending') return { code: 'ACCOUNT_PENDING', message: 'Your account is awaiting administrator approval.' }
  if (profile?.account_status === 'rejected') return { code: 'ACCOUNT_REJECTED', message: 'Your account application was not approved. Contact support for help.' }
  if (profile?.account_status === 'suspended') return { code: 'ACCOUNT_SUSPENDED', message: 'This account is suspended. Contact an administrator for help.' }
  if (profile?.account_status !== 'active') return { code: 'ACCOUNT_INACTIVE', message: 'This account is not active.' }
  return null
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
