/**
 * Quick create (unattended Windows 11 / Debian 13): pure builders, ported from
 * Virtua Desktop's quickcreate.rs. No I/O here so every generated file is
 * unit-tested; qemu.ts writes them and drives libvirt.
 *
 * - Debian 13: the official netboot kernel + initrd (fetched and checked
 *   against Debian's SHA256SUMS by the API), booted directly through libvirt
 *   `<os><kernel>/<initrd>/<cmdline>`, a preseed appended to the initrd as a
 *   newc cpio. The installer powers off; the tick removes the direct boot and
 *   starts the VM from its disk.
 * - Windows 11: the installer ISO, the virtio-win disc, and the answer file
 *   on a FAT12 floppy (Windows Setup reads `autounattend.xml` at the root of
 *   any removable drive). UEFI + Secure Boot + TPM.
 */
import { gzipSync } from "zlib";
import { QUICK_CREATE_PASSWORD, QUICK_CREATE_USER } from "@auxinux/shared";

const USER = QUICK_CREATE_USER;
const PASSWORD = QUICK_CREATE_PASSWORD;

// ── Debian 13 ───────────────────────────────────────────────────────────────

export function debianPreseed(hostname: string, timezone: string): string {
  return `# Virtua — installation automatique de Debian 13
d-i debian-installer/locale string fr_CA.UTF-8
d-i debian-installer/language string fr
d-i debian-installer/country string CA
d-i keyboard-configuration/xkb-keymap select ca
d-i netcfg/choose_interface select auto
d-i netcfg/get_hostname string ${hostname}
d-i netcfg/get_domain string local
d-i netcfg/hostname string ${hostname}
d-i hw-detect/load_firmware boolean false
d-i mirror/country string manual
d-i mirror/http/hostname string deb.debian.org
d-i mirror/http/directory string /debian
d-i mirror/http/proxy string
d-i passwd/root-login boolean false
d-i passwd/user-fullname string Virtua
d-i passwd/username string ${USER}
d-i passwd/user-password password ${PASSWORD}
d-i passwd/user-password-again password ${PASSWORD}
d-i user-setup/allow-password-weak boolean true
d-i clock-setup/utc boolean true
d-i time/zone string ${timezone}
d-i clock-setup/ntp boolean true
d-i partman-auto/disk string /dev/vda
d-i partman-auto/method string regular
d-i partman-auto/choose_recipe select atomic
d-i partman-partitioning/confirm_write_new_label boolean true
d-i partman/choose_partition select finish
d-i partman/confirm boolean true
d-i partman/confirm_nooverwrite boolean true
d-i partman-efi/non_efi_system boolean true
d-i partman-lvm/device_remove_lvm boolean true
d-i partman-md/device_remove_md boolean true
d-i apt-setup/non-free-firmware boolean true
d-i apt-setup/services-select multiselect security, updates
tasksel tasksel/first multiselect standard, ssh-server
d-i pkgsel/include string qemu-guest-agent spice-vdagent sudo
d-i pkgsel/upgrade select full-upgrade
popularity-contest popularity-contest/participate boolean false
d-i grub-installer/only_debian boolean true
d-i grub-installer/bootdev string default
d-i grub-installer/force-efi-extra-removable boolean true
d-i finish-install/reboot_in_progress note
d-i debian-installer/exit/poweroff boolean true
`;
}

/**
 * Preseed of a disposable *base*: the same installation, generalized at the
 * end so every copy gets its own machine-id and SSH host keys on first boot.
 */
export function debianBasePreseed(hostname: string, timezone: string): string {
  const unit = "[Unit]\\nDescription=Virtua: SSH host keys of this copy\\nBefore=ssh.service\\nConditionPathExists=!/etc/ssh/ssh_host_ed25519_key\\n[Service]\\nType=oneshot\\nExecStart=/usr/bin/ssh-keygen -A\\n[Install]\\nWantedBy=multi-user.target\\n";
  // log-output: whatever the commands print goes to the installer's log.
  // Printed straight to stdout, it lands on the debconf channel and corrupts
  // the installer (garbled main menu, "continue without boot loader") —
  // `systemctl enable` does print.
  return `${debianPreseed(hostname, timezone)}d-i preseed/late_command string log-output -t virtua in-target sh -c 'truncate -s 0 /etc/machine-id; rm -f /etc/ssh/ssh_host_*; printf "${unit}" > /etc/systemd/system/virtua-ssh-keys.service; systemctl enable virtua-ssh-keys.service; apt-get clean; true'\n`;
}

