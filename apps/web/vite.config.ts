import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Relative base so the built PWA can be self-hosted from any path.
export default defineConfig({
  base: "./",
  plugins: [react()],
  server: { port: 5173 },
  build: { outDir: "dist", target: "es2022" },
});
