import { describe, expect, it } from "vitest";
import {
  BaseManifestSchema,
  CreateBaseSchema,
  DisposableActionSchema,
  ImportDepotBaseSchema,
  LaunchDisposableSchema,
  baseDomainHardware,
  isVmtmpFilename,
} from "./disposable";

// A manifest exactly as Virtua Desktop writes it (disposable.rs BaseManifest).
const desktopManifest = {
  id: "debian13-amd64-20261101120000",
  label: "Debian 13 (AMD64)",
  os: "debian13",
  architecture: "amd64",
  guestOs: "other",
  cpu: 2,
  memoryMib: 4096,
  diskGib: 60,
  createdAt: "1761998400",
  diskSha256: "a".repeat(64),
};

describe("BaseManifestSchema", () => {
  it("reads a Desktop manifest and fills its defaults", () => {
    const m = BaseManifestSchema.parse(desktopManifest);
    expect(m).toMatchObject({ diskBus: "virtio", networkModel: "virtio", gpuModel: "virtio", tpm2: false, secureBoot: false, format: 1, source: "" });
  });

  it("rejects unsafe ids and unknown formats", () => {
    expect(BaseManifestSchema.safeParse({ ...desktopManifest, id: "../etc" }).success).toBe(false);
    expect(BaseManifestSchema.safeParse({ ...desktopManifest, os: "a b" }).success).toBe(false);
    expect(BaseManifestSchema.safeParse({ ...desktopManifest, format: 2 }).success).toBe(false);
    expect(BaseManifestSchema.safeParse({ ...desktopManifest, architecture: "x86_64" }).success).toBe(false);
  });
});

describe("baseDomainHardware", () => {
  it("maps a Desktop Windows 11 base (Secure Boot, TPM, NVMe on ARM)", () => {
    const win = BaseManifestSchema.parse({ ...desktopManifest, os: "windows11", guestOs: "windows", gpuModel: "std", diskBus: "virtio", tpm2: true, secureBoot: true });
    expect(baseDomainHardware(win)).toMatchObject({ arch: "x86_64", machine: "q35", uefi: true, secureBoot: true, tpm: true, videoModel: "vga", diskBus: "virtio" });
    const winArm = BaseManifestSchema.parse({ ...desktopManifest, architecture: "arm64", guestOs: "windows", diskBus: "nvme", secureBoot: true, networkModel: "ne2k_pci" });
    expect(baseDomainHardware(winArm)).toMatchObject({ arch: "aarch64", machine: "virt", diskBus: "virtio", secureBoot: false, uefi: true, networkModel: "virtio" });
  });

  it("boots BIOS unless the base carries UEFI variables", () => {
    const deb = BaseManifestSchema.parse(desktopManifest);
    expect(baseDomainHardware(deb).uefi).toBe(false);
    expect(baseDomainHardware(deb, { hasUefiVars: true }).uefi).toBe(true);
  });

  it("keeps an old-PC base on i440FX (IDE) and never IDE with Secure Boot", () => {
    const dos = BaseManifestSchema.parse({ ...desktopManifest, diskBus: "ide", networkModel: "pcnet", machine: "pc", cpuModel: "486", periodSpeed: true });
    expect(baseDomainHardware(dos)).toMatchObject({ machine: "pc", diskBus: "ide", networkModel: "pcnet", cpuModel: "486", periodSpeed: true });
    const odd = BaseManifestSchema.parse({ ...desktopManifest, diskBus: "ide", secureBoot: true });
    expect(baseDomainHardware(odd)).toMatchObject({ machine: "q35", diskBus: "sata" });
  });
});

describe("request schemas", () => {
  it("validate launch, base creation, actions and depot names", () => {
    expect(LaunchDisposableSchema.parse({ baseId: "debian13-amd64-1", storagePool: "local" })).toMatchObject({ strict: false, noNetwork: false, start: true, bridge: "virbr0" });
    expect(LaunchDisposableSchema.safeParse({ baseId: "x", storagePool: "local", name: "1bad" }).success).toBe(false);
    expect(LaunchDisposableSchema.safeParse({ baseId: "x", storagePool: "local", bridge: "br0;rm" }).success).toBe(false);
    expect(CreateBaseSchema.parse({ vmName: "win11" })).toEqual({ vmName: "win11", os: "other", removeSource: false });
    expect(DisposableActionSchema.options).toEqual(["discard", "reset", "keep", "convert"]);
    expect(ImportDepotBaseSchema.safeParse({ name: "debian13-amd64.vmtmp" }).success).toBe(true);
    expect(isVmtmpFilename("../x.vmtmp")).toBe(false);
    expect(isVmtmpFilename("a/b.vmtmp")).toBe(false);
    expect(isVmtmpFilename("debian.tar.gz")).toBe(false);
  });
});
