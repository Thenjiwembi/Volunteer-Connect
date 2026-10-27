import { createClient } from '@supabase/supabase-js'

const eventList = document.querySelector('[data-events-list]')
const eventMessage = document.querySelector('[data-events-message]')
const eventEmptyState = document.querySelector('[data-events-empty]')
const eventEmptyTitle = document.querySelector('[data-events-empty-title]')
const eventEmptyDescription = document.querySelector('[data-events-empty-description]')
const organisationList = document.querySelector('[data-organisations-list]')
const organisationMessage = document.querySelector('[data-organisations-message]')
const emptyState = document.querySelector('[data-organisations-empty]')
const emptyStateTitle = document.querySelector('[data-organisations-empty-title]')
const emptyStateDescription = document.querySelector('[data-organisations-empty-description]')
const searchInput = document.querySelector('[data-catalogue-search]')
const locationInput = document.querySelector('[data-catalogue-location]')

function showMessage(target, message, type = 'info', link) {
  target.replaceChildren(document.createTextNode(message))
  if (link) {
    const anchor = document.createElement('a')
    anchor.href = link.href
    anchor.textContent = link.label
    anchor.className = 'text-link'
    target.append(document.createTextNode(' '), anchor)
  }
  target.className = `notice notice-${type}`
  target.hidden = false
}

function hideMessage(target) {
  target.hidden = true
}

function formatEventDate(value) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
}

function createOrganisationCard(organisation) {
  const card = document.createElement('article')
  card.className = 'event-card'

  const image = document.createElement('div')
  image.className = 'event-card-image'

  const initial = document.createElement('span')
  initial.className = 'event-category'
  initial.textContent = organisation.location

  const illustration = document.createElement('div')
  illustration.className = 'event-illustration'
  const mark = document.createElement('span')
  mark.textContent = organisation.name.charAt(0).toUpperCase()
  illustration.append(mark)
  image.append(initial, illustration)

  const body = document.createElement('div')
  body.className = 'event-card-body'
  const title = document.createElement('h3')
  title.textContent = organisation.name
  const description = document.createElement('p')
  description.textContent = organisation.description
  const actions = document.createElement('div')
  actions.className = 'organisation-card-actions'
  const message = document.createElement('textarea')
  message.maxLength = 1000
  message.rows = 3
  message.placeholder = 'Introduce yourself (optional)'
  message.setAttribute('aria-label', `Message to ${organisation.name}`)
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'button button-primary full-width'
  button.textContent = 'Apply to volunteer'
  button.dataset.organisationApply = organisation.id
  actions.append(message, button)
  body.append(title, description)
  if (organisation.website && /^https?:\/\//i.test(organisation.website)) {
    const website = document.createElement('a')
    website.className = 'text-link'
    website.href = organisation.website
    website.target = '_blank'
    website.rel = 'noopener noreferrer'
    website.textContent = 'Visit website'
    body.append(website)
  }
  body.append(actions)
  card.append(image, body)
  return card
}

