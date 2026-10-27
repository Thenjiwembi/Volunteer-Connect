import { getAccessToken } from './organisations.js'

const message = document.querySelector('[data-organisation-detail-message]')
const detail = document.querySelector('[data-organisation-detail]')
const imageFrame = document.querySelector('[data-organisation-detail-image]')
const imageFallback = document.querySelector('[data-organisation-detail-fallback]')
const applicationForm = document.querySelector('[data-organisation-detail-application]')
const organisationId = new URLSearchParams(window.location.search).get('id')

function showMessage(text, type = 'info', showLogin = false) {
  message.replaceChildren(document.createTextNode(text))
  if (showLogin) {
    const login = document.createElement('a')
    login.href = '/login.html'
    login.className = 'text-link'
    login.textContent = 'Log in'
    message.append(document.createTextNode(' '), login)
  }
  message.className = `notice notice-${type}`
  message.hidden = false
}

function displayOrganisation(organisation) {
  document.title = `${organisation.name} | Volunteer Connect`
  document.querySelector('[data-organisation-detail-location]').textContent = organisation.location
  document.querySelector('[data-organisation-detail-name]').textContent = organisation.name
  document.querySelector('[data-organisation-detail-description]').textContent = organisation.description
  imageFallback.textContent = organisation.name.charAt(0).toUpperCase()
  if (organisation.image_url && /^https:\/\//i.test(organisation.image_url)) {
    const photo = document.createElement('img')
    photo.src = organisation.image_url
    photo.alt = `Work by ${organisation.name}`
    photo.addEventListener('error', () => photo.remove())
    imageFrame.prepend(photo)
  }
  const website = document.querySelector('[data-organisation-detail-website]')
  if (organisation.website && /^https:\/\//i.test(organisation.website)) {
    website.href = organisation.website
    website.hidden = false
  }
  detail.hidden = false
  message.hidden = true
}

async function loadOrganisation() {
  if (!organisationId) throw new Error('Choose an organisation from the directory to view its profile.')
  const response = await fetch(`/api/organisations/${encodeURIComponent(organisationId)}`)
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new Error('The server returned an invalid response while loading this organisation.')
  }
  if (!response.ok) throw new Error(payload.error?.message || 'This organisation could not be found.')
  displayOrganisation(payload.organisation)
}

applicationForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const button = applicationForm.querySelector('[type="submit"]')
  button.disabled = true
  try {
    const token = await getAccessToken()
    const response = await fetch(`/api/organisations/${encodeURIComponent(organisationId)}/applications`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ application_message: applicationForm.elements.application_message.value })
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
    showMessage(error.message || 'Your application could not be submitted.', 'error', error.message?.includes('Sign in'))
  }
})

loadOrganisation().catch((error) => showMessage(error.message || 'This organisation could not be loaded.', 'error'))