/**
 * Kernel command line of the installer. Boot-parameter aliases are read
 * before the preseed, so even the first screens are in French.
 */
export function debianAppend(hostname: string, architecture: "amd64" | "arm64"): string {
  // ARM64 `virt` makes the serial port the console: the installer then runs
  // there, offers only the "C" language, rejects the preseeded fr_CA and
  // stops on "Select a language". console=tty0 puts it on the screen; with
  // UEFI + ACPI the serial port stays preferred (ACPI SPCR) unless
  // acpi=nospcr (Linux 6.8+, Debian 13 has 6.12).
  const consoleArgs = architecture === "arm64" ? " acpi=nospcr console=tty0" : "";
  return `auto=true priority=critical language=fr country=CA locale=fr_CA.UTF-8 keymap=ca hostname=${hostname} domain=local${consoleArgs} ---`;
}

/** One file in a `newc` cpio archive (the initramfs format), plus the trailer. */
export function cpioNewc(name: string, data: Buffer): Buffer {
  const parts: Buffer[] = [];
  let length = 0;
  const push = (chunk: Buffer) => { parts.push(chunk); length += chunk.length; };
  const pad = () => { const n = (4 - (length % 4)) % 4; if (n) push(Buffer.alloc(n)); };
  const entry = (ino: number, mode: number, entryName: string, body: Buffer) => {
    const fields = [ino, mode, 0, 0, 1, 0, body.length, 0, 0, 0, 0, Buffer.byteLength(entryName) + 1, 0];
    push(Buffer.from(`070701${fields.map((f) => f.toString(16).padStart(8, "0")).join("")}`, "ascii"));
    push(Buffer.concat([Buffer.from(entryName, "utf8"), Buffer.alloc(1)]));
    pad();
    push(body);
    pad();
  };
  entry(1, 0o100644, name, data);
  entry(0, 0, "TRAILER!!!", Buffer.alloc(0));
  return Buffer.concat(parts, length);
}

/**
 * The installer's initrd with `/preseed.cfg` added: Linux unpacks every
 * compressed cpio archive concatenated in an initramfs, and debian-installer
 * loads `/preseed.cfg` before asking anything.
 */
export function initrdWithPreseed(initrd: Buffer, preseed: string): Buffer {
  return Buffer.concat([initrd, gzipSync(cpioNewc("preseed.cfg", Buffer.from(preseed, "utf8")))]);
}

// ── Windows 11 ──────────────────────────────────────────────────────────────

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inputLocale(language: string): string {
  if (language === "fr-CA") return "0c0c:00001009";
  if (language === "fr-FR") return "040c:0000040c";
  return "0409:00000409";
}

