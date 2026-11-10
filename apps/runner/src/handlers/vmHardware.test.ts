import { describe, expect, it } from "vitest";
import {
  applyCpuChoice,
  applyMachineType,
  applyPeriodSpeed,
  buildCpuXml,
  domainCpuModel,
  domainIcountShift,
  domainVirtType,
  mergeVirtuaMetadata,
  readVirtuaMetadata,
  writeVirtuaMetadata,
} from "./vmHardware";

// Shaped like `virsh dumpxml --inactive` output (single quotes, addresses).
const q35Domain = `<domain type='kvm'>
  <name>dos</name>
  <uuid>8f0c7c8e-0000-4000-8000-000000000001</uuid>
  <memory unit='KiB'>65536</memory>
  <vcpu placement='static'>1</vcpu>
  <os>
    <type arch='x86_64' machine='pc-q35-10.0'>hvm</type>
    <boot dev='hd'/>
  </os>
  <features><acpi/><apic/></features>
  <cpu mode='host-passthrough' check='none' migratable='on'><topology sockets='1' cores='1' threads='1'/></cpu>
  <devices>
    <emulator>/usr/bin/qemu-system-x86_64</emulator>
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2'/>
      <source file='/p/dos.qcow2'/>
      <target dev='sda' bus='sata'/>
      <address type='drive' controller='0' bus='0' target='0' unit='0'/>
    </disk>
    <controller type='sata' index='0'>
      <address type='pci' domain='0x0000' bus='0x00' slot='0x1f' function='0x2'/>
    </controller>
    <controller type='pci' index='0' model='pcie-root'/>
    <controller type='pci' index='1' model='pcie-root-port'>
      <model name='pcie-root-port'/>
      <target chassis='1' port='0x10'/>
      <address type='pci' domain='0x0000' bus='0x00' slot='0x02' function='0x0' multifunction='on'/>
    </controller>
    <controller type='usb' index='0' model='qemu-xhci'>
      <address type='pci' domain='0x0000' bus='0x02' slot='0x00' function='0x0'/>
    </controller>
    <interface type='bridge'>
      <mac address='52:54:00:12:34:56'/>
      <source bridge='virbr0'/>
      <model type='virtio'/>
      <driver name='vhost' queues='1'/>
      <address type='pci' domain='0x0000' bus='0x01' slot='0x00' function='0x0'/>
    </interface>
    <hostdev mode='subsystem' type='pci' managed='yes'>
      <source><address domain='0x0000' bus='0x03' slot='0x00' function='0x0'/></source>
      <address type='pci' domain='0x0000' bus='0x05' slot='0x00' function='0x0'/>
    </hostdev>
  </devices>
</domain>`;

describe("Virtua metadata", () => {
  it("round-trips the CPU choice and the disposable state", () => {
    const xml = writeVirtuaMetadata(q35Domain, {
      cpuModel: "286",
      periodSpeed: true,
      disposable: { baseId: "debian13-amd64-1", baseLabel: `Debian "13" & co`, strict: true },
    });
    expect(xml).toContain(`<virtua:vm xmlns:virtua="https://auxinux.ca/virtua/1.0">`);
    expect(readVirtuaMetadata(xml)).toEqual({
      cpuModel: "286",
      periodSpeed: true,
      disposable: { baseId: "debian13-amd64-1", baseLabel: `Debian "13" & co`, strict: true },
    });
    // Inserted once, after <name>.
    expect(xml.match(/<metadata>/g)).toHaveLength(1);
    expect(xml.indexOf("<metadata>")).toBeGreaterThan(xml.indexOf("</name>"));
  });

  it("reads what libvirt writes back (other prefix, single quotes) and keeps foreign metadata", () => {
    const libvirtStyle = q35Domain.replace("</name>", `</name>
  <metadata>
    <libosinfo:libosinfo xmlns:libosinfo='http://libosinfo.org/xmlns/libvirt/domain/1.0'><libosinfo:os id='http://debian.org/debian/13'/></libosinfo:libosinfo>
    <v:vm xmlns:v='https://auxinux.ca/virtua/1.0'>
      <v:cpu model='pentium4' periodSpeed='no'/>
    </v:vm>
  </metadata>`);
    expect(readVirtuaMetadata(libvirtStyle)).toEqual({ cpuModel: "pentium4", periodSpeed: false });
    const merged = mergeVirtuaMetadata(libvirtStyle, { disposable: { baseId: "b", baseLabel: "B", strict: false } });
    expect(merged).toContain("libosinfo:os");
    expect(merged).not.toContain("<v:vm");
    expect(readVirtuaMetadata(merged)).toEqual({ cpuModel: "pentium4", periodSpeed: false, disposable: { baseId: "b", baseLabel: "B", strict: false } });
  });

  it("removes the element (and an emptied <metadata>) when nothing is left", () => {
    const withMeta = writeVirtuaMetadata(q35Domain, { cpuModel: "486", periodSpeed: false });
    const cleared = mergeVirtuaMetadata(withMeta, { cpuModel: undefined, periodSpeed: undefined });
    expect(cleared).not.toContain("metadata");
    expect(readVirtuaMetadata(cleared)).toEqual({});
  });
});

