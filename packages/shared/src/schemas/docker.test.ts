import { describe, expect, it } from "vitest";
import { RunDockerSchema } from "./docker";

const basePayload = {
  name: "web",
  ports: [],
  volumes: [],
  env: [],
  restartPolicy: "unless-stopped" as const,
  privileged: false,
};

describe("RunDockerSchema", () => {
  it("accepts registry ports, tags, and digest image references", () => {
    for (const image of [
      "nginx:latest",
      "registry.example.com:5000/team/web:release-2026",
      "redis@sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    ]) {
      expect(RunDockerSchema.safeParse({ ...basePayload, image }).success).toBe(true);
    }
  });

  it("rejects image references with whitespace", () => {
    expect(RunDockerSchema.safeParse({ ...basePayload, image: "nginx:latest --privileged" }).success).toBe(false);
  });

  it("accepts an optional storage pool for Docker bind mounts", () => {
    expect(RunDockerSchema.safeParse({ ...basePayload, image: "nginx:latest", storagePool: "local" }).success).toBe(true);
  });

  it("accepts static network fields for routed or macvlan Docker containers", () => {
    expect(RunDockerSchema.safeParse({
      ...basePayload,
      image: "nginx:latest",
      network: "ovh-public",
      ipAddress: "149.56.244.245",
      macAddress: "02:00:00:09:42:48",
    }).success).toBe(true);
  });

  it("rejects invalid static Docker IP and MAC values", () => {
    expect(RunDockerSchema.safeParse({
      ...basePayload,
      image: "nginx:latest",
      network: "ovh-public",
      ipAddress: "149.56.244.999",
    }).success).toBe(false);
    expect(RunDockerSchema.safeParse({
      ...basePayload,
      image: "nginx:latest",
      network: "ovh-public",
      macAddress: "not-a-mac",
    }).success).toBe(false);
  });
});
