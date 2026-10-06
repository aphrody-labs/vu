#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SSH from a Claude Code cloud session to the owner hosts: writes ~/.ssh/config aliases `vps`, `dbfr` and `wsl`
# from the cloud environment, never from the repository. Idempotent, tolerant (exit code 0).
#   APHRODY_SSH_KEY_B64   base64 of the private key (cloud secret; SHENRON_SSH_KEY_B64 accepted)
#   APHRODY_VPS_HOST      first VPS address     APHRODY_DBFR_HOST  second VPS address
#   APHRODY_WSL_HOST      optional WSL address reachable from the cloud (reverse tunnel or private network)
#   APHRODY_WSL_PORT      optional WSL port (default 22)   APHRODY_WSL_USER  optional WSL login (default aphro)
#   APHRODY_SSH_USER      VPS login (default ubuntu)
#   --force               run outside a cloud session
set -u
[[ "${CLAUDE_CODE_REMOTE:-}" == "true" || "${1:-}" == "--force" ]] || exit 0
# GitHub: git identity, HTTPS through the gh credential helper (the owner SSH alias github-dev does not exist here).
git config --global user.name "aphrody-dev"
git config --global user.email "contact@aphrody.com"
git config --global url."https://github.com/".insteadOf "git@github-dev:"
if [[ -n "${GH_TOKEN:-}" ]] && command -v gh >/dev/null 2>&1; then
  git config --global credential.https://github.com.helper '!gh auth git-credential'
  gh auth status >/dev/null 2>&1 && echo "cloud-ssh: gh authenticated" || echo "cloud-ssh: gh token rejected"
fi
key_b64="${APHRODY_SSH_KEY_B64:-${SHENRON_SSH_KEY_B64:-}}"
vps="${APHRODY_VPS_HOST:-${SHENRON_VPS_HOST:-}}"
dbfr="${APHRODY_DBFR_HOST:-${SHENRON_DBFR_HOST:-}}"
if [[ -z "$key_b64" || ( -z "$vps" && -z "$dbfr" ) ]]; then
  echo "cloud-ssh: APHRODY_SSH_KEY_B64 and APHRODY_VPS_HOST/APHRODY_DBFR_HOST absent, SSH aliases not written"
  exit 0
fi
umask 077
mkdir -p "$HOME/.ssh"
key="$HOME/.ssh/aphrody_hosts"
printf '%s' "$key_b64" | base64 -d >"$key" 2>/dev/null && chmod 600 "$key" || {
  echo "cloud-ssh: APHRODY_SSH_KEY_B64 is not valid base64"
  exit 0
}
user="${APHRODY_SSH_USER:-${SHENRON_SSH_USER:-ubuntu}}"
config="$HOME/.ssh/config"
touch "$config"
host_block() { # alias address user port
  printf 'Host %s\n    HostName %s\n    User %s\n    Port %s\n    IdentityFile %s\n    IdentitiesOnly yes\n' "$1" "$2" "$3" "$4" "$key"
  printf '    StrictHostKeyChecking accept-new\n    ServerAliveInterval 30\n    ConnectTimeout 10\n    ControlMaster auto\n'
  printf '    ControlPath ~/.ssh/cm/%%C\n    ControlPersist 8h\n'
}
mkdir -p "$HOME/.ssh/cm"
if ! grep -q '# aphrody-hosts' "$config" 2>/dev/null; then
  {
    echo "# aphrody-hosts"
    [[ -z "$vps" ]] || host_block vps "$vps" "$user" 22
    [[ -z "$dbfr" ]] || host_block dbfr "$dbfr" "$user" 22
    [[ -z "${APHRODY_WSL_HOST:-}" ]] || host_block wsl "$APHRODY_WSL_HOST" "${APHRODY_WSL_USER:-aphro}" "${APHRODY_WSL_PORT:-22}"
  } >>"$config"
fi
chmod 600 "$config"
for h in vps dbfr wsl; do
  grep -q "^Host $h\$" "$config" || continue
  ssh -o BatchMode=yes -o ConnectTimeout=8 "$h" true 2>/dev/null && echo "cloud-ssh: $h reachable" || echo "cloud-ssh: $h unreachable (network or key)"
done
exit 0
