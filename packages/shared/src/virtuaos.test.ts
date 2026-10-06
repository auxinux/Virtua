import { describe, expect, it } from "vitest";
import {
  detectVirtuaOs,
  devKernelPackages,
  kernelReleaseChannel,
  parseChannelInput,
  parseLatestFromReleaseMd,
  prodKernelImages,
  readChannelFile,
  renderKernelSources,
  updateChannelFile,
} from "./virtuaos";

const DEBIAN_OS_RELEASE = `PRETTY_NAME="Debian GNU/Linux 13 (trixie)"
NAME="Debian GNU/Linux"
VERSION_ID="13"
ID=debian
`;

describe("detectVirtuaOs", () => {
  it("detects /etc/virtuaos-version alone", () => {
    expect(detectVirtuaOs({ versionFile: "1.0.3-BETA\n", releaseFile: null, osRelease: null }))
      .toEqual({ isVirtuaOS: true, version: "1.0.3-BETA" });
  });

  it("detects /etc/virtuaos-release alone", () => {
    expect(detectVirtuaOs({ versionFile: null, releaseFile: 'VERSION_ID="1.0.4"\n', osRelease: null }))
      .toEqual({ isVirtuaOS: true, version: "1.0.4" });
  });

  it("detects ID=virtuaos in os-release, quoted or not", () => {
    expect(detectVirtuaOs({ versionFile: null, releaseFile: null, osRelease: "ID=virtuaos\nVERSION_ID=1.0.3\n" }).isVirtuaOS).toBe(true);
    expect(detectVirtuaOs({ versionFile: null, releaseFile: null, osRelease: 'ID="virtuaos"\n' }).isVirtuaOS).toBe(true);
  });

  it("reports a plain host when no signal is present", () => {
    expect(detectVirtuaOs({ versionFile: null, releaseFile: null, osRelease: DEBIAN_OS_RELEASE }))
      .toEqual({ isVirtuaOS: false, version: null });
    expect(detectVirtuaOs({ versionFile: null, releaseFile: null, osRelease: null }).isVirtuaOS).toBe(false);
  });

  // base-files rewrote os-release back to Debian; virtuaos-version survives.
  it("still detects VirtuaOS when os-release says Debian but virtuaos-version exists", () => {
    expect(detectVirtuaOs({ versionFile: "1.0.3-BETA", releaseFile: null, osRelease: DEBIAN_OS_RELEASE }))
      .toEqual({ isVirtuaOS: true, version: "1.0.3-BETA" });
  });

  it("does not mistake ID_LIKE for ID", () => {
    expect(detectVirtuaOs({ versionFile: null, releaseFile: null, osRelease: "ID=debian\nID_LIKE=virtuaos\n" }).isVirtuaOS).toBe(false);
  });
});

describe("channel file", () => {
  it("defaults to PROD when the file is absent", () => {
    expect(readChannelFile(null)).toEqual({ virtuaosChannel: "PROD", kernelChannel: "PROD" });
  });

  it("defaults a missing key to PROD", () => {
    expect(readChannelFile("VIRTUAOS_CHANNEL=DEV\n")).toEqual({ virtuaosChannel: "DEV", kernelChannel: "PROD" });
  });

  it("treats an invalid value as PROD", () => {
    expect(readChannelFile("VIRTUAOS_CHANNEL=BETA\nKERNEL_CHANNEL=\n")).toEqual({ virtuaosChannel: "PROD", kernelChannel: "PROD" });
  });

  it("accepts dev in lowercase", () => {
    expect(readChannelFile("KERNEL_CHANNEL=dev\n").kernelChannel).toBe("DEV");
  });

  it("keeps unknown keys and comments when updating", () => {
    const before = "# managed by vos\nVIRTUAOS_CHANNEL=PROD\nVOS_MIRROR=eu\nKERNEL_CHANNEL=PROD\n";
    expect(updateChannelFile(before, { KERNEL_CHANNEL: "DEV" }))
      .toBe("# managed by vos\nVIRTUAOS_CHANNEL=PROD\nVOS_MIRROR=eu\nKERNEL_CHANNEL=DEV\n");
  });

  it("appends a missing key without quotes", () => {
    expect(updateChannelFile(null, { VIRTUAOS_CHANNEL: "DEV" })).toBe("VIRTUAOS_CHANNEL=DEV\n");
    expect(updateChannelFile("VOS_MIRROR=eu", { KERNEL_CHANNEL: "PROD" })).toBe("VOS_MIRROR=eu\nKERNEL_CHANNEL=PROD\n");
  });

  it("validates client input strictly", () => {
    expect(parseChannelInput("dev")).toBe("DEV");
    expect(parseChannelInput("PROD")).toBe("PROD");
    expect(parseChannelInput("https://dep.auxinux.ca/VIRTUA/KERNEL-DEV/")).toBeNull();
    expect(parseChannelInput(undefined)).toBeNull();
  });
});

describe("kernel helpers", () => {
  it("derives the running kernel channel from uname -r", () => {
    expect(kernelReleaseChannel("7.2.9-dev-auxinux-virtua-amd64")).toBe("DEV");
    expect(kernelReleaseChannel("7.2.4-auxinux-virtua-amd64")).toBe("PROD");
  });

  it("renders the PROD and DEV deb822 sources", () => {
    expect(renderKernelSources("PROD")).toBe([
      "Types: deb",
      "URIs: https://dep.auxinux.ca/VIRTUA",
      "Suites: kernel",
      "Components: main",
      "Architectures: amd64",
      "Signed-By: /usr/share/keyrings/virtua-archive-keyring.asc",
      "",
    ].join("\n"));
    expect(renderKernelSources("DEV")).toContain("Suites: kernel-dev\n");
    expect(renderKernelSources("DEV")).not.toContain("KERNEL-DEV");
  });

  it("finds PROD images in /boot", () => {
    expect(prodKernelImages([
      "vmlinuz-7.2.9-dev-auxinux-virtua-amd64",
      "vmlinuz-7.2.4-auxinux-virtua-amd64",
      "initrd.img-7.2.4-auxinux-virtua-amd64",
      "vmlinuz-6.12.0-amd64",
    ])).toEqual(["vmlinuz-7.2.4-auxinux-virtua-amd64"]);
  });

  it("selects only DEV kernel packages for purge", () => {
    expect(devKernelPackages([
      "kernel-virtua",
      "kernel-virtua-dev",
      "linux-image-7.2.9-dev-auxinux-virtua-amd64",
      "linux-headers-7.2.9-dev-auxinux-virtua-amd64",
      "linux-image-7.2.4-auxinux-virtua-amd64",
      "linux-image-6.12.0-amd64",
    ])).toEqual([
      "kernel-virtua-dev",
      "linux-image-7.2.9-dev-auxinux-virtua-amd64",
      "linux-headers-7.2.9-dev-auxinux-virtua-amd64",
    ]);
  });

  it("reads the latest line of release.md", () => {
    expect(parseLatestFromReleaseMd("# VirtuaOS\n\nlatest: 1.0.4\n\n## 1.0.4\n")).toBe("1.0.4");
    expect(parseLatestFromReleaseMd("Latest: 1.1.0-BETA")).toBe("1.1.0-BETA");
    expect(parseLatestFromReleaseMd("# nothing here")).toBeNull();
  });
});
