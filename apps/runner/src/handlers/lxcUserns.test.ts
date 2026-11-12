import { describe, expect, it } from "vitest";
import { applyUnprivilegedConfig, parseGetcap, parseIdmap, parseSubIdFile, planRootSubIds, usernsIncludeFor } from "./lxcUserns.js";

describe("planRootSubIds", () => {
  it("reuses root's existing range", () => {
    expect(planRootSubIds("root:100000:65536\n", "root:100000:65536\n")).toEqual({ base: 100000, append: false });
  });

  it("does not overlap another user's range (VirtuaOS ships virtua:100000:65536)", () => {
    expect(planRootSubIds("virtua:100000:65536\n", "virtua:100000:65536\n")).toEqual({ base: 165536, append: true });
  });

  it("starts at 100000 on an empty host", () => {
    expect(planRootSubIds("", "")).toEqual({ base: 100000, append: true });
  });

  it("skips past several ranges, uid and gid files alike", () => {
    expect(planRootSubIds("a:100000:65536\nb:165536:65536\n", "c:231072:1000\n").base).toBe(232072);
  });

  it("re-plans when root's uid and gid ranges disagree", () => {
    expect(planRootSubIds("root:100000:65536\n", "root:200000:65536\n").append).toBe(true);
  });

  it("parses subid files and ignores junk", () => {
    expect(parseSubIdFile("# c\nroot:1:2\nbad line\n")).toEqual([{ owner: "root", start: 1, count: 2 }]);
  });
});

describe("parseIdmap", () => {
  it("is null for a privileged container", () => {
    expect(parseIdmap("lxc.arch = linux64\n")).toBeNull();
  });

  it("reads the u/g mapping of container id 0", () => {
    expect(parseIdmap("lxc.idmap = u 0 165536 65536\nlxc.idmap = g 0 165536 65536\n")).toEqual({ uidBase: 165536, gidBase: 165536, size: 65536 });
  });

  it("accepts b entries and the legacy key", () => {
    expect(parseIdmap("lxc.id_map = b 0 100000 65536\n")).toEqual({ uidBase: 100000, gidBase: 100000, size: 65536 });
  });

  it("needs both uid and gid maps", () => {
    expect(parseIdmap("lxc.idmap = u 0 100000 65536\n")).toBeNull();
  });
});

describe("applyUnprivilegedConfig", () => {
  const cfg = "lxc.include = /usr/share/lxc/config/debian.common.conf\nlxc.idmap = u 0 1 10\nlxc.arch = linux64\n";

  it("replaces any old idmap and adds the userns include", () => {
    const out = applyUnprivilegedConfig(cfg, 165536, "/usr/share/lxc/config/debian.userns.conf");
    expect(out).not.toContain("u 0 1 10");
    expect(out).toContain("lxc.include = /usr/share/lxc/config/debian.userns.conf");
    expect(parseIdmap(out)).toEqual({ uidBase: 165536, gidBase: 165536, size: 65536 });
  });

  it("is idempotent", () => {
    const once = applyUnprivilegedConfig(cfg, 165536, "/x/userns.conf");
    expect(applyUnprivilegedConfig(once, 165536, "/x/userns.conf")).toBe(once);
  });

  it("does not add a second userns include", () => {
    const out = applyUnprivilegedConfig("lxc.include = /usr/share/lxc/config/userns.conf\n", 100000, "/other/userns.conf");
    expect(out).not.toContain("/other/userns.conf");
  });
});

describe("usernsIncludeFor", () => {
  it("prefers the distro flavour, then the generic file", () => {
    expect(usernsIncludeFor("lxc.include = /usr/share/lxc/config/debian.common.conf\n", "/cfg")).toEqual(["/cfg/debian.userns.conf", "/cfg/userns.conf"]);
    expect(usernsIncludeFor("lxc.include = /usr/share/lxc/config/common.conf\n", "/cfg")).toEqual(["/cfg/userns.conf"]);
  });
});

describe("parseGetcap", () => {
  it("reads both getcap output styles", () => {
    expect(parseGetcap("/r/usr/bin/ping cap_net_raw=ep\n/r/bin/x = cap_net_admin+ep\n")).toEqual([
      { file: "/r/usr/bin/ping", caps: "cap_net_raw=ep" },
      { file: "/r/bin/x", caps: "cap_net_admin+ep" },
    ]);
  });
});
