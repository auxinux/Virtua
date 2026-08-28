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
});
