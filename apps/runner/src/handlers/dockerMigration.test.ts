import { describe, expect, it } from "vitest";
import { buildDockerMigrationManifest } from "./dockerMigration";

describe("buildDockerMigrationManifest", () => {
  it("preserves the container run configuration for a portable migration", () => {
    const manifest = buildDockerMigrationManifest({
      name: "nginx",
      ports: [{ hostPort: 8080, containerPort: 80, protocol: "tcp", hostIp: "127.0.0.1" }],
      env: ["MODE=prod"],
      mounts: [],
      networks: ["frontend"],
      privileged: false,
      restartPolicy: "unless-stopped",
      command: "nginx -g daemon off;",
      cpuLimit: 2,
      memoryMb: 512,
    }, "nginx-copy");

    expect(manifest).toMatchObject({
      name: "nginx-copy",
      ports: [{ hostPort: 8080, containerPort: 80, protocol: "tcp", hostIp: "127.0.0.1" }],
      env: ["MODE=prod"],
      network: "frontend",
      restartPolicy: "unless-stopped",
      cpuLimit: 2,
      memoryMb: 512,
    });
  });

  it("refuses mounted data instead of silently losing it", () => {
    expect(() => buildDockerMigrationManifest({
      name: "db",
      mounts: [{ type: "volume", source: "db-data", destination: "/var/lib/db", mode: "rw" }],
    }, "db-copy")).toThrow(/volumes or bind mounts/i);
  });
});
