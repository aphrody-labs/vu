#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
//! Smoke and parity checks of an assembled runtime artifact; the results go into the build receipt.
//!
//!   bun scripts/smoke.ts <artifact> [--wheel <aphrody wheel>] [--expect-uv <x.y.z>] [--expect-ruff <x.y.z>] [--expect-python <x.y.z>]
//!
//! Prints one JSON document: `{ ok, checks: [...] }`. The glibc audit is a finding, not a failure: a need above the
//! oldest supported host (2.39, WSL) is reported so that the receipt shows it.

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { auditFile, compareVersions } from "./glibc.ts";
import { run, sha256File } from "./lib.ts";
import { verifyManifest } from "./manifest.ts";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}

export interface SmokeOptions {
  wheel?: string;
  expectUv: string;
  expectRuff: string;
  expectPython: string;
}

/** The oldest glibc of a supported host (WSL Ubuntu 24.04). */
export const OLDEST_HOST_GLIBC = "2.39";

const PARITY_SCRIPT = [
  "import json, platform, sys, ssl, sqlite3, zlib, ctypes, hashlib, decimal, lzma, bz2, uuid",
  "print(json.dumps({'version': sys.version, 'prefix': sys.prefix, 'executable': sys.executable,",
  "  'platform': platform.platform(), 'ssl': ssl.OPENSSL_VERSION, 'sqlite': sqlite3.sqlite_version,",
  "  'zlib': zlib.ZLIB_VERSION, 'path': sys.path}, sort_keys=True))",
].join("\n");

export function smokePlan(
  prefix: string,
  scratch: string,
  options: SmokeOptions,
): { name: string; run: () => Promise<{ ok: boolean; detail: string }> }[] {
  const bin = (name: string): string => join(prefix, "bin", name);
  // The artifact must stay pristine while it is checked: no bytecode caches are written into it.
  const environment = {
    VU_RUNTIME: prefix,
    UV_PYTHON_DOWNLOADS: "never",
    UV_NO_CONFIG: "1",
    PYTHONDONTWRITEBYTECODE: "1",
  };
  return [
    {
      name: "manifest",
      run: async () => {
        const problems = await verifyManifest(prefix);
        return {
          ok: problems.length === 0,
          detail: problems.length === 0 ? "every file matches" : problems.slice(0, 5).join("; "),
        };
      },
    },
    {
      name: "version",
      run: async () => {
        const result = await run([bin("vu"), "--version", "--json"], { env: environment });
        if (result.code !== 0) return { ok: false, detail: result.stderr.trim().slice(0, 300) };
        const info = JSON.parse(result.stdout) as Record<string, string>;
        const ok =
          info["schema"] === "aphrody.vu/1" &&
          info["uv"]?.startsWith(`uv ${options.expectUv}`) === true &&
          info["ruff"]?.startsWith(`ruff ${options.expectRuff}`) === true &&
          info["python"]?.startsWith(options.expectPython) === true;
        return { ok, detail: result.stdout.trim() };
      },
    },
    {
      name: "uv sidecar",
      run: async () => {
        const through = await run([bin("vu"), "uv", "--version"], { env: environment });
        const direct = await run([bin("uv"), "--version"], { env: environment });
        return {
          ok: through.code === 0 && through.stdout === direct.stdout,
          detail: through.stdout.trim(),
        };
      },
    },
    {
      name: "ruff sidecar",
      run: async () => {
        const file = join(scratch, "sample.py");
        await Bun.write(file, "import os\n");
        const through = await run([bin("vu"), "ruff", "check", "--no-cache", file], {
          env: environment,
        });
        const version = await run([bin("vu"), "ruff", "--version"], { env: environment });
        return {
          ok:
            through.code === 1 &&
            through.stdout.includes("F401") &&
            version.stdout.startsWith(`ruff ${options.expectRuff}`),
          detail: `${version.stdout.trim()}; check exit ${through.code}`,
        };
      },
    },
    {
      name: "python parity",
      run: async () => {
        const embedded = await run([bin("vu"), "python", "-c", PARITY_SCRIPT], {
          env: environment,
        });
        const standalone = await run([bin("python3"), "-c", PARITY_SCRIPT], { env: environment });
        const ok =
          embedded.code === 0 && standalone.code === 0 && embedded.stdout === standalone.stdout;
        return {
          ok,
          detail: ok
            ? "identical sys.version, sys.prefix, sys.executable, sys.path and extension modules"
            : `${embedded.stderr.trim()} | ${standalone.stderr.trim()}`.slice(0, 400),
        };
      },
    },
    {
      name: "python exit status and stdin",
      run: async () => {
        const status = await run([bin("vu"), "python", "-c", "import sys; sys.exit(7)"], {
          env: environment,
        });
        const piped = await run([bin("vu"), "python", "-"], {
          env: environment,
          stdin: "print(40 + 2)\n",
        });
        return {
          ok: status.code === 7 && piped.stdout.trim() === "42",
          detail: `exit ${status.code}, stdin result ${piped.stdout.trim()}`,
        };
      },
    },
    ...(options.wheel
      ? [
          {
            name: "sdk wheel through the sidecar uv and the embedded interpreter",
            run: async () => {
              const venv = join(scratch, "venv");
              const cache = join(scratch, "uv-cache");
              const env = { ...environment, UV_CACHE_DIR: cache };
              const created = await run(
                [bin("vu"), "uv", "venv", "--python", bin("python3"), venv],
                { env },
              );
              const installed = await run(
                [
                  bin("vu"),
                  "uv",
                  "pip",
                  "install",
                  "--python",
                  join(venv, "bin", "python"),
                  "--no-deps",
                  resolve(options.wheel as string),
                ],
                { env },
              );
              const site = (
                await run(
                  [
                    join(venv, "bin", "python"),
                    "-c",
                    "import sysconfig; print(sysconfig.get_path('purelib'))",
                  ],
                  { env },
                )
              ).stdout.trim();
              const script =
                "from aphrody import aphrody_rust as m; print(m.cosine_similarity([1.0, 0.0], [1.0, 0.0]))";
              const embedded = await run([bin("vu"), "python", "-c", script], {
                env: { ...env, PYTHONPATH: site },
              });
              const ok =
                created.code === 0 && installed.code === 0 && embedded.stdout.trim() === "1.0";
              return {
                ok,
                detail: ok
                  ? "aphrody.aphrody_rust.cosine_similarity returned 1.0 inside vu python"
                  : `${created.stderr}${installed.stderr}${embedded.stderr}`.trim().slice(0, 400),
              };
            },
          },
        ]
      : []),
    {
      name: "glibc audit",
      run: async () => {
        const libpython =
          readdirSync(join(prefix, "lib")).find((name) =>
            /^libpython3\.\d+\.so\.1\.0$/.test(name),
          ) ?? "libpython.so";
        const files = [bin("vu"), bin("uv"), bin("ruff"), join(prefix, "lib", libpython)];
        const audits = await Promise.all(files.map((file) => auditFile(file).catch(() => null)));
        const rows = audits.filter((audit) => audit !== null);
        const highest = rows.reduce<string | null>(
          (max, audit) =>
            audit.glibcMax && (max === null || compareVersions(audit.glibcMax, max) > 0)
              ? audit.glibcMax
              : max,
          null,
        );
        const detail = rows
          .map((audit) => `${audit.file.split("/").at(-1)}: ${audit.glibcMax ?? "none"}`)
          .join(", ");
        return {
          ok: true,
          detail: `${detail}; highest ${highest ?? "none"}; ${highest !== null && compareVersions(highest, OLDEST_HOST_GLIBC) > 0 ? `FINDING: above ${OLDEST_HOST_GLIBC}, WSL cannot run it` : `within ${OLDEST_HOST_GLIBC}`}`,
        };
      },
    },
  ];
}

