import { createClient } from '@supabase/supabase-js'

const config = import.meta.env
const configuredSupabaseUrl = config.VITE_SUPABASE_URL
const configuredSupabaseAnonKey = config.VITE_SUPABASE_ANON_KEY
let supabase = configuredSupabaseUrl && configuredSupabaseAnonKey
  ? createClient(configuredSupabaseUrl, configuredSupabaseAnonKey, { auth: { detectSessionInUrl: true, persistSession: true, autoRefreshToken: true } })
  : null

const dashboardPaths = {
  volunteer: '/dashboard-volunteer.html',
  organisation: '/dashboard-organisation.html',
  admin: '/dashboard-admin.html'
}
const protectedPagePaths = ['/events.html', '/organisation-details.html', '/event-details.html', ...Object.values(dashboardPaths)]

function requestedDestination() {
  const requested = new URLSearchParams(window.location.search).get('next')
  if (!requested) return null
  try {
    const destination = new URL(requested, window.location.origin)
    const allowedPaths = ['/events.html', '/organisation-details.html', '/event-details.html', ...Object.values(dashboardPaths)]
    if (destination.origin !== window.location.origin || !allowedPaths.includes(destination.pathname)) return null
    return `${destination.pathname}${destination.search}${destination.hash}`
  } catch {
    return null
  }
}

function destinationForRole(role) {
  if (!dashboardPaths[role]) return null
  const requested = requestedDestination()
  if (!requested) return dashboardPaths[role]
  const path = new URL(requested, window.location.origin).pathname
  const requestedRole = Object.entries(dashboardPaths).find(([, dashboardPath]) => dashboardPath === path)?.[0]
  if (requestedRole && requestedRole !== role) {
    sessionStorage.setItem('auth-notice', 'That page is not available to your account. You have been taken to your dashboard.')
    return dashboardPaths[role]
  }
  return requested
}

function showMessage(message, type = 'info') {
  const target = document.querySelector('[data-auth-message]')
  if (!target) return
  target.textContent = message
  target.className = `notice notice-${type}`
  target.hidden = false
}

function showDashboardMessage(message, type = 'info') {
  const target = document.querySelector('[data-dashboard-message]')
  if (!target) return
  target.textContent = message
  target.className = `notice notice-${type}`
  target.hidden = false
}

function requireSupabase() {
  if (!supabase) throw new Error('Authentication is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env, then restart the server.')
  return supabase
}

export async function getAccessToken() {
  const { data, error } = await requireSupabase().auth.getSession()
  if (error) throw new Error('Your sign-in session could not be checked. Please sign in again.')
  if (!data.session?.access_token) throw new Error('Sign in to access this page.')
  return data.session.access_token
}

async function apiRequest(path, options = {}) {
  const client = requireSupabase()
  const { data: { session } } = await client.auth.getSession()
  if (!session?.access_token) throw new Error('Your sign-in session has expired. Please log in again.')
  const response = await fetch(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers
    }
  })
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.error?.message || 'The request could not be completed.')
  return payload
}

async function fetchJson(path) {
  const response = await apiRequest(path)
  return response
}

function dashboardForRole(role) {
  const target = destinationForRole(role)
  if (!target) throw new Error('This account does not have a supported dashboard role.')
  window.location.assign(target)
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries())
}

function setBusy(form, busy) {
  const button = form.querySelector('[type="submit"]')
  if (button) button.disabled = busy
}

async function handleLogin(form) {
  const client = requireSupabase()
  const values = formData(form)
  const { data, error } = await client.auth.signInWithPassword({ email: values.email, password: values.password })
  if (error) throw error
  try {
    const result = await apiRequest('/api/profile/me')
    const requiredRole = form.dataset.authRole
    if (requiredRole && result.profile.role !== requiredRole) {
      throw new Error('This sign-in is for administrator accounts only.')
    }
    dashboardForRole(result.profile.role)
  } catch (accessError) {
    await client.auth.signOut()
    throw accessError
  }
  if (!data.session) throw new Error('Sign-in did not return a session. Please try again.')
}

async function handleRegistration(form, role) {
  const values = formData(form)
  const body = { full_name: values.full_name, email: values.email, password: values.password, role }
  if (role === 'organisation') {
    body.organisation = {
      name: values.organisation_name,
      description: values.description,
      registration_number: values.registration_number,
      contact_email: values.contact_email,
      contact_phone: values.contact_phone,
      location: values.location,
      website: values.website,
      image_url: values.image_url
    }
  }
  const response = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.error?.message || 'Your account could not be created.')
  showMessage(payload.message, 'success')
  form.reset()
}

async function handleAdminRegistration(form) {
  const response = await fetch('/api/auth/register-admin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(formData(form))
  })
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.error?.message || 'The administrator account could not be created.')
  showMessage(payload.message, 'success')
  form.reset()
}

async function handlePasswordReset(form) {
  const client = requireSupabase()
  const { error } = await client.auth.resetPasswordForEmail(formData(form).email, {
    redirectTo: `${window.location.origin}/reset-password.html`
  })
  if (error) throw error
  showMessage('If an account exists for that email, a password reset link will arrive shortly.', 'success')
  form.reset()
}

async function handlePasswordUpdate(form) {
  const client = requireSupabase()
  const { error } = await client.auth.updateUser({ password: formData(form).password })
  if (error) throw error
  showMessage('Your password has been updated. You can now log in with the new password.', 'success')
  form.reset()
  await client.auth.signOut()
}

