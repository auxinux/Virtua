import * as fs from "fs";
import * as path from "path";

/**
 * System locations that can never hold Virtua storage content. A pool rooted at
 * (or near) "/" would otherwise make the listing walk the whole host — pseudo
 * filesystems, package manager state, the OS tree — which is both slow and how
 * unrelated files ended up presented as pool content.
 *
 * Matched as absolute prefixes rather than by directory name: pruning the name
 * "lib" at any depth would also hide /var/lib/libvirt/images, where real VM
 * disks live.
 */
export const WALK_SKIP_ABSOLUTE = [
  "/proc", "/sys", "/dev", "/run", "/boot", "/usr", "/etc", "/bin", "/sbin",
  "/lib", "/lib32", "/lib64", "/libx32", "/snap", "/tmp", "/srv",
  "/var/cache", "/var/log", "/var/lib/dpkg", "/var/lib/apt",
];

/** Never Virtua data, wherever they appear. */
export const WALK_SKIP_NAMES = new Set(["node_modules", ".git", "lost+found", ".cache"]);

export const WALK_MAX_DEPTH = 8;

/** True when `child` is `parent` itself or lives underneath it. */
export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function shouldSkipDirectory(fullPath: string, root: string, name: string): boolean {
  if (WALK_SKIP_NAMES.has(name)) return true;
  // Never prune the pool root itself, only what lies inside it.
  if (fullPath === root) return false;
  return WALK_SKIP_ABSOLUTE.some((skip) => fullPath === skip || fullPath.startsWith(`${skip}/`));
}

export async function walkFiles(root: string, current = root, results: string[] = [], depth = 0): Promise<string[]> {
  const entries = await fs.promises.readdir(current, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (depth >= WALK_MAX_DEPTH) continue;
      if (shouldSkipDirectory(fullPath, root, entry.name)) continue;
      await walkFiles(root, fullPath, results, depth + 1);
      continue;
    }
    if (entry.isFile()) results.push(fullPath);
  }
  return results;
}

/**
 * Is this file somewhere Virtua actually writes?
 *
 * Extension alone says nothing about ownership: the Go toolchain ships
 * `archive/tar` test fixtures (`gnu-*.tar`) and `.raw` fixtures, which a pool
 * rooted on the system disk happily reported as "Archive" and "Disk" — complete
 * with a Delete button pointed at host files.
 *
 * Virtua writes VM disks straight into the pool root, backups into
 * `<pool>/backups/`, and everything else under its own data directories.
 */
export function isManagedStorageLocation(poolPath: string, filePath: string, managedRoots: string[]): boolean {
  const relative = path.relative(poolPath, filePath);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    const segments = relative.split(path.sep);
    if (segments.length === 1) return true;      // disk created in the pool root
    if (segments[0] === "backups") return true;  // <pool>/backups/<file>
  }
  return managedRoots.some((root) => isInside(root, filePath));
}
