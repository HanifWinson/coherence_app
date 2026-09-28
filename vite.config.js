import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // Two pages: the app, and the public pre-sell landing page (gtm/README.md).
    rollupOptions: { input: { main: 'index.html', landing: 'landing.html' } },
  },
  server: {
    // The API (server/) runs separately; proxying keeps it same-origin so the
    // session cookie needs no CORS.
    proxy: { '/api': 'http://localhost:8787' },
  },
})