function setupAuthForms() {
  const adminLoginForm = document.querySelector('[data-admin-form="login"]')
  const adminRegistrationForm = document.querySelector('[data-admin-form="register"]')
  const adminHeading = document.querySelector('[data-admin-heading]')
  const adminDescription = document.querySelector('[data-admin-description]')
  const setAdminMode = (mode) => {
    if (!adminLoginForm || !adminRegistrationForm) return
    const registering = mode === 'register'
    adminLoginForm.hidden = registering
    adminRegistrationForm.hidden = !registering
    if (adminHeading) adminHeading.textContent = registering ? 'Create your admin profile.' : 'Welcome back.'
    if (adminDescription) {
      adminDescription.textContent = registering
        ? 'Enter your details and administrator invite code to create your account.'
        : 'Sign in with your administrator account to manage the platform.'
    }
    if (registering) adminRegistrationForm.querySelector('input')?.focus()
  }
  document.querySelectorAll('[data-admin-mode]').forEach((button) => {
    button.addEventListener('click', () => setAdminMode(button.dataset.adminMode))
  })
  if (adminLoginForm && new URLSearchParams(window.location.search).get('mode') === 'register') {
    setAdminMode('register')
  }

  const resetForm = document.querySelector('[data-auth-form="reset"]')
  const updateForm = document.querySelector('[data-auth-form="update-password"]')
  const showUpdatePasswordForm = () => {
    if (!resetForm || !updateForm) return
    resetForm.hidden = true
    updateForm.hidden = false
    showMessage('Choose a new password for your account.')
  }
  const isRecovery = window.location.hash.includes('type=recovery')
  if (isRecovery) showUpdatePasswordForm()
  if (supabase && resetForm && updateForm) {
    supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') showUpdatePasswordForm()
    })
  }

  document.querySelectorAll('[data-auth-form]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      setBusy(form, true)
      try {
        switch (form.dataset.authForm) {
          case 'login':
            await handleLogin(form)
            break
          case 'register-volunteer':
            await handleRegistration(form, 'volunteer')
            break
          case 'register-organisation':
            await handleRegistration(form, 'organisation')
            break
          case 'register-admin':
            await handleAdminRegistration(form)
            break
          case 'reset':
            await handlePasswordReset(form)
            break
          case 'update-password':
            await handlePasswordUpdate(form)
            break
          default:
            throw new Error('This form is not supported.')
        }
      } catch (error) {
        showMessage(error.message || 'The request could not be completed.', 'error')
      } finally {
        setBusy(form, false)
      }
    })
  })

  if (window.location.search.includes('verified=1')) {
    const isAdmin = document.querySelector('[data-auth-role="admin"]')
    showMessage(isAdmin
      ? 'Email verified. You can now sign in with your administrator account.'
      : 'Email verified. Your account will be available after administrator approval.', 'success')
  }
  if (!supabase && document.querySelector('[data-auth-form]')) {
    showMessage('Authentication is not configured. Set the Supabase URL and anon key in .env, then restart the server.')
  }
}

function element(tag, text, className) {
  const node = document.createElement(tag)
  if (text !== undefined && text !== null) node.textContent = String(text)
  if (className) node.className = className
  return node
}

function createActionButton(text, action, userId, className = 'button button-secondary') {
  const button = element('button', text, className)
  button.type = 'button'
  button.dataset.accountAction = action
  button.dataset.userId = userId
  return button
}

function setList(container, children, emptyText) {
  if (!container) return
  container.replaceChildren(...(children.length ? children : [element('p', emptyText, 'empty-state compact')]))
}

async function reviewAccount(userId, decision) {
  const response = await apiRequest(`/api/admin/accounts/${encodeURIComponent(userId)}/review`, {
    method: 'PATCH',
    body: JSON.stringify({ approval_status: decision })
  })
  showDashboardMessage(`${response.user.full_name}: account ${decision}. ${response.notification_message}`, response.notification_sent ? 'success' : 'info')
  await loadAdminDashboard()
}

