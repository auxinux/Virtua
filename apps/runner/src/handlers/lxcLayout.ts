import * as path from "path";

/**
 * A container's rootfs can be relocated onto a storage pool, in which case it
 * is NOT under /var/lib/lxc/<name>. Every operation that copies "the container"
 * has to know that, otherwise it captures the config and nothing else.
 */
export function isExternalRootfs(containerDir: string, rootfsPath: string): boolean {
  const relative = path.relative(containerDir, rootfsPath);
  const inside = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  return !inside;
}

/**
 * tar members for an LXC backup.
 *
 * Relative members (-C <parent> <name>) rather than absolute paths, so the
 * archive is self-describing: `<name>/…` for the container definition and
 * `rootfs/…` for a relocated rootfs.
 */
export function buildBackupTarArgs(containerDir: string, externalRootfs?: string): string[] {
  return [
    "--warning=no-file-changed",
    "--warning=no-file-removed",
    "-cf",
    "-",
    "-C", path.dirname(containerDir), path.basename(containerDir),
    ...(externalRootfs ? ["-C", path.dirname(externalRootfs), path.basename(externalRootfs)] : []),
  ];
}

export interface SnapshotRestorability {
  ok: boolean;
  reason?: string;
}

/**
 * v1 snapshots of a pool-backed container never captured the filesystem, so
 * rolling one back is a silent no-op. Refuse loudly instead of reporting
 * success while changing nothing.
 */
export function checkSnapshotRestorable(
  snapshotName: string,
  externalRootfsPath: string | undefined,
  hasCapturedRootfs: boolean,
): SnapshotRestorability {
  if (!externalRootfsPath) return { ok: true };
  if (hasCapturedRootfs) return { ok: true };
  return {
    ok: false,
    reason:
      `Snapshot ${snapshotName} was taken before relocated-rootfs support and contains no filesystem data ` +
      `(rootfs lives at ${externalRootfsPath}). Rolling it back would change nothing — delete it and take a new snapshot.`,
  };
}
