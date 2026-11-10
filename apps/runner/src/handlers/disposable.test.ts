import { describe, expect, it } from "vitest";
import {
  assertBaseId,
  assertStandaloneQcow2,
  convertedDomainXml,
  domainNvramPath,
  hostBaseArch,
  manifestFromDomain,
  newBaseId,
  parseTarListing,
  primaryWritableDisk,
  selectVmtmpMembers,
} from "./disposable";
import { buildVmDomainXml } from "./vmXml";
import { readVirtuaMetadata, writeVirtuaMetadata } from "./vmHardware";

// GNU `tar -tvf` output of a Desktop .vmtmp (tar crate, no "./" prefix).
const listing = [
  "-rw-r--r-- 0/0             412 2026-11-01 12:00 manifest.json",
  "-rw-r--r-- user/user 1234567890 2026-11-01 12:00 disk.qcow2",
  "-rw-r--r-- user/user     540672 2026-11-01 12:00 disk.secboot-vars.fd",
].join("\n");

describe(".vmtmp checks", () => {
  it("lists and selects the manifest, disk and UEFI stores", () => {
    const entries = parseTarListing(listing);
    expect(entries.map((e) => [e.type, e.name, e.size])).toEqual([
      ["-", "manifest.json", 412],
      ["-", "disk.qcow2", 1234567890],
      ["-", "disk.secboot-vars.fd", 540672],
    ]);
    expect(selectVmtmpMembers(entries)).toEqual({ manifest: "manifest.json", disk: "disk.qcow2", vars: ["disk.secboot-vars.fd"] });
  });

  it("accepts ./ prefixes, ignores extra files and nested paths", () => {
    const entries = parseTarListing([
      "drwxr-xr-x 0/0 0 2026-11-01 12:00 ./",
      "-rw-r--r-- 0/0 10 2026-11-01 12:00 ./manifest.json",
      "-rw-r--r-- 0/0 10 2026-11-01 12:00 ./disk.qcow2",
      "-rw-r--r-- 0/0 10 2026-11-01 12:00 ./notes.txt",
      "-rw-r--r-- 0/0 10 2026-11-01 12:00 tpm/state.bin",
      "-rw-r--r-- 0/0 10 2026-11-01 12:00 sub/disk.qcow2",
    ].join("\n"));
    expect(selectVmtmpMembers(entries)).toEqual({ manifest: "./manifest.json", disk: "./disk.qcow2", vars: [] });
  });

  it("refuses links and archives without a disk or manifest", () => {
    const withLink = parseTarListing(`${listing}\nlrwxrwxrwx 0/0 0 2026-11-01 12:00 disk.x.fd -> /etc/shadow`);
    expect(() => selectVmtmpMembers(withLink)).toThrow(/link/);
    expect(() => selectVmtmpMembers(parseTarListing("-rw-r--r-- 0/0 1 2026-11-01 12:00 manifest.json"))).toThrow(/disk/);
    expect(() => selectVmtmpMembers(parseTarListing("-rw-r--r-- 0/0 1 2026-11-01 12:00 disk.qcow2"))).toThrow(/manifest/);
  });

  it("refuses a base disk with a backing file or another format", () => {
    expect(() => assertStandaloneQcow2({ format: "qcow2" })).not.toThrow();
    expect(() => assertStandaloneQcow2({ format: "qcow2", "backing-filename": "/etc/shadow" })).toThrow(/backing/);
    expect(() => assertStandaloneQcow2({ format: "raw" })).toThrow(/qcow2/);
  });
});

describe("ids", () => {
  it("builds Desktop-style ids and rejects traversal", () => {
    expect(newBaseId("debian13", "amd64", new Date("2026-11-10T05:06:07Z"))).toBe("debian13-amd64-20261110050607");
    expect(() => assertBaseId("../x")).toThrow();
    expect(() => assertBaseId("a/b")).toThrow();
    expect(hostBaseArch("x64")).toBe("amd64");
    expect(hostBaseArch("arm64")).toBe("arm64");
    expect(hostBaseArch("ia32")).toBeUndefined();
  });
});

