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

test("a Windows ARM installer gets NVMe, ramfb and the VirtIO driver disc", async ({ page }) => {
  await localDesktop(page);
  await page.goto("/#/vms");
  await page.getByRole("button", { name: /Nouvelle|Nouveau|Creer/i }).first().click();
  await page.getByLabel("Architecture").selectOption("arm64");
  await page.getByPlaceholder("/chemin/vers/install.iso").fill("/iso/Win11_24H2_English_Arm64.iso");
  await expect(page.getByLabel("Systeme invite")).toHaveValue("windows");
  await expect(page.getByLabel("Bus disque")).toHaveValue("nvme");
  await expect(page.getByLabel("Carte graphique")).toHaveValue("std");
  await expect(page.getByLabel(/pilotes VirtIO Windows/)).toBeChecked();
});

test("the VM configuration offers a second CD-ROM for drivers", async ({ page }) => {
  await localDesktop(page, { vms: [{ ...degradedVm, state: "stopped", pid: null, startupNotes: null }] });
  await page.goto("/#/resources/local-vm-1");
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByText("ISO pilotes (2e lecteur CD)")).toBeVisible();
  await expect(page.getByRole("button", { name: /Pilotes VirtIO pour Windows/ })).toBeVisible();
});

test("console mode folds every bar and the action bar can hide itself", async ({ page }) => {
  await localDesktop(page, { vms: [{ ...degradedVm, state: "stopped", pid: null }] });
  await page.goto("/#/console/local-vm-1");
  const logo = page.getByAltText("AuxiNux Virtua - Desktop Client");
  await expect(logo).toBeVisible();

  await page.getByTitle("Mode console : replier toutes les barres").click();
  await expect(logo).toBeHidden();
  await expect(page.getByPlaceholder("Rechercher...")).toBeHidden();

  // Opt-in auto-hide: the bar leaves until the pointer reaches the top edge.
  const bar = page.getByRole("button", { name: "Ctrl+Alt+Del" }).locator("xpath=../..");
  await page.getByRole("button", { name: "Masquer la barre" }).click();
  await page.mouse.move(400, 400);
  await expect(bar).toHaveClass(/opacity-0/);
  await page.mouse.move(400, 4);
  await expect(bar).toHaveClass(/opacity-100/);

  await page.getByTitle("Quitter le mode console").click();
  await expect(logo).toBeVisible();
});

test("the machine list folds into a rail and the info bars fold away entirely", async ({ page }) => {
  await localDesktop(page, { vms: [{ ...degradedVm, state: "stopped", pid: null }] });
  await page.goto("/#/console/local-vm-1");

  // The fold button sits on the list itself, where the eye looks for it.
  await page.locator("aside").getByTitle("Replier la liste des machines").click();
  await expect(page.getByPlaceholder("Rechercher...")).toBeHidden();
  await expect(page.getByTitle("Debian-Test (stopped)")).toBeVisible();

  await page.getByTitle("Replier les barres d'information").click();
  await expect(page.getByText("Adresse", { exact: true })).toBeHidden();
  // The way back now rides in the console action bar.
  await page.getByTitle("Afficher les barres d'information").click();
  await expect(page.getByText("Adresse", { exact: true })).toBeVisible();

  await page.getByTitle("Afficher la liste des machines").click();
  await expect(page.getByPlaceholder("Rechercher...")).toBeVisible();
});

test("a Windows ARM VM still on virtio is told what to change", async ({ page }) => {
  await localDesktop(page, { vms: [{ ...degradedVm, guestOs: "windows", state: "stopped", pid: null, startupNotes: null }] });
  await page.goto("/#/resources/local-vm-1");
  await expect(page.getByText(/passer le bus disque en NVMe/)).toBeVisible();
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
