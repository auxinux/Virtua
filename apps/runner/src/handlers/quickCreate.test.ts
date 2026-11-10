import { describe, expect, it } from "vitest";
import { gunzipSync } from "zlib";
import {
  buildFat12Image,
  cpioNewc,
  debianAppend,
  debianBasePreseed,
  debianPreseed,
  initrdWithPreseed,
  shortNameFor,
  stripDirectKernelBoot,
  stripInstallMedia,
  windowsAnswerFile,
} from "./quickCreate";
import { buildVmDomainXml } from "./vmXml";

/** Minimal FAT12 reader (root directory, VFAT names) to check the image back. */
function readFat12(image: Buffer): Map<string, Buffer> {
  const bps = image.readUInt16LE(11);
  const reserved = image.readUInt16LE(14);
  const fats = image[16];
  const rootEntries = image.readUInt16LE(17);
  const fatSectors = image.readUInt16LE(22);
  const fatStart = reserved * bps;
  const rootStart = (reserved + fats * fatSectors) * bps;
  const dataStart = rootStart + rootEntries * 32;
  const fatEntry = (n: number) => {
    const off = fatStart + Math.floor((n * 3) / 2);
    const v = image.readUInt16LE(off);
    return n % 2 === 0 ? v & 0xfff : v >> 4;
  };
  const files = new Map<string, Buffer>();
  let lfn: string[] = [];
  for (let i = 0; i < rootEntries; i += 1) {
    const e = image.subarray(rootStart + i * 32, rootStart + (i + 1) * 32);
    if (e[0] === 0) break;
    if (e[11] === 0x0f) {
      const units = [...Array(5).keys()].map((k) => e.readUInt16LE(1 + k * 2))
        .concat([...Array(6).keys()].map((k) => e.readUInt16LE(14 + k * 2)))
        .concat([...Array(2).keys()].map((k) => e.readUInt16LE(28 + k * 2)));
      const part = String.fromCharCode(...units.filter((u) => u !== 0 && u !== 0xffff));
      lfn = [part, ...lfn];
      continue;
    }
    if (e[11] & 0x08) { lfn = []; continue; }
    const short = `${e.subarray(0, 8).toString("ascii").trim()}.${e.subarray(8, 11).toString("ascii").trim()}`;
    const name = lfn.length ? lfn.join("") : short;
    lfn = [];
    const size = e.readUInt32LE(28);
    const chunks: Buffer[] = [];
    for (let c = e.readUInt16LE(26); c >= 2 && c < 0xff8; c = fatEntry(c)) {
      chunks.push(image.subarray(dataStart + (c - 2) * bps, dataStart + (c - 1) * bps));
    }
    files.set(name, Buffer.concat(chunks).subarray(0, size));
  }
  return files;
}

describe("Debian preseed", () => {
  it("answers everything with the virtua account", () => {
    const preseed = debianPreseed("debian-13", "America/Toronto");
    for (const line of [
      "d-i passwd/username string virtua",
      "d-i passwd/user-password password virtua",
      "d-i netcfg/get_hostname string debian-13",
      "d-i time/zone string America/Toronto",
      "d-i partman-auto/disk string /dev/vda",
      "d-i debian-installer/exit/poweroff boolean true",
    ]) expect(preseed).toContain(line);
  });

  it("keeps the base generalization off the debconf channel (log-output)", () => {
    const late = debianBasePreseed("debian-13", "UTC").split("\n").find((l) => l.startsWith("d-i preseed/late_command"))!;
    expect(late).toContain("string log-output -t virtua in-target sh -c '");
    expect(late.trimEnd().endsWith("true'")).toBe(true);
    expect(late).toContain("truncate -s 0 /etc/machine-id");
    // A single preseed line: the unit's newlines stay escaped for printf.
    expect(late).toContain("\\nExecStart=/usr/bin/ssh-keygen -A\\n");
  });

  it("puts the ARM64 installer on the screen", () => {
    expect(debianAppend("d", "arm64")).toContain(" acpi=nospcr console=tty0 ---");
    expect(debianAppend("d", "amd64")).not.toContain("console=");
    expect(debianAppend("deb", "amd64")).toBe("auto=true priority=critical language=fr country=CA locale=fr_CA.UTF-8 keymap=ca hostname=deb domain=local ---");
  });
});

describe("initrd with preseed", () => {
  it("appends a gzipped newc cpio holding /preseed.cfg", () => {
    const cpio = cpioNewc("preseed.cfg", Buffer.from("d-i x string y\n"));
    expect(cpio.subarray(0, 6).toString()).toBe("070701");
    expect(cpio.length % 4).toBe(0);
    expect(cpio.includes(Buffer.from("TRAILER!!!"))).toBe(true);
    // name size field (offset 6 + 11*8) = len("preseed.cfg") + NUL
    expect(cpio.subarray(94, 102).toString()).toBe("0000000c");
    // file size field (offset 6 + 6*8)
    expect(parseInt(cpio.subarray(54, 62).toString(), 16)).toBe(15);

    const original = Buffer.from("\x1f\x8boriginal-initrd", "latin1");
    const combined = initrdWithPreseed(original, "d-i x string y\n");
    expect(combined.subarray(0, original.length).equals(original)).toBe(true);
    expect(gunzipSync(combined.subarray(original.length)).equals(cpio)).toBe(true);
  });
});

