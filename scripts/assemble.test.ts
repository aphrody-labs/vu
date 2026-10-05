// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assemble } from "./assemble.ts";
import { ROOT } from "./lib.ts";
import { MANIFEST_PATH, verifyManifest } from "./manifest.ts";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A repository root with the real pins and manifest, a fake CPython prefix and fake release binaries. */
async function fixture(): Promise<{ root: string; targetDir: string; out: string }> {
  const dir = mkdtempSync(join(tmpdir(), "vu-assemble-"));
  directories.push(dir);
  for (const file of ["vendor.json", "vu.json", "Cargo.toml", "LICENSE"]) {
    await Bun.write(join(dir, file), Bun.file(join(ROOT, file)));
  }
  const prefix = join(dir, "build", "python");
  mkdirSync(join(prefix, "bin"), { recursive: true });
  mkdirSync(join(prefix, "lib", "python3.12"), { recursive: true });
  writeFileSync(join(prefix, "bin", "python3.12"), "interpreter");
  symlinkSync("python3.12", join(prefix, "bin", "python3"));
  writeFileSync(join(prefix, "lib", "libpython3.12.so.1.0"), "libpython");
  writeFileSync(join(prefix, "lib", "python3.12", "os.py"), "# os\n");
  const targetDir = join(dir, "target");
  mkdirSync(join(targetDir, "release"), { recursive: true });
  for (const binary of ["vu", "uv", "ruff"]) {
    writeFileSync(join(targetDir, "release", binary), `#!${binary}\n`);
    chmodSync(join(targetDir, "release", binary), 0o644);
  }
  return { root: dir, targetDir, out: join(dir, "artifacts") };
}

describe("assemble", () => {
  test("builds a verified artifact: prefix, sidecars, licences and a manifest", async () => {
    const { root, targetDir, out } = await fixture();
    const revision = "abcdef0123456789abcdef0123456789abcdef01";
    const { artifact, manifest } = await assemble({
      root,
      targetDir,
      out,
      revision,
      toolchain: "rustc 1.98.1",
    });
    expect(artifact).toBe(join(out, `0.1.0-${revision.slice(0, 8)}`));
    expect(existsSync(`${artifact}.partial`)).toBe(false);
    for (const binary of ["vu", "uv", "ruff"]) {
      expect(lstatSync(join(artifact, "bin", binary)).mode & 0o111).not.toBe(0);
      expect(manifest.files[`bin/${binary}`]).toBeDefined();
    }
    expect(lstatSync(join(artifact, "bin", "python3")).isSymbolicLink()).toBe(true);
    expect(manifest.links["bin/python3"]).toBe("python3.12");
    expect(existsSync(join(artifact, "share", "vu", "licenses", "vu", "LICENSE"))).toBe(true);
    expect(manifest).toMatchObject({
      schema: 1,
      name: "vu-runtime",
      version: "0.1.0",
      revision,
      toolchain: "rustc 1.98.1",
      capabilities: ["uv", "ruff", "python"],
    });
    expect(manifest.pins["uv"]).toMatchObject({
      upstreamTag: "0.12.23",
      forkBranch: "vu-pin-0.12.23",
    });
    expect(manifest.pins["python"]).toMatchObject({ version: "3.12.15", release: "20261003" });
    expect(await verifyManifest(artifact)).toEqual([]);
    expect(existsSync(join(artifact, MANIFEST_PATH))).toBe(true);
  });

  test("a missing CPython prefix or release binary is a clear error", async () => {
    const { root, targetDir, out } = await fixture();
    rmSync(join(root, "build"), { recursive: true });
    await expect(
      assemble({ root, targetDir, out, revision: "a".repeat(40), toolchain: "t" }),
    ).rejects.toThrow("scripts/fetch.ts");
    const second = await fixture();
    rmSync(join(second.targetDir, "release", "ruff"));
    await expect(assemble({ ...second, revision: "a".repeat(40), toolchain: "t" })).rejects.toThrow(
      "missing release binary",
    );
  });
});
