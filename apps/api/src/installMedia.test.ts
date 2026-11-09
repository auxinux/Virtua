import { describe, expect, it } from "vitest";
import { poolFileMatchesMediaType } from "./installMedia.js";

describe("poolFileMatchesMediaType", () => {
  it("classifies a 1.44 MB .img in an ISO pool as a floppy only", () => {
    expect(poolFileMatchesMediaType("floppy", "drivers.img", 1474560)).toBe(true);
    expect(poolFileMatchesMediaType("iso", "drivers.img", 1474560)).toBe(false);
  });

  it("keeps a large .img (hybrid ISO) as an ISO", () => {
    expect(poolFileMatchesMediaType("iso", "debian.img", 700 * 1024 * 1024)).toBe(true);
    expect(poolFileMatchesMediaType("floppy", "debian.img", 700 * 1024 * 1024)).toBe(false);
  });

  it("never lists .iso as a floppy nor .vfd/.ima as an ISO", () => {
    expect(poolFileMatchesMediaType("floppy", "tiny.iso", 1474560)).toBe(false);
    expect(poolFileMatchesMediaType("iso", "tiny.iso", 1474560)).toBe(true);
    expect(poolFileMatchesMediaType("iso", "xp.vfd", 1474560)).toBe(false);
    expect(poolFileMatchesMediaType("floppy", "dos.IMA", 1474560)).toBe(true);
  });

  it("rejects empty and over-2.88 MB floppy candidates", () => {
    expect(poolFileMatchesMediaType("floppy", "empty.img", 0)).toBe(false);
    expect(poolFileMatchesMediaType("floppy", "big.vfd", 2949121)).toBe(false);
    expect(poolFileMatchesMediaType("floppy", "ed.vfd", 2949120)).toBe(true);
  });
});
