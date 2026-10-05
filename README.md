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
| `scripts/` | Bun: fetch the pins and CPython, assemble the artifact, audit glibc needs, smoke and parity checks, the forge that drives the build host and writes receipts. |
| `receipts/` | One JSON receipt per build (`aphrody.vu-forge/1`). |
| `vendor/`, `build/` | Fetched and generated, git-ignored. |

## Build (never in WSL)

```sh
bun scripts/forge.ts            # tunnel, sync, fetch, build uv, ruff and vu, test, clippy, assemble, smoke, receipt
bun scripts/forge.ts --steps assemble,smoke
bun test scripts                # script tests, no Cargo
```

Cargo runs on the build host through `vps-cargo --repo vu` of the Aphrody checkout (`APHRODY_ROOT`, default `~/aphrody`):
the worktree is snapshotted and pushed over the SSH master, built under the factory locks, and the artifact is assembled
and smoke-tested there. Nothing is installed or activated by this repository.

## Artifact

`<version>-<revision8>/`: the CPython install tree as prefix, plus `bin/vu`, `bin/uv`, `bin/ruff`, the licences of the
parts under `share/vu/licenses/` and `share/vu/manifest.json` (schema 1, name `vu-runtime`: every file with sha256, size
and mode, the symlinks, the target, the toolchain, the revisions and the pins). A consumer verifies the manifest before
using anything.

## Licence

Apache-2.0 (`LICENSE`). Third-party components and their licences: `NOTICE`.
