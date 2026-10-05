#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
//! Assembles a runtime artifact from the pinned CPython prefix (build/python) and the release binaries.
//!
//!   bun scripts/assemble.ts --target-dir <cargo target dir> --out <artifact store> [--revision <sha>] [--toolchain <text>]
//!
//! The artifact directory is `<out>/<version>-<revision8>`: the CPython install tree as prefix, plus bin/vu, bin/uv,
//! bin/ruff, the licences of the parts, and share/vu/manifest.json. It is written as `.partial` and renamed when
//! complete; it is never installed or activated by this script.

import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { minorOf, readVendor, ROOT, run, workspaceVersion } from "./lib.ts";
import { buildManifest, MANIFEST_PATH, type Manifest } from "./manifest.ts";

export interface AssembleOptions {
  root: string;
  targetDir: string;
  out: string;
  revision: string;
  toolchain: string;
}

/** Licence files copied from the fork checkouts and the repository into share/vu/licenses. */
const LICENSES: Record<string, string[]> = {
  uv: ["vendor/uv/LICENSE-APACHE", "vendor/uv/LICENSE-MIT"],
  ruff: ["vendor/ruff/LICENSE"],
  pyo3: ["vendor/pyo3/LICENSE-APACHE", "vendor/pyo3/LICENSE-MIT"],
  vu: ["LICENSE"],
};

export async function assemble(
  options: AssembleOptions,
): Promise<{ artifact: string; manifest: Manifest }> {
  const { root, targetDir, out, revision, toolchain } = options;
  const vendor = await readVendor(root);
  const version = await workspaceVersion(root);
  const release = vendor.releases.find((entry) => entry.name === "python-build-standalone");
  if (!release) throw new Error("vendor.json has no python-build-standalone release");
  const python = release.defaultPython;
  const minor = minorOf(python);
  const prefix = join(root, "build", "python");
  if (!existsSync(join(prefix, "lib", `libpython${minor}.so.1.0`))) {
    throw new Error("build/python is missing: run `bun scripts/fetch.ts` first");
  }
  const name = `${version}-${revision.slice(0, 8)}`;
  const final = join(out, name);
  const staging = `${final}.partial`;
  rmSync(staging, { recursive: true, force: true });
  rmSync(final, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(prefix, staging, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  for (const binary of ["vu", "uv", "ruff"]) {
    const source = join(targetDir, "release", binary);
    if (!existsSync(source)) throw new Error(`missing release binary: ${source}`);
    copyFileSync(source, join(staging, "bin", binary));
    chmodSync(join(staging, "bin", binary), 0o755);
  }
  for (const [part, files] of Object.entries(LICENSES)) {
    const destination = join(staging, "share", "vu", "licenses", part);
    mkdirSync(destination, { recursive: true });
    for (const file of files) {
      const source = join(root, file);
      if (existsSync(source))
        copyFileSync(source, join(destination, file.split("/").at(-1) as string));
    }
  }
  const pins: Record<string, unknown> = Object.fromEntries(
    vendor.sources.map((source) => [
      source.name,
      { upstreamTag: source.upstreamTag, ref: source.ref, forkBranch: source.forkBranch },
    ]),
  );
  pins["python"] = {
    version: python,
    release: release.tag,
    sha256: release.assets.find(
      (asset) => asset.python === python && asset.name.endsWith("install_only_stripped.tar.gz"),
    )?.sha256,
  };
  const target =
    (await run(["rustc", "-vV"])).stdout.match(/^host:\s*(\S+)/m)?.[1] ??
    "x86_64-unknown-linux-gnu";
  const manifest = await buildManifest(staging, {
    schema: 1,
    name: "vu-runtime",
    version,
    target,
    toolchain,
    revision,
    pins,
    compatibility: { cliMajor: Number(version.split(".")[0]) },
    capabilities: ["uv", "ruff", "python"],
  });
  mkdirSync(join(staging, "share", "vu"), { recursive: true });
  await Bun.write(join(staging, MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(staging, final);
  return { artifact: final, manifest };
}

function parse(argv: string[]): AssembleOptions {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const targetDir = value("--target-dir");
  const out = value("--out");
  if (!targetDir || !out)
    throw new Error(
      "usage: assemble.ts --target-dir <dir> --out <dir> [--revision <sha>] [--toolchain <text>]",
    );
  return {
    root: resolve(value("--root") ?? ROOT),
    targetDir: resolve(targetDir),
    out: resolve(out),
    revision: value("--revision") ?? "unknown",
    toolchain: value("--toolchain") ?? "unknown",
  };
}

if (import.meta.main) {
  try {
    const options = parse(process.argv.slice(2));
    if (options.revision === "unknown") {
      options.revision = (
        await run(["git", "rev-parse", "HEAD"], { cwd: options.root })
      ).stdout.trim();
    }
    if (options.toolchain === "unknown") {
      options.toolchain = (await run(["rustc", "--version"])).stdout.trim();
    }
    const { artifact, manifest } = await assemble(options);
    console.log(
      JSON.stringify({
        artifact,
        files: Object.keys(manifest.files).length,
        links: Object.keys(manifest.links).length,
      }),
    );
  } catch (error) {
    console.error(`assemble: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
