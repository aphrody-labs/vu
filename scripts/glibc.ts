#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
//! The glibc symbol versions an ELF64 file needs (`.gnu.version_r`), for the build receipts.
//!
//!   bun scripts/glibc.ts <elf-file>...
//!
//! No tool of the toolbox exposes version needs (`aphrody re triage` lists sections and imports only), so this reads
//! the section headers directly. Little-endian ELF64 only (x86_64 and aarch64 Linux).

const SHT_GNU_VERNEED = 0x6ffffffe;

export interface GlibcAudit {
  file: string;
  /** Library soname to the version names it requires, for example `libc.so.6: [GLIBC_2.17, GLIBC_2.39]`. */
  needs: Record<string, string[]>;
  /** The highest `GLIBC_x.y` needed (`GLIBC_PRIVATE` excluded), or null when the file needs none. */
  glibcMax: string | null;
}

/** Numeric comparison of dotted versions: `2.9` is lower than `2.10`. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

function cString(bytes: Uint8Array, offset: number): string {
  let end = offset;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return new TextDecoder().decode(bytes.subarray(offset, end));
}

/** Parses the version needs of an ELF64 little-endian image. */
export function glibcNeeds(bytes: Uint8Array, file = ""): GlibcAudit {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 64 || view.getUint32(0, false) !== 0x7f454c46)
    throw new Error(`${file}: not an ELF file`);
  if (bytes[4] !== 2 || bytes[5] !== 1)
    throw new Error(`${file}: only little-endian ELF64 is supported`);
  const sectionTable = Number(view.getBigUint64(0x28, true));
  const entrySize = view.getUint16(0x3a, true);
  const count = view.getUint16(0x3c, true);
  const needs: Record<string, string[]> = {};
  for (let index = 0; index < count; index++) {
    const header = sectionTable + index * entrySize;
    if (view.getUint32(header + 4, true) !== SHT_GNU_VERNEED) continue;
    const offset = Number(view.getBigUint64(header + 0x18, true));
    const link = view.getUint32(header + 0x28, true);
    const info = view.getUint32(header + 0x2c, true);
    const strings = sectionTable + link * entrySize;
    const stringOffset = Number(view.getBigUint64(strings + 0x18, true));
    let entry = offset;
    for (let need = 0; need < info; need++) {
      const auxCount = view.getUint16(entry + 2, true);
      const library = cString(bytes, stringOffset + view.getUint32(entry + 4, true));
      let aux = entry + view.getUint32(entry + 8, true);
      const versions = needs[library] ?? (needs[library] = []);
      for (let item = 0; item < auxCount; item++) {
        versions.push(cString(bytes, stringOffset + view.getUint32(aux + 8, true)));
        aux += view.getUint32(aux + 12, true);
      }
      entry += view.getUint32(entry + 12, true);
    }
  }
  let glibcMax: string | null = null;
  for (const versions of Object.values(needs)) {
    for (const name of versions) {
      const version = name.match(/^GLIBC_(\d+(?:\.\d+)*)$/)?.[1];
      if (version && (glibcMax === null || compareVersions(version, glibcMax) > 0))
        glibcMax = version;
    }
  }
  return { file, needs, glibcMax };
}

export async function auditFile(path: string): Promise<GlibcAudit> {
  return glibcNeeds(new Uint8Array(await Bun.file(path).arrayBuffer()), path);
}

if (import.meta.main) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: bun scripts/glibc.ts <elf-file>...");
    process.exit(64);
  }
  console.log(JSON.stringify(await Promise.all(files.map(auditFile)), null, 2));
}