async function setAccountStatus(userId, accountStatus) {
  await apiRequest(`/api/admin/users/${encodeURIComponent(userId)}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ account_status: accountStatus })
  })
  showDashboardMessage(`Account status changed to ${accountStatus}.`, 'success')
  await loadAdminDashboard()
}

function renderPendingAccounts(accounts) {
  const container = document.querySelector('[data-pending-accounts]')
  const items = accounts.filter((account) => account.account_status === 'pending').map((account) => {
    const card = element('article', undefined, 'admin-list-card')
    const heading = element('h3', account.full_name)
    const verification = account.email_verified_at ? 'Email verified' : 'Email verification pending'
    const details = element('p', `${account.email} · ${account.role} · ${verification} · Submitted ${new Date(account.created_at).toLocaleDateString()}`)
    card.append(heading, details)
    if (account.organisation) {
      card.append(
        element('h4', account.organisation.name),
        element('p', account.organisation.description),
        element('p', `${account.organisation.contact_email} · ${account.organisation.location}`)
      )
    }
    if (account.role === 'organisation') {
      card.append(element('p', 'Review this organisation in the verification queue below.'))
    } else if (account.email_verified_at) {
      const actions = element('div', undefined, 'admin-list-actions')
      actions.append(
        createActionButton('Approve', 'approve', account.id),
        createActionButton('Reject', 'reject', account.id, 'button button-secondary')
      )
      card.append(actions)
    }
    return card
  })
  setList(container, items, 'There are no accounts awaiting review.')
}

function renderUsers(users) {
  const container = document.querySelector('[data-admin-users]')
  const items = users.map((user) => {
    const card = element('article', undefined, 'admin-list-card')
    card.append(
      element('h3', user.full_name),
      element('p', `${user.email} · ${user.role} · ${user.account_status} · ${user.email_verified_at ? 'email verified' : 'email not verified'}`)
    )
    if (user.account_status === 'active' && user.role !== 'admin') {
      card.append(createActionButton('Suspend account', 'suspend', user.id))
    } else if (user.account_status === 'suspended') {
      card.append(createActionButton('Reactivate account', 'reactivate', user.id))
    }
    return card
  })
  setList(container, items, 'No accounts were found.')
}

function renderAudit(audit) {
  const container = document.querySelector('[data-admin-audit]')
  const items = audit.map((entry) => element(
    'article',
    `${entry.actor} ${entry.action.replaceAll('_', ' ')} for ${entry.target} · ${entry.previous_status || 'new'} → ${entry.next_status || 'removed'} · ${new Date(entry.created_at).toLocaleString()}`,
    'admin-list-card'
  ))
  setList(container, items, 'No administrator actions have been recorded yet.')
}

async function loadOrganisationAttendance() {
  const container = document.querySelector('[data-organisation-attendance]')
  if (!container) return
  const params = new URLSearchParams()
  const eventId = document.querySelector('[data-attendance-event]')?.value
  const from = document.querySelector('[data-attendance-from]')?.value
  const to = document.querySelector('[data-attendance-to]')?.value
  const status = document.querySelector('[data-attendance-status]')?.value
  if (eventId) params.set('event_id', eventId)
  if (from) params.set('from', from)
  if (to) params.set('to', to)
  if (status) params.set('attendance_status', status)
  try {
    const query = params.toString()
    const { events, attendance } = await fetchJson(`/api/organisations/me/attendance${query ? `?${query}` : ''}`)
    const selector = document.querySelector('[data-attendance-event]')
    if (selector && !selector.dataset.loaded) {
      const options = events.map((event) => {
        const option = element('option', `${event.event_date} · ${event.title}`)
        option.value = event.id
        return option
      })
      selector.append(...options)
      selector.dataset.loaded = 'true'
    }
    const items = attendance.map((record) => {
      const card = element('article', undefined, 'admin-list-card attendance-card')
      card.append(
        element('h3', record.volunteer.full_name),
        element('p', `${record.event?.title || 'Event'} · ${record.event?.event_date || ''} · ${record.event?.location || ''}`),
        element('p', record.application_message || 'No application message provided.'),
        element('span', record.attendance_status.replaceAll('_', ' '), 'status-pill')
      )
      if (record.volunteer.skills?.length) card.append(element('p', `Skills: ${record.volunteer.skills.join(', ')}`))
      if (record.volunteer.interests?.length) card.append(element('p', `Interests: ${record.volunteer.interests.join(', ')}`))
      const form = element('form', undefined, 'attendance-record-form')
      form.dataset.attendanceRegistration = record.id
      const status = element('select')
      status.name = 'attendance_status'
      for (const [value, label] of [['present', 'Attended'], ['absent', 'Absent'], ['excused', 'Excused']]) {
        const option = element('option', label)
        option.value = value
        option.selected = record.attendance_status === value
        status.append(option)
      }
      const hours = element('input')
      hours.type = 'number'
      hours.name = 'completed_hours'
      hours.min = '0'
      hours.max = '24'
      hours.step = '0.25'
      hours.value = String(record.completed_hours || 0)
      hours.setAttribute('aria-label', 'Completed volunteer hours')
      const confirmedLabel = element('label', 'Confirm hours')
      const confirmed = element('input')
      confirmed.type = 'checkbox'
      confirmed.name = 'hours_confirmed'
      confirmed.checked = record.hours_confirmed === true
      confirmedLabel.prepend(confirmed)
      const submit = element('button', 'Save attendance', 'button button-secondary')
      submit.type = 'submit'
      form.append(status, hours, confirmedLabel, submit)
      card.append(form)
      if (record.attendance_updated_at) card.append(element('small', `Last updated ${new Date(record.attendance_updated_at).toLocaleString()}${record.attendance_updated_by_name ? ` by ${record.attendance_updated_by_name}` : ''}`))
      return card
    })
    setList(container, items, 'No accepted volunteers match these attendance filters.')
  } catch (error) {
    setList(container, [], error.message || 'Attendance roster could not be loaded.')
  }
}

async function loadOrganisationImpact() {
  const metrics = document.querySelector('[data-impact-metrics]')
  if (!metrics) return
  const params = new URLSearchParams()
  const from = document.querySelector('[data-impact-from]')?.value
  const to = document.querySelector('[data-impact-to]')?.value
  const category = document.querySelector('[data-impact-category]')?.value
  if (from) params.set('from', from)
  if (to) params.set('to', to)
  if (category) params.set('category', category)
  try {
    const query = params.toString()
    const { impact } = await fetchJson(`/api/organisations/me/impact${query ? `?${query}` : ''}`)
    const labels = {
      published_opportunities: 'Published opportunities',
      applications_received: 'Applications received',
      accepted_applications: 'Accepted applications',
      unique_applicants: 'Unique applicants',
      completed_events: 'Completed events',
      unique_attendees: 'Unique attendees',
      confirmed_volunteer_hours: 'Confirmed volunteer hours',
      attendance_rate: 'Attendance rate',
      acceptance_rate: 'Application acceptance rate'
    }
    metrics.replaceChildren(...Object.entries(impact.totals).map(([key, value]) => {
      const tile = element('div')
      tile.append(element('span', labels[key] || key.replaceAll('_', ' ')))
      tile.append(element('strong', value === null ? '—' : key.endsWith('_rate') ? `${value}%` : value))
      return tile
    }))
    const definitions = document.querySelector('[data-impact-definitions]')
    if (definitions) definitions.textContent = Object.values(impact.definitions).join(' ')
    const monthly = document.querySelector('[data-impact-monthly]')
    if (monthly) {
      const rows = impact.monthly.map((row) => {
        const line = element('div', undefined, 'impact-month-row')
        line.append(element('strong', row.month), element('span', `${row.applications} applications`), element('span', `${row.attendees} attendees`), element('span', `${row.confirmed_hours} hours`), element('span', `${row.completed_events} completed events`))
        return line
      })
      monthly.replaceChildren(element('h3', 'Monthly volunteering activity'), ...rows)
    }
    const categoryList = document.querySelector('[data-impact-categories]')
    const categoryFilter = document.querySelector('[data-impact-category]')
    if (categoryList) {
      const max = Math.max(1, ...impact.categories.map((row) => row.events))
      categoryList.replaceChildren(element('h3', 'Opportunities by category'), ...impact.categories.map((row) => {
        const item = element('div', undefined, 'impact-category-row')
        const label = element('span', `${row.category} · ${row.events}`)
        const bar = element('progress')
        bar.max = max
        bar.value = row.events
        bar.setAttribute('aria-label', `${row.events} opportunities in ${row.category}`)
        item.append(label, bar)
        return item
      }))
    }
    if (categoryFilter && !categoryFilter.dataset.loaded) {
      categoryFilter.append(...impact.categories.map((row) => {
        const option = element('option', row.category)
        option.value = row.category
        return option
      }))
      categoryFilter.dataset.loaded = 'true'
    }
    const exportLink = document.querySelector('[data-impact-export]')
    if (exportLink) exportLink.href = `/api/organisations/me/impact.csv${query ? `?${query}` : ''}`
  } catch (error) {
    setList(metrics, [], error.message || 'Impact metrics could not be loaded.')
  }
}

async function loadAdminDashboard() {
  const [dashboard, accountData, userData, auditData] = await Promise.all([
    fetchJson('/api/admin/dashboard'),
    fetchJson('/api/admin/accounts'),
    fetchJson('/api/admin/users'),
    fetchJson('/api/admin/audit')
  ])
  for (const [key, value] of Object.entries(dashboard.stats)) {
    const target = document.querySelector(`[data-stat="${key}"]`)
    if (target) target.textContent = String(value)
  }
  renderPendingAccounts(accountData.accounts)
  renderUsers(userData.users)
  renderAudit(auditData.audit)
  await loadOrganisationVerificationQueue()
}

async function loadOrganisationVerificationQueue() {
  const container = document.querySelector('[data-organisation-verification-list]')
  const message = document.querySelector('[data-verification-admin-message]')
  if (!container) return
  const params = new URLSearchParams()
  const search = document.querySelector('[data-verification-search]')?.value.trim()
  const status = document.querySelector('[data-verification-status-filter]')?.value
  if (search) params.set('search', search)
  if (status) params.set('status', status)
  try {
    const query = params.toString()
    const { organisations } = await fetchJson(`/api/admin/organisations/verification${query ? `?${query}` : ''}`)
    const items = organisations.map((organisation) => {
      const card = element('article', undefined, 'admin-list-card verification-review-card')
      card.append(
        element('h3', organisation.name),
        element('p', `${organisation.profiles?.full_name || 'Owner'} · ${organisation.profiles?.email || ''} · Submitted ${organisation.verification_submitted_at ? new Date(organisation.verification_submitted_at).toLocaleDateString() : 'not submitted'}`),
        element('p', `${organisation.contact_email} · ${organisation.contact_phone || 'No phone'} · ${[organisation.address, organisation.city, organisation.province, organisation.service_area, organisation.location].filter(Boolean).join(', ')}`),
        element('p', organisation.description),
        element('span', organisation.verification_status.replaceAll('_', ' '), 'status-pill')
      )
      if (organisation.verification_feedback) card.append(element('p', `Feedback to organisation: ${organisation.verification_feedback}`))
      for (const document of organisation.documents || []) {
        const doc = element('p', undefined, 'verification-document-row')
        if (document.download_url) {
          const link = element('a', document.file_name, 'text-link')
          link.href = document.download_url
          link.target = '_blank'
          link.rel = 'noopener noreferrer'
          doc.append(link)
        } else {
          doc.append(element('span', `${document.file_name} (download unavailable)`))
        }
        card.append(doc)
      }
      if (organisation.latest_review?.internal_notes) card.append(element('p', `Latest internal note: ${organisation.latest_review.internal_notes}`))
      const form = element('form', undefined, 'verification-decision-form')
      form.dataset.verificationReview = organisation.id
      const decision = element('select')
      decision.name = 'verification_status'
      for (const [value, label] of [['approved', 'Approve'], ['more_information_required', 'Request more information'], ['rejected', 'Reject']]) {
        const option = element('option', label)
        option.value = value
        decision.append(option)
      }
      const feedbackLabel = element('label', 'Feedback for organisation')
      const feedback = element('textarea')
      feedback.name = 'feedback'
      feedback.maxLength = 2000
      feedback.rows = 3
      feedback.placeholder = 'Required when requesting information or rejecting.'
      feedbackLabel.append(feedback)
      const notesLabel = element('label', 'Internal administrator notes')
      const notes = element('textarea')
      notes.name = 'internal_notes'
      notes.maxLength = 4000
      notes.rows = 2
      notesLabel.append(notes)
      const button = element('button', 'Save verification decision', 'button button-primary')
      button.type = 'submit'
      form.append(decision, feedbackLabel, notesLabel, button)
      card.append(form)
      return card
    })
    setList(container, items, 'No organisation verification applications match these filters.')
    if (message) message.hidden = true
  } catch (error) {
    setList(container, [], 'Organisation verification queue could not be loaded.')
    if (message) {
      message.textContent = error.message || 'Organisation verification queue could not be loaded.'
      message.className = 'notice notice-error'
      message.hidden = false
    }
  }
}

async function loadVolunteerDashboard() {
  const [profileResult, { registrations }, { applications }, attendanceResult, recommendationResult] = await Promise.all([
    fetchJson('/api/profile/me'),
    fetchJson('/api/registrations/me'),
    fetchJson('/api/organisation-applications/me'),
    fetchJson('/api/attendance/me').catch((error) => ({ error })),
    fetchJson('/api/events/recommended').catch((error) => ({ error }))
  ])
  const profile = profileResult.profile
  const profileForm = document.querySelector('[data-volunteer-profile-form]')
  if (profileForm) {
    for (const field of ['full_name', 'phone', 'location', 'city', 'province', 'service_area', 'experience', 'availability_notes', 'participation_type', 'preferred_distance_km', 'available_time_start', 'available_time_end']) {
      const input = profileForm.elements.namedItem(field)
      if (input) input.value = profile[field] ?? ''
    }
    for (const field of ['skills', 'interests', 'preferred_categories', 'available_days']) {
      const input = profileForm.elements.namedItem(field)
      if (input) input.value = (profile[field] || []).join(', ')
    }
    profileForm.elements.share_with_organisations.checked = profile.share_with_organisations === true
  }
  const container = document.querySelector('[data-volunteer-applications]')
  const eventItems = registrations.map((registration) => {
    const card = element('article', undefined, 'admin-list-card')
    const event = registration.events
    card.append(
      element('h3', event?.title || 'Opportunity'),
      element('p', `${event?.organisations?.name || 'Community organisation'} · ${event?.location || ''} · ${event?.event_date || ''}`),
      element('span', registration.status, 'status-pill')
    )
    return card
  })
  const organisationItems = applications.map((application) => {
    const card = element('article', undefined, 'admin-list-card')
    card.append(
      element('h3', application.organisations?.name || 'Community organisation'),
      element('p', `${application.organisations?.location || ''} · Applied ${new Date(application.applied_at).toLocaleDateString()}`),
      element('span', application.status, 'status-pill')
    )
    if (application.application_message) card.append(element('p', application.application_message))
    if (application.profiles?.skills?.length) card.append(element('p', `Shared skills: ${application.profiles.skills.join(', ')}`))
    if (application.profiles?.interests?.length) card.append(element('p', `Shared interests: ${application.profiles.interests.join(', ')}`))
    if (application.profiles?.experience) card.append(element('p', `Shared experience: ${application.profiles.experience}`))
    if (application.profiles?.available_days?.length) card.append(element('p', `Availability: ${application.profiles.available_days.join(', ')}${application.profiles.available_time_start ? `, ${application.profiles.available_time_start}–${application.profiles.available_time_end}` : ''}`))
    if (['pending', 'accepted'].includes(application.status)) {
      const withdraw = element('button', 'Withdraw application', 'button button-secondary')
      withdraw.type = 'button'
      withdraw.dataset.organisationApplicationAction = 'withdraw'
      withdraw.dataset.applicationId = application.id
      card.append(withdraw)
    }
    return card
  })
  setList(container, [...organisationItems, ...eventItems], 'You have not applied to an organisation yet.')
  const recommendationList = document.querySelector('[data-volunteer-recommendations]')
  if (recommendationList) {
    if (recommendationResult.error) {
      setList(recommendationList, [], 'Recommendations could not be loaded. Complete your preferences and try again.')
    } else {
      const cards = recommendationResult.events.slice(0, 6).map((event) => {
        const card = element('article', undefined, 'admin-list-card recommendation-card')
        card.append(
          element('h3', `${event.match.score}% · ${event.title}`),
          element('p', `${event.organisations?.name || 'Community organisation'} · ${event.category} · ${event.location} · ${event.event_date}`),
          element('p', event.match.reasons.join(' · '))
        )
        if (event.match.incomplete) card.append(element('p', event.match.missing.join(' · '), 'form-footnote'))
        const link = element('a', 'View opportunity', 'text-link')
        link.href = `/event-details.html?id=${encodeURIComponent(event.id)}`
        card.append(link)
        return card
      })
      setList(recommendationList, cards, 'No open opportunities match your current preferences.')
    }
  }
  const attendanceList = document.querySelector('[data-volunteer-attendance]')
  const hoursTotal = document.querySelector('[data-volunteer-confirmed-hours]')
  if (attendanceResult.error) {
    setList(attendanceList, [], 'Attendance history could not be loaded.')
  } else {
    if (hoursTotal) hoursTotal.textContent = String(attendanceResult.confirmed_hours)
    const records = attendanceResult.history.map((record) => {
      const card = element('article', undefined, 'admin-list-card')
      card.append(
        element('h3', record.events?.title || 'Event'),
        element('p', `${record.events?.organisations?.name || 'Organisation'} · ${record.events?.location || ''} · ${record.events?.event_date || ''}`),
        element('span', record.attendance_status.replaceAll('_', ' '), 'status-pill')
      )
      if (record.attendance_status === 'present' && record.hours_confirmed) card.append(element('p', `${record.completed_hours} confirmed hours`))
      return card
    })
    setList(attendanceList, records, 'Your attendance history will appear after an organisation records it.')
  }
}

async function loadOrganisationDashboard() {
  const [{ organisation }, { events }, registrationResult, applicationResult, verificationResult] = await Promise.all([
    fetchJson('/api/organisations/me'),
    fetchJson('/api/organisations/me/events'),
    fetchJson('/api/organisations/me/registrations').then((result) => ({ result })).catch((error) => ({ error })),
    fetchJson('/api/organisations/me/volunteer-applications').then((result) => ({ result })).catch((error) => ({ error })),
    fetchJson('/api/organisations/me/verification').catch((error) => ({ error }))
  ])
  const registrations = registrationResult.result?.registrations || []
  const applications = applicationResult.result?.applications || []
  if ((registrationResult.error || applicationResult.error) && organisation?.approval_status === 'approved') {
    showDashboardMessage('Some event application data could not be loaded.', 'error')
  }
  const profileForm = document.querySelector('[data-organisation-profile-form]')
  if (profileForm && organisation) {
    for (const [field, value] of Object.entries(organisation)) {
      const input = profileForm.elements.namedItem(field)
      if (input) input.value = value || ''
    }
  }
  const approvalStatus = document.querySelector('[data-organisation-status]')
  if (approvalStatus && organisation) {
    approvalStatus.textContent = organisation.approval_status === 'approved' ? 'Approved' : 'Approval pending'
    approvalStatus.className = `status-pill ${organisation.approval_status === 'approved' ? 'status-success' : 'status-accent'}`
  }
  const eventForm = document.querySelector('[data-organisation-event-form]')
  if (eventForm && organisation) {
    eventForm.elements.location.value = organisation.location || ''
    const publishOption = eventForm.elements.status.querySelector('option[value="published"]')
    publishOption.disabled = organisation.approval_status !== 'approved'
    if (organisation.approval_status === 'approved') eventForm.elements.status.value = 'published'
    eventForm.querySelectorAll('input,textarea,select,button').forEach((control) => {
      control.disabled = organisation.approval_status !== 'approved'
    })
  }
  if (verificationResult.error) {
    showDashboardMessage(verificationResult.error.message || 'Verification details could not be loaded.', 'error')
  } else {
    const status = document.querySelector('[data-verification-status]')
    const feedback = document.querySelector('[data-verification-feedback]')
    const submit = document.querySelector('[data-verification-submit]')
    const docs = document.querySelector('[data-verification-documents]')
    if (status) {
      status.textContent = verificationResult.organisation.verification_status.replaceAll('_', ' ')
      status.className = `status-pill ${verificationResult.organisation.verification_status === 'approved' ? 'status-success' : 'status-accent'}`
    }
    if (feedback && verificationResult.organisation.verification_feedback) {
      feedback.textContent = verificationResult.organisation.verification_feedback
      feedback.hidden = false
    }
    if (submit) submit.disabled = verificationResult.organisation.verification_status === 'approved'
    if (docs) {
      const items = (verificationResult.documents || []).map((document) => {
        const row = element('div', undefined, 'verification-document-row')
        const link = element('a', document.file_name, 'text-link')
        link.href = document.download_url || '#'
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        row.append(link, element('span', `${Math.ceil(document.file_size_bytes / 1024)} KB · ${new Date(document.created_at).toLocaleDateString()}`))
        return row
      })
      docs.replaceChildren(...items)
    }
  }
  const eventCards = events.map((event) => {
    const card = element('article', undefined, 'admin-list-card')
    card.append(element('h3', event.title), element('p', `${event.location} · ${event.event_date} · ${event.status}`))
    const isPast = new Date(`${event.event_date}T${event.end_time}Z`) <= new Date()
    if (event.status === 'draft') {
      const publish = element('button', 'Publish event', 'button button-secondary')
      publish.type = 'button'
      publish.dataset.eventStatusAction = event.id
      publish.dataset.nextStatus = 'published'
      publish.disabled = organisation?.approval_status !== 'approved'
      card.append(publish)
    } else if (event.status === 'published' && isPast) {
      const complete = element('button', 'Mark event complete', 'button button-secondary')
      complete.type = 'button'
      complete.dataset.eventStatusAction = event.id
      complete.dataset.nextStatus = 'completed'
      card.append(complete)
    }
    return card
  })
  setList(document.querySelector('[data-organisation-events]'), eventCards, 'No events have been created yet.')
  await loadOrganisationAttendance()
  await loadOrganisationImpact()
  const applicationCards = registrations.map((registration) => {
    const card = element('article', undefined, 'admin-list-card')
    card.append(
      element('h3', registration.profiles?.full_name || 'Volunteer'),
      element('p', `${registration.events?.title || 'Opportunity'} · ${registration.status}`)
    )
    return card
  })
  const organisationApplicationCards = applications.map((application) => {
    const card = element('article', undefined, 'admin-list-card')
    card.append(
      element('h3', application.profiles?.full_name || 'Volunteer'),
      element('p', `${application.profiles?.email || ''} · ${application.profiles?.location || ''} · Applied ${new Date(application.applied_at).toLocaleDateString()}`),
      element('span', application.status, 'status-pill')
    )
    if (application.application_message) card.append(element('p', application.application_message))
    if (application.status === 'pending') {
      const actions = element('div', undefined, 'admin-list-actions')
      for (const [status, label] of [['accepted', 'Accept'], ['rejected', 'Decline']]) {
        const button = element('button', label, 'button button-secondary')
        button.type = 'button'
        button.dataset.organisationApplicationAction = status
        button.dataset.applicationId = application.id
        actions.append(button)
      }
      card.append(actions)
    }
    return card
  })
  setList(document.querySelector('[data-organisation-applications]'), [...organisationApplicationCards, ...applicationCards], 'There are no volunteer applications yet.')
}

async function setupDashboard() {
  const role = document.body.dataset.dashboardRole
  if (!role) return
  const logout = document.querySelector('[data-logout]')
  if (logout) {
    logout.addEventListener('click', async () => {
      const { error } = await requireSupabase().auth.signOut()
      if (error) showDashboardMessage(error.message, 'error')
      else window.location.assign('/index.html')
    })
  }
  const organisationProfileForm = document.querySelector('[data-organisation-profile-form]')
  if (organisationProfileForm) {
    organisationProfileForm.addEventListener('submit', async (event) => {
      event.preventDefault()
      setBusy(organisationProfileForm, true)
      try {
        await apiRequest('/api/organisations/me', {
          method: 'PUT',
          body: JSON.stringify(formData(organisationProfileForm))
        })
        showDashboardMessage('Your public organisation profile has been updated.', 'success')
      } catch (error) {
        showDashboardMessage(error.message || 'Your organisation profile could not be updated.', 'error')
      } finally {
        setBusy(organisationProfileForm, false)
      }
    })
  }
  const organisationEventForm = document.querySelector('[data-organisation-event-form]')
  if (organisationEventForm) {
    organisationEventForm.addEventListener('submit', async (event) => {
      event.preventDefault()
      setBusy(organisationEventForm, true)
      const values = formData(organisationEventForm)
      values.capacity = Number(values.capacity)
      try {
        await apiRequest('/api/events', { method: 'POST', body: JSON.stringify(values) })
        showDashboardMessage(values.status === 'published' ? 'Your event is published for volunteers.' : 'Your event has been saved as a draft.', 'success')
        organisationEventForm.reset()
        organisationEventForm.elements.capacity.value = '10'
        await loadOrganisationDashboard()
      } catch (error) {
        showDashboardMessage(error.message || 'The event could not be created.', 'error')
      } finally {
        setBusy(organisationEventForm, false)
      }
    })
  }
  const verificationDocumentForm = document.querySelector('[data-verification-document-form]')
  if (verificationDocumentForm) {
    verificationDocumentForm.addEventListener('submit', async (event) => {
      event.preventDefault()
      const file = verificationDocumentForm.elements.document.files[0]
      if (!file) return
      setBusy(verificationDocumentForm, true)
      try {
        await apiRequest(`/api/organisations/me/verification-documents?file_name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          body: file,
          headers: { 'Content-Type': file.type }
        })
        verificationDocumentForm.reset()
        await loadOrganisationDashboard()
        showDashboardMessage('Verification document uploaded privately.', 'success')
      } catch (error) {
        showDashboardMessage(error.message || 'Verification document could not be uploaded.', 'error')
      } finally {
        setBusy(verificationDocumentForm, false)
      }
    })
  }
  const verificationSubmit = document.querySelector('[data-verification-submit]')
  if (verificationSubmit) {
    verificationSubmit.addEventListener('click', async () => {
      verificationSubmit.disabled = true
      try {
        await apiRequest('/api/organisations/me/verification/submit', { method: 'POST', body: JSON.stringify({}) })
        await loadOrganisationDashboard()
        showDashboardMessage('Your organisation has been submitted for verification.', 'success')
      } catch (error) {
        showDashboardMessage(error.message || 'Verification could not be submitted.', 'error')
        verificationSubmit.disabled = false
      }
    })
  }
  const verificationFilters = document.querySelector('[data-verification-filters]')
  if (verificationFilters) verificationFilters.addEventListener('submit', (event) => {
    event.preventDefault()
    loadOrganisationVerificationQueue()
  })
  const volunteerProfileForm = document.querySelector('[data-volunteer-profile-form]')
  if (volunteerProfileForm) volunteerProfileForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    setBusy(volunteerProfileForm, true)
    const values = formData(volunteerProfileForm)
    for (const field of ['skills', 'interests', 'preferred_categories', 'available_days']) {
      values[field] = values[field].split(',').map((item) => item.trim().toLocaleLowerCase()).filter(Boolean)
    }
    values.preferred_distance_km = values.preferred_distance_km ? Number(values.preferred_distance_km) : null
    values.share_with_organisations = volunteerProfileForm.elements.share_with_organisations.checked
    try {
      await apiRequest('/api/profile/me', { method: 'PUT', body: JSON.stringify(values) })
      await loadVolunteerDashboard()
      showDashboardMessage('Your volunteer profile and matching preferences have been saved.', 'success')
    } catch (error) {
      showDashboardMessage(error.message || 'Your volunteer profile could not be saved.', 'error')
    } finally {
      setBusy(volunteerProfileForm, false)
    }
  })
  const attendanceFilters = document.querySelector('[data-attendance-filters]')
  if (attendanceFilters) attendanceFilters.addEventListener('submit', (event) => {
    event.preventDefault()
    loadOrganisationAttendance()
  })
  const impactFilters = document.querySelector('[data-impact-filters]')
  if (impactFilters) impactFilters.addEventListener('submit', (event) => {
    event.preventDefault()
    loadOrganisationImpact()
  })
  if (!supabase) {
    showDashboardMessage('Authentication is not configured. Set the Supabase values in .env, then restart the server.')
    return
  }
  try {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) {
      window.location.assign(`/login.html?next=${encodeURIComponent(window.location.pathname + window.location.search + window.location.hash)}`)
      return
    }
    if (logout) logout.hidden = false
    const loginLink = document.querySelector('.main-nav .nav-login')
    if (loginLink) loginLink.hidden = true
    const { profile } = await apiRequest('/api/profile/me')
    if (profile.role !== role) {
      sessionStorage.setItem('auth-notice', 'That dashboard is not available to your account. You have been taken to your dashboard.')
      dashboardForRole(profile.role)
      return
    }
    document.body.dataset.authReady = 'true'
    const greeting = document.querySelector('[data-profile-greeting]')
    if (greeting) greeting.textContent = `Welcome, ${profile.full_name}.`
    if (role === 'organisation') {
      const status = document.querySelector('[data-organisation-status]')
      if (status) {
        status.textContent = 'Approved'
        status.className = 'status-pill status-success'
      }
    }
    if (role === 'admin') await loadAdminDashboard()
    else if (role === 'volunteer') await loadVolunteerDashboard()
    else await loadOrganisationDashboard()
    const notice = sessionStorage.getItem('auth-notice')
    if (notice) sessionStorage.removeItem('auth-notice')
    showDashboardMessage(notice || `Signed in as ${profile.full_name}.`)
  } catch (error) {
    window.location.assign(`/login.html?next=${encodeURIComponent(window.location.pathname + window.location.search + window.location.hash)}`)
  }
}