const winXml = buildVmDomainXml({
  name: "win11",
  vcpus: 4,
  memoryMb: 4096,
  arch: "x86_64",
  machine: "pc-q35-10.0",
  firmwareLines: `    <loader readonly="yes" secure="yes" type="pflash">/usr/share/OVMF/OVMF_CODE_4M.ms.fd</loader>\n    <nvram template="/usr/share/OVMF/OVMF_VARS_4M.ms.fd">/var/lib/libvirt/qemu/nvram/win11_VARS.fd</nvram>`,
  secureBoot: true,
  bootDevice: "hd",
  disk: { path: "/pool/win11.qcow2", bus: "virtio" },
  cdroms: ["/isos/virtio-win.iso"],
  network: { bridge: "virbr0", model: "e1000" },
  tpm: true,
  videoModel: "qxl",
});

describe("manifestFromDomain", () => {
  it("describes the VM's hardware in the Desktop manifest format", () => {
    const m = manifestFromDomain(winXml, { id: "windows11-amd64-1", label: "Windows 11 (AMD64)", os: "windows11", diskGib: 80, createdAt: "2026-11-10T00:00:00.000Z" });
    expect(m).toMatchObject({
      architecture: "amd64",
      guestOs: "windows",
      cpu: 4,
      memoryMib: 4096,
      diskGib: 80,
      diskBus: "virtio",
      networkModel: "e1000",
      gpuModel: "qxl",
      tpm2: true,
      secureBoot: true,
      uefi: true,
      machine: "q35",
      source: "local",
      format: 1,
    });
    expect(domainNvramPath(winXml)).toBe("/var/lib/libvirt/qemu/nvram/win11_VARS.fd");
    // The CD-ROM is read-only, the system disk is the virtio one.
    expect(primaryWritableDisk(winXml)?.source).toBe("/pool/win11.qcow2");
  });

  it("keeps an old PC's CPU choice and reads libvirt's KiB memory", () => {
    const dos = buildVmDomainXml({
      name: "dos", vcpus: 1, memoryMb: 32, arch: "x86_64", machine: "pc", bootDevice: "hd",
      disk: { path: "/pool/dos.qcow2", bus: "ide" }, network: { bridge: "virbr0", model: "pcnet" },
      videoModel: "vga", cpuModel: "286", periodSpeed: true,
    }).replace(`<memory unit="MiB">32</memory>`, `<memory unit='KiB'>32768</memory>`);
    const m = manifestFromDomain(dos, { id: "other-amd64-1", label: "DOS", os: "other", diskGib: 1, createdAt: "" });
    expect(m).toMatchObject({ memoryMib: 64, diskBus: "ide", networkModel: "pcnet", gpuModel: "std", machine: "pc", cpuModel: "286", periodSpeed: true, uefi: false });
  });
});

describe("convertedDomainXml", () => {
  it("points the disk at the flat copy and forgets the disposable state", () => {
    const disposable = writeVirtuaMetadata(
      buildVmDomainXml({
        name: "jetable-debian13-1", vcpus: 2, memoryMb: 4096, arch: "x86_64", machine: "q35", bootDevice: "hd",
        disk: { path: "/pool/jetable-debian13-1.qcow2", bus: "virtio", transient: true },
        network: null, videoModel: "virtio",
      }),
      { disposable: { baseId: "debian13-amd64-1", baseLabel: "Debian 13", strict: true } },
    );
    const out = convertedDomainXml(disposable, "/pool/jetable-debian13-1.qcow2", "/pool/jetable-debian13-1-1.qcow2");
    expect(out).toContain(`<source file="/pool/jetable-debian13-1-1.qcow2"/>`);
    expect(out).not.toContain("<transient");
    expect(readVirtuaMetadata(out).disposable).toBeUndefined();
    expect(() => convertedDomainXml(disposable, "/other.qcow2", "/x.qcow2")).toThrow(/overlay/);
  });
});
