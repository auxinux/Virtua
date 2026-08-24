import { describe, expect, it } from "vitest";
import { RunDockerSchema, RecreateDockerSchema, ComposeProjectSchema, DockerVolumeCreateSchema, DockerPruneSchema } from "./docker";

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

describe("RecreateDockerSchema", () => {
  it("accepts an empty object (no fields = preserve current config)", () => {
    expect(RecreateDockerSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a partial edit of ports, volumes, env, image and resources", () => {
    expect(RecreateDockerSchema.safeParse({
      image: "nginx:1.27",
      ports: [{ hostPort: 8080, containerPort: 80, protocol: "tcp" }],
      volumes: [{ hostPath: "/srv/web", containerPath: "/usr/share/nginx/html", mode: "ro" }],
      env: ["FOO=bar"],
      cpuLimit: 1.5,
      memoryMb: 512,
      restartPolicy: "always",
    }).success).toBe(true);
  });

  it("rejects an invalid port in a partial edit", () => {
    expect(RecreateDockerSchema.safeParse({ ports: [{ hostPort: 0, containerPort: 80 }] }).success).toBe(false);
  });
});

describe("ComposeProjectSchema", () => {
  it("requires composeYaml for save but not for down/ps", () => {
    expect(ComposeProjectSchema.safeParse({ name: "web", composeYaml: "services: {}" }).success).toBe(true);
    expect(ComposeProjectSchema.safeParse({ name: "web" }).success).toBe(true);
  });
});

describe("DockerVolumeCreateSchema", () => {
  it("accepts a name with optional driver", () => {
    expect(DockerVolumeCreateSchema.safeParse({ name: "data" }).success).toBe(true);
    expect(DockerVolumeCreateSchema.safeParse({ name: "data", driver: "local" }).success).toBe(true);
  });
});

describe("DockerPruneSchema", () => {
  it("defaults to all and validates the target enum", () => {
    expect(DockerPruneSchema.safeParse({}).success).toBe(true);
    expect(DockerPruneSchema.safeParse({ target: "images" }).success).toBe(true);
    expect(DockerPruneSchema.safeParse({ target: "bogus" }).success).toBe(false);
  });
});