export async function smoke(
  prefix: string,
  options: SmokeOptions,
): Promise<{ ok: boolean; checks: Check[] }> {
  const scratch = mkdtempSync(join(tmpdir(), "vu-smoke-"));
  const plan = smokePlan(prefix, scratch, options);
  const checks: Check[] = [];
  for (const step of plan) {
    const started = performance.now();
    try {
      const result = await step.run();
      checks.push({
        name: step.name,
        ok: result.ok,
        detail: result.detail,
        ms: Math.round(performance.now() - started),
      });
    } catch (error) {
      checks.push({
        name: step.name,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        ms: Math.round(performance.now() - started),
      });
    }
  }
  rmSync(scratch, { recursive: true, force: true });
  return { ok: checks.every((check) => check.ok), checks };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const artifact = argv[0];
  if (!artifact || artifact.startsWith("--")) {
    console.error(
      "usage: bun scripts/smoke.ts <artifact> [--wheel <wheel>] [--expect-uv x.y.z] [--expect-ruff x.y.z] [--expect-python x.y.z]",
    );
    process.exit(64);
  }
  const prefix = resolve(artifact);
  const result = await smoke(prefix, {
    wheel: value("--wheel"),
    expectUv: value("--expect-uv") ?? "0.12.23",
    expectRuff: value("--expect-ruff") ?? "0.16.10",
    expectPython: value("--expect-python") ?? "3.12.15",
  });
  const wheel = value("--wheel");
  const wheelSha256 = wheel ? await sha256File(resolve(wheel)) : undefined;
  console.log(
    JSON.stringify(
      { ...result, wheel: wheel ? { path: resolve(wheel), sha256: wheelSha256 } : undefined },
      null,
      2,
    ),
  );
  process.exitCode = result.ok ? 0 : 1;
}
