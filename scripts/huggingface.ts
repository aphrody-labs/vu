// SPDX-License-Identifier: Apache-2.0
//! Native Hugging Face configuration: where the cache, the token and the endpoint are, the environment handed to every
//! child of the runtime, and a download into the hub-compatible cache layout (`models--org--name/{blobs,snapshots,refs}`),
//! so `huggingface_hub`, `transformers`, vLLM and friends find what vu fetched, and the reverse.
//!
//! The token is read from `HF_TOKEN`, then `HF_TOKEN_PATH`, then `<HF_HOME>/token`; it is only ever sent as a Bearer header
//! to the configured endpoint and never printed (status reports `present`/`absent` and its source).

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

type Env = Readonly<Record<string, string | undefined>>;

export interface HfConfig {
  readonly home: string;
  readonly hubCache: string;
  readonly endpoint: string;
  readonly offline: boolean;
  readonly token: {
    readonly present: boolean;
    readonly source: "HF_TOKEN" | "HF_TOKEN_PATH" | "file" | null;
  };
}

const filled = (value: string | undefined): string | undefined =>
  value !== undefined && value !== "" ? value : undefined;

export function hfHome(env: Env = process.env, home: string = homedir()): string {
  const explicit = filled(env["HF_HOME"]);
  if (explicit) return resolve(explicit);
  const xdg = filled(env["XDG_CACHE_HOME"]);
  return join(xdg ?? join(home, ".cache"), "huggingface");
}

export function readToken(
  env: Env = process.env,
  home: string = homedir(),
): { value: string; source: NonNullable<HfConfig["token"]["source"]> } | null {
  const direct = filled(env["HF_TOKEN"]) ?? filled(env["HUGGING_FACE_HUB_TOKEN"]);
  if (direct) return { value: direct.trim(), source: "HF_TOKEN" };
  const path = filled(env["HF_TOKEN_PATH"]);
  const candidates: [string, "HF_TOKEN_PATH" | "file"][] = [];
  if (path) candidates.push([resolve(path), "HF_TOKEN_PATH"]);
  candidates.push([join(hfHome(env, home), "token"), "file"]);
  for (const [file, source] of candidates) {
    if (existsSync(file)) {
      const value = readFileSync(file, "utf8").trim();
      if (value !== "") return { value, source };
    }
  }
  return null;
}

export function resolveHf(env: Env = process.env, home: string = homedir()): HfConfig {
  const base = hfHome(env, home);
  const token = readToken(env, home);
  return {
    home: base,
    hubCache: resolve(
      filled(env["HF_HUB_CACHE"]) ?? filled(env["HUGGINGFACE_HUB_CACHE"]) ?? join(base, "hub"),
    ),
    endpoint: (filled(env["HF_ENDPOINT"]) ?? "https://huggingface.co").replace(/\/+$/, ""),
    offline: filled(env["HF_HUB_OFFLINE"]) === "1",
    token: { present: token !== null, source: token?.source ?? null },
  };
}

/** The variables a child process (uv, python, vllm) must see so every tool agrees on the same cache and endpoint. */
export function hfChildEnv(
  env: Env = process.env,
  home: string = homedir(),
): Record<string, string> {
  const config = resolveHf(env, home);
  return { HF_HOME: config.home, HF_HUB_CACHE: config.hubCache, HF_ENDPOINT: config.endpoint };
}

/** `org/name` to the hub cache folder name. */
export function repoFolder(repo: string, kind: "model" | "dataset" | "space" = "model"): string {
  if (!/^[\w.-]+(\/[\w.-]+)?$/.test(repo)) throw new Error(`invalid repository id: ${repo}`);
  return `${kind}s--${repo.replaceAll("/", "--")}`;
}

export interface DownloadResult {
  readonly path: string;
  readonly commit: string;
  readonly cached: boolean;
}

/**
 * Downloads one file of a repository into the hub cache layout: the content under `blobs/<etag>`, a relative symlink in
 * `snapshots/<commit>/<file>`, the revision in `refs/<revision>`. A file already in the snapshot is not fetched again.
 */
export async function downloadFile(
  repo: string,
  file: string,
  options: { revision?: string; env?: Env; home?: string; fetcher?: typeof fetch } = {},
): Promise<DownloadResult> {
  const env = options.env ?? process.env;
  const config = resolveHf(env, options.home);
  const revision = options.revision ?? "main";
  const folder = join(config.hubCache, repoFolder(repo));
  const ref = join(folder, "refs", revision);
  if (/^[0-9a-f]{40}$/.test(revision) === false && existsSync(ref)) {
    const commit = readFileSync(ref, "utf8").trim();
    const known = join(folder, "snapshots", commit, file);
    if (existsSync(known)) return { path: known, commit, cached: true };
  }
  if (config.offline) throw new Error(`${repo}/${file} is not cached and HF_HUB_OFFLINE=1`);
  const token = readToken(env, options.home);
  const url = `${config.endpoint}/${repo}/resolve/${encodeURIComponent(revision)}/${file.split("/").map(encodeURIComponent).join("/")}`;
  const response = await (options.fetcher ?? fetch)(url, {
    headers: token ? { authorization: `Bearer ${token.value}` } : {},
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const commit =
    response.headers.get("x-repo-commit") ?? (/^[0-9a-f]{40}$/.test(revision) ? revision : null);
  const etag = (
    response.headers.get("x-linked-etag") ??
    response.headers.get("etag") ??
    ""
  ).replaceAll(/^W\/|"/g, "");
  if (commit === null || !/^[\w-]+$/.test(etag))
    throw new Error(`${url}: the response lacks x-repo-commit or an etag`);
  const blob = join(folder, "blobs", etag);
  mkdirSync(dirname(blob), { recursive: true });
  const partial = `${blob}.incomplete`;
  writeFileSync(partial, new Uint8Array(await response.arrayBuffer()));
  renameSync(partial, blob);
  const link = join(folder, "snapshots", commit, file);
  mkdirSync(dirname(link), { recursive: true });
  rmSync(link, { force: true });
  symlinkSync(relative(dirname(link), blob), link);
  mkdirSync(dirname(ref), { recursive: true });
  writeFileSync(ref, commit);
  return { path: link, commit, cached: false };
}

if (import.meta.main) {
  const [command, repo, file] = process.argv.slice(2);
  if (command === "status" || command === undefined) {
    console.log(JSON.stringify(resolveHf(), null, 2));
  } else if (command === "download" && repo && file) {
    console.log(JSON.stringify(await downloadFile(repo, file)));
  } else {
    console.error("usage: bun scripts/huggingface.ts [status | download <org/name> <file>]");
    process.exit(2);
  }
}
