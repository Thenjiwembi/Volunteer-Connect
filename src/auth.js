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
  const target = dashboardPaths[role]
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
      website: values.website
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
    if (account.email_verified_at) {
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
}

async function loadVolunteerDashboard() {
  const { registrations } = await fetchJson('/api/registrations/me')
  const container = document.querySelector('[data-volunteer-applications]')
  const items = registrations.map((registration) => {
    const card = element('article', undefined, 'admin-list-card')
    const event = registration.events
    card.append(
      element('h3', event?.title || 'Opportunity'),
      element('p', `${event?.organisations?.name || 'Community organisation'} · ${event?.location || ''} · ${event?.event_date || ''}`),
      element('span', registration.status, 'status-pill')
    )
    return card
  })
  setList(container, items, 'You have not applied to an opportunity yet.')
}

async function loadOrganisationDashboard() {
  const [{ events }, { registrations }] = await Promise.all([
    fetchJson('/api/organisations/me/events'),
    fetchJson('/api/organisations/me/registrations')
  ])
  const eventCards = events.map((event) => {
    const card = element('article', undefined, 'admin-list-card')
    card.append(element('h3', event.title), element('p', `${event.location} · ${event.event_date} · ${event.status}`))
    return card
  })
  setList(document.querySelector('[data-organisation-events]'), eventCards, 'No opportunities have been created yet.')
  const applicationCards = registrations.map((registration) => {
    const card = element('article', undefined, 'admin-list-card')
    card.append(
      element('h3', registration.profiles?.full_name || 'Volunteer'),
      element('p', `${registration.events?.title || 'Opportunity'} · ${registration.status}`)
    )
    return card
  })
  setList(document.querySelector('[data-organisation-applications]'), applicationCards, 'There are no volunteer applications yet.')
}

async function setupDashboard() {
  const role = document.body.dataset.dashboardRole
  if (!role) return
  const logout = document.querySelector('[data-logout]')
  if (logout) {
    logout.addEventListener('click', async () => {
      const { error } = await requireSupabase().auth.signOut()
      if (error) showDashboardMessage(error.message, 'error')
      else window.location.assign('/login.html')
    })
  }
  if (!supabase) {
    showDashboardMessage('Authentication is not configured. Set the Supabase values in .env, then restart the server.')
    return
  }
  try {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) {
      showDashboardMessage('Please log in to view this dashboard.')
      return
    }
    if (logout) logout.hidden = false
    const loginLink = document.querySelector('.main-nav .nav-login')
    if (loginLink) loginLink.hidden = true
    const { profile } = await apiRequest('/api/profile/me')
    if (profile.role !== role) {
      dashboardForRole(profile.role)
      return
    }
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
    showDashboardMessage(`Signed in as ${profile.full_name}.`)
  } catch (error) {
    showDashboardMessage(error.message || 'Dashboard data could not be loaded.', 'error')
  }
}

document.addEventListener('click', async (event) => {
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
