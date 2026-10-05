#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
//! Builds the runtime on the build host and writes a receipt (schema aphrody.vu-forge/1).
//!
//!   bun scripts/forge.ts [--steps tunnel,sync,fetch,uv,ruff,vu,test,clippy,assemble,smoke] [--wheel <path on the build host>]
//!
//! Every Cargo step goes through `vps-cargo --repo vu` of the Aphrody checkout (APHRODY_ROOT, default ~/aphrody):
//! the exact worktree of this repository is snapshotted, pushed over the SSH master (the build host cannot read
//! private GitHub repositories) and built under the factory locks. The non-Cargo steps (fetch, assemble, smoke)
//! run on the build host over the same master. Nothing is installed or activated.

import { homedir } from "node:os";
import { join } from "node:path";
import { readVendor, ROOT, run } from "./lib.ts";

const ALL_STEPS = [
  "tunnel",
  "sync",
  "fetch",
  "uv",
  "ruff",
  "vu",
  "test",
  "clippy",
  "assemble",
  "smoke",
] as const;
type Step = (typeof ALL_STEPS)[number];

interface StepResult {
  name: Step;
  ok: boolean;
  ms: number;
  detail?: string;
}

interface VpsCargoModule {
  selectConfig(options: readonly string[]): Promise<{ host: string }>;
  repositoryConfig(
    config: { host: string },
    name: string,
  ): { config: { remoteWorkspace: string; remoteTargetDir: string; host: string }; root: string };
  sshBase(config: { host: string }): string[];
}

const aphrody = process.env["APHRODY_ROOT"] ?? join(homedir(), "aphrody");
const vpsCargoPath = join(aphrody, "scripts/build/rust/vps-cargo.ts");
const REMOTE_PATH = 'export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$HOME/.local/bin:$PATH"';
const ARTIFACTS = "/srv/aphrody-build/artifacts/vu";
const CACHE = "/srv/aphrody-build/cache/vu";
const DEFAULT_WHEEL =
  "/srv/aphrody-build/artifacts/wsl/ir-wheel/dist/aphrody-0.1.0-cp311-abi3-linux_x86_64.whl";

async function vpsCargo(args: string[]): Promise<{ code: number; stdout: string }> {
  const child = Bun.spawn(["bun", vpsCargoPath, ...args], { stdout: "pipe", stderr: "inherit" });
  let stdout = "";
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    const text = decoder.decode(chunk.value);
    stdout += text;
    process.stdout.write(text);
  }
  return { code: await child.exited, stdout };
}

async function remote(script: string): Promise<{ code: number; stdout: string }> {
  const module = (await import(vpsCargoPath)) as VpsCargoModule;
  const config = await module.selectConfig([]);
  const child = Bun.spawn([...module.sshBase(config), config.host, "bash -s"], {
    stdin: new Blob([script]),
    stdout: "pipe",
    stderr: "inherit",
  });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { code, stdout };
}

async function layout(): Promise<{ workspace: string; targetDir: string }> {
  const module = (await import(vpsCargoPath)) as VpsCargoModule;
  const config = await module.selectConfig([]);
  const { config: repository } = module.repositoryConfig(config, "vu");
  return { workspace: repository.remoteWorkspace, targetDir: repository.remoteTargetDir };
}

function lastJson(text: string): unknown {
  const line = text
    .trim()
    .split("\n")
    .filter((entry) => entry.startsWith("{"))
    .at(-1);
  if (!line) throw new Error(`no JSON in the remote output: ${text.slice(-300)}`);
  return JSON.parse(line);
}

