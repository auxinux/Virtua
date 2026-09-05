import { test, expect, type Page } from "@playwright/test";
async function desktop(page: Page, os = "macos", ready = false) {
  await page.addInitScript(({ os, ready }) => {
    let qemu = ready;
    const calls: string[] = [];
    const state = () => ({ os, architecture: os === "macos" ? "arm64" : "amd64", accelerator: os === "macos" ? "hvf" : "kvm", busy: false,
      engines: [ { id: "qemu", state: qemu ? "ready" : "missing", detail: "QEMU local" }, { id: "docker", state: "missing", detail: "Docker optionnel" }, { id: "lxc", state: "missing", detail: "Debian 13 LXC" } ] });
    const win = window as any;
    win.testCalls = calls;
    win.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    win.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (cmd: string, args: any = {}) => {
        calls.push(cmd);
        switch (cmd) {
          case "runtime_platform": return { os, arch: os === "macos" ? "arm64" : "amd64", mobile: false };
          case "local_qemu_diagnostics": return { os, hostArch: os === "macos" ? "arm64" : "amd64", accelerator: "hvf", ready: qemu, qemuImg: { available: qemu }, qemuSystemArm64: { available: qemu }, qemuSystemAmd64: { available: qemu }, homebrew: { available: true } };
          case "local_engine_status": return state();
          case "local_prepare_engine": if (args.engine === "qemu") { qemu = true; return state(); } throw "Installation annulée. Vous pouvez réessayer.";
          case "local_list_vms": case "local_list_containers": return [];
          case "local_host_metrics": return { totalCores: 8, totalMemoryGib: 16, virtualizationCores: 6, virtualizationMemoryGib: 8, cpuUsage: 10, memoryUsage: 20, storageUsage: 30, computerName: "Test Host" };
          case "local_load_storage_config": return { vmConfigDir: "/test/vms", diskDir: "/test/disks", isoDir: "/test/iso", snapshotDir: "/test/snapshots", exportDir: "/test/exports" };
          case "plugin:event|listen": return 1;
          default: return null;
        }
      },
    };
  }, { os, ready });
}
test("first local launch prepares QEMU before opening the dashboard", async ({ page }) => {
  await desktop(page);
  await page.goto("/");
  await page.getByRole("button", { name: /local/i }).click();
  await expect(page.getByRole("heading", { name: "Préparer cet ordinateur" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ouvrir le mode local" })).toHaveCount(0);
  await page.getByRole("button", { name: "Installer et préparer" }).click();
  await page.getByRole("button", { name: "Ouvrir le mode local" }).click();
  await expect(page.getByText("Vue d'ensemble")).toBeVisible();
  await expect(page.getByRole("link", { name: "LXC", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Docker", exact: true })).toBeVisible();
});
test("cloud login never installs or probes local engines", async ({ page }) => {
  await desktop(page);
  await page.goto("/");
  await page.getByRole("button", { name: /cloud|distant/i }).click();
  await expect(page.locator('input[type="password"]')).toBeVisible();
  expect(await page.evaluate(() => (window as any).testCalls.filter((c: string) => c.startsWith("local_")))).toEqual([]);
});
test("optional setup failure remains recoverable and Linux does not offer a Debian VM", async ({ page }) => {
  await desktop(page, "linux", true);
  await page.goto("/");
  await page.getByRole("button", { name: /local/i }).click();
  await page.getByRole("link", { name: "Configuration", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Moteurs locaux" })).toBeVisible();
  await page.getByRole("button", { name: "Installer et préparer" }).first().click();
  await expect(page.getByRole("alert")).toContainText("Installation annulée");
  await expect(page.getByRole("button", { name: "Installer et préparer" }).first()).toBeEnabled();
  await expect(page.getByRole("button", { name: "Arrêter Debian" })).toHaveCount(0);
  await page.screenshot({ path: "test-results/engines-linux.png", fullPage: true });
});
