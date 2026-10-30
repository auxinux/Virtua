import { describe, expect, it } from "vitest";
import {
  archiveBaseName,
  buildPbsRepository,
  buildPveLxcConfig,
  buildPveVmXml,
  lxcIncludeCandidates,
  parsePropertyString,
  parsePveCtConfig,
  parsePveVmConfig,
  parseSnapshotList,
  parseSnapshotRef,
  sanitizeGuestName,
  snapshotRef,
  validatePbsConnection,
} from "./pbsConfig";

const WIN11_CONF = `#Windows 11 poste%20compta
agent: 1
bios: ovmf
boot: order=scsi0;ide2;net0
cores: 4
cpu: x86-64-v2-AES
efidisk0: local-lvm:vm-100-disk-0,efitype=4m,pre-enrolled-keys=1,size=4M
ide2: local:iso/Win11.iso,media=cdrom,size=5G
machine: pc-q35-8.1
memory: 8192
meta: creation-qemu=8.1.5,ctime=1712345678
name: compta-win11
net0: virtio=BC:24:11:AA:BB:CC,bridge=vmbr0,firewall=1
numa: 0
ostype: win11
scsi0: local-lvm:vm-100-disk-1,cache=writeback,discard=on,iothread=1,size=64G,ssd=1
scsi1: local-lvm:vm-100-disk-3,backup=0,size=500G
scsihw: virtio-scsi-single
smbios1: uuid=3b2d5e8a-1f4c-4a6b-9c1d-2e3f4a5b6c7d
sockets: 1
tpmstate0: local-lvm:vm-100-disk-2,size=4M,version=v2.0
usb0: host=046d:c52b
vmgenid: 0d6a1a2c-aaaa-bbbb-cccc-111122223333

[before-update]
cores: 2
memory: 4096
scsi0: local-lvm:vm-100-disk-1,size=32G
`;

const LINUX_CONF = `boot: cdn
bootdisk: virtio0
cores: 2
ide0: local:iso/debian.iso,media=cdrom
memory: 2048
name: web01
net0: e1000=AA:BB:CC:00:11:22,bridge=vmbr1,tag=20
net1: virtio=AA:BB:CC:00:11:23,bridge=vmbr9,link_down=1
ostype: l26
sata0: local-lvm:vm-101-disk-1,size=10G
sockets: 2
virtio0: local-lvm:vm-101-disk-0,size=20G
`;

const CT_CONF = `#Serveur%20DNS
arch: amd64
cores: 2
features: nesting=1,keyctl=1
hostname: dns-01
memory: 1024
mp0: local-lvm:vm-200-disk-1,mp=/srv/data,backup=1,size=50G
mp1: /mnt/nas/share,mp=/mnt/share
nameserver: 1.1.1.1 9.9.9.9
net0: name=eth0,bridge=vmbr0,firewall=1,gw=192.168.1.1,hwaddr=BC:24:11:12:34:56,ip=192.168.1.53/24,type=veth
net1: name=eth1,bridge=vmbr1,hwaddr=BC:24:11:12:34:57,ip=dhcp,type=veth
onboot: 1
ostype: debian
rootfs: local-lvm:vm-200-disk-0,size=8G
swap: 512
unprivileged: 1
lxc.cgroup2.devices.allow: c 10:200 rwm
`;

describe("validatePbsConnection / buildPbsRepository", () => {
  const base = { server: "pbs.lan", datastore: "store1", authId: "root@pam!virtua", secret: "s3cret" };

  it("builds the PBS_REPOSITORY string with the default port", () => {
    expect(buildPbsRepository(validatePbsConnection(base))).toBe("root@pam!virtua@pbs.lan:8007:store1");
  });

  it("brackets IPv6 servers", () => {
    expect(buildPbsRepository(validatePbsConnection({ ...base, server: "fd00::5", port: 8008 }))).toBe("root@pam!virtua@[fd00::5]:8008:store1");
  });

  it("rejects values that could smuggle options or paths", () => {
    expect(() => validatePbsConnection({ ...base, server: "-x" })).toThrow();
    expect(() => validatePbsConnection({ ...base, datastore: "../etc" })).toThrow();
    expect(() => validatePbsConnection({ ...base, authId: "root" })).toThrow();
    expect(() => validatePbsConnection({ ...base, fingerprint: "nope" })).toThrow();
    expect(() => validatePbsConnection({ ...base, secret: "" })).toThrow();
  });

  it("accepts a namespace and a fingerprint", () => {
    const fp = Array.from({ length: 32 }, () => "AB").join(":");
    const c = validatePbsConnection({ ...base, namespace: "site1/pve", fingerprint: fp });
    expect(c.namespace).toBe("site1/pve");
    expect(c.fingerprint).toBe(fp.toLowerCase());
  });
});

