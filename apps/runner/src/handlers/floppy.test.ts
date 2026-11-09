import { describe, expect, it } from "vitest";
import {
  applyFloppyToDomainXml,
  assertFloppyBootable,
  assertFloppySupported,
  bootOrderDevices,
  bootOrderXmlLines,
  buildFloppyDiskXml,
  domainArchMachine,
  findFloppyDisk,
} from "./floppy";

const q35Domain = `<domain type="kvm">
  <name>dos</name>
  <os>
    <type arch="x86_64" machine="pc-q35-8.2">hvm</type>
    <boot dev="hd"/>
  </os>
  <devices>
    <emulator>/usr/bin/qemu-system-x86_64</emulator>
    <disk type="file" device="disk">
      <driver name="qemu" type="qcow2"/>
      <source file="/var/lib/libvirt/images/dos.qcow2"/>
      <target dev="vda" bus="virtio"/>
    </disk>
    <interface type="bridge"><source bridge="virbr0"/></interface>
  </devices>
</domain>`;

const armDomain = q35Domain.replace(`arch="x86_64" machine="pc-q35-8.2"`, `arch="aarch64" machine="virt"`);

describe("buildFloppyDiskXml", () => {
  it("emits a raw fda disk on the fdc bus, write-protected by default", () => {
    const xml = buildFloppyDiskXml({ path: "/var/lib/libvirt/images/floppies/dos622.img" });
    expect(xml).toContain(`<disk type="file" device="floppy">`);
    expect(xml).toContain(`<driver name="qemu" type="raw"/>`);
    expect(xml).toContain(`<source file="/var/lib/libvirt/images/floppies/dos622.img"/>`);
    expect(xml).toContain(`<target dev="fda" bus="fdc"/>`);
    expect(xml).toContain("<readonly/>");
  });

  it("omits <readonly/> for a writable floppy and <source> for an empty drive", () => {
    const xml = buildFloppyDiskXml({ path: null, readonly: false });
    expect(xml).not.toContain("<source");
    expect(xml).not.toContain("<readonly");
    expect(xml).toContain(`bus="fdc"`);
  });

  it("escapes XML metacharacters in the path", () => {
    expect(buildFloppyDiskXml({ path: `/x/a&b'.img` })).toContain(`file="/x/a&amp;b&apos;.img"`);
  });
});

describe("assertFloppySupported", () => {
  it("accepts x86 q35 and i440fx", () => {
    expect(() => assertFloppySupported("x86_64", "pc-q35-8.2")).not.toThrow();
    expect(() => assertFloppySupported("x86_64", "pc-i440fx-8.2")).not.toThrow();
    expect(() => assertFloppySupported("i686", "pc")).not.toThrow();
  });

  it("refuses ARM64 and other arches with no floppy controller", () => {
    expect(() => assertFloppySupported("aarch64", "virt")).toThrow(/not available on aarch64/);
    expect(() => assertFloppySupported("ppc64le", "pseries")).toThrow(/x86 only/);
    expect(() => assertFloppySupported("x86_64", "microvm")).toThrow(/no ISA bus/);
  });
});

describe("applyFloppyToDomainXml", () => {
  it("adds drive A: after the last disk on a q35 domain", () => {
    const out = applyFloppyToDomainXml(q35Domain, { path: "/f/xp-f6.img" });
    const floppy = findFloppyDisk(out);
    expect(floppy).toMatchObject({ device: "fda", source: "/f/xp-f6.img", readonly: true });
    expect(out.indexOf(`device="floppy"`)).toBeGreaterThan(out.indexOf(`dev="vda"`));
    expect(out.indexOf(`device="floppy"`)).toBeLessThan(out.indexOf("<interface"));
    // Exactly one floppy, the original disk untouched.
    expect(out.match(/device="floppy"/g)).toHaveLength(1);
    expect(out).toContain(`<source file="/var/lib/libvirt/images/dos.qcow2"/>`);
  });

  it("replaces the medium of an existing drive instead of adding a second one", () => {
    const once = applyFloppyToDomainXml(q35Domain, { path: "/f/one.img" });
    const twice = applyFloppyToDomainXml(once, { path: "/f/two.img" });
    expect(twice.match(/device="floppy"/g)).toHaveLength(1);
    expect(findFloppyDisk(twice)?.source).toBe("/f/two.img");
  });

  it("keeps the write-protect setting when ejecting, and can remove the drive", () => {
    const writable = applyFloppyToDomainXml(q35Domain, { path: "/f/one.img", readonly: false });
    const ejected = applyFloppyToDomainXml(writable, { path: null });
    expect(findFloppyDisk(ejected)).toMatchObject({ source: null, readonly: false });
    const removed = applyFloppyToDomainXml(ejected, { path: null, remove: true });
    expect(findFloppyDisk(removed)).toBeUndefined();
    expect(removed).toContain(`dev="vda"`);
  });

  it("refuses a floppy on an aarch64 domain instead of generating invalid XML", () => {
    expect(() => applyFloppyToDomainXml(armDomain, { path: "/f/a.img" })).toThrow(/aarch64/);
  });

  it("inserts before </devices> when the domain has no disk", () => {
    const diskless = q35Domain.replace(/\s*<disk[\s\S]*?<\/disk>/, "");
    const out = applyFloppyToDomainXml(diskless, { path: "/f/a.img" });
    expect(out.indexOf(`device="floppy"`)).toBeLessThan(out.indexOf("</devices>"));
  });

  it("ignores a cdrom when looking for the floppy", () => {
    const withCd = q35Domain.replace("</devices>", `<disk type="file" device="cdrom"><target dev="sda" bus="sata"/></disk></devices>`);
    expect(findFloppyDisk(withCd)).toBeUndefined();
  });
});

describe("boot order", () => {
  it("puts fd first only when floppy boot is chosen", () => {
    expect(bootOrderDevices("fd")).toEqual(["fd", "hd", "cdrom", "network"]);
    expect(bootOrderDevices("cdrom")).toEqual(["cdrom", "hd", "network"]);
    expect(bootOrderXmlLines("fd").split("\n")[0]).toBe(`    <boot dev="fd"/>`);
  });

  it("refuses floppy boot under UEFI", () => {
    expect(() => assertFloppyBootable(true)).toThrow(/UEFI/);
    expect(() => assertFloppyBootable(false)).not.toThrow();
  });

  it("reads arch and machine from the domain", () => {
    expect(domainArchMachine(armDomain)).toEqual({ arch: "aarch64", machine: "virt" });
  });
});
