#!/usr/bin/env bash
# Build the Agent Virtua for Windows x64 and ARM64 from Linux or macOS, and
# copy the binaries Virtua Desktop embeds (src-tauri/agent-bin/).
#
# Needs: rustup targets x86_64-pc-windows-gnullvm and aarch64-pc-windows-gnullvm,
# and Zig (https://ziglang.org) as the Windows linker: ZIG=/path/to/zig or zig in PATH.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZIG="${ZIG:-$(command -v zig || true)}"
[ -x "$ZIG" ] || { echo "Zig introuvable : ZIG=/chemin/vers/zig $0" >&2; exit 1; }
TOOLS="$(mktemp -d)"; trap 'rm -rf "$TOOLS"' EXIT

# zig cc as linker: drop the mingw runtime names Zig does not ship (it links
# UCRT) and resolve -lNAME to the import libraries of windows-sys (libNAME.a).
for arch in x86_64 aarch64; do
  cat > "$TOOLS/cc-$arch" <<WRAP
#!/usr/bin/env bash
dirs=(); prev=""
for a in "\$@"; do case "\$a" in -L) ;; -L*) dirs+=("\${a#-L}") ;; esac; [ "\$prev" = "-L" ] && dirs+=("\$a"); prev="\$a"; done
args=(); skip=0
for a in "\$@"; do
  if [ \$skip = 1 ]; then skip=0; continue; fi
  case "\$a" in
    --target=*|-target=*|-lmsvcrt|-lmingw32|-lmingwex) ;;
    -target|--target) skip=1 ;;
    -l*) name="\${a#-l}"; found=""
         for d in "\${dirs[@]}"; do [ -f "\$d/lib\$name.a" ] && { found="\$d/lib\$name.a"; break; }; done
         args+=("\${found:-\$a}") ;;
    *) args+=("\$a") ;;
  esac
done
exec "$ZIG" cc -target $arch-windows-gnu "\${args[@]}"
WRAP
  chmod +x "$TOOLS/cc-$arch"
done

cd "$HERE"
export CARGO_TARGET_X86_64_PC_WINDOWS_GNULLVM_LINKER="$TOOLS/cc-x86_64"
export CARGO_TARGET_AARCH64_PC_WINDOWS_GNULLVM_LINKER="$TOOLS/cc-aarch64"
cargo test
cargo build --release --target x86_64-pc-windows-gnullvm
cargo build --release --target aarch64-pc-windows-gnullvm
mkdir -p ../src-tauri/agent-bin
cp target/x86_64-pc-windows-gnullvm/release/virtua-agent.exe ../src-tauri/agent-bin/virtua-agent-x64.exe
cp target/aarch64-pc-windows-gnullvm/release/virtua-agent.exe ../src-tauri/agent-bin/virtua-agent-arm64.exe
ls -l ../src-tauri/agent-bin
