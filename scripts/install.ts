#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
//! Installs and activates a built artifact under `$VU_HOME` (default `~/.vu`). Plan by default; nothing changes without
//! `--apply` (a source change or a build never implies installation: plan, section 7, P5).
//!
//!   bun scripts/install.ts [--from <artifact dir> | --host vps [--artifact <dir on the host>]] [--home <dir>] [--apply]
//!   bun scripts/install.ts --rollback [--home <dir>] [--apply]
//!
//! Layout (the one `yolo py` resolves): `<home>/runtime/<target>/<version>-<rev8>/` is the artifact, `current` the
//! active link, `previous` the link `--rollback` returns to. The artifact is staged beside its destination, verified
//! against its manifest (every file), then moved into place; the `current` link is flipped atomically. A remote
//! artifact is archived on the build host (tar, zstd), downloaded with `aphrody infra ssh sftp` and compared with the
//! host's own sha256 before it is unpacked.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { run, sha256File, ROOT } from "./lib.ts";
import { MANIFEST_PATH, verifyManifest, type Manifest } from "./manifest.ts";

export const ARTIFACTS = "/srv/aphrody-build/artifacts/vu";
/** Where the archive is staged on the build host (the artifact volume can be full; the home volume is not). */
export const REMOTE_CACHE = "/home/ubuntu/.cache/vu-install";

export function vuHome(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env["VU_HOME"];
  return fromEnv !== undefined && fromEnv !== "" ? resolve(fromEnv) : join(homedir(), ".vu");
}

export interface InstallPlan {
  readonly source: string;
  readonly name: string;
  readonly target: string;
  readonly destination: string;
  readonly link: string;
  readonly previous: string | null;
}

export async function readArtifactManifest(dir: string): Promise<Manifest> {
  const path = join(dir, MANIFEST_PATH);
  if (!existsSync(path)) throw new Error(`no ${MANIFEST_PATH} in ${dir}`);
  return (await Bun.file(path).json()) as Manifest;
}

/** Where an artifact would be installed and what it would replace; reads, never writes. */
export async function planInstall(source: string, home: string): Promise<InstallPlan> {
  const manifest = await readArtifactManifest(source);
  const name = `${manifest.version}-${manifest.revision.slice(0, 8)}`;
  const runtime = join(home, "runtime", manifest.target);
  const link = join(runtime, "current");
  let previous: string | null = null;
  try {
    previous = readlinkSync(link);
  } catch {
    previous = null;
  }
  // Re-installing the active artifact replaces nothing: there is no previous one to keep.
  if (previous === name) previous = null;
  return {
    source,
    name,
    target: manifest.target,
    destination: join(runtime, name),
    link,
    previous,
  };
}

/** Atomically points `link` at `target` (relative), through a temporary link and a rename. */
export function flipLink(link: string, target: string): void {
  const temporary = `${link}.tmp-${process.pid}`;
  rmSync(temporary, { force: true });
  symlinkSync(target, temporary);
  renameSync(temporary, link);
}

export interface InstallReceipt {
  readonly installed: string;
  readonly files: number;
  readonly previous: string | null;
  readonly activated: boolean;
}

/**
 * Stages a copy of the artifact, verifies every file against the manifest, moves it into place and activates it.
 * A damaged copy is removed and never activated.
 */
