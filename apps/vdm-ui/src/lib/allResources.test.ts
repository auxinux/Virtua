import { describe, expect, it } from "vitest";
import { buildAllResourceRows } from "./allResources";

describe("buildAllResourceRows", () => {
  it("aggregates VM, LXC and Docker resources with stable detail links", () => {
    const rows = buildAllResourceRows(
      [{ name: "vm one", state: "running", nodeName: "node1", nodeDisplayName: "Node 1" }],
      [{ name: "web-lxc", state: "stopped", nodeName: "node2", nodeDisplayName: "Node 2" }],
      [{ id: "abc/123", name: "nginx", state: "running", nodeName: "node3", nodeDisplayName: "Node 3", image: "nginx:latest", status: "Up" }],
    );

    expect(rows.map((row) => ({ type: row.type, name: row.name, href: row.href }))).toEqual([
      { type: "VM", name: "vm one", href: "/inventory/vm/node1/vm%20one" },
      { type: "LXC", name: "web-lxc", href: "/inventory/lxc/node2/web-lxc" },
      { type: "Docker", name: "nginx", href: "/inventory/docker/node3/abc%2F123" },
    ]);
  });

  it("labels rows with the display-name override but keeps identifiers on the real name", () => {
    const rows = buildAllResourceRows(
      [{ name: "vm-01", displayName: "Billing prod", state: "running", nodeName: "node1", nodeDisplayName: "Node 1" }],
      [{ name: "web-lxc", displayName: "  ", state: "stopped", nodeName: "node2", nodeDisplayName: "Node 2" }],
      [{ id: "abc123", name: "nginx", displayName: "Reverse proxy", state: "running", nodeName: "node3", nodeDisplayName: "Node 3" }],
    );

    expect(rows.map((row) => ({ label: row.label, name: row.name, id: row.id, href: row.href }))).toEqual([
      { label: "Billing prod", name: "vm-01", id: "vm-01", href: "/inventory/vm/node1/vm-01" },
      // A blank override falls back to the real name rather than rendering empty.
      { label: "web-lxc", name: "web-lxc", id: "web-lxc", href: "/inventory/lxc/node2/web-lxc" },
      { label: "Reverse proxy", name: "nginx", id: "abc123", href: "/inventory/docker/node3/abc123" },
    ]);
  });
});
