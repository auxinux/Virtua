import { test, expect } from "@playwright/test";
// A 1366x768 laptop in AuxiNux Shell: 688 px left under the taskbar and title bar.
const vms = [{ id: "local-vm-1", name: "Windows 11 Pro", architecture: "amd64", cpu: 4, memoryMib: 8192, diskGib: 64, diskPath: "/d/w.qcow2", isoPath: null, network: "user", guestOs: "windows", state: "running", pid: 1, vncPort: 5901, cpuUsage: 12, memoryUsage: 40, uptimeSeconds: 3600, createdAt: "0", updatedAt: "0" },
  { id: "local-vm-2", name: "Debian 13 serveur", architecture: "amd64", cpu: 2, memoryMib: 2048, diskGib: 20, diskPath: "/d/d.qcow2", isoPath: null, network: "user", guestOs: "other", state: "stopped", createdAt: "0", updatedAt: "0" }];
test.use({ viewport: { width: 1366, height: 688 } });
for (const theme of ["dark", "light"] as const)
for (const [name, path] of [["dashboard", "/"], ["vms", "/#/vms"], ["detail", "/#/resources/local-vm-1"], ["console", "/#/console/local-vm-2"], ["storage", "/#/storage"], ["unified", "/#/unified"], ["settings", "/#/settings"]] as const) {
  test(`screen ${theme} ${name}`, async ({ page }) => {
    await page.addInitScript(({ vms, theme }) => {
      window.localStorage.setItem("auxinux-virtua-desktop-mode", "local");
      const w = window as any;
      w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
      w.__TAURI_INTERNALS__ = { transformCallback: () => 1, invoke: async (cmd: string) => {
        switch (cmd) {
          case "desktop_appearance": return { auxinuxShell: true, dark: theme === "dark", accent: "#ef8a12", highContrast: false, fontFamily: "Inter Variable", textScale: 1, animations: true };
          case "runtime_platform": return { os: "linux", arch: "amd64", mobile: false, auxinux: true, distro: "auxinux" };
          case "local_qemu_diagnostics": return { os: "linux", hostArch: "amd64", accelerator: "kvm", ready: true, qemuImg: { available: true }, qemuSystemArm64: { available: false }, qemuSystemAmd64: { available: true }, homebrew: { available: false }, host: { distro: "auxinux", auxinux: true } };
          case "local_engine_status": return { os: "linux", architecture: "amd64", accelerator: "kvm", busy: false, host: { distro: "auxinux", auxinux: true }, engines: [{ id: "qemu", state: "ready", detail: "QEMU" }, { id: "docker", state: "ready", detail: "Docker" }, { id: "lxc", state: "missing", detail: "Incus" }] };
          case "local_list_vms": return vms;
          case "local_list_containers": return [{ id: "docker:web", kind: "docker", name: "web", image: "nginx:latest", state: "running" }];
          case "local_host_metrics": return { totalCores: 8, totalMemoryGib: 16, virtualizationCores: 6, virtualizationMemoryGib: 8, cpuUsage: 10, memoryUsage: 20, storageUsage: 30, computerName: "portable" };
          case "local_load_storage_config": return { vmConfigDir: "/home/a/.local/share/AuxiNux Virtua Desktop/Local/VMs", diskDir: "/home/a/.local/share/AuxiNux Virtua Desktop/Local/Disks", isoDir: "/i", snapshotDir: "/s", exportDir: "/e" };
          case "local_storage_inventory": return { iso: [{ name: "Win11_24H2_French_x64.iso", path: "/i/w.iso", size: 6e9 }], templates: [], disks: [], snapshots: [], exports: [], dockerImages: [] };
          case "local_list_snapshots": return [];
          case "local_unified_overview": return { client: { available: true, detail: "FreeRDP 3 (RemoteApp).", installable: false }, vms: [{ id: "local-vm-1", name: "Windows 11 Pro", state: "running", architecture: "amd64", enabled: true, user: "andre", agent: true, rdpReady: true, needsRestart: false, integrated: false, apps: Array.from({ length: 14 }, (_, i) => ({ id: `a${i}`, name: ["Excel", "Word", "PowerPoint", "Paint", "Explorateur de fichiers", "Bloc-notes", "Outlook", "Teams", "Photoshop", "AutoCAD 2026", "Visual Studio", "Invite de commandes", "PowerShell", "Calculatrice"][i], path: "C:\\x.exe", args: "" })) }] };
          case "plugin:event|listen": return 1;
          default: return null;
        }
      } };
    }, { vms, theme });
    await page.goto(path);
    await page.waitForTimeout(500);
    await expect(page.locator("html")).toHaveAttribute("data-theme", `auxinux-${theme}`);
    // Nothing wider than the window, and the whole menu reachable without scrolling.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1366);
    const last = await page.getByRole("link", { name: "Configuration", exact: true }).boundingBox();
    expect(last && last.y + last.height).toBeLessThanOrEqual(688);
    await page.screenshot({ path: `test-results/screen-${theme}-${name}.png` });
  });
}
