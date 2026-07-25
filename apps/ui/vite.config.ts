import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import appPackage from "./package.json";

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(process.env.AUXINUX_NODE_VERSION ?? appPackage.version),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
        ws: true,
      },
    },
  },
  optimizeDeps: {
    exclude: ["@novnc/novnc", "@novnc/novnc/lib/rfb"],
    esbuildOptions: {
      target: "esnext",
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    target: "esnext",
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom", "react-router-dom"],
          query: ["@tanstack/react-query"],
          i18n: ["i18next", "react-i18next"],
        },
      },
    },
  },
});