/** Full answer file: nothing to click from the boot to the desktop. */
export function windowsAnswerFile(architecture: "amd64" | "arm64", language: string, computerName: string): string {
  const arch = architecture === "arm64" ? "arm64" : "amd64";
  const driverArch = architecture === "arm64" ? "ARM64" : "amd64";
  const attrs = `processorArchitecture="${arch}" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS"`;
  // The driver disc's letter depends on how many drives come before it.
  let paths = "";
  let key = 1;
  for (const letter of ["D", "E", "F", "G", "H"]) {
    for (const driver of ["viostor", "vioscsi", "NetKVM", "vioserial", "Balloon"]) {
      paths += `        <PathAndCredentials wcm:action="add" wcm:keyValue="${key}"><Path>${letter}:\\${driver}\\w11\\${driverArch}</Path></PathAndCredentials>\n`;
      key += 1;
    }
  }
  const lab = ["BypassTPMCheck", "BypassSecureBootCheck", "BypassRAMCheck", "BypassStorageCheck", "BypassCPUCheck"]
    .map((k, i) => `        <RunSynchronousCommand wcm:action="add"><Order>${i + 1}</Order><Path>reg add HKLM\\SYSTEM\\Setup\\LabConfig /v ${k} /t REG_DWORD /d 1 /f</Path></RunSynchronousCommand>\n`)
    .join("");
  const firstLogonCommands: Array<[string, string]> = [
    ["Mot de passe sans expiration", "net accounts /maxpwage:unlimited"],
    ["Outils invités VirtIO (agent, pilotes)", `cmd /c for %d in (D E F G H I) do @if exist %d:\\virtio-win-guest-tools.exe start "" /wait %d:\\virtio-win-guest-tools.exe /install /quiet /norestart`],
    ["Bureau à distance", `reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server" /v fDenyTSConnections /t REG_DWORD /d 0 /f`],
    ["RemoteApp", `reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Terminal Server\\TSAppAllowList" /v fDisabledAllowList /t REG_DWORD /d 1 /f`],
    ["RemoteApp (stratégie)", `reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows NT\\Terminal Services" /v fAllowUnlistedRemotePrograms /t REG_DWORD /d 1 /f`],
    ["Pare-feu Bureau à distance", `powershell -NoProfile -Command "Enable-NetFirewallRule -Group '@FirewallAPI.dll,-28752'"`],
  ];
  const firstLogon = firstLogonCommands
    .map(([description, command], i) => `        <SynchronousCommand wcm:action="add"><Order>${i + 1}</Order><Description>${xmlEscape(description)}</Description><CommandLine>${xmlEscape(command)}</CommandLine></SynchronousCommand>\n`)
    .join("");
  const input = inputLocale(language);
  const international = (name: string) =>
    `    <component name="${name}" ${attrs}>\n      <InputLocale>${input}</InputLocale>\n      <SystemLocale>${language}</SystemLocale>\n      <UILanguage>${language}</UILanguage>\n      <UserLocale>${language}</UserLocale>\n`;
  const password = `<Password><Value>${PASSWORD}</Value><PlainText>true</PlainText></Password>`;
  return `<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <settings pass="windowsPE">
${international("Microsoft-Windows-International-Core-WinPE")}      <SetupUILanguage><UILanguage>${language}</UILanguage></SetupUILanguage>
    </component>
    <component name="Microsoft-Windows-PnpCustomizationsWinPE" ${attrs}>
      <DriverPaths>
${paths}      </DriverPaths>
    </component>
    <component name="Microsoft-Windows-Setup" ${attrs}>
      <RunSynchronous>
${lab}      </RunSynchronous>
      <DiskConfiguration>
        <Disk wcm:action="add">
          <DiskID>0</DiskID>
          <WillWipeDisk>true</WillWipeDisk>
          <CreatePartitions>
            <CreatePartition wcm:action="add"><Order>1</Order><Type>EFI</Type><Size>300</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>2</Order><Type>MSR</Type><Size>16</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>3</Order><Type>Primary</Type><Extend>true</Extend></CreatePartition>
          </CreatePartitions>
          <ModifyPartitions>
            <ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Label>System</Label><Format>FAT32</Format></ModifyPartition>
            <ModifyPartition wcm:action="add"><Order>2</Order><PartitionID>2</PartitionID></ModifyPartition>
            <ModifyPartition wcm:action="add"><Order>3</Order><PartitionID>3</PartitionID><Label>Windows</Label><Letter>C</Letter><Format>NTFS</Format></ModifyPartition>
          </ModifyPartitions>
        </Disk>
      </DiskConfiguration>
      <ImageInstall>
        <OSImage>
          <InstallTo><DiskID>0</DiskID><PartitionID>3</PartitionID></InstallTo>
        </OSImage>
      </ImageInstall>
      <UserData>
        <AcceptEula>true</AcceptEula>
        <!-- Generic Windows 11 Pro installation key: selects the edition, does not activate it. -->
        <ProductKey><Key>VK7JG-NPHTM-C97JM-9MPGT-3V66T</Key><WillShowUI>Never</WillShowUI></ProductKey>
      </UserData>
    </component>
  </settings>
  <settings pass="specialize">
    <component name="Microsoft-Windows-Shell-Setup" ${attrs}>
      <ComputerName>${xmlEscape(computerName)}</ComputerName>
    </component>
    <component name="Microsoft-Windows-Deployment" ${attrs}>
      <RunSynchronous>
        <RunSynchronousCommand wcm:action="add"><Order>1</Order><Path>reg add HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\OOBE /v BypassNRO /t REG_DWORD /d 1 /f</Path></RunSynchronousCommand>
      </RunSynchronous>
    </component>
  </settings>
  <settings pass="oobeSystem">
${international("Microsoft-Windows-International-Core")}    </component>
    <component name="Microsoft-Windows-Shell-Setup" ${attrs}>
      <OOBE>
        <HideEULAPage>true</HideEULAPage>
        <HideLocalAccountScreen>true</HideLocalAccountScreen>
        <HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>
        <HideOnlineAccountScreens>true</HideOnlineAccountScreens>
        <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>
        <ProtectYourPC>3</ProtectYourPC>
      </OOBE>
      <UserAccounts>
        <LocalAccounts>
          <LocalAccount wcm:action="add"><Name>${USER}</Name><DisplayName>Virtua</DisplayName><Group>Administrators</Group>${password}</LocalAccount>
        </LocalAccounts>
      </UserAccounts>
      <AutoLogon><Enabled>true</Enabled><Username>${USER}</Username>${password}<LogonCount>9999999</LogonCount></AutoLogon>
      <FirstLogonCommands>
${firstLogon}      </FirstLogonCommands>
    </component>
  </settings>
</unattend>
`;
}

