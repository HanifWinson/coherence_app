import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // The API (server/) runs separately; proxying keeps it same-origin so the
    // session cookie needs no CORS.
    proxy: { '/api': 'http://localhost:8787' },
  },
})
