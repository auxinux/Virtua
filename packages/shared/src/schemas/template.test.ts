import { describe, it, expect } from "vitest";
import {
  TemplateMetaSchema,
  UpdateTemplateSchema,
  CreateResourceSchema,
  parseVirtuaConfig,
  isUnsafeArchivePath,
  archToQemu,
  qemuToArch,
} from "./template";

describe("archToQemu / qemuToArch", () => {
  it("maps portable arch to QEMU arch", () => {
    expect(archToQemu("amd64")).toBe("x86_64");
    expect(archToQemu("arm64")).toBe("aarch64");
  });

  it("maps QEMU/portable arch strings back, defaulting to amd64", () => {
    expect(qemuToArch("x86_64")).toBe("amd64");
    expect(qemuToArch("aarch64")).toBe("arm64");
    expect(qemuToArch("ARM64")).toBe("arm64");
    expect(qemuToArch(undefined)).toBe("amd64");
    expect(qemuToArch("sparc")).toBe("amd64");
  });
});

describe("parseVirtuaConfig", () => {
  it("parses a well-formed config.virtua", () => {
    const raw = [
      "[CONFIG VM TEMPLATE]",
      "Name=Debian 13.5 AMD64",
      "Desc=Debian 13.5 preconfigure pour Virtua",
      "CPU=2",
      "RAM=2048",
      "DISK=debian.qcow2",
      "ARCH=amd64",
    ].join("\n");
    expect(parseVirtuaConfig(raw)).toEqual({
      name: "Debian 13.5 AMD64",
      desc: "Debian 13.5 preconfigure pour Virtua",
      cpu: 2,
      ram: 2048,
      disk: "debian.qcow2",
      arch: "amd64",
    });
  });

  it("ignores comments, blank lines and the section header", () => {
    const raw = "# a comment\n; another\n\n[CONFIG VM TEMPLATE]\nName=X\n";
    expect(parseVirtuaConfig(raw)).toEqual({ name: "X" });
  });

  it("returns no usable name for an invalid config", () => {
    expect(parseVirtuaConfig("garbage without equals").name).toBeUndefined();
  });
});

describe("isUnsafeArchivePath", () => {
  it("accepts normal relative members", () => {
    expect(isUnsafeArchivePath("config.virtua")).toBe(false);
    expect(isUnsafeArchivePath("disks/debian.qcow2")).toBe(false);
  });

  it("rejects absolute paths and home expansion", () => {
    expect(isUnsafeArchivePath("/etc/passwd")).toBe(true);
    expect(isUnsafeArchivePath("~/.ssh/authorized_keys")).toBe(true);
  });

  it("rejects path traversal segments", () => {
    expect(isUnsafeArchivePath("../../etc/shadow")).toBe(true);
    expect(isUnsafeArchivePath("a/b/../../../etc")).toBe(true);
  });
});

describe("TemplateMetaSchema", () => {
  it("accepts the sidecar JSON format and coerces stringy numbers", () => {
    const parsed = TemplateMetaSchema.parse({
      Name: "Debian 13.5 AMD64",
      Desc: "x",
      CPU: "2",
      RAM: "2048",
      DISK: "debian.qcow2",
      ARCH: "amd64",
    });
    expect(parsed.CPU).toBe(2);
    expect(parsed.RAM).toBe(2048);
  });

  it("requires a Name", () => {
    expect(TemplateMetaSchema.safeParse({ Desc: "no name" }).success).toBe(false);
  });
});

describe("UpdateTemplateSchema", () => {
  it("rejects unknown fields (strict)", () => {
    expect(UpdateTemplateSchema.safeParse({ filename: "x.tar.gz" }).success).toBe(false);
  });

  it("accepts a visibility + tags edit", () => {
    expect(UpdateTemplateSchema.safeParse({ visibility: "public", tags: ["debian"] }).success).toBe(true);
  });
});

describe("CreateResourceSchema", () => {
  it("requires either templateId or isoId", () => {
    expect(CreateResourceSchema.safeParse({ type: "vm", name: "web1" }).success).toBe(false);
  });

  it("accepts creation from a template", () => {
    const r = CreateResourceSchema.safeParse({ type: "vm", name: "web1", templateId: "abc", cpu: 4 });
    expect(r.success).toBe(true);
  });

  it("accepts creation from an ISO with overrides", () => {
    const r = CreateResourceSchema.safeParse({
      type: "vm", name: "win1", isoId: "iso-1", disk: 60, architecture: "arm64", networkModel: "e1000",
    });
    expect(r.success).toBe(true);
  });

  it("rejects an invalid VM name", () => {
    expect(CreateResourceSchema.safeParse({ type: "vm", name: "1bad", templateId: "x" }).success).toBe(false);
  });
});
