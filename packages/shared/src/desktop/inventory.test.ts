import { describe, it, expect } from "vitest";
import { ResourceTombstones, resourceTombstoneKey, isValidResourceName } from "./inventory.js";

describe("isValidResourceName", () => {
  it("accepts valid names per type", () => {
    expect(isValidResourceName("vm", "Debian13VM")).toBe(true);
    expect(isValidResourceName("vm", "web-01.prod")).toBe(true);
    expect(isValidResourceName("lxc", "Debian-depot")).toBe(true);
    expect(isValidResourceName("docker", "my_app.1")).toBe(true);
    expect(isValidResourceName("docker", "2048game")).toBe(true); // docker may start with a digit
  });

  it("rejects invalid names", () => {
    expect(isValidResourceName("vm", "")).toBe(false);
    expect(isValidResourceName("vm", "1startsWithDigit")).toBe(false); // libvirt name must start with a letter
    expect(isValidResourceName("vm", "has space")).toBe(false);
    expect(isValidResourceName("vm", "bad/slash")).toBe(false);
    expect(isValidResourceName("lxc", "dot.notallowed")).toBe(false);   // lxc: no dots
    expect(isValidResourceName("lxc", "-startsWithDash")).toBe(false);
    expect(isValidResourceName("docker", "bad name")).toBe(false);
    expect(isValidResourceName("vm", "a".repeat(64))).toBe(false);       // too long
  });
});

describe("resourceTombstoneKey", () => {
  it("is unique per (type,node,name) triple", () => {
    expect(resourceTombstoneKey("vm", "n1", "web")).not.toBe(resourceTombstoneKey("lxc", "n1", "web"));
    expect(resourceTombstoneKey("vm", "n1", "web")).not.toBe(resourceTombstoneKey("vm", "n2", "web"));
    expect(resourceTombstoneKey("vm", "n1", "web")).toBe(resourceTombstoneKey("vm", "n1", "web"));
  });
});

describe("ResourceTombstones", () => {
  it("hides a resource right after it is marked deleted", () => {
    const t = new ResourceTombstones(60_000);
    expect(t.isDeleted("vm", "local", "Debian13VM")).toBe(false);
    t.mark("vm", "local", "Debian13VM");
    expect(t.isDeleted("vm", "local", "Debian13VM")).toBe(true);
  });

  it("only hides the exact resource that was deleted", () => {
    const t = new ResourceTombstones(60_000);
    t.mark("vm", "local", "Debian13VM");
    expect(t.isDeleted("vm", "local", "OtherVM")).toBe(false);
    expect(t.isDeleted("lxc", "local", "Debian13VM")).toBe(false);
    expect(t.isDeleted("vm", "node2", "Debian13VM")).toBe(false);
  });

  it("filters a deleted resource out of a live inventory listing", () => {
    const t = new ResourceTombstones(60_000);
    const rows = [
      { type: "vm", node: "local", name: "web" },
      { type: "lxc", node: "local", name: "db" },
      { type: "docker", node: "local", name: "abc123" },
    ];
    t.mark("lxc", "local", "db");
    const visible = t.filter(rows);
    expect(visible.map((r) => r.name)).toEqual(["web", "abc123"]);
  });

  it("auto-expires after the TTL so a re-created resource reappears", () => {
    let now = 1_000;
    const t = new ResourceTombstones(60_000, () => now);
    t.mark("docker", "local", "abc123");
    expect(t.isDeleted("docker", "local", "abc123")).toBe(true);
    now += 59_000;
    expect(t.isDeleted("docker", "local", "abc123")).toBe(true);
    now += 2_000; // past the 60s TTL
    expect(t.isDeleted("docker", "local", "abc123")).toBe(false);
  });

  it("prune() removes expired entries", () => {
    let now = 0;
    const t = new ResourceTombstones(1_000, () => now);
    t.mark("vm", "local", "a");
    t.mark("vm", "local", "b");
    expect(t.size).toBe(2);
    now += 2_000;
    t.prune();
    expect(t.size).toBe(0);
  });

  it("clear() removes a single tombstone (e.g. name reused by a create)", () => {
    const t = new ResourceTombstones(60_000);
    t.mark("vm", "local", "web");
    t.clear("vm", "local", "web");
    expect(t.isDeleted("vm", "local", "web")).toBe(false);
  });
});
