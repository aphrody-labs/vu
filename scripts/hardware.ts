// SPDX-License-Identifier: Apache-2.0
//! Hardware detection and wheel-index selection for the Python AI stack (PyTorch, JAX, vLLM, PyCUDA).
//!
//! The wheels themselves are resolved by the pinned uv (`uv pip install --torch-backend <tag>`); this module decides the
//! tag from the machine and prints the exact uv arguments, so the choice is explicit, testable and overridable
//! (`VU_ACCELERATOR=cpu|cuda<ver>|rocm<ver>`). Nothing here claims that a GPU wheel runs: a run needs a measurement on
//! the hardware (plan, section 14).

import { existsSync, readFileSync } from "node:fs";

export type Accelerator =
  | { readonly kind: "cpu" }
  | { readonly kind: "cuda"; readonly version: string }
  | { readonly kind: "rocm"; readonly version: string };

export interface Probes {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Output of `nvidia-smi` (header line carries "CUDA Version: X.Y"), or null when absent. */
  readonly nvidiaSmi: () => string | null;
  /** Content of /opt/rocm/.info/version, or null. */
  readonly rocmVersion: () => string | null;
}

export function systemProbes(env: Probes["env"] = process.env): Probes {
  return {
    env,
    nvidiaSmi: () => {
      try {
        const run = Bun.spawnSync(["nvidia-smi"], { stdout: "pipe", stderr: "ignore" });
        return run.exitCode === 0 ? run.stdout.toString() : null;
      } catch {
        return null;
      }
    },
    rocmVersion: () => {
      const path = "/opt/rocm/.info/version";
      return existsSync(path) ? readFileSync(path, "utf8").trim() : null;
    },
  };
}

/** `cuda12.8`, `rocm6.4` or `cpu` to an Accelerator. */
export function parseOverride(text: string): Accelerator | null {
  const cuda = /^cu(?:da)?\.?(\d+)\.?(\d+)$/.exec(text);
  if (cuda) return { kind: "cuda", version: `${cuda[1]}.${cuda[2]}` };
  const rocm = /^rocm(\d+)\.(\d+)$/.exec(text);
  if (rocm) return { kind: "rocm", version: `${rocm[1]}.${rocm[2]}` };
  return text === "cpu" ? { kind: "cpu" } : null;
}

export function detectAccelerator(probes: Probes = systemProbes()): Accelerator {
  const override = probes.env["VU_ACCELERATOR"];
  if (override !== undefined && override !== "") {
    const parsed = parseOverride(override);
    if (parsed === null)
      throw new Error(`VU_ACCELERATOR=${override}: expected cpu, cuda<X.Y> or rocm<X.Y>`);
    return parsed;
  }
  const smi = probes.nvidiaSmi();
  const cuda = smi === null ? null : /CUDA Version:\s*(\d+)\.(\d+)/.exec(smi);
  if (cuda) return { kind: "cuda", version: `${cuda[1]}.${cuda[2]}` };
  const rocm = probes.rocmVersion();
  const parsed = rocm === null ? null : /^(\d+)\.(\d+)/.exec(rocm);
  if (parsed) return { kind: "rocm", version: `${parsed[1]}.${parsed[2]}` };
  return { kind: "cpu" };
}

/** PyTorch wheel tags published on download.pytorch.org, newest first (verified against the index when resolving). */
const TORCH_CUDA = [
  [12, 8],
  [12, 6],
  [12, 4],
  [12, 1],
  [11, 8],
] as const;
const TORCH_ROCM = [
  [6, 4],
  [6, 3],
  [6, 2],
  [6, 1],
] as const;

/** The newest published tag that the driver's CUDA/ROCm version can run (drivers run older toolkits). */
export function torchBackend(accelerator: Accelerator): string {
  const pick = (table: readonly (readonly [number, number])[], version: string, prefix: string) => {
    const [major = 0, minor = 0] = version.split(".").map(Number);
    const found = table.find(([m, n]) => m < major || (m === major && n <= minor));
    return found ? `${prefix}${found[0]}${prefix === "cu" ? "" : "."}${found[1]}` : "cpu";
  };
  if (accelerator.kind === "cuda") return pick(TORCH_CUDA, accelerator.version, "cu");
  if (accelerator.kind === "rocm") return pick(TORCH_ROCM, accelerator.version, "rocm");
  return "cpu";
}

export interface StackPlan {
  readonly accelerator: Accelerator;
  readonly torchBackend: string;
  /** Arguments after `vu uv pip install` for each package family. */
  readonly install: Readonly<Record<string, readonly string[]>>;
  /** Families that cannot run on the detected hardware, with the reason. */
  readonly unsupported: Readonly<Record<string, string>>;
}

export function planStack(accelerator: Accelerator): StackPlan {
  const backend = torchBackend(accelerator);
  const unsupported: Record<string, string> = {};
  const install: Record<string, readonly string[]> = {
    torch: ["--torch-backend", backend, "torch"],
    jax:
      accelerator.kind === "cuda"
        ? [`jax[cuda${accelerator.version.split(".")[0]}]`]
        : accelerator.kind === "rocm"
          ? ["jax", "jax-rocm-plugin"]
          : ["jax"],
    vllm: ["--torch-backend", backend, "vllm"],
    pycuda: ["pycuda"],
  };
  if (accelerator.kind !== "cuda") {
    unsupported["pycuda"] = "PyCUDA needs an NVIDIA driver and the CUDA toolkit";
    delete install["pycuda"];
  }
  if (accelerator.kind === "cpu") {
    unsupported["vllm"] =
      "no accelerator detected; the CPU wheels of vLLM are not part of the default plan";
    delete install["vllm"];
  }
  return { accelerator, torchBackend: backend, install, unsupported };
}

if (import.meta.main) console.log(JSON.stringify(planStack(detectAccelerator()), null, 2));
