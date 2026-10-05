// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { auditFile, compareVersions, glibcNeeds } from "./glibc.ts";

describe("glibc audit", () => {
  test("versions compare numerically", () => {
    expect(compareVersions("2.9", "2.10")).toBe(-1);
    expect(compareVersions("2.39", "2.39")).toBe(0);
    expect(compareVersions("2.43", "2.39")).toBe(1);
    expect(compareVersions("2", "2.0")).toBe(0);
  });

  test("the version needs of a real dynamic executable are read", async () => {
    // The Bun running this test is a glibc executable: it needs libc.so.6 and at least one GLIBC_ version.
    const audit = await auditFile(process.execPath);
    const libc = audit.needs["libc.so.6"];
    if (libc === undefined) return; // a musl host has no glibc needs to read
    expect(libc.some((name) => /^GLIBC_\d+\.\d+/.test(name))).toBe(true);
    expect(audit.glibcMax).toMatch(/^2\.\d+$/);
  });

  test("anything but a little-endian ELF64 is refused", () => {
    expect(() => glibcNeeds(new Uint8Array(100), "zeros")).toThrow("not an ELF file");
    const header = new Uint8Array(64);
    header.set([0x7f, 0x45, 0x4c, 0x46, 1, 1]);
    expect(() => glibcNeeds(header, "elf32")).toThrow("only little-endian ELF64");
  });
});
