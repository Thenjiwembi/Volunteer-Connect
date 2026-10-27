import { createClient } from '@supabase/supabase-js'

const organisationList = document.querySelector('[data-organisations-list]')
const organisationMessage = document.querySelector('[data-organisations-message]')
const emptyState = document.querySelector('[data-organisations-empty]')
const emptyStateTitle = document.querySelector('[data-organisations-empty-title]')
const emptyStateDescription = document.querySelector('[data-organisations-empty-description]')
const searchInput = document.querySelector('[data-catalogue-search]')
const locationInput = document.querySelector('[data-catalogue-location]')

function showMessage(message, type = 'info', link) {
  organisationMessage.replaceChildren(document.createTextNode(message))
  if (link) {
    const anchor = document.createElement('a')
    anchor.href = link.href
    anchor.textContent = link.label
    anchor.className = 'text-link'
    organisationMessage.append(document.createTextNode(' '), anchor)
  }
  organisationMessage.className = `notice notice-${type}`
  organisationMessage.hidden = false
}

function createOrganisationCard(organisation) {
  const card = document.createElement('article')
  card.className = 'event-card'

  const image = document.createElement('div')
  image.className = 'event-card-image organisation-card-image'

  const location = document.createElement('span')
  location.className = 'event-category'
  location.textContent = organisation.location

  const illustration = document.createElement('div')
  illustration.className = 'event-illustration'
  illustration.classList.add('organisation-card-fallback')
  const mark = document.createElement('span')
  mark.textContent = organisation.name.charAt(0).toUpperCase()
  illustration.append(mark)
  if (organisation.image_url && /^https:\/\//i.test(organisation.image_url)) {
    const photo = document.createElement('img')
    photo.className = 'organisation-card-photo'
    photo.src = organisation.image_url
    photo.alt = `Work by ${organisation.name}`
    photo.loading = 'lazy'
    photo.addEventListener('error', () => photo.remove())
    image.append(photo)
  }
  image.append(location, illustration)

  const body = document.createElement('div')
  body.className = 'event-card-body'
  const title = document.createElement('h3')
  title.textContent = organisation.name
  const description = document.createElement('p')
  description.textContent = organisation.description
  body.append(title, description)

  const detailsLink = document.createElement('a')
  detailsLink.className = 'text-link'
  detailsLink.href = `/organisation-details.html?id=${encodeURIComponent(organisation.id)}`
  detailsLink.textContent = 'Learn about their work'
  body.append(detailsLink)

  if (organisation.website && /^https?:\/\//i.test(organisation.website)) {
    const website = document.createElement('a')
    website.className = 'text-link'
    website.href = organisation.website
    website.target = '_blank'
    website.rel = 'noopener noreferrer'
    website.textContent = 'Visit website'
    body.append(website)
  }

  card.append(image, body)
  return card
}

let supabase
export async function getAccessToken() {
  if (!supabase) {
    let url = import.meta.env.VITE_SUPABASE_URL
    let key = import.meta.env.VITE_SUPABASE_ANON_KEY
    if (!url || !key) {
      const response = await fetch('/api/config')
      if (!response.ok) throw new Error('Authentication settings could not be loaded.')
      const config = await response.json()
      url = config.supabaseUrl
      key = config.supabaseAnonKey
    }
    if (!url || !key) throw new Error('Authentication is not configured. Contact the site administrator.')
    supabase = createClient(url, key, {
      auth: { detectSessionInUrl: true, persistSession: true, autoRefreshToken: true }
    })
  }
  const { data, error } = await supabase.auth.getSession()
  if (error) throw new Error('Your sign-in session could not be checked. Please sign in again.')
  if (!data.session?.access_token) throw new Error('Sign in as a volunteer to apply.')
  return data.session.access_token
}

let requestId = 0
async function loadOrganisations() {
  const currentRequestId = ++requestId
  const params = new URLSearchParams()
  if (searchInput.value.trim()) params.set('search', searchInput.value.trim())
  if (locationInput.value.trim()) params.set('location', locationInput.value.trim())

  organisationMessage.textContent = 'Loading organizations…'
  organisationMessage.className = 'notice notice-info'
  organisationMessage.hidden = false
  emptyState.hidden = true

  try {
    const query = params.toString()
    const response = await fetch(`/api/organisations${query ? `?${query}` : ''}`)
    let payload
    try {
      payload = await response.json()
    } catch {
      throw new Error('The server returned an invalid response while loading organizations.')
    }
    if (!response.ok) throw new Error(payload.error?.message || 'Organizations could not be loaded.')
    if (!Array.isArray(payload.organisations)) throw new Error('The server returned an invalid organization list.')
    if (currentRequestId !== requestId) return

    organisationList.replaceChildren(...payload.organisations.map(createOrganisationCard))
    if (payload.organisations.length === 0) {
      const hasFilters = params.size > 0
      emptyStateTitle.textContent = hasFilters
        ? 'No organizations match your search'
        : 'No approved organizations are listed right now'
      emptyStateDescription.textContent = hasFilters
        ? 'Try another search or location.'
        : 'Approved community organizations will appear here when they join.'
    }
    emptyState.hidden = payload.organisations.length > 0
    organisationMessage.hidden = true
  } catch (error) {
    if (currentRequestId !== requestId) return
    organisationList.replaceChildren()
    emptyState.hidden = true
    showMessage(error.message || 'Organizations could not be loaded. Please try again.', 'error')
  }
}

if (organisationList) organisationList.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-organisation-apply]')
  if (!button) return
  button.disabled = true
  try {
    const token = await getAccessToken()
    const response = await fetch(`/api/organisations/${encodeURIComponent(button.dataset.organisationApply)}/applications`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ application_message: button.parentElement.querySelector('textarea').value })
    })
    let payload
    try {
      payload = await response.json()
    } catch {
      throw new Error('The server returned an invalid response while submitting your application.')
    }
    if (!response.ok) {
      if (response.status === 401) throw new Error('Sign in as a volunteer to apply.')
      throw new Error(payload.error?.message || 'Your application could not be submitted.')
    }
    button.textContent = 'Application sent'
    showMessage('Your volunteer application has been sent.', 'success')
  } catch (error) {
    button.disabled = false
    showMessage(error.message || 'Your application could not be submitted.', 'error',
      error.message?.includes('Sign in') ? { href: '/login.html', label: 'Log in' } : undefined)
  }
})

let searchTimeout
if (organisationList) {
  for (const input of [searchInput, locationInput]) {
    input.addEventListener('input', () => {
      clearTimeout(searchTimeout)
      searchTimeout = setTimeout(loadOrganisations, 250)
    })
  }
  loadOrganisations()
}
