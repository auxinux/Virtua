import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  KERNEL_META_PACKAGES,
  VIRTUAOS_CHANNEL_KEYS,
  VIRTUAOS_FILES,
  VIRTUAOS_REPOS,
  detectVirtuaOs,
  devKernelPackages,
  kernelReleaseChannel,
  parseChannelInput,
  prodKernelImages,
  readChannelFile,
  renderKernelSources,
  updateChannelFile,
  type VirtuaOsChannel,
  type VirtuaOsKernelChannelResult,
  type VirtuaOsStatus,
} from "@auxinux/shared";

export interface ExecResult { code: number; stdout: string; stderr: string }
export type ExecFn = (command: string, args: string[], timeoutMs?: number) => Promise<ExecResult>;

/**
 * Everything the channel operations touch on the host. Tests swap `root` for a
 * temp directory and `exec` for a fake, so no real apt/grub ever runs.
 */
export interface VirtuaOsEnv {
  root: string;
  exec: ExecFn;
  unameR: () => string;
}

const APT_ENV = {
  ...process.env,
  DEBIAN_FRONTEND: "noninteractive",
  APT_LISTCHANGES_FRONTEND: "none",
  LC_ALL: "C",
};

const defaultExec: ExecFn = (command, args, timeoutMs = 30 * 60_000) =>
  new Promise((resolve) => {
    execFile(command, args, { env: APT_ENV, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as NodeJS.ErrnoException).code === "number" ? Number((error as NodeJS.ErrnoException).code) : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") || (error && !stderr ? error.message : "") });
    });
  });

export const defaultVirtuaOsEnv: VirtuaOsEnv = { root: "/", exec: defaultExec, unameR: () => os.release() };