describe("CPU model", () => {
  it("keeps host-passthrough for auto/host and uses maximum for max", () => {
    expect(buildCpuXml(4)).toBe(`<cpu mode="host-passthrough" check="none" migratable="on"><topology sockets="1" cores="4" threads="1"/></cpu>`);
    expect(buildCpuXml(2, "host")).toContain(`mode="host-passthrough"`);
    expect(buildCpuXml(2, "max")).toContain(`mode="maximum"`);
  });

  it("maps period CPUs onto QEMU models (286/386 → 486, Pentium 4 → Pentium III + SSE2)", () => {
    expect(buildCpuXml(1, "286")).toContain(`<model fallback="forbid">486</model>`);
    expect(buildCpuXml(1, "386")).toContain(`<model fallback="forbid">486</model>`);
    const p4 = buildCpuXml(1, "pentium4");
    expect(p4).toContain(`<model fallback="forbid">pentium3</model>`);
    expect(p4).toContain(`<feature policy="require" name="sse2"/>`);
    expect(buildCpuXml(2, "Skylake-Client")).toContain(`mode="custom" match="exact" check="none"`);
  });

  it("applies a CPU choice with period speed: TCG domain, icount, no vhost, metadata", () => {
    const xml = applyCpuChoice(q35Domain, { cpuModel: "386", periodSpeed: true, vcpus: 1 });
    expect(domainVirtType(xml)).toBe("qemu");
    expect(xml).toMatch(/<domain type="qemu"[^>]*xmlns:qemu="http:\/\/libvirt\.org\/schemas\/domain\/qemu\/1\.0">/);
    expect(xml).toContain(`<qemu:arg value="-icount"/>\n    <qemu:arg value="shift=7,sleep=on"/>`);
    expect(domainIcountShift(xml)).toBe(7);
    expect(xml).not.toContain("vhost");
    expect(xml.match(/<cpu\b/g)).toHaveLength(1);
    expect(domainCpuModel(xml)).toBe("386");
    expect(readVirtuaMetadata(xml).periodSpeed).toBe(true);
    // Single <qemu:commandline>, placed last.
    expect(xml.trimEnd().endsWith("</qemu:commandline>\n</domain>")).toBe(true);
  });

  it("turns period speed off again (KVM, no icount) and back to auto", () => {
    const slow = applyCpuChoice(q35Domain, { cpuModel: "286", periodSpeed: true, vcpus: 1 });
    const fast = applyCpuChoice(slow, { cpuModel: "286", periodSpeed: false, vcpus: 1 });
    expect(domainVirtType(fast)).toBe("kvm");
    expect(fast).not.toContain("icount");
    expect(fast).not.toContain("qemu:commandline");
    expect(domainCpuModel(fast)).toBe("286");
    const auto = applyCpuChoice(fast, { cpuModel: "auto", periodSpeed: false, vcpus: 1 });
    expect(auto).toContain(`mode="host-passthrough"`);
    expect(readVirtuaMetadata(auto)).toEqual({});
  });

  it("re-applying replaces the shift instead of stacking -icount", () => {
    const once = applyCpuChoice(q35Domain, { cpuModel: "286", periodSpeed: true, vcpus: 1 });
    const twice = applyCpuChoice(once, { cpuModel: "pentium", periodSpeed: true, vcpus: 1 });
    expect(twice.match(/-icount/g)).toHaveLength(1);
    expect(domainIcountShift(twice)).toBe(3);
  });

  it("keeps foreign qemu:commandline args", () => {
    const other = q35Domain
      .replace("<domain type='kvm'>", `<domain type='kvm' xmlns:qemu='http://libvirt.org/schemas/domain/qemu/1.0'>`)
      .replace("</domain>", `  <qemu:commandline>\n    <qemu:arg value='-global'/>\n    <qemu:arg value='ICH9-LPC.disable_s3=1'/>\n  </qemu:commandline>\n</domain>`);
    const slow = applyPeriodSpeed(other, 4);
    expect(slow).toContain("ICH9-LPC.disable_s3=1");
    expect(domainIcountShift(slow)).toBe(4);
    expect(slow.match(/xmlns:qemu=/g)).toHaveLength(1);
    const back = applyPeriodSpeed(slow, null);
    expect(back).toContain("ICH9-LPC.disable_s3=1");
    expect(back).not.toContain("icount");
  });

  it("refuses period speed without a period CPU", () => {
    expect(() => applyCpuChoice(q35Domain, { cpuModel: "Haswell", periodSpeed: true, vcpus: 1 })).toThrow(/period CPU/);
  });
});

describe("applyMachineType", () => {
  it("moves a q35 domain to i440FX by dropping PCI/drive addresses and chipset controllers", () => {
    const pc = applyMachineType(q35Domain, "pc");
    expect(pc).toContain(`machine='pc'`);
    expect(pc).not.toMatch(/<address type='(pci|drive)'/);
    expect(pc).not.toContain("pcie-root");
    expect(pc).not.toContain(`<controller type='sata'`);
    // USB controller kept (address dropped), hostdev source address untouched.
    expect(pc).toContain(`<controller type='usb' index='0' model='qemu-xhci'>`);
    expect(pc).toContain(`<source><address domain='0x0000' bus='0x03' slot='0x00' function='0x0'/></source>`);
    expect(pc).toContain(`<source file='/p/dos.qcow2'/>`);
  });

  it("is a no-op on the same chipset and refuses impossible switches", () => {
    expect(applyMachineType(q35Domain, "q35")).toBe(q35Domain);
    const ideOnPc = q35Domain.replace("machine='pc-q35-10.0'", "machine='pc-i440fx-10.0'").replace("bus='sata'", "bus='ide'");
    expect(() => applyMachineType(ideOnPc, "q35")).toThrow(/IDE/);
    const secure = q35Domain.replace("</type>", "</type>\n    <loader readonly='yes' secure='yes' type='pflash'>/x</loader>");
    expect(() => applyMachineType(secure, "pc")).toThrow(/Secure Boot/);
    const arm = q35Domain.replace("arch='x86_64' machine='pc-q35-10.0'", "arch='aarch64' machine='virt'");
    expect(() => applyMachineType(arm, "pc")).toThrow(/x86/);
  });
});