// ── FAT12 floppy (the answer file's medium) ─────────────────────────────────

const SECTOR = 512;
const FLOPPY_SECTORS = 2880; // 1.44 MB
const FAT_SECTORS = 9;
const ROOT_ENTRIES = 224;
const ROOT_SECTORS = (ROOT_ENTRIES * 32) / SECTOR; // 14
const DATA_START = 1 + 2 * FAT_SECTORS + ROOT_SECTORS; // sector 33 = cluster 2

function shortNameChecksum(shortName: Buffer): number {
  let sum = 0;
  for (const byte of shortName) sum = (((sum & 1) << 7) + (sum >> 1) + byte) & 0xff;
  return sum;
}

/** Whether a name needs VFAT long-name entries (anything but plain upper-case 8.3). */
export function needsLongName(name: string): boolean {
  return !/^[A-Z0-9_-]{1,8}(\.[A-Z0-9_-]{1,3})?$/.test(name);
}

/** 8.3 name for a file name (`autounattend.xml` → `AUTOUN~1XML`), 11 bytes. */
export function shortNameFor(name: string, index = 1): Buffer {
  const dot = name.lastIndexOf(".");
  const base = (dot > 0 ? name.slice(0, dot) : name).toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  const ext = (dot > 0 ? name.slice(dot + 1) : "").toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 3);
  const stem = needsLongName(name) ? `${base.slice(0, 6)}~${index}` : base;
  return Buffer.from(stem.padEnd(8, " ") + ext.padEnd(3, " "), "ascii");
}

/** VFAT long-name entries (13 UTF-16 units each), last one first as on disk. */
function lfnEntries(name: string, checksum: number): Buffer[] {
  const chars: number[] = [];
  for (let i = 0; i < name.length; i += 1) chars.push(name.charCodeAt(i));
  const count = Math.ceil((chars.length + 1) / 13);
  const padded = [...chars, 0x0000];
  while (padded.length < count * 13) padded.push(0xffff);
  const entries: Buffer[] = [];
  for (let n = count; n >= 1; n -= 1) {
    const e = Buffer.alloc(32);
    const slice = padded.slice((n - 1) * 13, n * 13);
    e[0] = n | (n === count ? 0x40 : 0);
    slice.slice(0, 5).forEach((c, i) => e.writeUInt16LE(c, 1 + i * 2));
    e[11] = 0x0f;
    e[12] = 0;
    e[13] = checksum;
    slice.slice(5, 11).forEach((c, i) => e.writeUInt16LE(c, 14 + i * 2));
    e.writeUInt16LE(0, 26);
    slice.slice(11, 13).forEach((c, i) => e.writeUInt16LE(c, 28 + i * 2));
    entries.push(e);
  }
  return entries;
}

function fatDateTime(date: Date): { date: number; time: number } {
  return {
    date: ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
  };
}

/**
 * A 1.44 MB FAT12 floppy image holding `files` at its root (long file names
 * via VFAT entries). Enough for an answer file; no subdirectories.
 */
