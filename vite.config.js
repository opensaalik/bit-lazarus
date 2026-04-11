import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:3000";

export default defineConfig({
  root: "frontend",
  base: "/app/",
  plugins: [react()],
  server: {
    port: 5173,
    fs: {
      allow: [path.resolve(".")],
    },
    proxy: {
      "/auth": apiProxyTarget,
      "/users": apiProxyTarget,
      "/bounties": apiProxyTarget,
      "/verification-sessions": apiProxyTarget,
      "/contracts": apiProxyTarget,
      "/me": apiProxyTarget,
      "/health": apiProxyTarget,
      "/escrows": apiProxyTarget,
      "/wallets": apiProxyTarget,
      "/transactions": apiProxyTarget,
      "/peers": apiProxyTarget,
      "/events": apiProxyTarget,
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 700,
  },
});
