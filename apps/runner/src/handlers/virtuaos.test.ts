import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getVirtuaOsStatus, setKernelChannel, setVirtuaOsChannel, type ExecFn, type VirtuaOsEnv } from "./virtuaos";

const VIRTUA_SOURCES = "Types: deb\nURIs: https://dep.auxinux.ca/VIRTUA\nSuites: virtua\nComponents: main\n";

let root: string;
let calls: string[];

function put(rel: string, content: string) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function read(rel: string): string | null {
  const file = path.join(root, rel);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

/** Fake apt/dpkg/grub: `fail` maps a command prefix to a failing stderr. */
function makeEnv(opts: { installed?: string[]; fail?: Record<string, string>; uname?: string; onInstall?: (pkg: string) => void } = {}): VirtuaOsEnv {
  const exec: ExecFn = async (command, args) => {
    const line = `${command} ${args.join(" ")}`.trim();
    calls.push(line);
    for (const [prefix, stderr] of Object.entries(opts.fail ?? {})) {
      if (line.startsWith(prefix)) return { code: 100, stdout: "", stderr };
    }
    if (command === "dpkg-query") {
      return { code: 0, stdout: (opts.installed ?? []).map((pkg) => `${pkg}\tii \n`).join(""), stderr: "" };
    }
    if (command === "apt-get" && args[0] === "install") opts.onInstall?.(args[args.length - 1]);
    return { code: 0, stdout: "", stderr: "" };
  };
  return { root, exec, unameR: () => opts.uname ?? "7.2.4-auxinux-virtua-amd64" };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "virtuaos-"));
  calls = [];
  put("/etc/os-release", "ID=debian\n");
  put("/etc/apt/sources.list.d/virtua.sources", VIRTUA_SOURCES);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("non-VirtuaOS host", () => {
  it("reports isVirtuaOS false and refuses every change", async () => {
    const env = makeEnv();
    expect((await getVirtuaOsStatus(env)).isVirtuaOS).toBe(false);
    await expect(setVirtuaOsChannel({ channel: "DEV" }, env)).rejects.toThrow(/not VirtuaOS/);
    await expect(setKernelChannel({ channel: "DEV" }, env)).rejects.toThrow(/not VirtuaOS/);
    expect(calls).toEqual([]);
    expect(read("/etc/virtuaos/channel")).toBeNull();
  });
});

