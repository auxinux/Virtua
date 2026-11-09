import { FLOPPY_MAX_BYTES, isFloppyFilename } from "@auxinux/shared";

/**
 * An ISO-capable pool holds both CD and floppy media, and ".img" is a valid
 * extension for both. A pool file is classified by size: anything that fits a
 * 2.88 MB floppy (and has a floppy extension) is a floppy, the rest an ISO.
 * Returns whether `filename` should be listed as `type` for that pool scan.
 */
export function poolFileMatchesMediaType(type: "iso" | "floppy", filename: string, sizeBytes: number): boolean {
  const floppySized = sizeBytes > 0 && sizeBytes <= FLOPPY_MAX_BYTES;
  if (type === "floppy") return isFloppyFilename(filename) && floppySized;
  const lower = filename.toLowerCase();
  if (!lower.endsWith(".iso") && !lower.endsWith(".img")) return false;
  return !(floppySized && isFloppyFilename(filename));
}
