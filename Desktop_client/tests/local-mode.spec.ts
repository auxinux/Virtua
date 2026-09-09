import { test, expect, type Page } from "@playwright/test";

type Overrides = { vms?: unknown[]; dockerReady?: boolean };

/**
 * Boots the app straight into local mode with QEMU already available, so each
 * test exercises one behaviour instead of re-walking the setup wizard.
 */
async function localDesktop(page: Page, overrides: Overrides = {}) {
  await page.addInitScript((options) => {
    const { vms = [], dockerReady = false } = options as Overrides;
    let docker = dockerReady;
    const calls: Array<{ cmd: string; args: unknown }> = [];
    const engineState = () => ({
      os: "macos",
      architecture: "arm64",
      accelerator: "hvf",
      busy: false,
      engines: [
        { id: "qemu", state: "ready", detail: "QEMU local" },
        { id: "docker", state: docker ? "ready" : "missing", detail: "Docker est optionnel." },
        { id: "lxc", state: "missing", detail: "Debian 13 LXC" },
      ],
    });

    window.localStorage.setItem("auxinux-virtua-desktop-mode", "local");
    const win = window as any;
    win.testCalls = calls;
    win.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    win.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (cmd: string, args: any = {}) => {
        calls.push({ cmd, args });
        switch (cmd) {
          case "runtime_platform": return { os: "macos", arch: "arm64", mobile: false };
          case "local_qemu_diagnostics": return {
            os: "macos", hostArch: "arm64", accelerator: "hvf", ready: true,
            qemuImg: { available: true }, qemuSystemArm64: { available: true },
            qemuSystemAmd64: { available: true }, homebrew: { available: true },
          };
          case "local_engine_status": return engineState();
          case "local_prepare_engine":
            if (args.engine === "docker") docker = true;
            return engineState();
          case "local_list_vms": return vms;
          case "local_list_containers": return [];
          case "local_create_container": return {
            id: `docker:${args.payload.name}`, kind: "docker", name: args.payload.name,
            image: "nginx:latest", state: "running",
          };
          case "local_host_metrics": return {
            totalCores: 8, totalMemoryGib: 16, virtualizationCores: 6, virtualizationMemoryGib: 8,
            cpuUsage: 10, memoryUsage: 20, storageUsage: 30, computerName: "Test Host",
          };
          case "local_load_storage_config": return {
            vmConfigDir: "/test/vms", diskDir: "/test/disks", isoDir: "/test/iso",
            snapshotDir: "/test/snapshots", exportDir: "/test/exports",
          };
          case "local_storage_inventory": return {
            iso: [], templates: [], disks: [], snapshots: [], exports: [], dockerImages: [],
          };
          case "local_list_snapshots": return [];
          case "plugin:event|listen": return 1;
          default: return null;
        }
      },
    };
  }, overrides);
}

const degradedVm = {
  id: "local-vm-1",
  name: "Debian-Test",
  architecture: "arm64",
  cpu: 2,
  memoryMib: 2048,
  diskGib: 20,
  diskPath: "/test/disks/debian.qcow2",
  isoPath: null,
  network: "user",
  networkModel: "virtio",
  gpuModel: "virtio",
  diskBus: "virtio",
  state: "running",
  pid: 4242,
  vncPort: 5901,
  startupNotes: "SPICE indisponible sur cette installation de QEMU (console VNC utilisee)",
  createdAt: "0",
  updatedAt: "0",
};

test("a VM that started without SPICE says so instead of looking broken", async ({ page }) => {
  await localDesktop(page, { vms: [degradedVm] });
  await page.goto("/#/resources/local-vm-1");
  await expect(page.getByText(/Demarrage adapte a cet ordinateur/)).toContainText("SPICE indisponible");
});

test("the disk bus is offered on x86 VMs so an installer can see its disk", async ({ page }) => {
  await localDesktop(page);
  await page.goto("/#/vms");
  await page.getByRole("button", { name: /Nouvelle|Nouveau|Creer/i }).first().click();
  await page.getByLabel("Architecture").selectOption("amd64");
  await expect(page.getByLabel("Bus disque")).toBeVisible();
  await expect(page.getByLabel("Bus disque")).toHaveValue("virtio");
});

test("creating a Docker container offers to install the missing engine", async ({ page }) => {
  await localDesktop(page);
  await page.goto("/#/docker");

  let prompted = "";
  page.on("dialog", (dialog) => {
    prompted = dialog.message();
    void dialog.accept();
  });

  await page.getByRole("button", { name: /Nouveau|Nouvelle|Creer/i }).first().click();
  await page.getByLabel("Nom").fill("web");
  await page.locator("form").getByRole("button", { name: /^Creer$/i }).click();

  await expect.poll(() => prompted).toContain("Docker");
  await expect
    .poll(() => page.evaluate(() => (window as any).testCalls.map((c: any) => c.cmd)))
    .toContain("local_create_container");
});
