import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ResourceContextMenu, type ResourceMenuTarget } from "@/components/ResourceContextMenu";

vi.mock("@/api/client", () => ({
  api: {
    get: vi.fn(async () => []),
    post: vi.fn(async () => ({})),
    put: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
  },
}));

function Harness({ resource, strict }: { resource: ResourceMenuTarget; strict: boolean }) {
  const [menu, setMenu] = React.useState<any>({ x: 10, y: 10, entries: [], resource });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ResourceContextMenu menu={menu} onClose={() => setMenu(null)} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return strict ? <React.StrictMode>{tree}</React.StrictMode> : tree;
}

const cases: Array<[string, ResourceMenuTarget, string, string]> = [
  ["VM migrate", { kind: "vm", node: "n1", name: "vm1", displayName: "vm1", state: "running" }, "Migrate…", /Migrate VM/i.source],
  ["VM clone", { kind: "vm", node: "n1", name: "vm1", displayName: "vm1", state: "stopped" }, "Clone…", /Clone VM/i.source],
  ["LXC migrate", { kind: "lxc", node: "n1", name: "ct1", displayName: "ct1", state: "stopped" }, "Migrate…", /Migrate/i.source],
  ["VM backup", { kind: "vm", node: "n1", name: "vm1", displayName: "vm1", state: "stopped" }, "Backup…", /Backup/i.source],
  ["Docker duplicate", { kind: "docker", node: "n1", name: "abc", displayName: "web", state: "running" }, "Duplicate…", /Duplicate/i.source],
];

describe.each([true, false])("ResourceContextMenu (StrictMode=%s)", (strict) => {
  beforeEach(() => vi.clearAllMocks());
  it.each(cases)("%s opens its modal", async (_label, resource, entryLabel, expectRe) => {
    render(<Harness resource={resource} strict={strict} />);
    const entry = await screen.findByText(entryLabel);
    fireEvent.click(entry);
    await waitFor(() => {
      const hit = screen.queryAllByText(new RegExp(expectRe, "i"));
      expect(hit.length, `no modal matching /${expectRe}/ after clicking "${entryLabel}"`).toBeGreaterThan(0);
    });
  });
});

const dialogCases: Array<[string, ResourceMenuTarget, string, RegExp]> = [
  ["VM snapshot prompt", { kind: "vm", node: "n1", name: "vm1", displayName: "vm1", state: "stopped" }, "Snapshot", /New snapshot/i],
  ["LXC snapshot prompt", { kind: "lxc", node: "n1", name: "ct1", displayName: "ct1", state: "stopped" }, "Snapshot", /New snapshot/i],
  ["VM delete confirm", { kind: "vm", node: "n1", name: "vm1", displayName: "vm1", state: "stopped" }, "Delete", /permanently removed/i],
  ["Docker delete confirm", { kind: "docker", node: "n1", name: "abc", displayName: "web", state: "stopped" }, "Delete", /permanently removed/i],
  ["VM force off confirm", { kind: "vm", node: "n1", name: "vm1", displayName: "vm1", state: "running" }, "Force Off", /immediately cuts power/i],
];

describe("ResourceContextMenu entries", () => {
  it("does not offer Clone for LXC (no server-side LXC clone endpoint)", async () => {
    render(<Harness resource={{ kind: "lxc", node: "n1", name: "ct1", displayName: "ct1", state: "stopped" }} strict />);
    await screen.findByText("Migrate…");
    expect(screen.queryByText("Clone…")).toBeNull();
  });
  it("offers Clone for VMs", async () => {
    render(<Harness resource={{ kind: "vm", node: "n1", name: "vm1", displayName: "vm1", state: "stopped" }} strict />);
    expect(await screen.findByText("Clone…")).toBeTruthy();
  });
});

describe.each([true, false])("ResourceContextMenu dialogs (StrictMode=%s)", (strict) => {
  it.each(dialogCases)("%s opens its dialog", async (_label, resource, entryLabel, expectRe) => {
    render(<Harness resource={resource} strict={strict} />);
    fireEvent.click(await screen.findByText(entryLabel));
    await waitFor(() => {
      expect(screen.queryAllByText(expectRe).length, `no dialog after "${entryLabel}"`).toBeGreaterThan(0);
    });
  });
});

describe("overlay layering", () => {
  it("paints the modal on <body>, above the context-menu layer", async () => {
    const { container } = render(
      <Harness resource={{ kind: "vm", node: "n1", name: "vm1", displayName: "vm1", state: "stopped" }} strict />,
    );
    const menu = await screen.findByRole("menu");
    const menuZ = Number(getComputedStyle(menu).zIndex);
    fireEvent.click(screen.getByText("Migrate…"));

    const dialog = await screen.findByRole("dialog");
    const overlay = dialog.parentElement!;
    // Escapes the triggering subtree, so no ancestor overflow/stacking context
    // can hide it.
    expect(container.contains(overlay)).toBe(false);
    expect(overlay.parentElement).toBe(document.body);
    expect(Number(getComputedStyle(overlay).zIndex)).toBeGreaterThan(menuZ);
  });
});
