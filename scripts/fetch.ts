#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
//! Fetches the pinned inputs of the runtime build.
//!
//!   bun scripts/fetch.ts [--root <dir>] [--cache <dir>] [--python <x.y.z>] [--skip-sources] [--skip-python]
//!
//! * sources: each fork of vendor.json is cloned shallow at its pin branch under vendor/ and must be at the pinned
//!   commit; an existing checkout at another commit is an error, never silently moved;
//! * CPython: the install tree of python-build-standalone for the default (or requested) version is downloaded
//!   into the cache, verified against its sha256, extracted into build/python and described to PyO3 in
//!   build/pyo3-config.txt (read through .cargo/config.toml).

import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type Asset,
  cacheDir,
  minorOf,
  readVendor,
  ROOT,
  run,
  sha256Bytes,
  type Source,
  type Vendor,
} from "./lib.ts";

export interface FetchOptions {
  root: string;
  cache: string;
  python?: string;
  skipSources: boolean;
  skipPython: boolean;
}

export function parseArgs(argv: string[]): FetchOptions {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    root: resolve(value("--root") ?? ROOT),
    cache: resolve(value("--cache") ?? cacheDir()),
    python: value("--python"),
    skipSources: argv.includes("--skip-sources"),
    skipPython: argv.includes("--skip-python"),
  };
}

/** The runtime-tree asset of one CPython version. */
export function runtimeAsset(vendor: Vendor, version: string): { asset: Asset; tag: string } {
  const release = vendor.releases.find((entry) => entry.name === "python-build-standalone");
  if (!release) throw new Error("vendor.json has no python-build-standalone release");
  const asset = release.assets.find(
    (entry) => entry.python === version && entry.name.endsWith("install_only_stripped.tar.gz"),
  );
  if (!asset)
    throw new Error(`vendor.json has no install_only_stripped asset for CPython ${version}`);
  return { asset, tag: release.tag };
}

/** The PyO3 configuration of a prefix: shared libpython, no abi3 (the interpreter is embedded, not extended). */
export function pyo3Config(prefix: string, version: string): string {
  const minor = minorOf(version);
  return [
    "implementation=CPython",
    `version=${minor}`,
    "shared=true",
    `lib_name=python${minor}`,
    `lib_dir=${join(prefix, "lib")}`,
    `executable=${join(prefix, "bin", `python${minor}`)}`,
    "pointer_width=64",
    "suppress_build_script_link_lines=false",
    "",
  ].join("\n");
}

async function git(args: string[], cwd?: string): Promise<string> {
  const result = await run(["git", ...args], { cwd });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** Clones one fork at its pin branch and checks the pinned commit. */
export async function fetchSource(root: string, source: Source): Promise<string> {
  const destination = join(root, source.path);
  if (!existsSync(join(destination, ".git"))) {
    mkdirSync(join(destination, ".."), { recursive: true });
    await git([
      "clone",
      "--quiet",
      "--depth",
      "1",
      "--branch",
      source.forkBranch,
      source.url,
      destination,
    ]);
  }
  const head = await git(["rev-parse", "HEAD"], destination);
  if (head !== source.ref) {
    throw new Error(
      `${source.name}: checkout is at ${head}, the pin is ${source.ref}; remove ${source.path} to refetch`,
    );
  }
  return head;
}

/** Downloads (or reuses) the archive of an asset and verifies its sha256 and size. */
export async function downloadAsset(cache: string, tag: string, asset: Asset): Promise<Uint8Array> {
  mkdirSync(join(cache, "pbs"), { recursive: true });
  const file = join(cache, "pbs", asset.name);
  if (existsSync(file)) {
    const cached = new Uint8Array(await Bun.file(file).arrayBuffer());
    if (sha256Bytes(cached) === asset.sha256) return cached;
    rmSync(file);
  }
  const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${tag}/${encodeURIComponent(asset.name)}`;
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = sha256Bytes(bytes);
  if (digest !== asset.sha256 || bytes.length !== asset.size) {
    throw new Error(
      `${asset.name}: sha256 ${digest} (${bytes.length} bytes) differs from the pin ${asset.sha256} (${asset.size})`,
    );
  }
  await Bun.write(`${file}.partial`, bytes);
  renameSync(`${file}.partial`, file);
  return bytes;
}

/** Extracts the verified archive to build/python and writes the PyO3 configuration. */
export async function installPython(
  root: string,
  bytes: Uint8Array,
  version: string,
): Promise<string> {
  const minor = minorOf(version);
  const staging = join(root, "build", ".python-extract");
  const prefix = join(root, "build", "python");
  rmSync(staging, { recursive: true, force: true });
  rmSync(prefix, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  await new Bun.Archive(Bun.gunzipSync(bytes)).extract(staging);
  renameSync(join(staging, "python"), prefix);
  rmSync(staging, { recursive: true, force: true });
  for (const required of [`lib/libpython${minor}.so.1.0`, "bin/python3", `bin/python${minor}`]) {
    if (!existsSync(join(prefix, required)))
      throw new Error(`the CPython distribution has no ${required}`);
  }
  await Bun.write(join(root, "build", "pyo3-config.txt"), pyo3Config(prefix, version));
  return prefix;
}

export async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  const vendor = await readVendor(options.root);
  if (!options.skipSources) {
    for (const source of vendor.sources) {
      const head = await fetchSource(options.root, source);
      console.log(`source ${source.name} ${head} (${source.forkBranch})`);
    }
  }
  if (!options.skipPython) {
    const release = vendor.releases.find((entry) => entry.name === "python-build-standalone");
    const version = options.python ?? release?.defaultPython;
    if (!version) throw new Error("no CPython version to fetch");
    const { asset, tag } = runtimeAsset(vendor, version);
    const bytes = await downloadAsset(options.cache, tag, asset);
    const prefix = await installPython(options.root, bytes, version);
    console.log(`python ${version} ${asset.sha256} -> ${prefix}`);
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`fetch: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
