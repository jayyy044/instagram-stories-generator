import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Proxy keeps the backend same-origin in dev, so it needs no CORS handling.
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8002',
    },
  },
})
