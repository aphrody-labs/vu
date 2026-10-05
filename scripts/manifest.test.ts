// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildManifest,
  isDerivedPath,
  MANIFEST_PATH,
  type ManifestMeta,
  verifyManifest,
} from "./manifest.ts";

const meta: ManifestMeta = {
  schema: 1,
  name: "vu-runtime",
  version: "0.1.0",
  target: "x86_64-unknown-linux-gnu",
  toolchain: "rustc 1.98.1",
  revision: "0".repeat(40),
  pins: {},
  compatibility: { cliMajor: 0 },
  capabilities: ["uv", "ruff", "python"],
};

const directories: string[] = [];
function prefix(): string {
  const dir = mkdtempSync(join(tmpdir(), "vu-manifest-"));
  directories.push(dir);
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(join(dir, "bin", "vu"), "#!vu\n");
  chmodSync(join(dir, "bin", "vu"), 0o755);
  writeFileSync(join(dir, "lib", "libpython3.12.so.1.0"), "lib");
  symlinkSync("libpython3.12.so.1.0", join(dir, "lib", "libpython3.12.so"));
  return dir;
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("manifest", () => {
  test("lists every file with sha256, size and mode, and the symlinks", async () => {
    const dir = prefix();
    const manifest = await buildManifest(dir, meta);
    expect(Object.keys(manifest.files)).toEqual(["bin/vu", "lib/libpython3.12.so.1.0"]);
    expect(manifest.files["bin/vu"]).toMatchObject({ bytes: 5, mode: 0o755 });
    expect(manifest.files["bin/vu"]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.links).toEqual({ "lib/libpython3.12.so": "libpython3.12.so.1.0" });
  });

  test("an intact artifact verifies, the manifest itself is not listed", async () => {
    const dir = prefix();
    const manifest = await buildManifest(dir, meta);
    mkdirSync(join(dir, "share", "vu"), { recursive: true });
    await Bun.write(join(dir, MANIFEST_PATH), JSON.stringify(manifest));
    expect(await verifyManifest(dir)).toEqual([]);
  });

  test("a changed, missing, extra or relinked file is reported", async () => {
    const dir = prefix();
    const manifest = await buildManifest(dir, meta);
    writeFileSync(join(dir, "bin", "vu"), "#!ru\n");
    expect(await verifyManifest(dir, manifest)).toEqual(["sha256: bin/vu"]);
    writeFileSync(join(dir, "bin", "vu"), "#!vu!\n");
    expect(await verifyManifest(dir, manifest)).toEqual(["size: bin/vu"]);
    unlinkSync(join(dir, "lib", "libpython3.12.so.1.0"));
    writeFileSync(join(dir, "extra.txt"), "x");
    unlinkSync(join(dir, "lib", "libpython3.12.so"));
    symlinkSync("elsewhere", join(dir, "lib", "libpython3.12.so"));
    const problems = await verifyManifest(dir, manifest);
    expect(problems).toContain("missing: lib/libpython3.12.so.1.0");
    expect(problems).toContain("unlisted: extra.txt");
    expect(problems).toContain("link target: lib/libpython3.12.so");
  });

  test("bytecode caches are derived data: never listed, never required, never flagged", async () => {
    expect(isDerivedPath("lib/python3.12/__pycache__/os.cpython-312.pyc")).toBe(true);
    expect(isDerivedPath("__pycache__/x.pyc")).toBe(true);
    expect(isDerivedPath("lib/python3.12/os.py")).toBe(false);
    expect(isDerivedPath("lib/my__pycache__/x")).toBe(false);
    const dir = prefix();
    mkdirSync(join(dir, "lib", "__pycache__"), { recursive: true });
    writeFileSync(join(dir, "lib", "__pycache__", "a.cpython-312.pyc"), "before");
    const manifest = await buildManifest(dir, meta);
    expect(Object.keys(manifest.files).some((path) => path.includes("__pycache__"))).toBe(false);
    // CPython writes and rewrites caches while the runtime is used.
    writeFileSync(join(dir, "lib", "__pycache__", "a.cpython-312.pyc"), "after, longer");
    writeFileSync(join(dir, "lib", "__pycache__", "b.cpython-312.pyc"), "new");
    expect(await verifyManifest(dir, manifest)).toEqual([]);
  });

  test("another schema or name is refused", async () => {
    const dir = prefix();
    const manifest = await buildManifest(dir, meta);
    expect(await verifyManifest(dir, { ...manifest, name: "other" as "vu-runtime" })).toEqual([
      "unsupported manifest schema or name",
    ]);
  });
});