export async function main(argv: string[]): Promise<number> {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const wanted = (value("--steps")?.split(",") ?? [...ALL_STEPS]) as Step[];
  const unknown = wanted.filter((step) => !ALL_STEPS.includes(step));
  if (unknown.length > 0) throw new Error(`unknown steps: ${unknown.join(", ")}`);
  const vendor = await readVendor();
  const { workspace, targetDir } = await layout();
  const startedAt = new Date().toISOString();
  const results: StepResult[] = [];
  const state: { revision: string; toolchain: string; artifact?: unknown; smoke?: unknown } = {
    revision: "",
    toolchain: "",
  };
  const head = (await run(["git", "rev-parse", "HEAD"], { cwd: ROOT })).stdout.trim();
  const dirty =
    (await run(["git", "status", "--porcelain"], { cwd: ROOT })).stdout.trim().length > 0;

  const step = async (
    name: Step,
    work: () => Promise<{ ok: boolean; detail?: string }>,
  ): Promise<boolean> => {
    if (!wanted.includes(name)) return true;
    console.log(`\n== ${name}`);
    const started = performance.now();
    let outcome: { ok: boolean; detail?: string };
    try {
      outcome = await work();
    } catch (error) {
      outcome = { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
    results.push({
      name,
      ok: outcome.ok,
      ms: Math.round(performance.now() - started),
      detail: outcome.detail,
    });
    console.log(
      `== ${name}: ${outcome.ok ? "ok" : "FAILED"} in ${((performance.now() - started) / 1000).toFixed(1)} s${outcome.detail ? ` (${outcome.detail})` : ""}`,
    );
    return outcome.ok;
  };
  const cargo = (name: Step, cargoArgs: string[]) =>
    step(name, async () => {
      const result = await vpsCargo(["run", "--repo", "vu", "--", ...cargoArgs]);
      return {
        ok: result.code === 0,
        detail: result.code === 0 ? undefined : `exit ${result.code}`,
      };
    });

  const steps: (() => Promise<boolean>)[] = [
    () => step("tunnel", async () => ({ ok: (await vpsCargo(["tunnel", "status"])).code === 0 })),
    () =>
      step("sync", async () => {
        const result = await vpsCargo(["sync", "--repo", "vu"]);
        state.revision = result.stdout.trim().split("\n").at(-1) ?? "";
        return {
          ok: result.code === 0 && /^[0-9a-f]{40}$/.test(state.revision),
          detail: state.revision.slice(0, 12),
        };
      }),
    () =>
      step("fetch", async () => {
        const result = await remote(
          `set -euo pipefail\n${REMOTE_PATH}\ncd ${workspace}\nVU_CACHE=${CACHE} bun scripts/fetch.ts\n`,
        );
        return { ok: result.code === 0, detail: result.stdout.trim().split("\n").at(-1) };
      }),
    () =>
      cargo("uv", [
        "build",
        "--release",
        "--locked",
        "--manifest-path",
        "vendor/uv/Cargo.toml",
        "-p",
        "uv",
      ]),
    () =>
      cargo("ruff", [
        "build",
        "--release",
        "--locked",
        "--manifest-path",
        "vendor/ruff/Cargo.toml",
        "-p",
        "ruff",
      ]),
    () => cargo("vu", ["build", "--release", "--locked", "-p", "vu"]),
    () => cargo("test", ["test", "--locked", "-p", "vu-runtime"]),
    () =>
      cargo("clippy", [
        "clippy",
        "--locked",
        "--all-targets",
        "-p",
        "vu",
        "-p",
        "vu-runtime",
        "--",
        "-D",
        "warnings",
      ]),
    () =>
      step("assemble", async () => {
        const result = await remote(
          `set -euo pipefail\n${REMOTE_PATH}\ncd ${workspace}\nbun scripts/assemble.ts --target-dir ${targetDir} --out ${ARTIFACTS} --revision ${state.revision || head}\nrustc --version >&2\n`,
        );
        if (result.code !== 0) return { ok: false };
        state.artifact = lastJson(result.stdout);
        return { ok: true, detail: (state.artifact as { artifact: string }).artifact };
      }),
    () =>
      step("smoke", async () => {
        const artifact = (state.artifact as { artifact?: string } | undefined)?.artifact;
        if (!artifact) return { ok: false, detail: "no artifact (run the assemble step)" };
        const wheel = value("--wheel") ?? DEFAULT_WHEEL;
        const result = await remote(
          `set -uo pipefail\n${REMOTE_PATH}\ncd ${workspace}\nif [ -f ${wheel} ]; then bun scripts/smoke.ts ${artifact} --wheel ${wheel}; else bun scripts/smoke.ts ${artifact}; fi\n`,
        );
        const text = result.stdout.trim();
        state.smoke = JSON.parse(text.slice(text.indexOf("{"))) as unknown;
        return { ok: (state.smoke as { ok: boolean }).ok };
      }),
  ];
  for (const execute of steps) {
    if (!(await execute())) break;
  }

  const toolchain = (
    await remote(`${REMOTE_PATH}\ncd ${workspace}\nrustc --version\n`)
  ).stdout.trim();
  const receipt = {
    schema: "aphrody.vu-forge/1",
    startedAt,
    finishedAt: new Date().toISOString(),
    ok:
      results.length > 0 &&
      results.every((entry) => entry.ok) &&
      wanted.every((name) => results.some((entry) => entry.name === name)),
    revision: state.revision || head,
    head,
    dirty,
    host: "vps",
    toolchain,
    pins: Object.fromEntries(
      vendor.sources.map((source) => [source.name, { tag: source.upstreamTag, ref: source.ref }]),
    ),
    steps: results,
    artifact: state.artifact,
    smoke: state.smoke,
  };
  const file = join(
    ROOT,
    "receipts",
    `${(state.revision || head).slice(0, 8)}-${startedAt.replaceAll(/[:.]/g, "-")}.json`,
  );
  await Bun.write(file, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`\nreceipt ${file}: ${receipt.ok ? "OK" : "FAILED"}`);
  return receipt.ok ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`forge: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
