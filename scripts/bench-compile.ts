#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
//! What `vu compile` buys at start-up: import time of a real package tree as plain sources with no bytecode cache (a
//! fresh checkout, a read-only install), as the interpreter's own timestamp cache after one run, and as the
//! unchecked-hash bytecode `vu compile` writes. The receipt keeps the medians; no figure is assumed.
//!
//!   bun scripts/bench-compile.ts --site <site-packages> --import <module> [--packages a,b,c] [--vu <prefix>]

import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./lib.ts";
import { summarize } from "./bench.ts";

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

const site = arg("--site");
const module = arg("--import") ?? "httpx";
const packages = (arg("--packages") ?? "httpx,httpcore,h11,anyio,idna,certifi,sniffio").split(",");
const prefix = arg("--vu") ?? join(homedir(), ".vu/runtime/x86_64-unknown-linux-gnu/current");
if (!site) {
  console.error(
    "usage: bun scripts/bench-compile.ts --site <site-packages> [--import m] [--packages a,b]",
  );
  process.exit(64);
}
const python = join(prefix, "bin/python3");
const work = mkdtempSync(join(tmpdir(), "vu-bench-compile-"));

function stage(name: string): string {
  const dir = join(work, name);
  for (const pkg of packages)
    cpSync(join(site, pkg), join(dir, pkg), {
      recursive: true,
      filter: (p) => !p.includes("__pycache__"),
    });
  return dir;
}

function median(dir: string, env: Record<string, string>, runs: number) {
  const ms: number[] = [];
  for (let run = 0; run < runs; run++) {
    const start = performance.now();
    const result = Bun.spawnSync([python, "-c", `import ${module}`], {
      env: { ...process.env, ...env, PYTHONPATH: dir },
      stdout: "ignore",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    ms.push(performance.now() - start);
  }
  return summarize(ms);
}

const cases: Record<string, ReturnType<typeof summarize>> = {};
const cold = stage("cold");
cases["sources, no bytecode cache (PYTHONDONTWRITEBYTECODE)"] = median(
  cold,
  { PYTHONDONTWRITEBYTECODE: "1" },
  15,
);

const warm = stage("warm");
Bun.spawnSync([python, "-c", `import ${module}`], { env: { ...process.env, PYTHONPATH: warm } });
cases["interpreter timestamp cache, warm"] = median(warm, {}, 15);

const compiled = stage("compiled");
const compile = Bun.spawnSync(
  [python, "-c", await Bun.file(join(ROOT, "crates/vu-runtime/py/compile.py")).text(), compiled],
  {
    stdout: "pipe",
    stderr: "pipe",
  },
);
if (compile.exitCode !== 0) throw new Error(`vu compile failed: ${compile.stderr.toString()}`);
cases["vu compile (unchecked-hash bytecode)"] = median(
  compiled,
  { PYTHONDONTWRITEBYTECODE: "1" },
  15,
);

const base = cases["sources, no bytecode cache (PYTHONDONTWRITEBYTECODE)"]!;
for (const [name, sample] of Object.entries(cases))
  console.log(
    `${name.padEnd(56)} ${sample.median.toFixed(1).padStart(8)} ms  x${(base.median / sample.median).toFixed(2)} against no cache`,
  );
const at = new Date().toISOString();
await Bun.write(
  join(ROOT, "receipts", `bench-compile-${at.replaceAll(/[:.]/g, "-")}.json`),
  `${JSON.stringify({ schema: "aphrody.vu-bench-compile/1", at, import: module, packages, python: python, results: cases }, null, 2)}\n`,
);
rmSync(work, { recursive: true, force: true });
