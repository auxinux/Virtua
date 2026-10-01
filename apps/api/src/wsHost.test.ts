import { describe, expect, it } from "vitest";
import { clientHost, isLoopbackHost, webOrigin } from "./wsHost.js";

describe("console WebSocket host", () => {
  it("ignores the Tauri origin of the macOS desktop client", () => {
    const headers = { origin: "tauri://localhost", host: "virtua.lan:8441" };
    expect(webOrigin(headers)).toBeNull();
    expect(clientHost(headers)).toBe("virtua.lan:8441");
    expect(isLoopbackHost(clientHost(headers))).toBe(false);
  });

  it("ignores the Tauri origin of the Windows desktop client", () => {
    const headers = { origin: "http://tauri.localhost", host: "10.0.0.5:8441" };
    expect(clientHost(headers)).toBe("10.0.0.5:8441");
  });

  it("keeps a real web origin (the Vite dev proxy serves the UI elsewhere)", () => {
    const headers = { origin: "http://dev.lan:5173", host: "127.0.0.1:8441" };
    expect(clientHost(headers)).toBe("dev.lan:5173");
  });

  it("falls back to the reverse proxy's forwarded host", () => {
    expect(clientHost({ "x-forwarded-host": "virtua.example.net, proxy", host: "127.0.0.1:8441" })).toBe("virtua.example.net");
  });

  it("treats loopback and empty hosts as unreachable", () => {
    expect(isLoopbackHost("localhost:8441")).toBe(true);
    expect(isLoopbackHost("[::1]:8441")).toBe(true);
    expect(isLoopbackHost("")).toBe(true);
    expect(isLoopbackHost("virtua.lan:8441")).toBe(false);
  });
});