export function buildFat12Image(files: Array<{ name: string; data: Buffer }>, volumeLabel = "VIRTUA", now = new Date()): Buffer {
  const image = Buffer.alloc(FLOPPY_SECTORS * SECTOR);
  // Boot sector / BPB of a standard 3½" 1.44 MB diskette.
  image.set([0xeb, 0x3c, 0x90], 0);
  image.write("MSWIN4.1", 3, "ascii");
  image.writeUInt16LE(SECTOR, 11);
  image[13] = 1; // sectors per cluster
  image.writeUInt16LE(1, 14); // reserved sectors
  image[16] = 2; // FATs
  image.writeUInt16LE(ROOT_ENTRIES, 17);
  image.writeUInt16LE(FLOPPY_SECTORS, 19);
  image[21] = 0xf0; // media descriptor
  image.writeUInt16LE(FAT_SECTORS, 22);
  image.writeUInt16LE(18, 24); // sectors per track
  image.writeUInt16LE(2, 26); // heads
  image[36] = 0x00; // drive number
  image[38] = 0x29; // extended boot signature
  image.writeUInt32LE(((now.getTime() / 1000) >>> 0) ^ 0x5649_5254, 39); // volume serial
  image.write(volumeLabel.toUpperCase().slice(0, 11).padEnd(11, " "), 43, "ascii");
  image.write("FAT12   ", 54, "ascii");
  image[510] = 0x55;
  image[511] = 0xaa;

  const fat: number[] = [0xff0, 0xfff];
  const rootEntries: Buffer[] = [];
  const label = Buffer.alloc(32);
  label.write(volumeLabel.toUpperCase().slice(0, 11).padEnd(11, " "), 0, "ascii");
  label[11] = 0x08;
  rootEntries.push(label);

  const { date, time } = fatDateTime(now);
  let nextCluster = 2;
  files.forEach((file, index) => {
    const clusters = Math.max(1, Math.ceil(file.data.length / SECTOR));
    if (nextCluster + clusters > 2 + (FLOPPY_SECTORS - DATA_START)) throw new Error("Files do not fit on a 1.44 MB floppy");
    const first = file.data.length > 0 ? nextCluster : 0;
    if (file.data.length > 0) {
      for (let c = 0; c < clusters; c += 1) {
        fat[nextCluster + c] = c === clusters - 1 ? 0xfff : nextCluster + c + 1;
      }
      file.data.copy(image, (DATA_START + (nextCluster - 2)) * SECTOR);
      nextCluster += clusters;
    }
    const short = shortNameFor(file.name, index + 1);
    if (needsLongName(file.name)) rootEntries.push(...lfnEntries(file.name, shortNameChecksum(short)));
    const entry = Buffer.alloc(32);
    short.copy(entry, 0);
    entry[11] = 0x20; // archive
    entry.writeUInt16LE(time, 14);
    entry.writeUInt16LE(date, 16);
    entry.writeUInt16LE(date, 18);
    entry.writeUInt16LE(time, 22);
    entry.writeUInt16LE(date, 24);
    entry.writeUInt16LE(first, 26);
    entry.writeUInt32LE(file.data.length, 28);
    rootEntries.push(entry);
  });
  if (rootEntries.length > ROOT_ENTRIES) throw new Error("Too many files for the floppy root directory");

  // FAT12: two entries packed in three bytes.
  const fatBytes = Buffer.alloc(FAT_SECTORS * SECTOR);
  for (let n = 0; n < fat.length; n += 1) {
    const value = (fat[n] ?? 0) & 0xfff;
    const offset = Math.floor((n * 3) / 2);
    if (n % 2 === 0) {
      fatBytes[offset] = value & 0xff;
      fatBytes[offset + 1] = (fatBytes[offset + 1] & 0xf0) | (value >> 8);
    } else {
      fatBytes[offset] = (fatBytes[offset] & 0x0f) | ((value & 0x0f) << 4);
      fatBytes[offset + 1] = value >> 4;
    }
  }
  fatBytes.copy(image, 1 * SECTOR);
  fatBytes.copy(image, (1 + FAT_SECTORS) * SECTOR);
  Buffer.concat(rootEntries).copy(image, (1 + 2 * FAT_SECTORS) * SECTOR);
  return image;
}

// ── After the installation ──────────────────────────────────────────────────

/** Drop the installer's direct kernel boot: the VM boots from its disk. */
export function stripDirectKernelBoot(xml: string): string {
  return xml.replace(/[ \t]*<(kernel|initrd|cmdline)\b[^>]*>[^<]*<\/\1>\n?/gi, "").replace(/[ \t]*<(kernel|initrd|cmdline)\b[^>]*\/>\n?/gi, "");
}

function unescapeXml(value: string) {
  return value.replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/**
 * Remove the install media (installer/driver CD-ROMs and the answer-file
 * floppy) whose source is one of `paths` or under `workDir`.
 */
export function stripInstallMedia(xml: string, paths: string[], workDir: string): string {
  const prefix = workDir.endsWith("/") ? workDir : `${workDir}/`;
  return xml.replace(/[ \t]*<disk\b[\s\S]*?<\/disk>\n?/gi, (block) => {
    const open = block.match(/<disk\b[^>]*>/i)?.[0] ?? "";
    if (!/\bdevice=['"](cdrom|floppy|disk)['"]/i.test(open)) return block;
    const raw = block.match(/<source\b[^>]*\bfile=['"]([^'"]+)['"]/i)?.[1];
    if (!raw) return block;
    const source = unescapeXml(raw);
    const isMedia = paths.includes(source) || source.startsWith(prefix);
    // Never the system disk: only read-only media qualify.
    if (/\bdevice=['"]disk['"]/i.test(open) && !/<readonly\s*\/?>/i.test(block)) return block;
    return isMedia ? "" : block;
  });
}
