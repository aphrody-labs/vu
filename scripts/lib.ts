// SPDX-License-Identifier: Apache-2.0
//! Shared helpers of the vu build scripts (Bun only).

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "..");

export interface Source {
  name: string;
  path: string;
  url: string;
  upstream: string;
  upstreamTag: string;
  ref: string;
  forkBranch: string;
}

export interface Asset {
  python: string;
  role: string;
  name: string;
  sha256: string;
  size: number;
}

export interface Release {
  name: string;
  tag: string;
  commit: string;
  python: string[];
  defaultPython: string;
  assets: Asset[];
}

export interface Vendor {
  sources: Source[];
  releases: Release[];
}

export interface Identity {
  name: string;
  derived: Record<string, string>;
}

export async function readVendor(root = ROOT): Promise<Vendor> {
  return (await Bun.file(join(root, "vendor.json")).json()) as Vendor;
}

export async function readIdentity(root = ROOT): Promise<Identity> {
  return (await Bun.file(join(root, "vu.json")).json()) as Identity;
}

/** The version of the vu workspace (`[workspace.package] version` of the root manifest). */
export async function workspaceVersion(root = ROOT): Promise<string> {
  const manifest = await Bun.file(join(root, "Cargo.toml")).text();
  const match = manifest.match(/^\[workspace\.package\][\s\S]*?^version\s*=\s*"([^"]+)"/m);
  if (!match?.[1]) throw new Error("Cargo.toml has no [workspace.package] version");
  return match[1];
}

/** Download cache of the pinned CPython archives (`VU_CACHE`, default `~/.cache/vu`). */
export function cacheDir(): string {
  return process.env["VU_CACHE"] ?? join(homedir(), ".cache", "vu");
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolvePromise(hash.digest("hex")));
  });
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
}

/** Runs a command to completion and captures its output; never throws on a non-zero exit. */
export async function run(
  command: string[],
  options: { cwd?: string; env?: Record<string, string | undefined>; stdin?: string } = {},
): Promise<RunResult> {
  const started = performance.now();
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr, ms: Math.round(performance.now() - started) };
}

/** Maps with at most `limit` calls in flight (thousands of files must not open thousands of descriptors). */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** `3.12.15` to `3.12`. */
export function minorOf(version: string): string {
  const parts = version.split(".");
  if (parts.length < 3 || parts.some((part) => !/^\d+/.test(part))) {
    throw new Error(`not a CPython version: ${version}`);
  }
  return `${parts[0]}.${parts[1]}`;
}
