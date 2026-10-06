// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { ratio, summarize } from "./bench.ts";

test("summaries are order independent and use the median", () => {
  const sample = summarize([5, 1, 3, 2, 4]);
  expect(sample.median).toBe(3);
  expect(sample.min).toBe(1);
  expect(sample.p10).toBe(1);
  expect(sample.ms).toEqual([5, 1, 3, 2, 4]);
});

test("the ratio is before over after medians, above 1 when the after arm is faster", () => {
  expect(ratio(summarize([10, 10, 10]), summarize([5, 5, 5]))).toBe(2);
  expect(ratio(summarize([5, 5, 5]), summarize([10, 10, 10]))).toBe(0.5);
});
