// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findLibpython } from "./shared-libpython.ts";

const artifact =
  process.env["VU_TEST_ARTIFACT"] ??
  join(homedir(), ".vu/runtime/x86_64-unknown-linux-gnu/current");
const present = existsSync(artifact) && findLibpython(artifact) !== null;
const site = process.env["VU_TEST_SITE"];

test("findLibpython reads the artifact's lib directory", () => {
  expect(findLibpython("/nonexistent")).toBeNull();
});

// Python is initialised and finalised once per process, so each scenario runs in a child Bun.
async function child(
  code: string,
  withSite: boolean,
  fork?: string,
): Promise<{ code: number; out: string; err: string }> {
  const script = `import { runInSharedPython } from ${JSON.stringify(join(import.meta.dir, "shared-libpython.ts"))};
console.log(JSON.stringify(runInSharedPython(${JSON.stringify(artifact)}, ${JSON.stringify(code)}${withSite ? `, ${JSON.stringify(site)}` : ", undefined"}, { promote: ${fork === undefined} })));`;
  const run = Bun.spawn([fork ?? "bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [out, err, exit] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  return { code: exit, out, err };
}

test.skipIf(!present)("Bun runs the runtime's CPython in-process", async () => {
  const run = await child("open(RESULT_PATH, 'w').write(sys.version.split()[0])", false);
  expect(run.code).toBe(0);
  expect(JSON.parse(run.out).value).toMatch(/^3\.12\./);
});

test.skipIf(!present)("exactly one libpython is mapped in the process", async () => {
  const code = [
    "import re",
    "maps = open('/proc/self/maps').read()",
    "libs = sorted(set(re.findall(r'(\\S*libpython3[^\\s]*)', maps)))",
    "open(RESULT_PATH, 'w').write(str(len(libs)))",
  ].join("\n");
  const run = await child(code, false);
  expect(run.code).toBe(0);
  expect(JSON.parse(run.out).value).toBe("1");
});

test.skipIf(!present || site === undefined)(
  "Bun to Python to Rust: a PyO3 extension runs on the same libpython and returns a value to Bun",
  async () => {
    const code =
      "from aphrody import aphrody_rust as r\nopen(RESULT_PATH, 'w').write(repr(r.cosine_similarity([1.0, 2.0], [1.0, 2.0])))";
    const run = await child(code, true);
    expect(run.err).not.toContain("Traceback");
    expect(JSON.parse(run.out).value).toBe("1.0");
  },
);

// The yolo fork opens the library RTLD_GLOBAL itself (`dlopen(..., { global: true })`, plan D18): no promotion from Python.
// VU_TEST_BUN is the fork's engine link (the `bun` name of the yolo binary, argv0 selects the engine).
const fork = process.env["VU_TEST_BUN"];
test.skipIf(!present || site === undefined || fork === undefined)(
  "yolo fork: the same end-to-end path works with no ctypes promotion",
  async () => {
    const code =
      "from aphrody import aphrody_rust as r\nopen(RESULT_PATH, 'w').write(repr(r.cosine_similarity([1.0, 2.0], [1.0, 2.0])))";
    const run = await child(code, true, fork);
    expect(run.err).not.toContain("undefined symbol");
    expect(JSON.parse(run.out).value).toBe("1.0");
  },
);
