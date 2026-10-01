//! UEFI firmware shipped inside the app. Windows 11 requires Secure Boot, and
//! neither Homebrew's QEMU (ARM) nor the Windows QEMU builds ship an EDK2
//! image that has it together with the Microsoft keys a Windows PC carries.
//! Provenance and regeneration: `firmware/README.md`.
use super::*;
use std::io::Read as _;

/// Bumped whenever a bundled image changes: extracted copies live in a
/// directory named after it, so an update never mixes old and new files.
const BUNDLE_VERSION: &str = "aa64-qemu11.1.2-sb_x64-deb13u1_ms2023";

struct Blob {
    name: &'static str,
    gz: &'static [u8],
}

const AARCH64_CODE: Blob = Blob {
    name: "aarch64-code.secboot.fd",
    gz: include_bytes!("../firmware/aarch64-code.secboot.fd.gz"),
};
const AARCH64_VARS: Blob = Blob {
    name: "aarch64-vars.fd",
    gz: include_bytes!("../firmware/aarch64-vars.fd.gz"),
};
const AARCH64_VARS_WINDOWS: Blob = Blob {
    name: "aarch64-vars.windows.fd",
    gz: include_bytes!("../firmware/aarch64-vars.windows.fd.gz"),
};
const X86_64_CODE: Blob = Blob {
    name: "x86_64-code.secboot.fd",
    gz: include_bytes!("../firmware/x86_64-code.secboot.fd.gz"),
};
const X86_64_VARS: Blob = Blob {
    name: "x86_64-vars.fd",
    gz: include_bytes!("../firmware/x86_64-vars.fd.gz"),
};
const X86_64_VARS_WINDOWS: Blob = Blob {
    name: "x86_64-vars.windows.fd",
    gz: include_bytes!("../firmware/x86_64-vars.windows.fd.gz"),
};

/// The firmware a launch uses: read-only code, the VM's own variable store.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UefiFirmware {
    pub code: String,
    pub vars: String,
    /// Secure Boot enabled in the variable store (Microsoft keys enrolled).
    pub secure_boot: bool,
    /// x86 Secure Boot builds keep their variables in SMM-protected flash.
    pub smm: bool,
}

fn decompress(blob: &Blob) -> Result<Vec<u8>, String> {
    let mut raw = Vec::new();
    flate2::read::GzDecoder::new(blob.gz)
        .read_to_end(&mut raw)
        .map_err(|err| format!("Firmware {} illisible: {}", blob.name, err))?;
    Ok(raw)
}

fn extract(blob: &Blob) -> Result<PathBuf, String> {
    let dir = local_state_dir()?.join("Firmware").join(BUNDLE_VERSION);
    fs::create_dir_all(&dir).map_err(|err| format!("Dossier firmware impossible: {}", err))?;
    let path = dir.join(blob.name);
    if path.is_file() {
        return Ok(path);
    }
    // Write then rename: a crash mid-write must not leave a truncated
    // firmware that QEMU would refuse on every later start.
    let partial = dir.join(format!("{}.partial", blob.name));
    fs::write(&partial, decompress(blob)?).map_err(|err| format!("Firmware impossible: {}", err))?;
    fs::rename(&partial, &path).map_err(|err| format!("Firmware impossible: {}", err))?;
    Ok(path)
}

/// Per-VM variable store, named after its template so switching Secure Boot
/// on or off never reuses a store enrolled for the other mode.
pub fn vars_path(vm: &LocalVm, secure_boot: bool) -> PathBuf {
    let kind = if secure_boot { "secboot" } else { "uefi" };
    // ARM64 stores carry the firmware generation: the 0.2.6 stores came from
    // Debian's AAVMF and must not be paired with the QEMU-based build.
    let generation = if vm.architecture == "arm64" { "-q11" } else { "" };
    Path::new(&vm.disk_path).with_extension(format!("{kind}-vars{generation}.fd"))
}

