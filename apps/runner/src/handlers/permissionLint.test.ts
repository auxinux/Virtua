import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

/**
 * Static guard against the 0.8.2 class of bug: a recursive chown/chmod (or a
 * find/xargs driving one) over directories that can hold LXC root
 * filesystems. Every such command in the shipped scripts must be reviewed and
 * listed below with the reason it cannot reach a pool or a rootfs.
 */

const REPO_ROOT = path.resolve(__dirname, "../../../..");

const REVIEWED: Array<{ file: string; command: string; why: string }> = [
  { file: "INSTALL/install.sh", command: 'find "$qemu_isos_dir" -type f', why: "regular files of the ISO library, outside the pools" },
  { file: "INSTALL/vdm-install.sh", command: 'chown -R "$SERVICE_USER:$SERVICE_USER" "$VDM_DATA_DIR"', why: "VDM data dir, inside the VDM container" },
  { file: "INSTALL/vdm-install.sh", command: 'chown -R "${SERVICE_USER}:${SERVICE_USER}" "${VDM_DATA_DIR}"', why: "VDM data dir, inside the VDM container" },
  { file: "INSTALL/vdm-install.sh", command: 'chown -R root:"$SERVICE_USER" "$INSTALL_DIR"', why: "VDM application tree, inside the VDM container" },
  { file: "INSTALL/vdm-install.sh", command: 'find "$INSTALL_DIR" -type d -exec chmod 0750', why: "VDM application tree, inside the VDM container" },
  { file: "INSTALL/vdm-install.sh", command: 'find "$INSTALL_DIR" -type f -exec chmod g+r', why: "VDM application tree, inside the VDM container" },
  { file: "packaging/deb/debian/postinst", command: 'find "${INSTALL_DIR}/INSTALL" -name "*.sh"', why: "installer scripts shipped in the package" },
  { file: "packaging/deb/setup-depot-server.sh", command: 'chmod -R a+rX "${DEPOT_ROOT}"', why: "APT depot server, not a Virtua node" },
  { file: "packaging/deb/sync-os-mirrors.sh", command: 'chmod -R a+rX "${DEPOT_ROOT}/DEBIAN" "${DEPOT_ROOT}/UBUNTU"', why: "APT depot mirrors, not a Virtua node" },
];

const RISKY = [
  /\b(chown|chmod|chgrp|setfacl)\s+(?:[^\n]*\s)?(-[a-zA-Z]*R[a-zA-Z]*|--recursive)(\s|$)/,
  /\bfind\b[^\n]*-exec(?:dir)?\s+(chown|chmod|chgrp|setfacl)\b/,
  /\bxargs\b[^\n]*\b(chown|chmod|chgrp|setfacl)\b/,
];

function shellScripts(): string[] {
  const inDir = (dir: string, keep: (name: string) => boolean) =>
    fs.readdirSync(path.join(REPO_ROOT, dir)).filter(keep).map((name) => path.posix.join(dir, name));
  const isSh = (name: string) => name.endsWith(".sh");
  return [
    ...inDir(".", isSh),
    ...inDir("INSTALL", (name) => isSh(name) || name === "vdm-ha-agent"),
    ...inDir("scripts", isSh),
    ...inDir("packaging/deb", isSh),
    ...inDir("packaging/deb/debian", (name) => ["postinst", "prerm", "postrm"].includes(name)),
  ];
}

/** Continuation lines joined, comment lines dropped. */
function logicalLines(text: string): string[] {
  const lines: string[] = [];
  let pending = "";
  for (const raw of text.split("\n")) {
    if (!pending && raw.trim().startsWith("#")) continue;
    if (raw.endsWith("\\")) {
      pending += `${raw.slice(0, -1)} `;
      continue;
    }
    lines.push(pending + raw);
    pending = "";
  }
  if (pending) lines.push(pending);
  return lines;
}

