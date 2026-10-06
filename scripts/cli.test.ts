// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// End-to-end tests of the installed `vu` binary (the native subcommands). They run against
// $VU_TEST_ARTIFACT (default: the active runtime under ~/.vu) and skip when it predates the subcommands.
const prefix =
  process.env["VU_TEST_ARTIFACT"] ??
  join(homedir(), ".vu/runtime/x86_64-unknown-linux-gnu/current");
const vu = join(prefix, "bin/vu");

function run(args: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
  const result = Bun.spawnSync([vu, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

const current = existsSync(vu) && run(["--help"]).out.includes("python install");
let scratch = "";
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "vu-cli-"));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe.skipIf(!current)("vu native subcommands", () => {
  test("help documents every command family", () => {
    const { out } = run(["--help"]);
    for (const word of [
      "python install",
      "lint",
      "format",
      "ffi",
      "hf",
      "compile",
      "add remove sync",
    ])
      expect(out).toContain(word);
  });

  test("unknown commands fail with a usage status", () => {
    expect(run(["nope"]).code).toBe(64);
  });

  test("ffi reports the single shared libpython", () => {
    const { code, out } = run(["ffi", "info", "--json"]);
    expect(code).toBe(0);
    const info = JSON.parse(out);
    expect(info.schema).toBe("aphrody.vu-ffi/1");
    expect(info.libraries).toBe(1);
    expect(info.dlopen).toBe("RTLD_NOW|RTLD_GLOBAL");
    expect(existsSync(info.libpython)).toBe(true);
    expect(info.pythonhome).toBe(info.prefix);
    expect(run(["ffi", "check"]).code).toBe(0);
  });

  test("hf status reads the standard variables and never prints the token", () => {
    const home = join(scratch, "hf");
    const { code, out } = run(["hf", "status", "--json"], {
      env: { HF_HOME: home, HF_TOKEN: "hf_secret_value" },
    });
    expect(code).toBe(0);
    expect(out).not.toContain("hf_secret_value");
    const report = JSON.parse(out);
    expect(report.hubCache).toBe(join(home, "hub"));
    expect(report.token).toEqual({ present: true, source: "HF_TOKEN" });
  });

  test("compile byte-compiles a tree into unchecked-hash caches", () => {
    const tree = join(scratch, "tree");
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, "m.py"), "VALUE = 1\n");
    expect(run(["compile", tree]).code).toBe(0);
    expect(readdirSync(join(tree, "__pycache__")).some((f) => f.endsWith(".pyc"))).toBe(true);
  });

  test("lint and format run the pinned ruff", () => {
    const dir = join(scratch, "lint");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ok.py"), "x = 1\n");
    writeFileSync(join(dir, "bad.py"), "import os\n");
    expect(run(["lint", "ok.py"], { cwd: dir }).code).toBe(0);
    expect(run(["lint", "bad.py"], { cwd: dir }).code).toBe(1);
    expect(run(["format", "--check", "ok.py"], { cwd: dir }).code).toBe(0);
  });

  test("python runs the embedded interpreter when the project pins its minor or nothing", () => {
    const dir = join(scratch, "pin312");
    mkdirSync(dir, { recursive: true });
    const script = "import sys; print(sys.version_info[0], sys.version_info[1])";
    const plain = run(["python", "-c", script], { cwd: dir });
    expect(plain.out.trim()).toBe("3 12");
    writeFileSync(join(dir, ".python-version"), "3.12\n");
    expect(run(["python", "-c", script], { cwd: dir }).out.trim()).toBe("3 12");
  });

  test("python list names the runtime's interpreter first", () => {
    const home = join(scratch, "home-list");
    const { code, out } = run(["python", "list"], { env: { VU_HOME: home } });
    expect(code).toBe(0);
    expect(out.split("\n")[0]).toContain("runtime, embedded");
  });
});

// Network: installs CPython 3.14 from the pinned python-build-standalone release metadata of uv.
describe.skipIf(!current || process.env["VU_TEST_NETWORK"] !== "1")(
  "vu python version manager",
  () => {
    const home = () => join(scratch, "home-manager");
    test("install, use and per-project selection of 3.14", () => {
      const env = { VU_HOME: home() };
      const install = run(["python", "install", "3.14"], { env });
      expect(install.code).toBe(0);
      expect(run(["python", "list"], { env }).out).toContain("cpython-3.14");
      expect(existsSync(join(home(), "python"))).toBe(true);

      const project = join(scratch, "project314");
      mkdirSync(project, { recursive: true });
      const used = run(["python", "use", "3.14"], { cwd: project, env });
      expect(used.code).toBe(0);
      expect(Bun.file(join(project, ".python-version")).size).toBeGreaterThan(0);
      const script = "import sys; print(sys.version_info[0], sys.version_info[1])";
      expect(run(["python", "-c", script], { cwd: project, env }).out.trim()).toBe("3 14");
      expect(
        run(["python", "-c", script], {
          cwd: project,
          env: { ...env, VU_PYTHON: "3.12" },
        }).out.trim(),
      ).toBe("3 12");
      expect(run(["python", "find", "3.14"], { cwd: project, env }).out.trim()).toContain(
        "python3.14",
      );
    });

    test("a project that asks for a missing version gets it installed on demand", () => {
      const env = { VU_HOME: join(scratch, "home-auto") };
      const project = join(scratch, "projectauto");
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, ".python-version"), "3.11\n");
      const result = run(["python", "-c", "import sys; print(sys.version_info[1])"], {
        cwd: project,
        env,
      });
      expect(result.out.trim()).toBe("11");
      expect(result.err).toContain("installing Python 3.11");
    });
  },
);