/// Every variable store a VM may have accumulated, current or retired.
pub fn all_vars_paths(vm: &LocalVm) -> Vec<PathBuf> {
    let disk = Path::new(&vm.disk_path);
    vec![
        vars_path(vm, true),
        vars_path(vm, false),
        disk.with_extension("secboot-vars.fd"),
        disk.with_extension("uefi-vars.fd"),
    ]
}

/// Bundled firmware for the VMs that need it: Windows guests (Windows 11
/// requires a Secure Boot-capable UEFI) and any VM with Secure Boot on.
/// Other VMs keep the firmware of the installed QEMU.
pub fn prepare(vm: &LocalVm) -> Result<Option<UefiFirmware>, String> {
    if vm.guest_os != "windows" && !vm.secure_boot {
        return Ok(None);
    }
    let arm64 = vm.architecture == "arm64";
    let (code, template) = match (arm64, vm.secure_boot) {
        (true, true) => (&AARCH64_CODE, &AARCH64_VARS_WINDOWS),
        (true, false) => (&AARCH64_CODE, &AARCH64_VARS),
        (false, true) => (&X86_64_CODE, &X86_64_VARS_WINDOWS),
        (false, false) => (&X86_64_CODE, &X86_64_VARS),
    };
    let code = extract(code)?;
    let vars = vars_path(vm, vm.secure_boot);
    if !vars.is_file() {
        let template = extract(template)?;
        fs::copy(&template, &vars).map_err(|err| format!("Variables UEFI impossibles: {}", err))?;
    }
    Ok(Some(UefiFirmware {
        code: code.to_string_lossy().to_string(),
        vars: vars.to_string_lossy().to_string(),
        secure_boot: vm.secure_boot,
        smm: !arm64,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_images_have_the_sizes_qemu_expects() {
        // `virt` pflash banks are exactly 64 MiB; OVMF 4M images pair a
        // 3.5 MiB code volume with a 528 KiB variable store.
        for blob in [&AARCH64_CODE, &AARCH64_VARS, &AARCH64_VARS_WINDOWS] {
            assert_eq!(decompress(blob).unwrap().len(), 64 * 1024 * 1024, "{}", blob.name);
        }
        assert_eq!(decompress(&X86_64_CODE).unwrap().len(), 3_653_632);
        for blob in [&X86_64_VARS, &X86_64_VARS_WINDOWS] {
            assert_eq!(decompress(blob).unwrap().len(), 540_672, "{}", blob.name);
        }
    }

    #[test]
    fn windows_variable_stores_carry_the_2011_and_2023_microsoft_keys() {
        for blob in [&AARCH64_VARS_WINDOWS, &X86_64_VARS_WINDOWS] {
            let raw = decompress(blob).unwrap();
            let has = |needle: &str| raw.windows(needle.len()).any(|w| w == needle.as_bytes());
            for cn in [
                "Microsoft Windows Production PCA 2011",
                "Windows UEFI CA 2023",
                "Microsoft Corporation KEK CA 2011",
                "Microsoft Corporation KEK 2K CA 2023",
                "Windows OEM Devices PK",
            ] {
                assert!(has(cn), "{} missing from {}", cn, blob.name);
            }
        }
    }

    #[test]
    fn secure_boot_and_plain_stores_never_share_a_file() {
        let mut vm = crate::local_mode_tests::sample_vm("arm64", "std");
        vm.disk_path = "/disks/win.qcow2".into();
        assert_eq!(vars_path(&vm, true), PathBuf::from("/disks/win.secboot-vars-q11.fd"));
        assert_eq!(vars_path(&vm, false), PathBuf::from("/disks/win.uefi-vars-q11.fd"));
        vm.architecture = "amd64".into();
        assert_eq!(vars_path(&vm, true), PathBuf::from("/disks/win.secboot-vars.fd"));
    }
}