function createEventCard(event) {
  const card = document.createElement('article')
  card.className = 'event-card'

  const image = document.createElement('div')
  image.className = `event-card-image category-${event.category.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  const category = document.createElement('span')
  category.className = 'event-category'
  category.textContent = event.category
  const places = document.createElement('span')
  places.className = 'event-places'
  places.textContent = `${event.available_places} ${event.available_places === 1 ? 'place' : 'places'} open`
  const illustration = document.createElement('div')
  illustration.className = 'event-illustration'
  const initial = document.createElement('span')
  initial.textContent = event.title.charAt(0).toUpperCase()
  illustration.append(initial)
  image.append(category, places, illustration)

  const body = document.createElement('div')
  body.className = 'event-card-body'
  const meta = document.createElement('div')
  meta.className = 'event-meta'
  const date = document.createElement('span')
  date.textContent = `${formatEventDate(event.event_date)} · ${event.start_time.slice(0, 5)}`
  const location = document.createElement('span')
  location.textContent = event.location
  meta.append(date, location)

  const title = document.createElement('h3')
  title.textContent = event.title
  const description = document.createElement('p')
  description.textContent = event.description
  const organisation = document.createElement('span')
  organisation.className = 'event-meta'
  organisation.textContent = event.organisations.name

  const actions = document.createElement('div')
  actions.className = 'organisation-card-actions'
  const message = document.createElement('textarea')
  message.maxLength = 1000
  message.rows = 3
  message.placeholder = 'Introduce yourself (optional)'
  message.setAttribute('aria-label', `Application message for ${event.title}`)
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'button button-primary full-width'
  button.textContent = 'Apply for this opportunity'
  button.dataset.eventApply = event.id
  actions.append(message, button)

  body.append(meta, title, description, organisation, actions)
  card.append(image, body)
  return card
}

let supabase
async function getAccessToken() {
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
function getCatalogueFilters() {
  const params = new URLSearchParams()
  if (searchInput.value.trim()) params.set('search', searchInput.value.trim())
  if (locationInput.value.trim()) params.set('location', locationInput.value.trim())
  return params
}

let eventRequestId = 0
async function loadEvents() {
  const currentRequestId = ++eventRequestId
  const params = getCatalogueFilters()
  showMessage(eventMessage, 'Loading opportunities…')
  eventEmptyState.hidden = true

  try {
    const query = params.toString()
    const response = await fetch(`/api/events${query ? `?${query}` : ''}`)
    let payload
    try {
      payload = await response.json()
    } catch {
      throw new Error('The server returned an invalid response while loading opportunities.')
    }
    if (!response.ok) throw new Error(payload.error?.message || 'Opportunities could not be loaded.')
    if (!Array.isArray(payload.events)) throw new Error('The server returned an invalid opportunity list.')
    if (currentRequestId !== eventRequestId) return

    eventList.replaceChildren(...payload.events.map(createEventCard))
    if (payload.events.length === 0) {
      const hasFilters = params.size > 0
      eventEmptyTitle.textContent = hasFilters
        ? 'No opportunities match your search'
        : 'No upcoming opportunities are available right now'
      eventEmptyDescription.textContent = hasFilters
        ? 'Try another search or location.'
        : 'Published upcoming opportunities from approved organisations will appear here.'
    }
    eventEmptyState.hidden = payload.events.length > 0
    hideMessage(eventMessage)
  } catch (error) {
    if (currentRequestId !== eventRequestId) return
    eventList.replaceChildren()
    eventEmptyState.hidden = true
    showMessage(eventMessage, error.message || 'Opportunities could not be loaded. Please try again.', 'error')
  }
}

let organisationRequestId = 0
async function loadOrganisations() {
  const currentRequestId = ++organisationRequestId
  const params = getCatalogueFilters()

  showMessage(organisationMessage, 'Loading organisations…')
  emptyState.hidden = true

  try {
    const query = params.toString()
    const response = await fetch(`/api/organisations${query ? `?${query}` : ''}`)
    let payload
    try {
      payload = await response.json()
    } catch {
      throw new Error('The server returned an invalid response while loading organisations.')
    }
    if (!response.ok) throw new Error(payload.error?.message || 'Organisations could not be loaded.')
    if (!Array.isArray(payload.organisations)) throw new Error('The server returned an invalid organisation list.')
    if (currentRequestId !== organisationRequestId) return

    organisationList.replaceChildren(...payload.organisations.map(createOrganisationCard))
    if (payload.organisations.length === 0) {
      const hasFilters = params.size > 0
      emptyStateTitle.textContent = hasFilters
        ? 'No organisations match your search'
        : 'No approved organisations are listed right now'
      emptyStateDescription.textContent = hasFilters
        ? 'Try another search or location.'
        : 'Approved community organisations will appear here when they join.'
    }
    emptyState.hidden = payload.organisations.length > 0
    hideMessage(organisationMessage)
  } catch (error) {
    if (currentRequestId !== organisationRequestId) return
    organisationList.replaceChildren()
    emptyState.hidden = true
    showMessage(organisationMessage, error.message || 'Organisations could not be loaded. Please try again.', 'error')
  }
}

async function submitApplication(button, endpoint, textarea) {
  button.disabled = true
  try {
    const token = await getAccessToken()
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ application_message: textarea.value })
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
    showMessage(organisationMessage, 'Your volunteer application has been sent.', 'success')
  } catch (error) {
    button.disabled = false
    showMessage(organisationMessage, error.message || 'Your application could not be submitted.', 'error',
      error.message?.includes('Sign in') ? { href: '/login.html', label: 'Log in' } : undefined)
  }
}

organisationList.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-organisation-apply]')
  if (!button) return
  const endpoint = `/api/organisations/${encodeURIComponent(button.dataset.organisationApply)}/applications`
  await submitApplication(button, endpoint, button.parentElement.querySelector('textarea'))
})

eventList.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-event-apply]')
  if (!button) return
  const endpoint = `/api/events/${encodeURIComponent(button.dataset.eventApply)}/registrations`
  await submitApplication(button, endpoint, button.parentElement.querySelector('textarea'))
})

let searchTimeout
for (const input of [searchInput, locationInput]) {
  input.addEventListener('input', () => {
    clearTimeout(searchTimeout)
    searchTimeout = setTimeout(() => {
      loadEvents()
      loadOrganisations()
    }, 250)
  })
}

loadEvents()
loadOrganisations()
