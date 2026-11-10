import { describe, expect, it } from "vitest";
import {
  QUICK_CREATE_PROFILES,
  QuickCreateSchema,
  debianNetbootUrls,
  effectiveVcpus,
  isWindows11Iso,
  quickCreateHostName,
  sha256For,
  windowsLanguage,
} from "./quickCreate";

describe("quick create profiles", () => {
  it("match the Desktop sizes", () => {
    expect(QUICK_CREATE_PROFILES.windows11).toMatchObject({ vcpus: 4, memoryMb: 4096, diskGb: 80 });
    expect(QUICK_CREATE_PROFILES.debian13).toMatchObject({ vcpus: 2, memoryMb: 4096, diskGb: 60 });
    expect(effectiveVcpus(4, 2)).toBe(2);
    expect(effectiveVcpus(4, 16)).toBe(4);
    expect(effectiveVcpus(4, 0)).toBe(1);
  });

  it("validate the request", () => {
    expect(QuickCreateSchema.parse({ os: "debian13", storagePool: "local" })).toEqual({ os: "debian13", storagePool: "local", bridge: "virbr0", makeBase: false });
    expect(QuickCreateSchema.safeParse({ os: "macos", storagePool: "local" }).success).toBe(false);
    expect(QuickCreateSchema.safeParse({ os: "debian13", storagePool: "local", name: "a b" }).success).toBe(false);
  });
});

describe("helpers", () => {
  it("recognise the depot's Windows 11 ISOs", () => {
    expect(isWindows11Iso("Windows11-FR_CA-25h2.iso")).toBe(true);
    expect(isWindows11Iso("Win11_25H2_FrenchCanadian_Arm64.iso")).toBe(true);
    expect(isWindows11Iso("debian-13.5.0-amd64-netinst.iso")).toBe(false);
    expect(isWindows11Iso("Windows11.iso.part")).toBe(false);
  });

  it("pick the setup language and host names like Desktop", () => {
    expect(windowsLanguage("Windows11-FR_CA-25h2.iso")).toBe("fr-CA");
    expect(windowsLanguage("Win11_25H2_FrenchCanadian_x64.iso")).toBe("fr-CA");
    expect(windowsLanguage("Win11_25H2_French_x64.iso")).toBe("fr-FR");
    expect(windowsLanguage("Win11_25H2_English_x64.iso")).toBe("en-US");
    expect(quickCreateHostName("Windows 11 (2)", 15)).toBe("Windows-11-2");
    expect(quickCreateHostName("!!!", 15)).toBe("virtua");
    expect(quickCreateHostName("windows-11-workstation", 15)).toBe("windows-11-work");
  });

  it("look up Debian checksums by path", () => {
    const sums = "57303d157cffce3fa402301667fbc9b2280aa7372082b081e777375ae49da5f2  ./netboot/debian-installer/amd64/initrd.gz\n"
      + "2b2358b37674d2505350528875bb17afae2a36522a9e8a9417eaca65a7da0e08  ./netboot/debian-installer/amd64/linux\n";
    expect(sha256For(sums, "netboot/debian-installer/amd64/linux")).toBe("2b2358b37674d2505350528875bb17afae2a36522a9e8a9417eaca65a7da0e08");
    expect(sha256For(sums, "netboot/debian-installer/arm64/linux")).toBeUndefined();
    const urls = debianNetbootUrls("arm64");
    expect(urls.sums).toBe("https://deb.debian.org/debian/dists/trixie/main/installer-arm64/current/images/SHA256SUMS");
    expect(urls.files[1]).toEqual({ name: "initrd.gz", sumsPath: "netboot/debian-installer/arm64/initrd.gz", url: "https://deb.debian.org/debian/dists/trixie/main/installer-arm64/current/images/netboot/debian-installer/arm64/initrd.gz" });
  });
});