describe("VirtuaOS host", () => {
  beforeEach(() => put("/etc/virtuaos-version", "1.0.3-BETA\n"));

  it("reports channel, running kernel and mismatch", async () => {
    put("/etc/virtuaos/channel", "VIRTUAOS_CHANNEL=PROD\nKERNEL_CHANNEL=PROD\n");
    const status = await getVirtuaOsStatus(makeEnv({ uname: "7.2.9-dev-auxinux-virtua-amd64", installed: ["kernel-virtua-dev"] }));
    expect(status).toMatchObject({
      isVirtuaOS: true,
      version: "1.0.3-BETA",
      kernelChannel: "PROD",
      runningKernelChannel: "DEV",
      installedKernelMetas: ["kernel-virtua-dev"],
      mismatch: true,
    });
  });

  it("changes VIRTUAOS_CHANNEL without running anything and keeps unknown keys", async () => {
    put("/etc/virtuaos/channel", "VOS_MIRROR=eu\nKERNEL_CHANNEL=DEV\n");
    const result = await setVirtuaOsChannel({ channel: "dev" }, makeEnv());
    expect(result).toEqual({ ok: true, previous: "PROD", current: "DEV" });
    expect(read("/etc/virtuaos/channel")).toBe("VOS_MIRROR=eu\nKERNEL_CHANNEL=DEV\nVIRTUAOS_CHANNEL=DEV\n");
    expect(fs.statSync(path.join(root, "/etc/virtuaos/channel")).mode & 0o777).toBe(0o644);
    expect(calls).toEqual([]);
  });

  it("rejects anything but PROD|DEV", async () => {
    await expect(setKernelChannel({ channel: "https://dep.auxinux.ca/VIRTUA/KERNEL-DEV/" }, makeEnv())).rejects.toThrow(/PROD or DEV/);
    expect(calls).toEqual([]);
  });

  it("switches to DEV: kernel-dev suite, dev meta-package, grub, channel file", async () => {
    const result = await setKernelChannel({ channel: "DEV" }, makeEnv());
    expect(result).toMatchObject({ ok: true, previous: "PROD", current: "DEV", rebootRequired: true });
    expect(read("/etc/apt/sources.list.d/auxinux-kernel.sources")).toContain("Suites: kernel-dev\n");
    expect(read("/etc/apt/sources.list.d/virtua.sources")).toBe(VIRTUA_SOURCES);
    expect(read("/etc/virtuaos/channel")).toBe("KERNEL_CHANNEL=DEV\n");
    expect(calls).toEqual(["apt-get update --error-on=any", "apt-get install -y kernel-virtua-dev", "update-grub"]);
    expect(calls.some((c) => c.includes("full-upgrade") || c.includes("reboot"))).toBe(false);
  });

  it("switches back to PROD and purges the DEV kernels once a PROD image exists", async () => {
    put("/etc/virtuaos/channel", "KERNEL_CHANNEL=DEV\n");
    put("/etc/apt/sources.list.d/auxinux-kernel.sources", "Suites: kernel-dev\n");
    put("/boot/vmlinuz-7.2.9-dev-auxinux-virtua-amd64", "");
    put("/boot/vmlinuz-7.2.4-auxinux-virtua-amd64", "");
    const env = makeEnv({ installed: ["kernel-virtua", "kernel-virtua-dev", "linux-image-7.2.9-dev-auxinux-virtua-amd64", "linux-image-7.2.4-auxinux-virtua-amd64"] });
    const result = await setKernelChannel({ channel: "PROD" }, env);
    expect(result).toMatchObject({ ok: true, previous: "DEV", current: "PROD" });
    expect(read("/etc/apt/sources.list.d/auxinux-kernel.sources")).toContain("Suites: kernel\n");
    expect(calls).toContain("apt-get purge -y kernel-virtua-dev linux-image-7.2.9-dev-auxinux-virtua-amd64");
    expect(calls[calls.length - 1]).toBe("update-grub");
    expect(read("/etc/virtuaos/channel")).toBe("KERNEL_CHANNEL=PROD\n");
    expect(read("/etc/apt/sources.list.d/virtua.sources")).toBe(VIRTUA_SOURCES);
  });

  it("purges nothing and fails when no PROD kernel is present", async () => {
    put("/etc/virtuaos/channel", "KERNEL_CHANNEL=DEV\n");
    put("/etc/apt/sources.list.d/auxinux-kernel.sources", "Suites: kernel-dev\n");
    put("/boot/vmlinuz-7.2.9-dev-auxinux-virtua-amd64", "");
    const env = makeEnv({ installed: ["kernel-virtua-dev", "linux-image-7.2.9-dev-auxinux-virtua-amd64"] });
    await expect(setKernelChannel({ channel: "PROD" }, env)).rejects.toThrow(/No PROD kernel/);
    expect(calls.some((c) => c.includes("purge"))).toBe(false);
    expect(calls).not.toContain("update-grub");
    expect(read("/etc/virtuaos/channel")).toBe("KERNEL_CHANNEL=DEV\n");
    expect(read("/etc/apt/sources.list.d/auxinux-kernel.sources")).toBe("Suites: kernel-dev\n");
  });

  it("restores the backups and returns stderr when apt-get update fails", async () => {
    put("/etc/virtuaos/channel", "KERNEL_CHANNEL=PROD\nVOS_MIRROR=eu\n");
    put("/etc/apt/sources.list.d/auxinux-kernel.sources", "Suites: kernel\n");
    const env = makeEnv({ fail: { "apt-get update": "E: The repository 'https://dep.auxinux.ca/VIRTUA kernel-dev Release' does not have a Release file." } });
    await expect(setKernelChannel({ channel: "DEV" }, env)).rejects.toThrow(/does not have a Release file/);
    expect(read("/etc/apt/sources.list.d/auxinux-kernel.sources")).toBe("Suites: kernel\n");
    expect(read("/etc/virtuaos/channel")).toBe("KERNEL_CHANNEL=PROD\nVOS_MIRROR=eu\n");
    expect(calls).toEqual(["apt-get update --error-on=any"]);
    expect(read("/etc/apt/sources.list.d/virtua.sources")).toBe(VIRTUA_SOURCES);
  });

  it("removes a kernel sources file that did not exist before a failed switch", async () => {
    const env = makeEnv({ fail: { "apt-get update": "E: boom" } });
    await expect(setKernelChannel({ channel: "DEV" }, env)).rejects.toThrow(/boom/);
    expect(read("/etc/apt/sources.list.d/auxinux-kernel.sources")).toBeNull();
  });
});
