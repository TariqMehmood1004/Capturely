import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite for Tauri: a fixed port of its own (ReeliF Studio uses 1420), Rust sources not watched.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1430, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: { target: "es2022", sourcemap: false },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
