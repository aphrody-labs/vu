#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Toolchain for Claude Code cloud sessions (CLAUDE_CODE_REMOTE=true): Rust, Bun, uv, Graphify, build tools and
# the repository dependencies. User-level, idempotent, tolerant: every step logs and continues, the exit code
# is always 0 so a missing network route never blocks a session.
#   --background  fork the installation and return at once (SessionStart hook)
#   --wait        run in the foreground
#   --dry-run     print the steps only
#   --force       run outside a cloud session
set -u
mode=wait
force=0
dry=0
for arg in "$@"; do
  case "$arg" in
    --background) mode=background ;;
    --wait) mode=wait ;;
    --dry-run) dry=1 ;;
    --force) force=1 ;;
  esac
done
[[ "${CLAUDE_CODE_REMOTE:-}" == "true" || $force == 1 || $dry == 1 ]] || exit 0

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
log_dir="${XDG_STATE_HOME:-$HOME/.local/state}/aphrody"
log="$log_dir/cloud-setup.log"
mkdir -p "$log_dir" "$HOME/.local/bin" "$HOME/.cargo/bin" "$HOME/.bun/bin"
export PATH="$HOME/.cargo/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH"
# Later Bash calls of the session find the tools without a shell profile.
if [[ -n "${CLAUDE_ENV_FILE:-}" ]]; then
  grep -q 'aphrody-cloud-path' "$CLAUDE_ENV_FILE" 2>/dev/null ||
    echo 'export PATH="$HOME/.cargo/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH" # aphrody-cloud-path' >>"$CLAUDE_ENV_FILE"
fi

if [[ $mode == background && $dry == 0 ]]; then
  nohup bash "$0" --wait >>"$log" 2>&1 </dev/null &
  echo "aphrody cloud setup started in the background (log: $log)"
  exit 0
fi

step() { printf '\n[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
run() { if (( dry == 1 )); then echo "  would run: $*"; else "$@" || echo "  step failed (continuing): $*"; fi; }
have() { command -v "$1" >/dev/null 2>&1; }

lock="$log_dir/cloud-setup.lock"
if (( dry == 0 )); then
  exec 9>"$lock"
  flock -n 9 || { echo "another cloud setup is running"; exit 0; }
fi

step "versions from the repository"
channel="$(sed -nE 's/^channel[[:space:]]*=[[:space:]]*"([^"]+)"/\1/p' "$root/rust-toolchain.toml" 2>/dev/null | head -1)"
bun_pin="$(sed -nE '/"bun"[[:space:]]*:[[:space:]]*\{/,/\}/ s/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$root/config/system-packages.json" 2>/dev/null | head -1)"
echo "  rust channel: ${channel:-stable}  bun: ${bun_pin:-latest}"

step "rust"
if ! have rustup; then
  run bash -c "curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --default-toolchain none"
fi
if have rustup || (( dry == 1 )); then
  run rustup toolchain install "${channel:-stable}" --profile minimal -c rustfmt -c clippy
  run rustup default "${channel:-stable}"
fi

step "bun"
if ! have bun; then
  run bash -c "curl -fsSL https://bun.sh/install | bash -s ${bun_pin:+bun-v$bun_pin}"
fi

step "uv and Graphify"
if ! have uv; then
  run bash -c "curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=$HOME/.local/bin INSTALLER_NO_MODIFY_PATH=1 sh"
fi
if have uv || (( dry == 1 )); then
  have graphify || run uv tool install graphifyy
  run graphify install
fi

step "build and search tools (cargo-binstall, prebuilt binaries only)"
if ! have cargo-binstall; then
  run bash -c "curl -L --proto '=https' --tlsv1.2 -sSf https://raw.githubusercontent.com/cargo-bins/cargo-binstall/main/install-from-binstall-release.sh | bash"
fi
if have cargo-binstall || (( dry == 1 )); then
  for pair in just:just sccache:sccache cargo-nextest:cargo-nextest nu:nu fd:fd-find rg:ripgrep bat:bat; do
    have "${pair%%:*}" || run cargo binstall -y --locked --disable-strategies compile "${pair##*:}"
  done
fi

step "repository dependencies"
if [[ -f "$root/bun.lock" ]] && (have bun || (( dry == 1 ))); then
  run bash -c "cd '$root' && bun install --frozen-lockfile"
fi

step "Aphrody and Yolo binaries (download server, when announced)"
if [[ -n "${APHRODY_DOWNLOAD_BASE:-}" ]]; then
  run bash -c "curl -fsSL '$APHRODY_DOWNLOAD_BASE/install.sh' | sh"
else
  echo "  APHRODY_DOWNLOAD_BASE is not set: skipped"
fi

step "code graph (local, offline)"
if have graphify && [[ -f "$root/.graphifyignore" ]]; then
  run bash -c "cd '$root' && graphify update ."
fi

step "done"
exit 0
