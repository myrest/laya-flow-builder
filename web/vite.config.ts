import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const workspaceDirectory = fileURLToPath(new URL("..", import.meta.url));
const apiPort = Number(process.env.API_PORT ?? 3000);

export default defineConfig({
  plugins: [react()],
  root: fileURLToPath(new URL(".", import.meta.url)),
  server: {
    fs: { allow: [workspaceDirectory] },
    proxy: {
      "/api": `http://127.0.0.1:${apiPort}`,
      "/health": `http://127.0.0.1:${apiPort}`,
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
