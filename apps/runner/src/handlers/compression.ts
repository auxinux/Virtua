import { execFile, spawn } from "child_process";
import { createWriteStream } from "fs";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Compression strategy for backups. We prefer zstd (Zstandard): far better
 * ratio than gzip and multi-threaded, so a huge LXC/VM no longer takes hours.
 * pigz (parallel gzip) is the fallback, plain gzip the last resort. zstd output
 * is read back transparently on restore via extension detection.
 */
export interface Compressor {
  /** Program name passed to `tar --use-compress-program`. */
  program: string;
  /** Archive extension WITHOUT a leading dot, e.g. "tar.zst" or "tar.gz". */
  ext: string;
  /** Whether this is zstd (vs a gzip-family compressor). */
  isZstd: boolean;
}

/** Default zstd level: 9 + long-range matching = strong ratio, still fast. */
const ZSTD_LEVEL = parseInt(process.env.BACKUP_ZSTD_LEVEL ?? "9", 10);
/** Long-range match window log (2^27 = 128 MiB) helps on big disk images. */
const ZSTD_LONG = parseInt(process.env.BACKUP_ZSTD_LONG ?? "27", 10);

/** Clamp a caller-supplied zstd level to a sane range, defaulting to ZSTD_LEVEL. */
function zstdLevel(level?: number): number {
  if (typeof level !== "number" || !Number.isFinite(level)) return ZSTD_LEVEL;
  return Math.max(1, Math.min(19, Math.round(level)));
}

function zstdProgram(level?: number): string {
  return `zstd -${zstdLevel(level)} -T0 --long=${ZSTD_LONG}`;
}

let cachedCompressor: Compressor | undefined;

