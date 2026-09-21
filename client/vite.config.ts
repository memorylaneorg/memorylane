import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Production build output lands directly in server/public, which is where
// the Fastify server serves static assets from (see server/src/config/paths.ts).
export default defineConfig({
  plugins: [tailwindcss(), react()],
  build: {
    outDir: "../server/public",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4280",
        changeOrigin: true,
      },
    },
  },
});
