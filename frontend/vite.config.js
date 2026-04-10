import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Forward REST API calls to backend
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      // Forward Socket.IO to backend
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
