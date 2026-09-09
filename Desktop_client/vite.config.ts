import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import type { IncomingMessage } from "node:http";

function readBody(req: IncomingMessage) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const packageVersion = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
).version as string;

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(packageVersion),
  },
  plugins: [
    react(),
    {
      name: "virtua-dev-proxy",
      configureServer(server) {
        server.middlewares.use("/__virtua_proxy", async (req, res) => {
          try {
            const requestUrl = new URL(req.url ?? "", "http://127.0.0.1");
            const target = requestUrl.searchParams.get("url");
            if (!target || !/^https?:\/\//i.test(target)) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Invalid proxy target" }));
              return;
            }

            const body = req.method && req.method !== "GET" && req.method !== "HEAD" ? await readBody(req) : undefined;
            const headers = new Headers();
            for (const [name, value] of Object.entries(req.headers)) {
              if (!value || ["host", "origin", "referer"].includes(name.toLowerCase())) continue;
              headers.set(name, Array.isArray(value) ? value.join(", ") : value);
            }

            const upstream = await fetch(target, {
              method: req.method,
              headers,
              body,
            });

            const responseHeaders: Record<string, string> = {};
            upstream.headers.forEach((value, key) => {
              if (!["set-cookie"].includes(key.toLowerCase())) responseHeaders[key] = value;
            });
            res.writeHead(upstream.status, responseHeaders);
            res.end(Buffer.from(await upstream.arrayBuffer()));
          } catch (error) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Proxy failed" }));
          }
        });
      },
    },
  ],
  build: {
    target: "esnext",
  },
  optimizeDeps: {
    esbuildOptions: {
      target: "esnext",
    },
  },
  resolve: {
    alias: {
      "@": "/src",
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
});
