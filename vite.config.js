import { defineConfig } from 'vite'
import { resolve } from 'node:path'

const pages = [
  'index.html',
  'events.html',
  'organisation-details.html',
  'event-details.html',
  'about.html',
  'how-it-works.html',
  'contact.html',
  'register-volunteer.html',
  'register-organisation.html',
  'login.html',
  'admin-login.html',
  'reset-password.html',
  'dashboard-volunteer.html',
  'dashboard-organisation.html',
  'dashboard-admin.html',
  '404.html'
]

export default defineConfig({
  server: {
    hmr: true
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      input: Object.fromEntries(pages.map((page) => [page.replace('.html', ''), resolve(process.cwd(), page)]))
    }
  }
})
