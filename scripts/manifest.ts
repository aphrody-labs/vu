// SPDX-License-Identifier: Apache-2.0
//! The manifest of a vu runtime artifact (schema 1, name `vu-runtime`), in the manner of the Yolo runtime SDK:
//! every file with its sha256 and size, the symlinks, the target, the toolchain, the revisions and the pins. A
//! consumer verifies it before using anything from the directory.

import { lstatSync, readdirSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { mapLimit, sha256File } from "./lib.ts";

export const MANIFEST_PATH = "share/vu/manifest.json";

export interface FileEntry {
  sha256: string;
  bytes: number;
  mode: number;
}

export interface Manifest {
  schema: 1;
  name: "vu-runtime";
  version: string;
  target: string;
  toolchain: string;
  revision: string;
  pins: Record<string, unknown>;
  compatibility: { cliMajor: number };
  capabilities: string[];
  files: Record<string, FileEntry>;
  links: Record<string, string>;
}

export type ManifestMeta = Omit<Manifest, "files" | "links">;

function walk(directory: string, prefix: string, out: { files: string[]; links: string[] }): void {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) out.links.push(relative(prefix, path));
    else if (entry.isDirectory()) walk(path, prefix, out);
    else if (entry.isFile()) out.files.push(relative(prefix, path));
  }
}

/** Hashes every file of a prefix (the manifest itself excluded) and records its symlinks. */
export async function buildManifest(prefix: string, meta: ManifestMeta): Promise<Manifest> {
  const listing = { files: [] as string[], links: [] as string[] };
  walk(prefix, prefix, listing);
  const files: Record<string, FileEntry> = {};
  const entries = await mapLimit(
    listing.files.filter((path) => path !== MANIFEST_PATH),
    32,
    async (path) => {
      const stat = lstatSync(join(prefix, path));
      return [
        path,
        {
          sha256: await sha256File(join(prefix, path)),
          bytes: stat.size,
          mode: stat.mode & 0o777,
        },
      ] as const;
    },
  );
  for (const [path, entry] of entries.sort((a, b) => a[0].localeCompare(b[0]))) files[path] = entry;
  const links: Record<string, string> = {};
  for (const path of listing.links) links[path] = readlinkSync(join(prefix, path));
  return { ...meta, files, links };
}

/** Every difference between a prefix and its manifest; empty when the artifact is intact. */
export async function verifyManifest(prefix: string, manifest?: Manifest): Promise<string[]> {
  const problems: string[] = [];
  const declared = manifest ?? ((await Bun.file(join(prefix, MANIFEST_PATH)).json()) as Manifest);
  if (declared.schema !== 1 || declared.name !== "vu-runtime")
    return ["unsupported manifest schema or name"];
  const listing = { files: [] as string[], links: [] as string[] };
  walk(prefix, prefix, listing);
  const present = new Set(listing.files.filter((path) => path !== MANIFEST_PATH));
  for (const [path, entry] of Object.entries(declared.files)) {
    if (!present.has(path)) {
      problems.push(`missing: ${path}`);
      continue;
    }
    const stat = lstatSync(join(prefix, path));
    if (stat.size !== entry.bytes) problems.push(`size: ${path}`);
    else if ((await sha256File(join(prefix, path))) !== entry.sha256)
      problems.push(`sha256: ${path}`);
  }
  for (const path of present) if (!(path in declared.files)) problems.push(`unlisted: ${path}`);
  for (const [path, target] of Object.entries(declared.links)) {
    try {
      if (readlinkSync(join(prefix, path)) !== target) problems.push(`link target: ${path}`);
    } catch {
      problems.push(`missing link: ${path}`);
    }
  }
  return problems;
}
