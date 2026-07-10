import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'HARNESS_')
  const backendTarget = env.HARNESS_BACKEND_PROXY_TARGET || 'http://127.0.0.1:11431'
  const proxy = (ws = false) => ({ target: backendTarget, changeOrigin: true, ws })

  return {
    base: '/bonsai/',
    plugins: [react()],
    server: {
      allowedHosts: ['localhost', '127.0.0.1'],
      hmr: false,
      proxy: {
        '/api': proxy(),
        '/gateway': proxy(),
        '/health': proxy(),
        '/mcp': proxy(),
        '/ws': proxy(true),
      },
    },
  }
})