async function enforcePageAccess() {
  const pathname = window.location.pathname
  const isLandingPage = pathname === '/' || pathname === '/index.html'
  const isLoginPage = pathname === '/login.html'
  const isProtectedPage = protectedPagePaths.includes(pathname)
  if (!supabase) {
    if (isProtectedPage) {
      window.location.assign(`/login.html?next=${encodeURIComponent(pathname + window.location.search + window.location.hash)}`)
    }
    return
  }
  const { data: { session } } = await supabase.auth.getSession()
  if (isProtectedPage && !session) {
    window.location.assign(`/login.html?next=${encodeURIComponent(pathname + window.location.search + window.location.hash)}`)
    return
  }
  if (session && (isLandingPage || isLoginPage)) {
    try {
      const { profile } = await apiRequest('/api/profile/me')
      dashboardForRole(profile.role)
    } catch {
      if (isLandingPage) return
    }
  }
}

document.addEventListener('click', async (event) => {
  const eventStatusButton = event.target.closest('[data-event-status-action]')
  if (eventStatusButton) {
    eventStatusButton.disabled = true
    try {
      const { events } = await fetchJson('/api/organisations/me/events')
      const current = events.find((item) => item.id === eventStatusButton.dataset.eventStatusAction)
      if (!current) throw new Error('This event could not be found.')
      await apiRequest(`/api/events/${encodeURIComponent(current.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ ...current, status: eventStatusButton.dataset.nextStatus })
      })
      showDashboardMessage(eventStatusButton.dataset.nextStatus === 'published' ? 'Event published for volunteers.' : 'Event marked complete.', 'success')
      await loadOrganisationDashboard()
    } catch (error) {
      showDashboardMessage(error.message || 'Event status could not be updated.', 'error')
      eventStatusButton.disabled = false
    }
    return
  }
  const applicationButton = event.target.closest('[data-organisation-application-action]')
  if (applicationButton) {
    applicationButton.disabled = true
    try {
      const id = encodeURIComponent(applicationButton.dataset.applicationId)
      if (applicationButton.dataset.organisationApplicationAction === 'withdraw') {
        await apiRequest(`/api/organisation-applications/${id}/withdraw`, { method: 'PATCH' })
        showDashboardMessage('Your organisation application has been withdrawn.', 'success')
      } else {
        const status = applicationButton.dataset.organisationApplicationAction
        await apiRequest(`/api/organisation-applications/${id}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ status })
        })
        showDashboardMessage(`Volunteer application ${status}.`, 'success')
      }
      if (document.body.dataset.dashboardRole === 'volunteer') await loadVolunteerDashboard()
      else await loadOrganisationDashboard()
    } catch (error) {
      showDashboardMessage(error.message || 'The application could not be updated.', 'error')
      applicationButton.disabled = false
    }
    return
  }

  const button = event.target.closest('[data-account-action]')
  if (!button) return
  button.disabled = true
  try {
    if (button.dataset.accountAction === 'approve' || button.dataset.accountAction === 'reject') {
      await reviewAccount(button.dataset.userId, button.dataset.accountAction === 'approve' ? 'approved' : 'rejected')
    } else if (button.dataset.accountAction === 'suspend') {
      await setAccountStatus(button.dataset.userId, 'suspended')
    } else if (button.dataset.accountAction === 'reactivate') {
      await setAccountStatus(button.dataset.userId, 'active')
    }
  } catch (error) {
    showDashboardMessage(error.message || 'The account action could not be completed.', 'error')
    button.disabled = false
  }
})

