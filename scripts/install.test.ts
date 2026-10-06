// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flipLink, installArtifact, main, planInstall, rollback } from "./install.ts";
import { buildManifest, MANIFEST_PATH } from "./manifest.ts";

const TARGET = "x86_64-unknown-linux-gnu";
let scratch = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "vu-install-"));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

async function artifact(version: string, revision: string): Promise<string> {
  const dir = join(scratch, `src-${version}-${revision}`);
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "share/vu"), { recursive: true });
  writeFileSync(join(dir, "bin/vu"), `vu ${version}`);
  const manifest = await buildManifest(dir, {
    schema: 1,
    name: "vu-runtime",
    version,
    target: TARGET,
    toolchain: "rustc test",
    revision,
    pins: {},
    compatibility: { cliMajor: 0 },
    capabilities: ["uv", "ruff", "python"],
  });
  writeFileSync(join(dir, MANIFEST_PATH), JSON.stringify(manifest));
  return dir;
}

test("a plan names the destination and replaces nothing", async () => {
  const home = join(scratch, "home");
  const plan = await planInstall(await artifact("0.1.0", "aaaaaaaabbbb"), home);
  expect(plan.name).toBe("0.1.0-aaaaaaaa");
  expect(plan.destination).toBe(join(home, "runtime", TARGET, "0.1.0-aaaaaaaa"));
  expect(plan.previous).toBeNull();
  expect(await Bun.file(join(home, "runtime")).exists()).toBe(false);
});

test("main without --apply changes nothing", async () => {
  const home = join(scratch, "home");
  const source = await artifact("0.1.0", "aaaaaaaabbbb");
  expect(await main(["--from", source, "--home", home])).toBe(0);
  expect(await Bun.file(join(home, "runtime")).exists()).toBe(false);
});

test("install activates, a second install keeps the previous link, rollback returns to it", async () => {
  const home = join(scratch, "home");
  const first = await planInstall(await artifact("0.1.0", "aaaaaaaabbbb"), home);
  const receipt = await installArtifact(first);
  expect(receipt.activated).toBe(true);
  expect(readlinkSync(first.link)).toBe("0.1.0-aaaaaaaa");

  const second = await planInstall(await artifact("0.2.0", "ccccccccdddd"), home);
  expect(second.previous).toBe("0.1.0-aaaaaaaa");
  await installArtifact(second);
  const runtime = join(home, "runtime", TARGET);
  expect(readlinkSync(join(runtime, "current"))).toBe("0.2.0-cccccccc");
  expect(readlinkSync(join(runtime, "previous"))).toBe("0.1.0-aaaaaaaa");

  expect(rollback(home, TARGET)).toEqual({ from: "0.2.0-cccccccc", to: "0.1.0-aaaaaaaa" });
  expect(readlinkSync(join(runtime, "current"))).toBe("0.1.0-aaaaaaaa");
});

test("a damaged artifact is refused and never activated", async () => {
  const home = join(scratch, "home");
  const source = await artifact("0.1.0", "aaaaaaaabbbb");
  writeFileSync(join(source, "bin/vu"), "tampered");
  const plan = await planInstall(source, home);
  await expect(installArtifact(plan)).rejects.toThrow("failed verification");
  expect(await Bun.file(plan.destination).exists()).toBe(false);
  expect(() => readlinkSync(plan.link)).toThrow();
});

test("the link flip is atomic and replaces an existing link", () => {
  const link = join(scratch, "current");
  flipLink(link, "a");
  flipLink(link, "b");
  expect(readlinkSync(link)).toBe("b");
});

test("re-installing the active artifact keeps no previous link", async () => {
  const home = join(scratch, "home");
  const source = await artifact("0.1.0", "aaaaaaaabbbb");
  await installArtifact(await planInstall(source, home));
  const again = await planInstall(source, home);
  expect(again.previous).toBeNull();
  const receipt = await installArtifact(again);
  expect(receipt.activated).toBe(true);
  expect(() => readlinkSync(join(home, "runtime", TARGET, "previous"))).toThrow();
});
