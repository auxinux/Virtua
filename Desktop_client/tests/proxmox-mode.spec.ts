import { test, expect, type Page } from "@playwright/test";

const FP = "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89";

const clusterRows = [
  { id: "node/pve1", type: "node", node: "pve1", status: "online", cpu: 0.12, maxcpu: 8, mem: 4 * 1024 ** 3, maxmem: 16 * 1024 ** 3, disk: 10 * 1024 ** 3, maxdisk: 100 * 1024 ** 3, uptime: 7200 },
  { id: "qemu/100", type: "qemu", node: "pve1", vmid: 100, name: "web-01", status: "running", cpu: 0.25, maxcpu: 2, mem: 1024 ** 3, maxmem: 2 * 1024 ** 3, maxdisk: 32 * 1024 ** 3, uptime: 3600 },
  { id: "lxc/200", type: "lxc", node: "pve1", vmid: 200, name: "dns", status: "stopped", cpu: 0, maxcpu: 1, mem: 0, maxmem: 512 * 1024 ** 2, maxdisk: 8 * 1024 ** 3 },
  { id: "storage/pve1/local-lvm", type: "storage", node: "pve1", storage: "local-lvm" },
];

/** Boots straight into Proxmox mode, the Rust `pve_*` commands mocked. */
async function proxmoxDesktop(page: Page, { loggedIn = false } = {}) {
  await page.addInitScript(({ rows, fp, loggedIn }) => {
    window.localStorage.setItem("auxinux-virtua-desktop-mode", "proxmox");
    if (loggedIn) window.localStorage.setItem("auxinux-virtua-desktop-proxmox", JSON.stringify({ base: "https://pve.lan:8006", fingerprint: fp, username: "root@pam", tokenId: "desk" }));
    const win = window as any;
    const calls: Array<{ cmd: string; args: any }> = [];
    win.testCalls = calls;
    const session = { base: "https://pve.lan:8006", fingerprint: fp, username: "root@pam", auth: "token", version: "9.2.0", release: "9.2" };
    win.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    win.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (cmd: string, args: any) => {
        calls.push({ cmd, args });
        switch (cmd) {
          case "runtime_platform": return { os: "linux", arch: "amd64", mobile: false, auxinux: true, distro: "auxinux" };
          case "pve_probe": return { base: "https://pve.lan:8006", fingerprint: fp };
          case "pve_login": return session;
          case "pve_restore": return loggedIn ? session : null;
          case "pve_logout": return null;
          case "pve_console": return { url: "ws://127.0.0.1:9/relay", password: args.mode === "vnc" ? "PVEVNC:ticket" : null };
          case "pve_api": {
            const { method, path } = args;
            if (path === "/cluster/resources") return rows;
            if (path === "/cluster/tasks") return [{ upid: "UPID:pve1:1", type: "qmstart", id: "100", node: "pve1", status: "OK", starttime: 1_700_000_000, endtime: 1_700_000_005, user: "root@pam" }];
            if (path === "/cluster/nextid") return "101";
            if (/\/storage$/.test(path)) return args.params?.content === "iso" ? [{ storage: "local", type: "dir", active: 1 }] : [{ storage: "local-lvm", type: "lvmthin", active: 1, avail: 50 * 1024 ** 3 }];
            if (/\/content$/.test(path)) return [{ volid: "local:iso/debian-13.iso", size: 700 * 1024 ** 2 }];
            if (/\/network$/.test(path)) return [{ iface: "vmbr0", type: "bridge" }];
            if (path === "/nodes/pve1/qemu/100/config" && method === "GET") return { name: "web-01", cores: 2, memory: 2048, onboot: 0, ostype: "l26", scsi0: "local-lvm:vm-100-disk-0,iothread=1,size=32G", ide2: "none,media=cdrom", net0: "virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0" };
            if (path === "/nodes/pve1/qemu/100/snapshot" && method === "GET") return [{ name: "current", description: "You are here!" }, { name: "avant-maj", snaptime: 1_700_000_000 }];
            return "UPID:pve1:00000001";
          }
          case "plugin:event|listen": return 1;
          default: return null;
        }
      },
    };
  }, { rows: clusterRows, fp: FP, loggedIn });
}

const apiCalls = (page: Page) => page.evaluate(() => (window as any).testCalls.filter((c: any) => c.cmd === "pve_api").map((c: any) => c.args));