async function has(cmd: string): Promise<boolean> {
  try {
    await execFileAsync("sh", ["-c", `command -v ${cmd}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the best available backup compressor: zstd → pigz → gzip.
 * Result is cached for the lifetime of the runner process.
 */
export async function resolveCompressor(level?: number): Promise<Compressor> {
  // The cache only memoizes WHICH program is available, not the level, so a
  // per-backup level still takes effect.
  if (cachedCompressor === undefined) {
    if (await has("zstd")) {
      cachedCompressor = { program: "zstd", ext: "tar.zst", isZstd: true };
    } else if (await has("pigz")) {
      cachedCompressor = { program: "pigz", ext: "tar.gz", isZstd: false };
    } else {
      cachedCompressor = { program: "gzip", ext: "tar.gz", isZstd: false };
    }
  }
  if (cachedCompressor.isZstd) {
    return { ...cachedCompressor, program: zstdProgram(level) };
  }
  return cachedCompressor;
}

/**
 * Resolve the compressor for a requested filename's extension. `.tar.zst` asks
 * for zstd, but if zstd is missing we fall back to pigz/gzip — the caller must
 * use the returned `ext` to name the file so contents and name always agree
 * (the restore path keys off the extension).
 */
export async function resolveCompressorForFilename(filename: string, level?: number): Promise<Compressor> {
  if (isZstdArchive(filename) && (await has("zstd"))) {
    return { program: zstdProgram(level), ext: "tar.zst", isZstd: true };
  }
  if (await has("pigz")) return { program: "pigz", ext: "tar.gz", isZstd: false };
  return { program: "gzip", ext: "tar.gz", isZstd: false };
}

/**
 * Swap a backup archive's compression extension to `ext`, e.g. retarget
 * `lxc-foo-2026.tar.zst` to `tar.gz` when falling back. Leaves a name without a
 * known archive extension untouched except for appending the correct one.
 */
export function retargetArchiveExt(filename: string, ext: string): string {
  const base = filename.replace(/\.(tar\.zst|tar\.gz|tzst|tgz|tar)$/i, "");
  return `${base}.${ext}`;
}

/**
 * Build the `tar --use-compress-program` token for COMPRESSION.
 * tar splits the program string on spaces, so we pass it as a single arg and
 * let tar invoke `sh -c`-style; in practice tar runs it verbatim via execvp,
 * which DOES accept a quoted multi-word string for --use-compress-program.
 */
export function tarCompressArgs(c: Compressor): string[] {
  return ["--use-compress-program", c.program];
}

/**
 * Decompressor program for an existing archive, chosen by its filename, for use
 * with `tar --use-compress-program`. GNU tar appends `-d` itself when
 * extracting, so the returned string must NOT include `-d`.
 * `.tar.zst`/`.tzst` → zstd, everything else → gzip (covers legacy .tar.gz).
 * `--long=31` (max window) on decompress accepts any window we ever wrote.
 */
export function decompressorFor(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".tar.zst") || lower.endsWith(".tzst") || lower.endsWith(".zst")) {
    return "zstd --long=31";
  }
  return "gzip";
}

/** True if the archive name is a zstd archive. */
export function isZstdArchive(filename: string): boolean {
  const lower = filename.toLowerCase();
  return lower.endsWith(".tar.zst") || lower.endsWith(".tzst") || lower.endsWith(".zst");
}

/** argv form of the compressor that reads stdin and writes compressed to stdout. */
function compressorArgv(c: Compressor): string[] {
  return [...c.program.trim().split(/\s+/), "-c"];
}

/** Whether `pv` (pipe viewer, for real progress) is available. */
export async function hasPv(): Promise<boolean> {
  return has("pv");
}

export interface BackupProgress {
  percent?: number;
  bytesCurrent?: number;
  bytesTotal?: number;
  message?: string;
}

export interface TarPipelineOpts {
  /** tar args that emit the archive on stdout (must include `-cf -` and sources). */
  tarArgs: string[];
  compressor: Compressor;
  destPath: string;
  /** Uncompressed total (bytes) so `pv` can report a REAL percentage. */
  totalBytes?: number;
  emit?: (p: BackupProgress) => void;
  /** tar exits 1 when files change mid-read on a live container — tolerate it. */
  tolerateTarExit1?: boolean;
}

/**
 * Run `tar … | [pv -s total] | compressor -c > destPath`, streaming a REAL
 * progress percentage (uncompressed bytes processed / total) via `emit`. Falls
 * back to a pv-less pipeline when pv is unavailable (no percentage, still works).
 */
export async function runTarPipeline(opts: TarPipelineOpts): Promise<void> {
  const { tarArgs, compressor, destPath, totalBytes, emit, tolerateTarExit1 } = opts;
  const usePv = !!(totalBytes && totalBytes > 0) && (await hasPv());

  await new Promise<void>((resolve, reject) => {
    const procs: Array<{ name: string; child: ReturnType<typeof spawn>; ok: (code: number | null) => boolean }> = [];
    let failed: Error | null = null;
    const out = createWriteStream(destPath);

    const fail = (err: Error) => {
      if (!failed) {
        failed = err;
        for (const { child } of procs) child.kill("SIGTERM");
        out.destroy();
        reject(err);
      }
    };

    const tar = spawn("tar", tarArgs, { stdio: ["ignore", "pipe", "ignore"] });
    procs.push({ name: "tar", child: tar, ok: (c) => c === 0 || (tolerateTarExit1 === true && c === 1) });

    const comp = spawn(compressorArgv(compressor)[0], compressorArgv(compressor).slice(1), { stdio: ["pipe", "pipe", "ignore"] });
    procs.push({ name: compressor.program, child: comp, ok: (c) => c === 0 });

    if (usePv) {
      // pv -n writes an integer percent per line to stderr; data passes through.
      const pv = spawn("pv", ["-n", "-f", "-s", String(totalBytes)], { stdio: ["pipe", "pipe", "pipe"] });
      procs.push({ name: "pv", child: pv, ok: (c) => c === 0 });
      tar.stdout!.pipe(pv.stdin!);
      pv.stdout!.pipe(comp.stdin!);
      let stderrBuf = "";
      pv.stderr!.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString();
        const lines = stderrBuf.split(/[\r\n]/);
        stderrBuf = lines.pop() ?? "";
        for (const line of lines) {
          const pct = parseInt(line.trim(), 10);
          if (Number.isFinite(pct) && pct >= 0 && pct <= 100) {
            emit?.({
              percent: pct,
              bytesCurrent: Math.round((pct / 100) * (totalBytes as number)),
              bytesTotal: totalBytes,
              message: "Compressing backup data",
            });
          }
        }
      });
      pv.on("error", fail);
    } else {
      tar.stdout!.pipe(comp.stdin!);
    }

    comp.stdout!.pipe(out);
    tar.on("error", fail);
    comp.on("error", fail);

    let pending = procs.length + 1; // +1 for the output stream
    const done = () => {
      pending -= 1;
      if (pending === 0 && !failed) resolve();
    };

    out.on("finish", done);
    out.on("error", fail);
    for (const { name, child, ok } of procs) {
      child.on("close", (code) => {
        if (!ok(code)) {
          fail(new Error(`${name} exited with code ${code}`));
          return;
        }
        done();
      });
    }
  });
}