export async function installArtifact(plan: InstallPlan, activate = true): Promise<InstallReceipt> {
  const runtime = join(plan.destination, "..");
  mkdirSync(runtime, { recursive: true });
  const staging = join(runtime, `.staging-${plan.name}-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  try {
    if (!existsSync(plan.destination)) {
      const copy = await run(["cp", "-a", plan.source, staging]);
      if (copy.code !== 0) throw new Error(`copy failed: ${copy.stderr.trim()}`);
      const problems = await verifyManifest(staging);
      if (problems.length > 0)
        throw new Error(`artifact failed verification: ${problems.slice(0, 5).join("; ")}`);
      renameSync(staging, plan.destination);
    } else {
      const problems = await verifyManifest(plan.destination);
      if (problems.length > 0)
        throw new Error(
          `installed artifact failed verification: ${problems.slice(0, 5).join("; ")}`,
        );
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  const manifest = await readArtifactManifest(plan.destination);
  if (activate) {
    if (plan.previous !== null && plan.previous !== plan.name)
      flipLink(join(runtime, "previous"), plan.previous);
    flipLink(plan.link, plan.name);
  }
  return {
    installed: plan.destination,
    files: Object.keys(manifest.files).length,
    previous: plan.previous,
    activated: activate,
  };
}

/** Returns `current` to the artifact `previous` names (the one replaced by the last activation). */
export function rollback(home: string, target: string): { from: string; to: string } {
  const runtime = join(home, "runtime", target);
  const current = readlinkSync(join(runtime, "current"));
  const previous = readlinkSync(join(runtime, "previous"));
  if (!existsSync(join(runtime, previous)))
    throw new Error(`previous artifact ${previous} is gone`);
  flipLink(join(runtime, "previous"), current);
  flipLink(join(runtime, "current"), previous);
  return { from: current, to: previous };
}

/** Archives the artifact on the build host, downloads it, checks the sha256 and unpacks it into a scratch directory. */
export async function fetchFromHost(
  host: string,
  remoteDir: string,
  scratch: string,
  remoteCache = REMOTE_CACHE,
): Promise<{ dir: string; sha256: string }> {
  const name = basename(remoteDir);
  const remoteArchive = `${remoteCache}/${name}.tar.zst`;
  process.env["APHRODY_SSH_COMMAND_TIMEOUT_SECS"] ??= "1800";
  const archive = await run([
    "aphrody",
    "infra",
    "ssh",
    "exec",
    "--host",
    host,
    "-c",
    `mkdir -p ${remoteCache} && tar -C ${dirname(remoteDir)} --zstd -cf ${remoteArchive} ${name} && sha256sum ${remoteArchive}`,
  ]);
  const expected = archive.stdout.trim().split(/\s+/)[0] ?? "";
  if (archive.code !== 0 || !/^[0-9a-f]{64}$/.test(expected))
    throw new Error(
      `archiving on ${host} failed: ${archive.stderr.trim() || archive.stdout.trim()}`,
    );
  const local = join(scratch, `${name}.tar.zst`);
  const download = await run([
    "aphrody",
    "infra",
    "ssh",
    "sftp",
    "--host",
    host,
    "--path",
    remoteArchive,
    "--get",
    local,
  ]);
  if (download.code !== 0 || !existsSync(local))
    throw new Error(`download failed: ${download.stderr.trim() || download.stdout.trim()}`);
  await run(["aphrody", "infra", "ssh", "exec", "--host", host, "-c", `rm -f ${remoteArchive}`]);
  const actual = await sha256File(local);
  if (actual !== expected) throw new Error(`sha256 mismatch: host ${expected}, local ${actual}`);
  const extract = await run(["tar", "-C", scratch, "--zstd", "-xf", local]);
  if (extract.code !== 0) throw new Error(`unpack failed: ${extract.stderr.trim()}`);
  return { dir: join(scratch, name), sha256: actual };
}

function flag(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

/** The artifact named by the newest successful receipt (by `startedAt`), a path on the build host. */
export async function latestReceiptArtifact(root = ROOT): Promise<string> {
  const dir = join(root, "receipts");
  const receipts: { startedAt: string; artifact: string }[] = [];
  for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".json"))) {
    const receipt = (await Bun.file(join(dir, file)).json()) as {
      ok?: boolean;
      startedAt?: string;
      artifact?: { artifact?: string };
    };
    if (receipt.ok === true && receipt.startedAt && receipt.artifact?.artifact !== undefined)
      receipts.push({ startedAt: receipt.startedAt, artifact: receipt.artifact.artifact });
  }
  const newest = receipts.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (newest === undefined) throw new Error("no successful receipt names an artifact");
  return newest.artifact;
}

export async function main(args: string[]): Promise<number> {
  const home = flag(args, "--home") ?? vuHome();
  const apply = args.includes("--apply");
  if (args.includes("--rollback")) {
    const target = flag(args, "--target") ?? "x86_64-unknown-linux-gnu";
    if (!apply) {
      console.log(
        `plan: roll back ${join(home, "runtime", target, "current")} to its previous artifact (add --apply)`,
      );
      return 0;
    }
    console.log(JSON.stringify(rollback(home, target)));
    return 0;
  }
  const from = flag(args, "--from");
  const host = flag(args, "--host") ?? "vps";
  const scratch = join(tmpdir(), `vu-install-${process.pid}`);
  try {
    let source = from;
    let archiveSha256: string | null = null;
    let remote: string | null = null;
    if (source === undefined) {
      remote = flag(args, "--artifact") ?? (await latestReceiptArtifact());
      console.log(`artifact: ${host}:${remote}`);
      if (!apply) {
        console.log(
          `plan: archive, download and verify it, install under ${home}/runtime, activate (add --apply)`,
        );
        return 0;
      }
      mkdirSync(scratch, { recursive: true });
      const fetched = await fetchFromHost(host, remote, scratch);
      source = fetched.dir;
      archiveSha256 = fetched.sha256;
    }
    const plan = await planInstall(resolve(source), home);
    console.log(JSON.stringify({ ...plan, apply }, null, 2));
    if (!apply) {
      console.log("plan only: nothing changed (add --apply to install and activate)");
      return 0;
    }
    const receipt = await installArtifact(plan);
    console.log(JSON.stringify(receipt, null, 2));
    const version = await run([join(plan.destination, "bin/vu"), "--version", "--json"]);
    const manifest = await readArtifactManifest(plan.destination);
    const startedAt = new Date().toISOString();
    const file = join(ROOT, "receipts", `install-${startedAt.replaceAll(/[:.]/g, "-")}.json`);
    await Bun.write(
      file,
      `${JSON.stringify(
        {
          schema: "aphrody.vu-install/1",
          at: startedAt,
          source:
            remote === null ? { directory: source } : { host, artifact: remote, archiveSha256 },
          home,
          ...receipt,
          revision: manifest.revision,
          verification: "manifest: every file, link, target and CLI major",
          version: version.code === 0 ? JSON.parse(version.stdout) : null,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`receipt ${file}`);
    return 0;
  } catch (error) {
    console.error(`install: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    if (from === undefined && existsSync(scratch))
      rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
