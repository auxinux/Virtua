import { z } from "zod";

/**
 * Virtual floppy disk images (drive A:). Raw sector dumps only: QEMU's floppy
 * controller picks the drive geometry from the image size, so anything larger
 * than an ED 2.88 MB disk is not a floppy and is refused.
 */
export const FLOPPY_EXTENSIONS = [".img", ".ima", ".vfd", ".flp"] as const;

/** 2.88 MB (ED) floppy: 2880 KiB = 2 949 120 bytes. Largest format QEMU's FDC handles. */
export const FLOPPY_MAX_BYTES = 2880 * 1024;

/** Standard raw floppy sizes QEMU recognizes, in bytes. */
export const FLOPPY_STANDARD_SIZES: ReadonlyArray<{ bytes: number; label: string }> = [
  { bytes: 160 * 1024, label: "160 KB" },
  { bytes: 180 * 1024, label: "180 KB" },
  { bytes: 320 * 1024, label: "320 KB" },
  { bytes: 360 * 1024, label: "360 KB" },
  { bytes: 720 * 1024, label: "720 KB" },
  { bytes: 1200 * 1024, label: "1.2 MB" },
  { bytes: 1440 * 1024, label: "1.44 MB" },
  { bytes: 1680 * 1024, label: "1.68 MB (DMF)" },
  { bytes: 1720 * 1024, label: "1.72 MB" },
  { bytes: 2880 * 1024, label: "2.88 MB" },
];

export function isFloppyFilename(filename: string): boolean {
  const lower = filename.toLowerCase();
  return FLOPPY_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Human label of a standard floppy size ("1.44 MB"), or undefined for a non-standard image. */
export function floppySizeLabel(sizeBytes: number): string | undefined {
  return FLOPPY_STANDARD_SIZES.find((entry) => entry.bytes === sizeBytes)?.label;
}

export type FloppyValidation = { ok: true; standard: boolean; label?: string } | { ok: false; error: string };

/**
 * Validate a floppy image by name and size. Non-standard sizes up to 2.88 MB
 * are accepted (QEMU pads/guesses geometry) but flagged `standard: false`.
 */
export function validateFloppyImage(filename: string, sizeBytes: number): FloppyValidation {
  if (!isFloppyFilename(filename)) {
    return { ok: false, error: `Unsupported floppy image extension (expected ${FLOPPY_EXTENSIONS.join(", ")})` };
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return { ok: false, error: "Floppy image is empty" };
  }
  if (sizeBytes > FLOPPY_MAX_BYTES) {
    return {
      ok: false,
      error: `Floppy image too large: ${sizeBytes} bytes (maximum ${FLOPPY_MAX_BYTES} bytes = 2.88 MB). Use an ISO or a disk image instead.`,
    };
  }
  const label = floppySizeLabel(sizeBytes);
  return { ok: true, standard: label !== undefined, label };
}

/** Architectures whose machine types have an ISA floppy controller. */
export const FLOPPY_CAPABLE_ARCHES = ["x86_64", "i686"] as const;

export function archSupportsFloppy(arch: string | undefined | null): boolean {
  return (FLOPPY_CAPABLE_ARCHES as readonly string[]).includes(arch ?? "x86_64");
}

export const AttachFloppySchema = z.object({
  floppyFile: z.string().min(1, "floppyFile is required").max(255).refine(isFloppyFilename, {
    message: `Floppy image must end with ${FLOPPY_EXTENSIONS.join(", ")}`,
  }),
  /** Write-protect tab. Library images are shared, so read-only by default. */
  readonly: z.boolean().default(true),
});

export type AttachFloppyInput = z.infer<typeof AttachFloppySchema>;
