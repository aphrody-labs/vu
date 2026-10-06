<!-- SPDX-License-Identifier: Apache-2.0 -->
# vu

The Aphrody Python runtime: pinned `uv` and `ruff`, plus an embedded CPython driven through PyO3, in one directory that
Aphrody consumes as a precompiled runtime (the way it consumes Bun through Yolo). `vu` is the literal inverse of `uv`.

```text
vu uv ...        the pinned uv, unmodified
vu ruff ...      the pinned ruff, unmodified
vu python ...    the embedded CPython command line (shared libpython of the runtime, PyO3)
vu --version [--json]
```

Private repository. Architecture, decisions and the verification journal live in the Aphrody monorepo
(`docs/plans/vu/PLAN.md`); this repository only holds what builds the runtime.

## Layout

| Path | Content |
| --- | --- |
| `vu.json`, `vendor.json` | The runtime name (one place) and the pins: forks of uv, ruff and PyO3 at exact commits (branches `vu-pin-<version>`), python-build-standalone assets by sha256. Mirrored byte for byte in the Aphrody monorepo. |
| `crates/vu` | The launcher: `uv` and `ruff` are executed from the runtime's `bin/` (tier T0), `python` runs `Py_BytesMain`. |
| `crates/vu-runtime` | The CPython embedding (PyO3 0.29.3, `auto-initialize`) and the pure launcher helpers. |
| `scripts/` | Bun: fetch the pins and CPython, assemble the artifact, audit glibc needs, smoke and parity checks, the forge that drives the build host and writes receipts, the installer. |
| `receipts/` | One JSON receipt per build (`aphrody.vu-forge/1`) and per applied install (`aphrody.vu-install/1`). |
| `vendor/`, `build/` | Fetched and generated, git-ignored. |

## Build (never in WSL)

```sh
bun scripts/forge.ts            # tunnel, sync, fetch, build uv, ruff and vu, test, clippy, assemble, smoke, receipt
bun scripts/forge.ts --steps assemble,smoke
bun test scripts                # script tests, no Cargo
```

Cargo runs on the build host through `vps-cargo --repo vu` of the Aphrody checkout (`APHRODY_ROOT`, default `~/aphrody`):
the worktree is snapshotted and pushed over the SSH master, built under the factory locks, and the artifact is assembled
and smoke-tested there. A build never installs or activates anything.

## Artifact

`<version>-<revision8>/`: the CPython install tree as prefix, plus `bin/vu`, `bin/uv`, `bin/ruff`, the licences of the
parts under `share/vu/licenses/` and `share/vu/manifest.json` (schema 1, name `vu-runtime`: every file with sha256, size
and mode, the symlinks, the target, the toolchain, the revisions and the pins). A consumer verifies the manifest before
using anything.

## Install and activate (never implied by a build)

```sh
bun scripts/install.ts                      # plan: names the newest receipt's artifact, changes nothing
bun scripts/install.ts --apply              # archive on the build host, download (aphrody infra ssh sftp), sha256,
                                            # verify every file against the manifest, install, flip `current`, receipt
bun scripts/install.ts --from <dir> --apply # install an artifact directory already on this host
bun scripts/install.ts --rollback --apply   # `current` back to `previous`
```

The artifact lands in `$VU_HOME` (default `~/.vu`) at `runtime/<target>/<version>-<revision8>/`, `current` is the active
link and `previous` the one a rollback returns to. `yolo py status` (Aphrody) resolves and verifies it. Each applied
install writes `receipts/install-<time>.json` (schema `aphrody.vu-install/1`). The glibc ceiling of the artifact is 2.39.
Nothing is published: the repository is private and no public channel is authorised for the runtime.

## AI stack, Hugging Face, shared libpython (source and test state; see the plan, section 14)

```sh
bun scripts/hardware.ts                       # detect CUDA / ROCm / CPU (VU_ACCELERATOR overrides) and print the uv arguments
bun scripts/huggingface.ts status             # HF_HOME, hub cache, endpoint, token presence (never the token)
bun scripts/huggingface.ts download org/name config.json   # hub-compatible cache layout
bun scripts/shared-libpython.ts <artifact> [--site <site-packages with the aphrody wheel>]   # Bun -> libpython -> Rust
```

Nothing here is a GPU validation: wheel resolution is checked with `uv pip install --dry-run --torch-backend cu128`; a run
on real hardware needs its own measurement.

## Licence

Apache-2.0 (`LICENSE`). Third-party components and their licences: `NOTICE`.
