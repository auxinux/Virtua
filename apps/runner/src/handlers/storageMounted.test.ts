import { describe, expect, it } from "vitest";
import { parseMountedBlockDevices } from "./storage";

// `lsblk -nro NAME,MOUNTPOINT /dev/sdb` on a system disk.
const SYSTEM_DISK = `sdb
sdb1 /boot/efi
sdb2
sdb3 /`;

const FREE_DISK = `sda
sda1`;

describe("parseMountedBlockDevices", () => {
  // The hole this closes: `findmnt -S /dev/sdb` reports nothing because the
  // parent device itself is not mounted, so formatting it would have wiped a
  // live root filesystem.
  it("reports partitions of a device that is not itself mounted", () => {
    expect(parseMountedBlockDevices(SYSTEM_DISK)).toEqual([
      { name: "sdb1", mountpoint: "/boot/efi" },
      { name: "sdb3", mountpoint: "/" },
    ]);
  });

  it("reports nothing for a device with no mounted partition", () => {
    expect(parseMountedBlockDevices(FREE_DISK)).toEqual([]);
  });

  it("treats swap as in use", () => {
    expect(parseMountedBlockDevices("sda\nsda2 [SWAP]")).toEqual([{ name: "sda2", mountpoint: "[SWAP]" }]);
  });

  it("handles mountpoints containing spaces", () => {
    expect(parseMountedBlockDevices("sdc1 /mnt/my disk")).toEqual([{ name: "sdc1", mountpoint: "/mnt/my disk" }]);
  });

  it("tolerates empty output when lsblk is unavailable", () => {
    expect(parseMountedBlockDevices("")).toEqual([]);
  });
});