describe("Windows answer file", () => {
  it("is complete and well formed", () => {
    const xml = windowsAnswerFile("amd64", "fr-CA", "WIN11");
    expect(xml).toContain("<UILanguage>fr-CA</UILanguage>");
    expect(xml).toContain("<InputLocale>0c0c:00001009</InputLocale>");
    expect(xml).toContain("<Path>E:\\viostor\\w11\\amd64</Path>");
    expect(xml).toContain("<Name>virtua</Name>");
    expect(xml).toContain("<ComputerName>WIN11</ComputerName>");
    expect(xml).toContain("VK7JG-NPHTM-C97JM-9MPGT-3V66T");
    expect(xml).toContain("virtio-win-guest-tools.exe");
    for (const line of xml.split("\n").filter((l) => l.includes("<CommandLine>"))) {
      const inner = line.split("<CommandLine>")[1].split("</CommandLine>")[0];
      expect(inner).not.toMatch(/[<>]/);
      expect(inner.replace(/&quot;|&amp;/g, "")).not.toContain("&");
    }
    expect(xml.match(/<component /g)?.length).toBe(xml.match(/<\/component>/g)?.length);
    expect(xml.match(/<settings /g)?.length).toBe(xml.match(/<\/settings>/g)?.length);
    const arm = windowsAnswerFile("arm64", "en-US", "W");
    expect(arm).toContain("\\w11\\ARM64");
    expect(arm).toContain(`processorArchitecture="arm64"`);
  });

  it("escapes the computer name", () => {
    expect(windowsAnswerFile("amd64", "en-US", "A&B")).toContain("<ComputerName>A&amp;B</ComputerName>");
  });
});

describe("FAT12 floppy", () => {
  it("is a 1.44 MB FAT12 diskette whose root holds autounattend.xml under its long name", () => {
    const answer = Buffer.from(windowsAnswerFile("amd64", "fr-CA", "WIN11"));
    expect(answer.length).toBeGreaterThan(512 * 3); // spans several clusters
    const image = buildFat12Image([{ name: "autounattend.xml", data: answer }]);
    expect(image.length).toBe(1474560);
    expect(image.readUInt16LE(510)).toBe(0xaa55);
    expect(image.subarray(54, 62).toString()).toBe("FAT12   ");
    expect(image.readUInt16LE(19)).toBe(2880);
    expect(image[21]).toBe(0xf0);
    // Media byte mirrored in the first FAT entry, both FAT copies identical.
    expect(image[512]).toBe(0xf0);
    expect(image.subarray(512, 512 * 10).equals(image.subarray(512 * 10, 512 * 19))).toBe(true);
    const files = readFat12(image);
    expect([...files.keys()]).toEqual(["autounattend.xml"]);
    expect(files.get("autounattend.xml")!.equals(answer)).toBe(true);
  });

  it("stores plain 8.3 names without long-name entries", () => {
    expect(shortNameFor("autounattend.xml").toString()).toBe("AUTOUN~1XML");
    expect(shortNameFor("README.TXT").toString()).toBe("README  TXT");
    const files = readFat12(buildFat12Image([{ name: "README.TXT", data: Buffer.from("hi") }, { name: "empty.txt", data: Buffer.alloc(0) }]));
    expect(files.get("README.TXT")!.toString()).toBe("hi");
    expect(files.get("empty.txt")!.length).toBe(0);
  });

  it("refuses more than a floppy holds", () => {
    expect(() => buildFat12Image([{ name: "big.bin", data: Buffer.alloc(1_500_000) }])).toThrow(/1.44/);
  });
});

describe("after the installation", () => {
  const installer = buildVmDomainXml({
    name: "debian-13", vcpus: 2, memoryMb: 4096, arch: "x86_64", machine: "q35", bootDevice: "hd",
    disk: { path: "/pool/debian-13.qcow2", bus: "virtio" }, network: { bridge: "virbr0", model: "virtio" }, videoModel: "virtio",
    directKernel: { kernel: "/ai/debian-13/linux", initrd: "/ai/debian-13/initrd-preseed.gz", cmdline: "auto=true ---" },
  });

  it("drops the direct kernel boot and keeps the rest of <os>", () => {
    const out = stripDirectKernelBoot(installer.replace(/"/g, "'"));
    expect(out).not.toMatch(/<kernel|<initrd|<cmdline/);
    expect(out).toContain(`<boot dev='hd'/>`);
    expect(out).toContain(`<type arch='x86_64' machine='q35'>hvm</type>`);
  });

  it("removes the install media but never the system disk", () => {
    const win = buildVmDomainXml({
      name: "windows-11", vcpus: 4, memoryMb: 4096, arch: "x86_64", machine: "q35", bootDevice: "cdrom",
      disk: { path: "/pool/windows-11.qcow2", bus: "virtio" },
      cdroms: ["/isos/Windows11.iso", "/isos/virtio-win.iso"],
      floppy: { path: "/ai/windows-11/autounattend.img", readonly: true },
      network: { bridge: "virbr0", model: "virtio" }, videoModel: "qxl",
    });
    const out = stripInstallMedia(win, ["/isos/Windows11.iso", "/isos/virtio-win.iso"], "/ai/windows-11");
    expect(out).not.toContain("Windows11.iso");
    expect(out).not.toContain("virtio-win.iso");
    expect(out).not.toContain("autounattend.img");
    expect(out).toContain(`<source file="/pool/windows-11.qcow2"/>`);
    // Even if the system disk lived under the work dir it would stay.
    expect(stripInstallMedia(win, [], "/pool")).toContain("/pool/windows-11.qcow2");
  });
});