function riskyCommands(): Array<{ file: string; line: string }> {
  return shellScripts().flatMap((file) =>
    logicalLines(fs.readFileSync(path.join(REPO_ROOT, file), "utf8"))
      .filter((line) => RISKY.some((pattern) => pattern.test(line)))
      .map((line) => ({ file, line: line.trim() })),
  );
}

function body(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `${signature} not found`).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf("\n}\n", start));
}

function tsSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "dist" ? [] : tsSources(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes(".test.") ? [full] : [];
  });
}

describe("recursive permission changes in shell scripts", () => {
  it("only the reviewed ones exist", () => {
    const unreviewed = riskyCommands().filter(({ file, line }) =>
      !REVIEWED.some((entry) => entry.file === file && line.includes(entry.command)));
    expect(unreviewed).toEqual([]);
  });

  it("the reviewed list has no stale entries", () => {
    const found = riskyCommands();
    const stale = REVIEWED.filter((entry) => !found.some(({ file, line }) => file === entry.file && line.includes(entry.command)));
    expect(stale).toEqual([]);
  });
});

describe("install.sh storage handling", () => {
  const install = fs.readFileSync(path.join(REPO_ROOT, "INSTALL/install.sh"), "utf8");

  it("loads the LXC-safe helpers and ships them", () => {
    expect(install).toContain('source "$INSTALL_DIR/INSTALL/storage-permissions.sh"');
    expect(install).toContain('"INSTALL/storage-permissions.sh"');
  });

  it("routes every pool permission change through the guarded walk", () => {
    expect(body(install, "fix_libvirt_storage_permissions() {")).toContain('virtua_fix_pool_permissions "$AUXINUX_DATA_DIR/pools"');
    const createDataDirs = body(install, "create_data_dirs() {");
    expect(createDataDirs).toContain("virtua_prepare_data_dirs");
    expect(createDataDirs).toContain("virtua_report_damaged_lxc_rootfs");
    expect(install).not.toMatch(/find\s+"\$AUXINUX_DATA_DIR/);
  });

  it("never deletes the whole data directory on reset, clean or auto-recovery", () => {
    expect(install).not.toMatch(/remove_path_if_exists\s+"\$AUXINUX_DATA_DIR"\s*$/m);
    expect(body(install, "reset_portal_state() {")).toContain('virtua_remove_portal_data "$AUXINUX_DATA_DIR"');
    expect(body(install, "clean_full_wipe() {")).toContain('virtua_remove_portal_data "$AUXINUX_DATA_DIR"');
  });
});

describe("runner and API permission changes", () => {
  const storage = fs.readFileSync(path.join(REPO_ROOT, "apps/runner/src/handlers/storage.ts"), "utf8");
  const qemu = fs.readFileSync(path.join(REPO_ROOT, "apps/runner/src/handlers/qemu.ts"), "utf8");

  it("every storage chown/chmod helper goes through the LXC rootfs guard", () => {
    expect(body(storage, "async function ensureLibvirtPoolAccess(")).toContain("assertOutsideLxcRootfs(");
    expect(body(qemu, "async function ensureLibvirtStorageDir(")).toContain("assertOutsideLxcRootfs(");
    expect(body(qemu, "async function ensureLibvirtDiskAccess(")).toContain("assertOutsideLxcRootfs(");
  });

  it("TypeScript never spawns a recursive permission command", () => {
    const spawnsRecursive = /["'`](chown|chmod|chgrp|setfacl)["'`]\s*,\s*\[[^\]]*["'`](-[a-zA-Z]*R[a-zA-Z]*|--recursive)["'`]/;
    const spawnsFindExec = /["'`]find["'`]\s*,\s*\[[^\]]*["'`]-exec(dir)?["'`]/;
    const offenders = ["apps", "packages"]
      .flatMap((dir) => tsSources(path.join(REPO_ROOT, dir)))
      .filter((file) => {
        const source = fs.readFileSync(file, "utf8");
        return spawnsRecursive.test(source) || spawnsFindExec.test(source);
      })
      .map((file) => path.relative(REPO_ROOT, file));
    expect(offenders).toEqual([]);
  });
});
