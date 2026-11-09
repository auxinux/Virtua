import { test, expect, type Page } from "@playwright/test";

type Overrides = { vms?: unknown[]; dockerReady?: boolean; unifiedVms?: unknown[] };

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
          case "local_list_vms": return (window as any).__vms ?? vms;
          case "local_list_bases": return [{ id: "debian13-amd64-1", label: "Debian 13 (AMD64)", os: "debian13", architecture: "amd64", guestOs: "other", cpu: 2, memoryMib: 4096, diskGib: 60, createdAt: "0", source: "depot", size: 1.2e9, inUse: 0 }];
          case "local_depot_bases": return [{ name: "debian13-amd64.vmtmp", url: "https://dep.auxinux.ca/TEMPLATES/VM/AMD64/debian13-amd64.vmtmp", size: 9e8 }];
          case "local_launch_disposable": return { id: "local-vm-jetable", name: "Jetable Debian 13 #1", architecture: "amd64", cpu: 2, memoryMib: 4096, diskGib: 60, diskPath: "/d/j.qcow2", network: "user", state: "running", pid: 7, createdAt: "0", updatedAt: "0", disposable: { baseId: args.baseId, baseLabel: "Debian 13 (AMD64)", strict: args.strict } };
          case "local_disposable_action": return null;
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
          case "local_unified_overview": return {
            client: { available: true, kind: "freerdp3", detail: "FreeRDP 3 (RemoteApp).", installable: false },
            vms: (options as any).unifiedVms ?? [],
          };
          case "local_unified_launch": return null;
          case "local_quick_create": return {
            id: "local-vm-quick", name: args.name ?? "Debian 13", architecture: "arm64", cpu: 2, memoryMib: 4096, diskGib: 60,
            diskPath: "/test/disks/quick.qcow2", network: "user", guestOs: "other", state: "running", pid: 99,
            createdAt: "0", updatedAt: "0",
          };
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
  // Windows 11 as on a real PC: Secure Boot and TPM 2.0 come on by default.
  await expect(page.getByLabel("Secure Boot", { exact: true })).toBeChecked();
  await expect(page.getByLabel("TPM 2.0", { exact: true })).toBeChecked();
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
  // The sidebar brand (icon + name in the AuxiNux themes).
  const logo = page.getByText("Virtua Desktop", { exact: true });
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

test("the Unified mode lists Windows apps and opens one in its own window", async ({ page }) => {
  const icon = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  await localDesktop(page, {
    unifiedVms: [{
      id: "win-1", name: "Windows 11", state: "running", architecture: "amd64", enabled: true, user: "alex",
      agent: true, rdpReady: true, needsRestart: false, integrated: false,
      apps: [
        { id: "a1", name: "Excel", path: "C:\\Office\\EXCEL.EXE", args: "", icon },
        { id: "a2", name: "Paint", path: "C:\\Windows\\mspaint.exe", args: "", icon: null },
      ],
    }],
  });
  await page.goto("/#/unified");
  await expect(page.getByRole("heading", { name: "Mode Unifié" })).toBeVisible();
  await expect(page.getByText("mode Unifié actif (alex)")).toBeVisible();
  await page.getByRole("button", { name: /Excel/ }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).testCalls.filter((c: any) => c.cmd === "local_unified_launch").map((c: any) => c.args)))
    .toEqual([{ id: "win-1", appId: "a1" }]);
  await expect(page.getByRole("status")).toContainText("Excel");
});

test("a Windows VM not yet unified walks through the prerequisites", async ({ page }) => {
  await localDesktop(page, {
    unifiedVms: [{
      id: "win-1", name: "Windows 11", state: "running", architecture: "arm64", enabled: false, user: null,
      agent: false, rdpReady: false, needsRestart: false, integrated: false, apps: [],
    }],
  });
  await page.goto("/#/unified");
  await expect(page.getByText(/virtio-win-guest-tools/)).toBeVisible();
  await page.getByPlaceholder(/Compte Windows/).fill("alex");
  await page.getByPlaceholder("Mot de passe Windows").fill("secret");
  // No guest agent yet: nothing could be configured inside Windows.
  await expect(page.getByRole("button", { name: "Activer le mode Unifié" })).toBeDisabled();
});

test("the theme follows AuxiNux Shell and survives a backend without appearance", async ({ page }) => {
  await localDesktop(page);
  await page.goto("/#/settings");
  // The mock answers null to desktop_appearance: the page still renders, AuxiNux palette.
  await expect(page.getByRole("heading", { name: "Apparence" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", /^auxinux-(light|dark)$/);
  await page.getByRole("radio", { name: /Virtua classique/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "virtua");
  await page.getByRole("radio", { name: /^Clair/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "auxinux-light");
  // Light palette: darkened accent with readable text on it.
  const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--v-accent").trim());
  expect(accent).toBe("186 108 14");
});

test("quick create installs Debian 13 in one click and opens its console", async ({ page }) => {
  await localDesktop(page);
  await page.goto("/#/vms");
  await page.getByRole("button", { name: /Nouveau|Nouvelle|Creer/i }).first().click();
  await expect(page.getByRole("heading", { name: "Création rapide" })).toBeVisible();
  await expect(page.getByText("4 vCPU · 4 Go RAM · 80 Go")).toBeVisible();
  await page.getByLabel("Nom de la VM Debian 13").fill("Mon Debian");
  await page.getByRole("button", { name: "Créer et installer" }).nth(1).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).testCalls.filter((c: any) => c.cmd === "local_quick_create").map((c: any) => c.args)))
    .toEqual([{ os: "debian13", name: "Mon Debian" }]);
  await expect(page).toHaveURL(/#\/console\/local-vm-quick$/);
});

test("a disposable VM starts from a base in one click and opens its console", async ({ page }) => {
  await localDesktop(page);
  await page.goto("/#/disposable");
  await expect(page.getByRole("heading", { name: /VM jetables/ })).toBeVisible();
  await expect(page.getByText("debian13-amd64.vmtmp")).toBeVisible();
  await page.getByLabel(/Sandbox stricte/).check();
  await page.getByRole("button", { name: "Lancer une jetable" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).testCalls.filter((c: any) => c.cmd === "local_launch_disposable").map((c: any) => c.args)))
    .toEqual([{ baseId: "debian13-amd64-1", strict: true, network: "user" }]);
  await expect(page).toHaveURL(/#\/console\/local-vm-jetable$/);
});

test("when a disposable VM stops, Virtua asks whether to throw it away", async ({ page }) => {
  const jetable = {
    id: "local-vm-j", name: "Jetable Debian 13 #1", architecture: "amd64", cpu: 2, memoryMib: 4096, diskGib: 60,
    diskPath: "/d/j.qcow2", network: "user", state: "running", pid: 7, createdAt: "0", updatedAt: "0",
    disposable: { baseId: "b", baseLabel: "Debian 13 (AMD64)", strict: false },
  };
  await localDesktop(page, { vms: [jetable] });
  await page.goto("/#/disposable");
  await expect(page.getByRole("main").getByText("Jetable Debian 13 #1")).toBeVisible();
  await page.evaluate((vm) => { (window as any).__vms = [{ ...vm, state: "stopped", pid: null }]; }, jetable);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("est arrêtée");
  await expect(dialog.getByRole("button", { name: /Convertir en VM normale/ })).toBeVisible();
  await dialog.getByRole("button", { name: /Repartir à neuf/ }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).testCalls.filter((c: any) => c.cmd === "local_disposable_action").map((c: any) => c.args)))
    .toEqual([{ id: "local-vm-j", action: "reset" }]);
  await expect(dialog).toBeHidden();
});
