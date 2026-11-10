import { describe, expect, it } from "vitest";
import { buildVmDomainXml, cdromTargets, type VmDomainSpec } from "./vmXml";
import { readVirtuaMetadata } from "./vmHardware";

const base: VmDomainSpec = {
  name: "vm1",
  vcpus: 2,
  memoryMb: 2048,
  arch: "x86_64",
  machine: "q35",
  bootDevice: "hd",
  disk: { path: "/pool/vm1.qcow2", bus: "virtio" },
  network: { bridge: "virbr0", model: "virtio" },
  videoModel: "virtio",
};

describe("buildVmDomainXml", () => {
  it("keeps the historical default domain (KVM, host-passthrough, virtio)", () => {
    const xml = buildVmDomainXml(base);
    expect(xml.startsWith(`<domain type="kvm">`)).toBe(true);
    expect(xml).toContain(`<cpu mode="host-passthrough" check="none" migratable="on"><topology sockets="1" cores="2" threads="1"/></cpu>`);
    expect(xml).toContain(`<target dev="vda" bus="virtio"/>`);
    expect(xml).toContain(`<model type="virtio"/>`);
    expect(xml).toContain(`<channel type="unix">`);
    expect(xml).not.toContain("metadata");
    expect(xml).not.toContain("qemu:commandline");
  });

  it("builds an old PC: i440FX, IDE disk + IDE CD-ROM, NE2000, boot floppy, 486 at period speed", () => {
    const xml = buildVmDomainXml({
      ...base,
      name: "dos",
      vcpus: 1,
      memoryMb: 16,
      machine: "pc",
      bootDevice: "fd",
      disk: { path: "/pool/dos.qcow2", bus: "ide" },
      cdroms: ["/isos/drivers.iso"],
      floppy: { path: "/floppies/dos622.img", readonly: true },
      network: { bridge: "virbr0", model: "ne2k_pci" },
      videoModel: "vga",
      cpuModel: "486",
      periodSpeed: true,
    });
    expect(xml).toMatch(/<domain type="qemu" xmlns:qemu=/);
    expect(xml).toContain(`machine="pc"`);
    expect(xml).toContain(`<target dev="hda" bus="ide"/>`);
    expect(xml).toContain(`<target dev="hdb" bus="ide"/>`);
    expect(xml).toContain(`<target dev="fda" bus="fdc"/>`);
    expect(xml).toContain(`<model type="ne2k_pci"/>`);
    expect(xml).toContain(`<model fallback="forbid">486</model>`);
    expect(xml).toContain(`<qemu:arg value="shift=4,sleep=on"/>`);
    expect(xml.indexOf(`<boot dev="fd"/>`)).toBeLessThan(xml.indexOf(`<boot dev="hd"/>`));
    expect(readVirtuaMetadata(xml)).toEqual({ cpuModel: "486", periodSpeed: true });
  });

  it("supports a diskless/NIC-less domain, transient disks, direct kernel boot and metadata", () => {
    const noNet = buildVmDomainXml({ ...base, network: null });
    expect(noNet).not.toContain("<interface");

    const strict = buildVmDomainXml({
      ...base,
      disk: { path: "/pool/jetable.qcow2", bus: "virtio", transient: true },
      metadata: { disposable: { baseId: "debian13-amd64-1", baseLabel: "Debian 13 (AMD64)", strict: true } },
    });
    expect(strict).toMatch(/<target dev="vda" bus="virtio"\/>\n      <transient\/>\n    <\/disk>/);
    expect(readVirtuaMetadata(strict).disposable).toEqual({ baseId: "debian13-amd64-1", baseLabel: "Debian 13 (AMD64)", strict: true });

    const installer = buildVmDomainXml({
      ...base,
      directKernel: { kernel: "/ai/vm1/linux", initrd: "/ai/vm1/initrd-preseed.gz", cmdline: "auto=true priority=critical hostname=vm1 ---" },
    });
    expect(installer).toContain(`<kernel>/ai/vm1/linux</kernel>\n    <initrd>/ai/vm1/initrd-preseed.gz</initrd>\n    <cmdline>auto=true priority=critical hostname=vm1 ---</cmdline>`);
    // Inside <os>, before the boot order.
    expect(installer.indexOf("<kernel>")).toBeLessThan(installer.indexOf(`<boot dev="hd"/>`));
  });

  it("escapes values that end up in attributes and text", () => {
    const xml = buildVmDomainXml({ ...base, directKernel: { kernel: "/k", initrd: "/i", cmdline: `a<b & "c"` } });
    expect(xml).toContain(`<cmdline>a&lt;b &amp; &quot;c&quot;</cmdline>`);
  });

  it("places Windows install media: installer + driver CD on SATA next to a virtio disk, UEFI lines kept", () => {
    const xml = buildVmDomainXml({
      ...base,
      firmwareLines: `    <loader readonly="yes" secure="yes" type="pflash">/usr/share/OVMF/OVMF_CODE_4M.ms.fd</loader>`,
      secureBoot: true,
      bootDevice: "cdrom",
      cdroms: ["/isos/Win11.iso", "/isos/virtio-win.iso"],
      tpm: true,
      videoModel: "qxl",
    });
    expect(xml).toContain(`<source file="/isos/Win11.iso"/>\n      <target dev="sda" bus="sata"/>`);
    expect(xml).toContain(`<source file="/isos/virtio-win.iso"/>\n      <target dev="sdb" bus="sata"/>`);
    expect(xml).toContain(`<smm state="on"/>`);
    expect(xml).toContain(`<tpm model="tpm-crb">`);
    expect(xml.indexOf("<loader")).toBeGreaterThan(xml.indexOf("<type "));
  });
});

describe("cdromTargets", () => {
  it("never collides with the primary disk", () => {
    expect(cdromTargets("virtio", 2)).toEqual([{ dev: "sda", bus: "sata" }, { dev: "sdb", bus: "sata" }]);
    expect(cdromTargets("sata", 1)).toEqual([{ dev: "sdb", bus: "sata" }]);
    expect(cdromTargets("ide", 2)).toEqual([{ dev: "hdb", bus: "ide" }, { dev: "hdc", bus: "ide" }]);
    expect(cdromTargets(undefined, 1)).toEqual([{ dev: "sda", bus: "sata" }]);
    expect(() => cdromTargets("ide", 4)).toThrow(/four/);
  });
});
