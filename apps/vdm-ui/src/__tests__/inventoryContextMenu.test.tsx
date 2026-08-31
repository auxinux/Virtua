import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/api/client", () => ({
  api: {
    get: vi.fn(async (path: string) => {
      if (path.startsWith("/api/vdm/vms")) return [{ name: "vm1", node: "n1", nodeDisplayName: "Node 1", state: "stopped", vcpus: 2, memoryMb: 2048 }];
      if (path.startsWith("/api/vdm/lxc")) return [{ name: "ct1", node: "n1", nodeDisplayName: "Node 1", state: "stopped" }];
      if (path.startsWith("/api/vdm/docker")) return [];
      return [];
    }),
    post: vi.fn(async () => ({})), put: vi.fn(async () => ({})), delete: vi.fn(async () => ({})),
  },
}));

vi.mock("@/components/ConsoleModal", () => ({ ConsoleModal: () => null }));

import InventoryPage from "@/pages/InventoryPage";

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <React.StrictMode>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/inventory"]}>
          <InventoryPage />
        </MemoryRouter>
      </QueryClientProvider>
    </React.StrictMode>,
  );
}

describe("Inventory table context menu → modal", () => {
  it.each([
    ["vm1", "Migrate…", /Migrate/i],
    ["vm1", "Clone…", /Clone/i],
    ["ct1", "Migrate…", /Migrate/i],
  ])("right-click %s then %s shows the modal", async (rowName, entryLabel, expectRe) => {
    renderPage();
    const cell = await screen.findByText(rowName);
    const row = cell.closest("tr")!;
    fireEvent.contextMenu(row, { clientX: 50, clientY: 50 });
    const entry = await screen.findByText(entryLabel);
    fireEvent.click(entry);
    await waitFor(() => {
      const dialogs = document.querySelectorAll(".fixed.inset-0");
      expect(dialogs.length, `no overlay after "${entryLabel}" on ${rowName}`).toBeGreaterThan(0);
      expect(screen.queryAllByText(expectRe).length).toBeGreaterThan(0);
    });
  });
});