describe("snapshot references", () => {
  it("round-trips epoch → ref → parts", () => {
    const ref = snapshotRef("vm", "100", 1730000000);
    expect(ref).toBe("vm/100/2024-10-27T03:33:20Z");
    expect(parseSnapshotRef(ref)).toEqual({ type: "vm", id: "100", time: "2024-10-27T03:33:20Z" });
  });

  it("rejects host backups and traversal", () => {
    expect(() => parseSnapshotRef("host/pve/2024-10-27T03:33:20Z")).toThrow();
    expect(() => parseSnapshotRef("vm/../2024-10-27T03:33:20Z")).toThrow();
  });

  it("strips index suffixes", () => {
    expect(archiveBaseName("drive-scsi0.img.fidx")).toBe("drive-scsi0.img");
    expect(archiveBaseName("root.pxar.didx")).toBe("root.pxar");
    expect(archiveBaseName("pct.conf.blob")).toBe("pct.conf");
  });
});

describe("parseSnapshotList", () => {
  it("parses the JSON output (object and string files), skips host backups, newest first", () => {
    const json = JSON.stringify([
      { "backup-type": "vm", "backup-id": "100", "backup-time": 1730000000, size: 123, files: [
        { filename: "qemu-server.conf.blob", "crypt-mode": "none", size: 500 },
        { filename: "drive-scsi0.img.fidx", "crypt-mode": "none", size: 68719476736 },
      ] },
      { "backup-type": "ct", "backup-id": "200", "backup-time": 1730100000, files: ["pct.conf.blob", "root.pxar.didx"], protected: true, comment: "avant MAJ" },
      { "backup-type": "host", "backup-id": "pve1", "backup-time": 1730200000, files: [] },
      { "backup-type": "vm", "backup-id": "101", "backup-time": 1730050000, files: [{ filename: "drive-scsi0.img.fidx", "crypt-mode": "encrypt" }] },
    ]);
    const list = parseSnapshotList(json);
    expect(list.map((s) => s.ref)).toEqual([
      "ct/200/2024-10-28T07:20:00Z",
      "vm/101/2024-10-27T17:26:40Z",
      "vm/100/2024-10-27T03:33:20Z",
    ]);
    expect(list[0]).toMatchObject({ protected: true, comment: "avant MAJ", encrypted: false });
    expect(list[1].encrypted).toBe(true);
    expect(list[2].files[1]).toEqual({ filename: "drive-scsi0.img.fidx", sizeBytes: 68719476736, encrypted: false });
  });
});

describe("parsePropertyString", () => {
  it("separates the positional volume from the options", () => {
    expect(parsePropertyString("local-lvm:vm-100-disk-0,size=32G,ssd=1")).toEqual({
      positional: "local-lvm:vm-100-disk-0",
      props: { size: "32G", ssd: "1" },
    });
  });
});