test("signing in shows the certificate fingerprint and asks for trust first", async ({ page }) => {
  await proxmoxDesktop(page);
  await page.goto("/");
  await page.getByPlaceholder("pve.example.lan:8006").fill("pve.lan");
  await page.getByRole("button", { name: "Vérifier" }).click();
  await expect(page.getByTestId("pve-fingerprint")).toHaveText(FP);
  // No credentials before the certificate is trusted.
  await expect(page.getByRole("button", { name: "Se connecter" })).toHaveCount(0);
  await page.getByLabel("C'est bien le certificat de mon serveur").check();
  await page.getByRole("button", { name: "Jeton d'API" }).click();
  await page.getByPlaceholder("virtua-desktop").fill("desk");
  await page.getByPlaceholder("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx").fill("s3cret");
  await page.getByRole("button", { name: "Se connecter" }).click();
  await expect(page.getByText("Proxmox VE 9.2.0 · https://pve.lan:8006")).toBeVisible();
  const login = await page.evaluate(() => (window as any).testCalls.find((c: any) => c.cmd === "pve_login").args.input);
  expect(login).toMatchObject({ url: "https://pve.lan:8006", fingerprint: FP, username: "root@pam", tokenId: "desk", tokenSecret: "s3cret", remember: true });
});

test("the inventory lists VMs and containers and drives their power", async ({ page }) => {
  await proxmoxDesktop(page, { loggedIn: true });
  await page.goto("/#/inventory");
  await expect(page.getByText("100 · web-01")).toBeVisible();
  await expect(page.getByText("200 · dns")).toBeVisible();
  await page.screenshot({ path: "test-results/proxmox-inventory.png" });
  await page.getByRole("button", { name: "Démarrer dns", exact: true }).click();
  await page.getByRole("button", { name: "Redémarrer web-01", exact: true }).click();
  await expect.poll(async () => (await apiCalls(page)).map((c: any) => `${c.method} ${c.path}`)).toEqual(expect.arrayContaining([
    "POST /nodes/pve1/lxc/200/status/start",
    "POST /nodes/pve1/qemu/100/status/reboot",
  ]));
});

test("a VM is created on the node with an EFI disk, SCSI disk, ISO and bridge", async ({ page }) => {
  await proxmoxDesktop(page, { loggedIn: true });
  await page.goto("/#/vms");
  await page.getByRole("button", { name: "Créer une VM" }).click();
  await page.getByPlaceholder("web-01").fill("test-vm");
  await expect(page.getByRole("option", { name: "debian-13.iso" })).toHaveCount(1);
  await page.locator("select").nth(1).selectOption("local:iso/debian-13.iso");
  await page.getByRole("button", { name: "Créer", exact: true }).click();
  // The dialog closes once Proxmox accepted the creation.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(async () => (await apiCalls(page)).find((c: any) => c.path === "/nodes/pve1/qemu" && c.method === "POST")?.params).toMatchObject({
    vmid: 101, name: "test-vm", cores: 2, memory: 2048, bios: "ovmf", machine: "q35",
    scsi0: "local-lvm:32,iothread=1,discard=on", ide2: "local:iso/debian-13.iso,media=cdrom", net0: "virtio,bridge=vmbr0", start: true,
  });
});

test("the detail page edits resources, grows a disk and takes snapshots", async ({ page }) => {
  await proxmoxDesktop(page, { loggedIn: true });
  await page.goto("/#/resources/pve-100");
  await expect(page.getByText("avant-maj")).toBeVisible();
  await page.getByRole("spinbutton").first().fill("4");
  await page.getByRole("button", { name: "Enregistrer" }).click();
  await page.getByLabel("Agrandir scsi0").fill("10");
  await page.getByRole("button", { name: "Agrandir", exact: true }).click();
  await page.getByPlaceholder("nom (lettres, chiffres, - _)").fill("propre");
  await page.getByRole("button", { name: "Prendre" }).click();
  await expect.poll(async () => (await apiCalls(page)).filter((c: any) => c.method !== "GET").map((c: any) => [c.method, c.path, c.params])).toEqual(expect.arrayContaining([
    ["PUT", "/nodes/pve1/qemu/100/config", expect.objectContaining({ name: "web-01", cores: 4, memory: 2048, onboot: false })],
    ["PUT", "/nodes/pve1/qemu/100/resize", { disk: "scsi0", size: "+10G" }],
    ["POST", "/nodes/pve1/qemu/100/snapshot", expect.objectContaining({ snapname: "propre" })],
  ]));
});

test("the mode chooser offers Proxmox VE", async ({ page }) => {
  await proxmoxDesktop(page);
  await page.addInitScript(() => window.localStorage.setItem("auxinux-virtua-desktop-mode", "unset"));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: /Proxmox VE/ })).toBeVisible();
});

test("consoles ask Proxmox for a VM screen and a container shell", async ({ page }) => {
  await proxmoxDesktop(page, { loggedIn: true });
  await page.goto("/#/dashboard");
  await expect(page.getByText("pve1").first()).toBeVisible();
  await page.goto("/#/console/pve-100");
  await expect(page.getByRole("button", { name: "Ctrl+Alt+Del" })).toBeVisible();
  await page.goto("/#/console/pve-200");
  const consoles = () => page.evaluate(() => (window as any).testCalls.filter((c: any) => c.cmd === "pve_console").map((c: any) => c.args));
  await expect.poll(consoles).toEqual(expect.arrayContaining([
    { node: "pve1", kind: "qemu", vmid: 100, mode: "vnc" },
    { node: "pve1", kind: "lxc", vmid: 200, mode: "text" },
  ]));
});
