// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { mapLimit, minorOf, sha256Bytes, workspaceVersion } from "./lib.ts";

describe("lib", () => {
  test("mapLimit keeps the order and never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(5);
      inFlight--;
      return n * 2;
    });
    expect(results).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
    expect(peak).toBeLessThanOrEqual(3);
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });

  test("minorOf keeps major and minor", () => {
    expect(minorOf("3.12.15")).toBe("3.12");
    expect(() => minorOf("3.12")).toThrow("not a CPython version");
  });

  test("sha256 of a known value", () => {
    expect(sha256Bytes(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("the workspace version is read from the root manifest", async () => {
    expect(await workspaceVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
