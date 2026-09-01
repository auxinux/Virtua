import { describe, expect, it } from "vitest";
import { buildPartitionRanges } from "./storage";

const DISK_1TB_MB = 953869; // ~931.5 GiB, the Toshiba disk in the report

describe("buildPartitionRanges", () => {
  it("spans the whole disk with a single open-ended partition", () => {
    expect(buildPartitionRanges([{}], DISK_1TB_MB)).toEqual([
      { start: "1MiB", end: "100%", label: undefined },
    ]);
  });

  // Starting at sector 34 (parted's GPT minimum) misaligns the partition with
  // SSD erase blocks and RAID stripes.
  it("starts the first partition at 1 MiB for alignment", () => {
    const [first] = buildPartitionRanges([{ sizeMb: 1024 }], DISK_1TB_MB);
    expect(first.start).toBe("1MiB");
  });

  it("lays out fixed-size partitions back to back", () => {
    expect(buildPartitionRanges([{ sizeMb: 1024 }, { sizeMb: 2048 }], DISK_1TB_MB)).toEqual([
      { start: "1MiB", end: "1025MiB", label: undefined },
      { start: "1025MiB", end: "3073MiB", label: undefined },
    ]);
  });

  it("lets the last partition take the remaining space", () => {
    const ranges = buildPartitionRanges([{ sizeMb: 512, label: "boot" }, {}], DISK_1TB_MB);
    expect(ranges).toEqual([
      { start: "1MiB", end: "513MiB", label: "boot" },
      { start: "513MiB", end: "100%", label: undefined },
    ]);
  });

  it("refuses a plan larger than the device", () => {
    expect(() => buildPartitionRanges([{ sizeMb: DISK_1TB_MB + 1000 }], DISK_1TB_MB))
      .toThrow(/exceeds the device capacity/);
  });

  it("leaves room for the GPT backup header at the very end", () => {
    expect(() => buildPartitionRanges([{ sizeMb: DISK_1TB_MB - 1 }], DISK_1TB_MB))
      .toThrow(/exceeds the device capacity/);
  });

  it("allows only one open-ended partition", () => {
    expect(() => buildPartitionRanges([{}, {}], DISK_1TB_MB))
      .toThrow(/Only one partition can take the remaining space/);
  });

  it("requires the open-ended partition to be last", () => {
    expect(() => buildPartitionRanges([{}, { sizeMb: 1024 }], DISK_1TB_MB))
      .toThrow(/Only the last partition can take the remaining space/);
  });

  it("rejects an empty or oversized plan", () => {
    expect(() => buildPartitionRanges([], DISK_1TB_MB)).toThrow(/At least one partition/);
    expect(() => buildPartitionRanges(Array.from({ length: 129 }, () => ({ sizeMb: 1 })), DISK_1TB_MB))
      .toThrow(/Too many partitions/);
  });

  it("rejects a non-positive size", () => {
    expect(() => buildPartitionRanges([{ sizeMb: 0 }, {}], DISK_1TB_MB)).toThrow(/positive number/);
    expect(() => buildPartitionRanges([{ sizeMb: -5 }, {}], DISK_1TB_MB)).toThrow(/positive number/);
  });
});
