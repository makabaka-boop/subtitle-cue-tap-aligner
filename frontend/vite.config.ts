import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// During local development / Playwright the dev server proxies /api to the
// FastAPI service. In the Docker image the built assets are served by nginx,
// which performs the same proxy.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY_TARGET ?? "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
