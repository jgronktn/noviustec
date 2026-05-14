import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// Dev server proxies /api/* and /webhooks/* to the local backend so the
// frontend can use relative URLs (matches the same-origin pattern in prod
// where nginx routes both apex domains through the same TLS termination).
//
// Production: build with VITE_API_URL=https://api.noviustec.com (set in
// .env.production) so the bundled JS hits the real backend.
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/webhooks": "http://127.0.0.1:3000",
      "/health": "http://127.0.0.1:3000",
    },
  },
  build: {
    sourcemap: true,
  },
});
