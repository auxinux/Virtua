import { test, expect, type Page } from "@playwright/test";

/**
 * Cloud mode against a fake Virtua server: in the web preview (no Tauri) the
 * client goes through the dev proxy, which these tests answer.
 */
async function cloudDesktop(page: Page, { modern = true } = {}) {
  const posts: Array<{ path: string; body: unknown }> = [];
  await page.addInitScript(() => {
    window.localStorage.setItem("auxinux-virtua-desktop-mode", "cloud");
    window.localStorage.setItem("auxinux:virtua:endpoint", "http://192.168.0.20:8441");
    window.localStorage.setItem("auxinux:virtua:refresh-token:fallback", "refresh-1");
  });
  await page.route("**/__virtua_proxy**", async (route) => {
    const target = new URL(new URL(route.request().url()).searchParams.get("url") ?? "");
    const path = target.pathname;
    const method = route.request().method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (method !== "GET") posts.push({ path, body: route.request().postDataJSON?.() ?? null });
    if (path === "/api/desktop/auth/refresh") return json({ accessToken: "a", refreshToken: "refresh-2", expiresIn: 3600 });
    if (path === "/api/desktop/me") {
      return json({
        user: { id: 1, username: "andre", displayName: "André", role: "ADMIN" },
        device: { id: "d1", name: "MacMini" },
        capabilities: { isAdmin: true, canCreate: { vm: true, lxc: true, docker: true } },
      });
    }
    if (path === "/api/desktop/resources" && method === "GET") return json([]);
    if (path === "/api/desktop/tasks") return json([]);
    if (path === "/api/desktop/templates") return json([]);
    if (path === "/api/desktop/resources/create-options") {
      return json({
        nodes: [{ id: "virtuaos02", name: "virtuaos02", label: "virtuaos02" }],
        images: [],
        networks: [{ id: "virbr0", name: "virbr0", label: "virbr0" }],
        architectures: [{ id: "amd64", name: "AMD64", label: "AMD64 / x86_64" }],
        defaults: { cpu: 2, memory: 2048, disk: 20, network: "virbr0", architecture: "amd64" },
        ...(modern
          ? {
              hardware: {
                machines: ["auto", "q35", "pc"],
                cpus: ["auto", "host", "max", "286", "386", "486", "pentium", "pentium4"],
                diskBuses: ["virtio", "sata", "ide"],
                networkModels: ["virtio", "e1000", "rtl8139", "ne2k_pci", "pcnet"],
                periodSpeed: true,
              },
              floppies: [{ id: "fd-1", name: "dos622.img", label: "MS-DOS 6.22 (1,44 Mo)" }],
              features: { quickCreate: true, disposable: true },
            }
          : {}),
      });
    }
    if (path === "/api/desktop/resources" && method === "POST") return json({ ok: true });
    if (path === "/api/desktop/quick-create") return json({ taskId: "t1", name: "Debian 13" });
    return json({ error: `unexpected ${method} ${path}` }, 404);
  });
  return posts;
}

test("cloud: a Virtua 0.8.11 server offers machine, period CPU, IDE, NE2000 and floppy", async ({ page }) => {
  const posts = await cloudDesktop(page);
  await page.goto("/#/vms");
  await page.getByRole("button", { name: /Creer/i }).first().click();
  await expect(page.getByRole("heading", { name: "Création rapide" })).toBeVisible();
  await page.getByLabel("Nom", { exact: true }).fill("AuxiDos");
  await page.getByLabel("Type de machine").selectOption("pc");
  await page.getByLabel("Modèle de CPU").selectOption("286");
  await page.getByLabel(/Vitesse d’époque/).check();
  await page.getByLabel(/^Bus disque/).selectOption("ide");
  await page.getByLabel(/^Carte reseau/).selectOption("ne2k_pci");
  await page.getByLabel(/Disquette/).selectOption("fd-1");
  await page.locator("form").getByRole("button", { name: /^Creer$/i }).click();
  await expect
    .poll(() => posts.filter((p) => p.path === "/api/desktop/resources").map((p) => p.body))
    .toEqual([expect.objectContaining({ name: "AuxiDos", machine: "pc", cpuModel: "286", periodSpeed: true, diskBus: "ide", networkModel: "ne2k_pci", floppyId: "fd-1" })]);
});

test("cloud: quick create asks the server and follows the task", async ({ page }) => {
  const posts = await cloudDesktop(page);
  await page.goto("/#/vms");
  await page.getByRole("button", { name: /Creer/i }).first().click();
  await expect(page.getByText(/le serveur Virtua télécharge/)).toBeVisible();
  await page.getByRole("button", { name: "Créer et installer" }).nth(1).click();
  await expect.poll(() => posts.filter((p) => p.path === "/api/desktop/quick-create").map((p) => p.body)).toEqual([{ os: "debian13", name: "Debian 13" }]);
  await expect(page).toHaveURL(/#\/tasks$/);
});

test("cloud: an older server keeps the previous form", async ({ page }) => {
  await cloudDesktop(page, { modern: false });
  await page.goto("/#/vms");
  await page.getByRole("button", { name: /Creer/i }).first().click();
  await expect(page.getByLabel("Nom", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Type de machine")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Création rapide" })).toHaveCount(0);
});
