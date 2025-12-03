import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
const proxiedPaths = ["/api", "/subscribe", "/push", "/vapid-public-key", "/health"];

const makeProxyConfig = () =>
  proxiedPaths.reduce((acc, path) => {
    acc[path] = {
      target: "http://localhost:3001",
      changeOrigin: true,
    };
    return acc;
  }, {});

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: makeProxyConfig(),
  },
  preview: {
    port: 4173,
    proxy: makeProxyConfig(),
  },
})
