import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const localApiPort = process.env.TRASHPAL_LOCAL_DEMO_PORT ?? '3211'

/**
 * The web client never chooses a backend host in production. In development,
 * its same-origin `/v1` requests proxy only to the local API process.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 3212,
    strictPort: true,
    proxy: {
      '/v1': {
        target: `http://127.0.0.1:${localApiPort}`,
        changeOrigin: false,
      },
    },
  },
})
