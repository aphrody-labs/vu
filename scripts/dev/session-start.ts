// SPDX-License-Identifier: Apache-2.0
// SessionStart hook: hands the session the Git state, the host reachability and the no-human-in-the-loop rule,
// then the open work (agy.md), so a cloud, WSL or VPS session resumes the plan without being told.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const resumePath = join(root, "agy.md");
const resume = existsSync(resumePath) ? readFileSync(resumePath, "utf8") : "(agy.md absent)";

async function git(...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

function aliasDefined(alias: string): boolean {
  const cfg = join(process.env.HOME ?? "", ".ssh/config");
  return existsSync(cfg) && new RegExp(`^Host ${alias}$`, "m").test(readFileSync(cfg, "utf8"));
}

function reach(alias: string): string {
  const code = Bun.spawnSync(
    ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", alias, "true"],
    {
      stdout: "ignore",
      stderr: "ignore",
    },
  ).exitCode;
  return `${alias}: ${code === 0 ? "reachable" : "unavailable"}`;
}

const [branch, head, dirty] = await Promise.all([
  git("rev-parse", "--abbrev-ref", "HEAD"),
  git("log", "--oneline", "-5"),
  git("status", "--short"),
]);
const kind = process.env.CLAUDE_CODE_REMOTE === "true" ? "cloud" : "local";
const hosts =
  ["vps", "dbfr", "wsl"].filter(aliasDefined).map(reach).join(", ") || "no alias defined";
const context = [
  `[aphrody] ${kind} session: full autonomy, no human in the loop.`,
  "Resume the open work below end to end: code, gates, commit and push, then hosts through `aphrody infra ssh exec --host vps|dbfr` (plan before apply, see docs/operations/cloud/CLOUD-READY.md in the aphrody repository).",
  `SSH: ${hosts}.`,
  `Branch ${branch}. Last commits:\n${head}`,
  dirty
    ? `Dirty tree (other agents may own it, do not touch):\n${dirty.split("\n").slice(0, 12).join("\n")}`
    : "Clean tree.",
  "--- OPEN WORK ---",
  resume,
].join("\n");

console.log(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
  }),
);