describe("parsePveVmConfig", () => {
  it("translates a Windows 11 / OVMF / Secure Boot / TPM VM", () => {
    const spec = parsePveVmConfig(WIN11_CONF);
    expect(spec).toMatchObject({
      name: "compta-win11",
      vcpus: 4,
      memoryMb: 8192,
      uefi: true,
      machine: "q35",
      secureBoot: true,
      efiType: "4m",
      hasEfiDisk: true,
      tpm: "2.0",
      isWindows: true,
      agent: true,
      video: "vga",
      scsiModel: "virtio-scsi",
      onboot: false,
      smbiosUuid: "3b2d5e8a-1f4c-4a6b-9c1d-2e3f4a5b6c7d",
      description: "Windows 11 poste compta",
    });
    // The [before-update] snapshot section must be ignored.
    expect(spec.disks.map((d) => [d.key, d.inBackup, d.sizeBytes])).toEqual([
      ["scsi0", true, 64 * 1024 ** 3],
      ["scsi1", false, 500 * 1024 ** 3],
    ]);
    expect(spec.nics).toEqual([{ key: "net0", index: 0, model: "virtio", mac: "bc:24:11:aa:bb:cc", bridge: "vmbr0", tag: undefined, linkDown: false }]);
    expect(spec.bootOrder).toEqual(["scsi0", "net0"]);
    expect(spec.warnings.join("\n")).toMatch(/scsi1.*backup=0/);
    expect(spec.warnings.join("\n")).toMatch(/BitLocker/);
    expect(spec.warnings.join("\n")).toMatch(/usb0/);
  });

  it("translates a legacy SeaBIOS / i440fx Linux VM", () => {
    const spec = parsePveVmConfig(LINUX_CONF);
    expect(spec).toMatchObject({ vcpus: 4, memoryMb: 2048, uefi: false, machine: "pc", isWindows: false, agent: false, scsiModel: "lsilogic" });
    expect(spec.disks.map((d) => d.key)).toEqual(["virtio0", "sata0"]);
    expect(spec.bootOrder).toEqual(["virtio0", "net0", "net1"]);
    expect(spec.nics[0]).toMatchObject({ model: "e1000", bridge: "vmbr1", tag: 20 });
    expect(spec.nics[1]).toMatchObject({ linkDown: true });
    expect(spec.warnings.join("\n")).toMatch(/VLAN tag 20/);
  });

  it("drops Secure Boot when the machine is not q35", () => {
    const spec = parsePveVmConfig("bios: ovmf\nefidisk0: x:y,efitype=4m,pre-enrolled-keys=1\nscsi0: x:z,size=1G\n");
    expect(spec.secureBoot).toBe(false);
    expect(spec.warnings.join("\n")).toMatch(/Secure Boot/);
  });

  it("accepts the memory: current=… form", () => {
    expect(parsePveVmConfig("memory: current=3072\n").memoryMb).toBe(3072);
  });
});

describe("buildPveVmXml", () => {
  it("produces a bootable domain with mapped bridges, boot order, UEFI and TPM", () => {
    const spec = parsePveVmConfig(WIN11_CONF);
    const xml = buildPveVmXml(spec, {
      name: "compta-win11",
      arch: "x86_64",
      diskPaths: { scsi0: "/pool/compta-win11-scsi0.qcow2" },
      bridgeMap: { vmbr0: "br-lan" },
      defaultBridge: "virbr0",
      firmware: { loader: "/usr/share/OVMF/OVMF_CODE_4M.ms.fd", nvramTemplate: "/usr/share/OVMF/OVMF_VARS_4M.ms.fd", nvramPath: "/var/lib/libvirt/qemu/nvram/compta-win11_VARS.fd" },
      uuid: spec.smbiosUuid,
      cpuXml: "<cpu/>",
      displayXml: "    <!-- display -->",
    });
    expect(xml).toContain(`<type arch="x86_64" machine="q35">hvm</type>`);
    expect(xml).toContain(`<loader readonly="yes" secure="yes" type="pflash">/usr/share/OVMF/OVMF_CODE_4M.ms.fd</loader>`);
    expect(xml).toContain(`<nvram template="/usr/share/OVMF/OVMF_VARS_4M.ms.fd">/var/lib/libvirt/qemu/nvram/compta-win11_VARS.fd</nvram>`);
    expect(xml).toContain(`<smm state="on"/>`);
    expect(xml).toContain(`<hyperv mode="custom">`);
    expect(xml).toContain(`<clock offset="localtime">`);
    expect(xml).toContain(`<controller type="scsi" index="0" model="virtio-scsi"/>`);
    expect(xml).toMatch(/<target dev="sda" bus="scsi" rotation_rate="1"\/>\s*<boot order="1"\/>/);
    expect(xml).toMatch(/<source bridge="br-lan"\/>[\s\S]*<boot order="2"\/>/);
    expect(xml).toContain(`<tpm model="tpm-crb"><backend type="emulator" version="2.0"/></tpm>`);
    expect(xml).toContain(`<uuid>3b2d5e8a-1f4c-4a6b-9c1d-2e3f4a5b6c7d</uuid>`);
    expect(xml).toContain("org.qemu.guest_agent.0");
    expect(xml).not.toContain("<boot dev=");
    // scsi1 had backup=0: no path → no disk element.
    expect(xml.match(/<disk /g)?.length).toBe(1);
  });

  it("maps IDE disks to SATA on q35 and falls back to the default bridge", () => {
    const spec = parsePveVmConfig("machine: q35\nide0: x:vm-1-disk-0,size=8G\nnet0: virtio=AA:BB:CC:DD:EE:01,bridge=vmbr7\n");
    const xml = buildPveVmXml(spec, { name: "t", arch: "x86_64", diskPaths: { ide0: "/p/t.qcow2" }, defaultBridge: "virbr0", cpuXml: "<cpu/>", displayXml: "" });
    expect(xml).toContain(`<target dev="sda" bus="sata"/>`);
    expect(xml).toContain(`<source bridge="virbr0"/>`);
    expect(xml).toMatch(/bus="sata"\/>\s*<boot order="1"\/>/);
  });
});