async function initializeAuth() {
  let configLoadError
  if (!supabase) {
    try {
      const response = await fetch('/api/config')
      if (!response.ok) throw new Error('The server could not provide public Supabase settings.')
      const publicConfig = await response.json()
      if (publicConfig.supabaseUrl && publicConfig.supabaseAnonKey) {
        supabase = createClient(publicConfig.supabaseUrl, publicConfig.supabaseAnonKey, {
          auth: { detectSessionInUrl: true, persistSession: true, autoRefreshToken: true }
        })
      }
    } catch (error) {
      configLoadError = error
    }
  }
  setupAuthForms()
  try {
    await enforcePageAccess()
  } catch {
    if (protectedPagePaths.includes(window.location.pathname)) {
      window.location.assign(`/login.html?next=${encodeURIComponent(window.location.pathname + window.location.search + window.location.hash)}`)
      return
    }
  }
  await setupDashboard()
  if (configLoadError) {
    const message = `Authentication settings could not be loaded: ${configLoadError.message}`
    showMessage(message, 'error')
    showDashboardMessage(message, 'error')
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeAuth, { once: true })
} else {
  initializeAuth()
}

document.addEventListener('submit', async (event) => {
  const attendanceForm = event.target.closest('[data-attendance-registration]')
  if (attendanceForm) {
    event.preventDefault()
    const button = attendanceForm.querySelector('[type="submit"]')
    button.disabled = true
    const values = formData(attendanceForm)
    values.completed_hours = Number(values.completed_hours)
    values.hours_confirmed = attendanceForm.elements.hours_confirmed.checked
    try {
      await apiRequest(`/api/registrations/${encodeURIComponent(attendanceForm.dataset.attendanceRegistration)}/attendance`, {
        method: 'PATCH',
        body: JSON.stringify(values)
      })
      showDashboardMessage('Attendance record saved.', 'success')
      await loadOrganisationAttendance()
      await loadOrganisationImpact()
    } catch (error) {
      showDashboardMessage(error.message || 'Attendance could not be saved.', 'error')
      button.disabled = false
    }
    return
  }
  const form = event.target.closest('[data-verification-review]')
  if (!form) return
  event.preventDefault()
  const button = form.querySelector('[type="submit"]')
  button.disabled = true
  const values = formData(form)
  try {
    await apiRequest(`/api/admin/organisations/${encodeURIComponent(form.dataset.verificationReview)}/verification`, {
      method: 'PATCH',
      body: JSON.stringify(values)
    })
    showDashboardMessage('Organisation verification decision saved.', 'success')
    await loadOrganisationVerificationQueue()
  } catch (error) {
    showDashboardMessage(error.message || 'Organisation verification decision could not be saved.', 'error')
    button.disabled = false
  }
})
