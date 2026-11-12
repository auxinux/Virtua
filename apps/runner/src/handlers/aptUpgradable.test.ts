import { describe, expect, it } from "vitest";
import { parseAptUpgradable } from "./system.js";

describe("parseAptUpgradable", () => {
  it("ignores the login banner and the Listing line", () => {
    const out = [
      "  ╔════════════════════════════════╗",
      "  ║  VirtuaOS 1.0.3 • Debian 13 • x86_64 ║",
      "System",
      "IP Address : 192.0.2.1",
      "Memory : 30145 MB free",
      "Listing...",
      "",
    ].join("\n");
    expect(parseAptUpgradable(out)).toEqual([]);
  });

  it("keeps real upgradable entries", () => {
    const out = "Listing...\nbase-files/stable 13.8 amd64 [upgradable from: 13.7]\nlibc6/stable-security,stable 2.41-12 amd64 [upgradable from: 2.41-11]\n";
    expect(parseAptUpgradable(out)).toEqual(["base-files", "libc6"]);
  });
});