describe("parsePveCtConfig / buildPveLxcConfig", () => {
  it("translates an unprivileged Debian container", () => {
    const spec = parsePveCtConfig(CT_CONF);
    expect(spec).toMatchObject({
      hostname: "dns-01",
      arch: "amd64",
      ostype: "debian",
      cores: 2,
      memoryMb: 1024,
      swapMb: 512,
      unprivileged: true,
      nesting: true,
      onboot: true,
      rootfsSizeGb: 8,
      nameservers: ["1.1.1.1", "9.9.9.9"],
      description: "Serveur DNS",
    });
    const w = spec.warnings.join("\n");
    expect(w).toMatch(/mp0 \(\/srv\/data\) is restored inside/);
    expect(w).toMatch(/mp1 .*not in Proxmox backups/);
    expect(w).toMatch(/privileged/);
    expect(w).toMatch(/lxc\.cgroup2\.devices\.allow/);

    const cfg = buildPveLxcConfig(spec, {
      name: "dns-01",
      rootfsPath: "/var/lib/lxc/dns-01/rootfs",
      include: "/usr/share/lxc/config/debian.common.conf",
      bridgeMap: { vmbr0: "br-lan" },
      defaultBridge: "lxcbr0",
      autostart: true,
      generateMac: () => "00:16:3e:00:00:01",
    });
    expect(cfg).toContain("lxc.include = /usr/share/lxc/config/debian.common.conf");
    expect(cfg).toContain("lxc.rootfs.path = dir:/var/lib/lxc/dns-01/rootfs");
    expect(cfg).toContain("lxc.net.0.link = br-lan");
    expect(cfg).toContain("lxc.net.0.hwaddr = bc:24:11:12:34:56");
    expect(cfg).toContain("lxc.net.0.ipv4.address = 192.168.1.53/24");
    expect(cfg).toContain("lxc.net.0.ipv4.gateway = 192.168.1.1");
    expect(cfg).toContain("lxc.net.1.link = lxcbr0");
    expect(cfg).not.toContain("lxc.net.1.ipv4");
    expect(cfg).toContain("lxc.cgroup2.cpu.max = 200000 100000");
    expect(cfg).toContain("lxc.cgroup2.memory.max = 1024M");
    expect(cfg).toContain("lxc.start.auto = 1");
    expect(cfg).toContain("lxc.apparmor.allow_nesting = 1");
    // Raw lxc.* keys from Proxmox must never be copied through.
    expect(cfg).not.toContain("devices.allow");
  });

  it("picks the distro include with a common.conf fallback", () => {
    expect(lxcIncludeCandidates("ubuntu")).toEqual(["/usr/share/lxc/config/ubuntu.common.conf", "/usr/share/lxc/config/common.conf"]);
    expect(lxcIncludeCandidates("devuan")[0]).toBe("/usr/share/lxc/config/debian.common.conf");
    expect(lxcIncludeCandidates(undefined)).toEqual(["/usr/share/lxc/config/common.conf"]);
    expect(lxcIncludeCandidates("../x")).toEqual(["/usr/share/lxc/config/common.conf"]);
  });
});

describe("sanitizeGuestName", () => {
  it("keeps valid names and repairs the rest", () => {
    expect(sanitizeGuestName("compta-win11", "vm-100")).toBe("compta-win11");
    expect(sanitizeGuestName("my vm (old)", "vm-100")).toBe("my-vm-old");
    expect(sanitizeGuestName("123", "vm-100")).toBe("vm-100");
    expect(sanitizeGuestName(undefined, "ct-200")).toBe("ct-200");
  });
});
