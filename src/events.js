import { getAccessToken } from './auth.js'

const eventList = document.querySelector('[data-volunteer-events-list]')
const eventMessage = document.querySelector('[data-volunteer-events-message]')
const emptyState = document.querySelector('[data-volunteer-events-empty]')
const eventFilters = document.querySelector('[data-event-filters]')

function showEventMessage(text, type = 'info', showLogin = false) {
  eventMessage.replaceChildren(document.createTextNode(text))
  if (showLogin) {
    const login = document.createElement('a')
    login.href = '/login.html'
    login.className = 'text-link'
    login.textContent = 'Log in'
    eventMessage.append(document.createTextNode(' '), login)
  }
  eventMessage.className = `notice notice-${type}`
  eventMessage.hidden = false
}

function createEventCard(event) {
  const card = document.createElement('article')
  card.className = 'event-card'

  const visual = document.createElement('div')
  visual.className = 'event-card-image'
  const category = document.createElement('span')
  category.className = 'event-category'
  category.textContent = event.category
  const places = document.createElement('span')
  places.className = 'event-places'
  places.textContent = event.available_places > 0 ? `${event.available_places} places` : 'Full'
  visual.append(category, places)

  const body = document.createElement('div')
  body.className = 'event-card-body'
  const meta = document.createElement('div')
  meta.className = 'event-meta'
  const date = new Date(`${event.event_date}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  const time = `${event.start_time.slice(0, 5)}–${event.end_time.slice(0, 5)}`
  const organisation = event.organisations?.name || 'Community organisation'
  meta.append(document.createTextNode(`${date} · ${time} · ${event.location}`))
  const title = document.createElement('h3')
  title.textContent = event.title
  const description = document.createElement('p')
  description.textContent = event.description
  const organiser = document.createElement('p')
  organiser.className = 'event-organiser'
  organiser.textContent = `Hosted by ${organisation}`
  const detailsLink = document.createElement('a')
  detailsLink.className = 'text-link'
  detailsLink.href = `/event-details.html?id=${encodeURIComponent(event.id)}`
  detailsLink.textContent = 'View opportunity details'

  const actions = document.createElement('div')
  actions.className = 'event-application-actions'
  const message = document.createElement('textarea')
  message.rows = 2
  message.maxLength = 1000
  message.placeholder = 'Introduce yourself (optional)'
  message.setAttribute('aria-label', `Message to ${organisation} about ${event.title}`)
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'button button-primary full-width'
  button.textContent = event.available_places > 0 ? 'Apply to this event' : 'Event is full'
  button.disabled = event.available_places <= 0
  button.dataset.eventApply = event.id
  actions.append(message, button)

  body.append(meta, title, description, organiser, detailsLink, actions)
  card.append(visual, body)
  return card
}

async function loadEvents() {
  try {
    const params = new URLSearchParams()
    for (const [field, selector] of Object.entries({ location: '[data-event-filter-location]', category: '[data-event-filter-category]', skill: '[data-event-filter-skill]', from: '[data-event-filter-from]', to: '[data-event-filter-to]', participation_type: '[data-event-filter-participation]' })) {
      const value = document.querySelector(selector)?.value.trim()
      if (value) params.set(field, value)
    }
    if (document.querySelector('[data-event-filter-available]')?.checked) params.set('available', 'true')
    const token = await getAccessToken()
    const response = await fetch(`/api/events${params.size ? `?${params}` : ''}`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    let payload
    try {
      payload = await response.json()
    } catch {
      throw new Error('The server returned an invalid response while loading events.')
    }
    if (!response.ok) throw new Error(payload.error?.message || 'Upcoming events could not be loaded.')
    if (!Array.isArray(payload.events)) throw new Error('The server returned an invalid event list.')
    eventList.replaceChildren(...payload.events.map(createEventCard))
    emptyState.hidden = payload.events.length > 0
    eventMessage.hidden = true
  } catch (error) {
    eventList.replaceChildren()
    emptyState.hidden = true
    showEventMessage(error.message || 'Upcoming events could not be loaded.', 'error')
  }
}

eventList.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-event-apply]')
  if (!button) return
  button.disabled = true
  try {
    const token = await getAccessToken()
    const response = await fetch(`/api/events/${encodeURIComponent(button.dataset.eventApply)}/registrations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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
    showEventMessage('Your event application has been sent.', 'success')
  } catch (error) {
    button.disabled = false
    showEventMessage(error.message || 'Your application could not be submitted.', 'error', error.message?.includes('Sign in'))
  }
})

eventFilters.addEventListener('submit', (event) => {
  event.preventDefault()
  loadEvents()
})

loadEvents()