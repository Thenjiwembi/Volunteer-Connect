import { getAccessToken } from './auth.js'

const message = document.querySelector('[data-event-detail-message]')
const detail = document.querySelector('[data-event-detail]')
const form = document.querySelector('[data-event-detail-application]')
const eventId = new URLSearchParams(window.location.search).get('id')

function showMessage(text, type = 'info', showLogin = false) {
  message.replaceChildren(document.createTextNode(text))
  if (showLogin) {
    const link = document.createElement('a')
    link.href = '/login.html'
    link.className = 'text-link'
    link.textContent = 'Log in'
    message.append(document.createTextNode(' '), link)
  }
  message.className = `notice notice-${type}`
  message.hidden = false
}

async function loadEvent() {
  if (!eventId) throw new Error('Choose an opportunity from the directory to view its details.')
  const token = await getAccessToken()
  const response = await fetch(`/api/events/${encodeURIComponent(eventId)}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new Error('The server returned an invalid response while loading this opportunity.')
  }
  if (!response.ok) throw new Error(payload.error?.message || 'This opportunity could not be found.')
  const event = payload.event
  document.title = `${event.title} | Volunteer Connect`
  document.querySelector('[data-event-category]').textContent = event.category
  document.querySelector('[data-event-organisation]').textContent = `Hosted by ${event.organisations?.name || 'Community organisation'}`
  document.querySelector('[data-event-title]').textContent = event.title
  const date = new Date(`${event.event_date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  document.querySelector('[data-event-meta]').textContent = `${date} · ${event.start_time.slice(0, 5)}–${event.end_time.slice(0, 5)} · ${event.location} · ${event.participation_type.replace('_', ' ')}`
  document.querySelector('[data-event-description]').textContent = event.description
  const availablePlaces = payload.event.available_places
  document.querySelector('[data-event-places]').textContent = availablePlaces > 0 ? `${availablePlaces} volunteer places remain.` : 'This event is full.'
  const requirements = document.querySelector('[data-event-requirements]')
  const skills = document.querySelector('[data-event-required-skills]')
  if (event.eligibility) document.querySelector('[data-event-eligibility]').textContent = event.eligibility
  skills.replaceChildren(...(event.required_skills || []).map((skill) => {
    const item = document.createElement('li')
    item.textContent = skill
    return item
  }))
  requirements.hidden = !event.eligibility && !(event.required_skills || []).length
  const button = form.querySelector('[type="submit"]')
  button.disabled = availablePlaces <= 0
  if (availablePlaces <= 0) button.textContent = 'Event is full'
  detail.hidden = false
  message.hidden = true
}

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  const button = form.querySelector('[type="submit"]')
  button.disabled = true
  try {
    const token = await getAccessToken()
    const response = await fetch(`/api/events/${encodeURIComponent(eventId)}/registrations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ application_message: form.elements.application_message.value })
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
    showMessage('Your application has been sent to the organisation.', 'success')
  } catch (error) {
    button.disabled = false
    showMessage(error.message || 'Your application could not be submitted.', 'error', error.message?.includes('Sign in'))
  }
})

loadEvent().catch((error) => showMessage(error.message || 'This opportunity could not be loaded.', 'error'))
