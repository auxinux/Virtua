import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Typed so `post.mock.calls[0]` keeps its [url, body] shape under tsc.
const post = vi.fn(async (_url: string, _body?: unknown) => ({}));
const del = vi.fn(async (_url: string) => ({}));
const put = vi.fn(async (_url: string, _body?: unknown) => ({}));

vi.mock("@/api/client", () => ({
  api: {
    get: vi.fn(async (path: string) => {
      if (path.includes("/bridges")) return [{ name: "vmbr0" }, { name: "vmbr1" }];
      if (path.includes("/storage")) return [{ name: "local", type: "dir" }];
      if (path === "/api/vdm/isos") return [{ filename: "debian.iso", nodeName: "n1", sizeBytes: 1024 ** 3 }];
      return [];
    }),
    post: (url: string, body?: unknown) => post(url, body),
    put: (url: string, body?: unknown) => put(url, body),
    delete: (url: string) => del(url),
  },
}));

import { VmHardwarePanel } from "@/components/ResourcePanels";
import type { VdmVmInfo } from "@/types/vdm";

const vm = {
  name: "vm1", state: "stopped", nodeName: "n1", nodeDisplayName: "N1",
  mountedIso: null,
  disks: [
    { device: "vda", deviceType: "disk", bus: "virtio", source: "/pool/vm1.qcow2", sizeBytes: 10 * 1024 ** 3, format: "qcow2", readonly: false },
    { device: "sda", deviceType: "cdrom", bus: "sata", source: "/iso/debian.iso", sizeBytes: 0, format: "raw", readonly: true },
  ],
  networks: [{ index: 0, mac: "aa:bb:cc:dd:ee:ff", model: "virtio", source: "vmbr0", type: "bridge" }],
} as unknown as VdmVmInfo;

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <VmHardwarePanel node="n1" name="vm1" vm={vm} />
    </QueryClientProvider>,
  );
}

describe("VmHardwarePanel", () => {
  beforeEach(() => { post.mockClear(); del.mockClear(); put.mockClear(); });

  it("lists data disks and hides the CD drive from the disk list", async () => {
    renderPanel();
    expect(await screen.findByText("vda")).toBeTruthy();
    // sda is the cdrom: it must not appear as a resizable/detachable disk
    expect(screen.queryByText("sda")).toBeNull();
  });

  it("reads the disk path from `source`, not the non-existent `path`", async () => {
    renderPanel();
    expect(await screen.findByText("/pool/vm1.qcow2")).toBeTruthy();
  });

  it("reads the NIC bridge from `source`", async () => {
    renderPanel();
    expect(await screen.findByText("vmbr0")).toBeTruthy();
    expect(await screen.findByText("aa:bb:cc:dd:ee:ff")).toBeTruthy();
  });

  it("attaches a disk through the VDM relay", async () => {
    renderPanel();
    fireEvent.click(await screen.findByText("+ Add disk"));
    fireEvent.click(await screen.findByText("Attach"));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [url, body] = post.mock.calls[0];
    expect(url).toBe("/api/vdm/vms/n1/vm1/disk/attach");
    expect(body).toMatchObject({ sizeGb: 10, bus: "virtio", format: "qcow2", storagePool: "local" });
  });

  it("attaches a network card through the VDM relay", async () => {
    renderPanel();
    fireEvent.click(await screen.findByText("+ Add network card"));
    fireEvent.click(await screen.findByText("Attach"));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [url, body] = post.mock.calls[0];
    expect(url).toBe("/api/vdm/vms/n1/vm1/network/attach");
    expect(body).toMatchObject({ bridge: "vmbr0", model: "virtio" });
  });

  it("inserts an ISO through the VDM relay", async () => {
    renderPanel();
    // The ISO list loads asynchronously; setting a value before its <option>
    // exists silently leaves the select empty.
    await screen.findByRole("option", { name: /debian\.iso/ });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "debian.iso" } });
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][0]).toBe("/api/vdm/vms/n1/vm1/iso/attach");
  });
});
