// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import {
  detectAccelerator,
  parseOverride,
  planStack,
  torchBackend,
  type Probes,
} from "./hardware.ts";

const probes = (over: Partial<Probes> = {}): Probes => ({
  env: {},
  nvidiaSmi: () => null,
  rocmVersion: () => null,
  ...over,
});

test("no accelerator is cpu", () => {
  expect(detectAccelerator(probes())).toEqual({ kind: "cpu" });
});

test("nvidia-smi names the CUDA version", () => {
  const out = "| NVIDIA-SMI 570.1  Driver Version: 570.1  CUDA Version: 12.8 |";
  expect(detectAccelerator(probes({ nvidiaSmi: () => out }))).toEqual({
    kind: "cuda",
    version: "12.8",
  });
});

test("ROCm version file", () => {
  expect(detectAccelerator(probes({ rocmVersion: () => "6.3.1-42" }))).toEqual({
    kind: "rocm",
    version: "6.3",
  });
});

test("override wins and bad override fails", () => {
  expect(
    detectAccelerator(
      probes({ env: { VU_ACCELERATOR: "cpu" }, nvidiaSmi: () => "CUDA Version: 12.8" }),
    ),
  ).toEqual({
    kind: "cpu",
  });
  expect(() => detectAccelerator(probes({ env: { VU_ACCELERATOR: "tpu" } }))).toThrow(
    "VU_ACCELERATOR",
  );
  expect(parseOverride("cuda12.6")).toEqual({ kind: "cuda", version: "12.6" });
});

test("the newest tag the driver can run is chosen", () => {
  expect(torchBackend({ kind: "cuda", version: "12.9" })).toBe("cu128");
  expect(torchBackend({ kind: "cuda", version: "12.5" })).toBe("cu124");
  expect(torchBackend({ kind: "cuda", version: "10.2" })).toBe("cpu");
  expect(torchBackend({ kind: "rocm", version: "6.3" })).toBe("rocm6.3");
  expect(torchBackend({ kind: "cpu" })).toBe("cpu");
});

test("stack plan per hardware", () => {
  const cuda = planStack({ kind: "cuda", version: "12.8" });
  expect(cuda.install["torch"]).toEqual(["--torch-backend", "cu128", "torch"]);
  expect(cuda.install["jax"]).toEqual(["jax[cuda12]"]);
  expect(cuda.install["pycuda"]).toBeDefined();
  const cpu = planStack({ kind: "cpu" });
  expect(cpu.install["torch"]).toEqual(["--torch-backend", "cpu", "torch"]);
  expect(Object.keys(cpu.unsupported).sort()).toEqual(["pycuda", "vllm"]);
  expect(Object.keys(planStack({ kind: "rocm", version: "6.4" }).unsupported)).toEqual(["pycuda"]);
});
