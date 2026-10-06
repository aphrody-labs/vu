// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadFile, hfChildEnv, readToken, repoFolder, resolveHf } from "./huggingface.ts";

let scratch = "";
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "vu-hf-"));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

test("defaults follow huggingface_hub: HF_HOME, XDG, ~/.cache/huggingface", () => {
  expect(resolveHf({}, "/h").hubCache).toBe("/h/.cache/huggingface/hub");
  expect(resolveHf({ XDG_CACHE_HOME: "/x" }, "/h").home).toBe("/x/huggingface");
  expect(resolveHf({ HF_HOME: "/data/hf" }, "/h").hubCache).toBe("/data/hf/hub");
  expect(resolveHf({ HF_HUB_CACHE: "/c" }, "/h").hubCache).toBe("/c");
  expect(resolveHf({ HF_ENDPOINT: "https://mirror.example/" }, "/h").endpoint).toBe(
    "https://mirror.example",
  );
});

test("token precedence and it is never in the report", () => {
  const home = join(scratch, "home");
  mkdirSync(join(home, ".cache/huggingface"), { recursive: true });
  writeFileSync(join(home, ".cache/huggingface/token"), "hf_file\n");
  expect(readToken({}, home)).toEqual({ value: "hf_file", source: "file" });
  expect(readToken({ HF_TOKEN: "hf_env" }, home)?.source).toBe("HF_TOKEN");
  const report = JSON.stringify(resolveHf({ HF_TOKEN: "hf_secret" }, home));
  expect(report).not.toContain("hf_secret");
  expect(JSON.parse(report).token).toEqual({ present: true, source: "HF_TOKEN" });
});

test("child environment pins cache and endpoint", () => {
  expect(hfChildEnv({ HF_HOME: "/d" }, "/h")).toEqual({
    HF_HOME: "/d",
    HF_HUB_CACHE: "/d/hub",
    HF_ENDPOINT: "https://huggingface.co",
  });
});

test("repository ids are validated", () => {
  expect(repoFolder("org/name")).toBe("models--org--name");
  expect(() => repoFolder("../etc/passwd")).toThrow("invalid repository id");
});

const COMMIT = "a".repeat(40);
const fakeFetch = (calls: { url: string; auth: string | null }[]): typeof fetch =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
    return new Response("weights", {
      headers: { "x-repo-commit": COMMIT, "x-linked-etag": '"deadbeef01"' },
    });
  }) as typeof fetch;

test("download writes the hub layout, sends the token, and a second call hits the cache", async () => {
  const env = { HF_HOME: join(scratch, "hf"), HF_TOKEN: "hf_secret" };
  const calls: { url: string; auth: string | null }[] = [];
  const first = await downloadFile("org/model", "dir/config.json", {
    env,
    fetcher: fakeFetch(calls),
  });
  expect(first.cached).toBe(false);
  expect(calls[0]?.url).toBe("https://huggingface.co/org/model/resolve/main/dir/config.json");
  expect(calls[0]?.auth).toBe("Bearer hf_secret");
  const folder = join(scratch, "hf/hub/models--org--model");
  expect(readFileSync(join(folder, "refs/main"), "utf8")).toBe(COMMIT);
  expect(readFileSync(join(folder, "blobs/deadbeef01"), "utf8")).toBe("weights");
  expect(lstatSync(first.path).isSymbolicLink()).toBe(true);
  expect(readlinkSync(first.path)).toBe("../../../blobs/deadbeef01");
  expect(readFileSync(first.path, "utf8")).toBe("weights");
  const second = await downloadFile("org/model", "dir/config.json", {
    env,
    fetcher: fakeFetch(calls),
  });
  expect(second.cached).toBe(true);
  expect(calls.length).toBe(1);
});

test("offline mode refuses to fetch", async () => {
  const env = { HF_HOME: join(scratch, "hf"), HF_HUB_OFFLINE: "1" };
  await expect(downloadFile("org/model", "x", { env, fetcher: fakeFetch([]) })).rejects.toThrow(
    "HF_HUB_OFFLINE",
  );
});