function hostPath(env: VirtuaOsEnv, absolute: string) {
  return path.join(env.root, absolute);
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** tmp file in the same directory, fsync, rename, fsync the directory. */
export async function writeFileAtomic(file: string, content: string, mode = 0o644) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o755 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const handle = await fs.open(tmp, "w", mode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
  try {
    const dirHandle = await fs.open(dir, "r");
    try { await dirHandle.sync(); } finally { await dirHandle.close(); }
  } catch { /* directory fsync is best effort on exotic filesystems */ }
}

export async function detectHost(env: VirtuaOsEnv = defaultVirtuaOsEnv) {
  const [versionFile, releaseFile, osRelease] = await Promise.all([
    readOptional(hostPath(env, VIRTUAOS_FILES.version)),
    readOptional(hostPath(env, VIRTUAOS_FILES.release)),
    readOptional(hostPath(env, VIRTUAOS_FILES.osRelease)),
  ]);
  return detectVirtuaOs({ versionFile, releaseFile, osRelease });
}

/** Which of kernel-virtua / kernel-virtua-dev are installed. */
async function installedPackages(env: VirtuaOsEnv, patterns: string[]): Promise<string[]> {
  // dpkg-query exits 1 when a pattern matches nothing but still lists the rest.
  const { stdout } = await env.exec("dpkg-query", ["-W", "-f=${Package}\\t${db:Status-Abbrev}\\n", ...patterns], 30_000);
  return stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(([pkg, status]) => pkg && status?.startsWith("ii"))
    .map(([pkg]) => pkg);
}

export async function getVirtuaOsStatus(env: VirtuaOsEnv = defaultVirtuaOsEnv): Promise<Omit<VirtuaOsStatus, "latestVirtuaOS">> {
  const detection = await detectHost(env);
  const channels = readChannelFile(await readOptional(hostPath(env, VIRTUAOS_FILES.channel)));
  const runningKernel = env.unameR();
  const runningKernelChannel = kernelReleaseChannel(runningKernel);
  const installed = detection.isVirtuaOS
    ? await installedPackages(env, [...KERNEL_META_PACKAGES, "linux-image-*", "linux-headers-*"])
    : [];
  const installedKernelMetas = installed.filter((pkg) => (KERNEL_META_PACKAGES as readonly string[]).includes(pkg));
  return {
    isVirtuaOS: detection.isVirtuaOS,
    version: detection.version,
    virtuaosChannel: channels.virtuaosChannel,
    kernelChannel: channels.kernelChannel,
    runningKernel,
    runningKernelChannel,
    installedKernelMetas,
    devKernelPackages: devKernelPackages(installed),
    mismatch: runningKernelChannel !== channels.kernelChannel,
  };
}

// ── Locking ─────────────────────────────────────────────────────────────────
let channelOperationRunning = false;

const DPKG_LOCKS = [
  "/var/lib/dpkg/lock-frontend",
  "/var/lib/dpkg/lock",
  "/var/lib/apt/lists/lock",
  "/var/cache/apt/archives/lock",
];

/**
 * dpkg/apt hold fcntl locks, which /proc/locks lists as MAJ:MIN:INODE. No
 * dependency on fuser/lsof, which a minimal host may not ship.
 */
export async function isDpkgLocked(env: VirtuaOsEnv = defaultVirtuaOsEnv): Promise<boolean> {
  const procLocks = await readOptional(hostPath(env, "/proc/locks"));
  if (!procLocks) return false;
  const held = new Set<string>();
  for (const line of procLocks.split("\n")) {
    const m = line.match(/\s([0-9a-f]+):([0-9a-f]+):(\d+)\s/i);
    if (m) held.add(`${parseInt(m[1], 16)}:${parseInt(m[2], 16)}:${m[3]}`);
  }
  for (const lock of DPKG_LOCKS) {
    try {
      const st = await fs.stat(hostPath(env, lock));
      const major = Math.floor(st.dev / 256) & 0xfff;
      const minor = (st.dev & 0xff) | ((st.dev >> 12) & 0xfff00);
      if (held.has(`${major}:${minor}:${st.ino}`)) return true;
    } catch { /* lock file absent: nothing holds it */ }
  }
  return false;
}

async function requireVirtuaOs(env: VirtuaOsEnv) {
  if (!(await detectHost(env)).isVirtuaOS) {
    throw Object.assign(new Error("This host is not VirtuaOS"), { code: "NOT_VIRTUAOS" });
  }
}

// ── VIRTUAOS_CHANNEL ────────────────────────────────────────────────────────

/** Only the channel file changes; `vos os upgrade` reads it for the upgrade itself. */
export async function setVirtuaOsChannel(params: { channel?: unknown }, env: VirtuaOsEnv = defaultVirtuaOsEnv) {
  await requireVirtuaOs(env);
  const channel = parseChannelInput(params.channel);
  if (!channel) throw new Error("channel must be PROD or DEV");
  if (channelOperationRunning) throw new Error("Another VirtuaOS channel operation is already running");
  channelOperationRunning = true;
  try {
    const file = hostPath(env, VIRTUAOS_FILES.channel);
    const current = await readOptional(file);
    const previous = readChannelFile(current).virtuaosChannel;
    await writeFileAtomic(file, updateChannelFile(current, { [VIRTUAOS_CHANNEL_KEYS.virtuaos]: channel }));
    return { ok: true, previous, current: channel };
  } finally {
    channelOperationRunning = false;
  }
}

// ── KERNEL_CHANNEL ──────────────────────────────────────────────────────────

class KernelChannelError extends Error {
  constructor(message: string, readonly log: string) {
    super(message);
  }
}

/**
 * Switch the kernel APT suite and meta-package. Never reboots, never runs
 * full-upgrade. Going back to PROD purges the -dev kernels — GRUB boots the
 * highest version (7.2.9-dev > 7.2.4), so without the purge the host would
 * come back up on DEV — but only once a PROD image is confirmed in /boot.
 */
export async function setKernelChannel(params: { channel?: unknown }, env: VirtuaOsEnv = defaultVirtuaOsEnv): Promise<VirtuaOsKernelChannelResult> {
  await requireVirtuaOs(env);
  const channel = parseChannelInput(params.channel);
  if (!channel) throw new Error("channel must be PROD or DEV");
  if (channelOperationRunning) throw new Error("Another VirtuaOS channel operation is already running");
  channelOperationRunning = true;
  const logLines: string[] = [];
  const log = (line: string) => logLines.push(line);
  const sourcesFile = hostPath(env, VIRTUAOS_FILES.kernelSources);
  const channelFile = hostPath(env, VIRTUAOS_FILES.channel);
  const sourcesBak = `${sourcesFile}.bak`;
  const channelBak = `${channelFile}.bak`;

  const run = async (command: string, args: string[]) => {
    log(`$ ${command} ${args.join(" ")}`);
    const result = await env.exec(command, args);
    const output = `${result.stdout}${result.stderr}`.trim();
    if (output) log(output);
    if (result.code !== 0) throw new KernelChannelError(result.stderr.trim() || `${command} exited with code ${result.code}`, logLines.join("\n"));
    return result;
  };

  try {
    if (await isDpkgLocked(env)) throw new Error("dpkg/apt is locked by another process — retry once it has finished");
    const channelContent = await readOptional(channelFile);
    const previous = readChannelFile(channelContent).kernelChannel;
    const sourcesContent = await readOptional(sourcesFile);

    // 2. Backups. A file that did not exist is "restored" by removing it.
    if (sourcesContent !== null) await fs.copyFile(sourcesFile, sourcesBak);
    if (channelContent !== null) await fs.copyFile(channelFile, channelBak);
    const restore = async () => {
      if (sourcesContent !== null) await fs.copyFile(sourcesBak, sourcesFile);
      else await fs.rm(sourcesFile, { force: true });
      if (channelContent !== null) await fs.copyFile(channelBak, channelFile);
      log("Restored the previous auxinux-kernel.sources and channel file.");
    };

    try {
      // 3. Kernel suite only — virtua.sources (suite `virtua`) is never touched.
      await writeFileAtomic(sourcesFile, renderKernelSources(channel));
      log(`Wrote ${VIRTUAOS_FILES.kernelSources} (suite ${VIRTUAOS_REPOS.kernel.suite[channel]}).`);

      // 4. A suite the depot does not serve must fail here, not later.
      await run("apt-get", ["update", "--error-on=any"]);

      // 5. Meta-package of the target channel.
      if (channel === "DEV") {
        await run("apt-get", ["install", "-y", VIRTUAOS_REPOS.kernel.meta.DEV]);
      } else {
        await run("apt-get", ["install", "-y", VIRTUAOS_REPOS.kernel.meta.PROD]);
        const prodImages = prodKernelImages(await fs.readdir(hostPath(env, "/boot")).catch(() => [] as string[]));
        if (prodImages.length === 0) {
          throw new KernelChannelError("No PROD kernel (/boot/vmlinuz-*-auxinux-virtua-amd64 without -dev-) is installed — nothing was purged", logLines.join("\n"));
        }
        log(`PROD kernel present: ${prodImages.join(", ")}`);
        const toPurge = devKernelPackages(await installedPackages(env, [
          VIRTUAOS_REPOS.kernel.meta.DEV,
          "linux-image-*",
          "linux-headers-*",
        ]));
        if (toPurge.length > 0) await run("apt-get", ["purge", "-y", ...toPurge]);
        else log("No DEV kernel package to purge.");
      }
    } catch (error) {
      await restore();
      throw error;
    }

    // 6. Boot menu, then record the choice.
    await run("update-grub", []);
    const latestChannelContent = await readOptional(channelFile);
    await writeFileAtomic(channelFile, updateChannelFile(latestChannelContent, { [VIRTUAOS_CHANNEL_KEYS.kernel]: channel }));
    log(`${VIRTUAOS_CHANNEL_KEYS.kernel}=${channel} written to ${VIRTUAOS_FILES.channel}. Reboot required.`);
    // The sources backup would make apt print an "invalid filename extension"
    // notice on every run; the channel backup is kept.
    await fs.rm(sourcesBak, { force: true });

    return { ok: true, previous, current: channel, rebootRequired: true, log: logLines.join("\n") };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const detail = error instanceof KernelChannelError ? error.log : logLines.join("\n");
    throw new Error(detail ? `${message}\n\n${detail}` : message);
  } finally {
    channelOperationRunning = false;
  }
}

export async function handleVirtuaOs(action: string, params: unknown): Promise<unknown> {
  const p = (params ?? {}) as Record<string, unknown>;
  switch (action) {
    case "virtuaos_status": return getVirtuaOsStatus();
    case "virtuaos_set_channel": return setVirtuaOsChannel(p);
    case "virtuaos_set_kernel_channel": return setKernelChannel(p);
    default: throw new Error(`Unknown VirtuaOS action: ${action}`);
  }
}
