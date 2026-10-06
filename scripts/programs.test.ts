// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./lib.ts";

const prefix =
  process.env["VU_TEST_ARTIFACT"] ??
  join(homedir(), ".vu/runtime/x86_64-unknown-linux-gnu/current");
const python = join(prefix, "bin/python3");

// The programs embedded in the binary (vu hf, vu compile) are tested with the runtime's own interpreter.
test.skipIf(!existsSync(python))("embedded Python programs pass their unittest suite", () => {
  const run = Bun.spawnSync([python, "-m", "unittest", "discover", "-s", "tests", "-v"], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = run.stderr.toString() + run.stdout.toString();
  expect(output).toContain("OK");
  expect(run.exitCode).toBe(0);
});
