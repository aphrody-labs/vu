// Install prebuilt crate binaries from cargo-quickinstall releases (same source as cargo-binstall's QuickInstall strategy).
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TARGET = "x86_64-unknown-linux-gnu";
const BIN = `${process.env.HOME}/.cargo/bin`;
const crates = process.argv.slice(2);

function indexPath(name: string): string {
  const n = name.toLowerCase();
  if (n.length <= 2) return `${n.length}/${n}`;
  if (n.length === 3) return `3/${n[0]}/${n}`;
  return `${n.slice(0, 2)}/${n.slice(2, 4)}/${n}`;
}

async function versions(name: string): Promise<string[]> {
  const res = await fetch(`https://index.crates.io/${indexPath(name)}`);
  if (!res.ok) throw new Error(`index ${res.status}`);
  const rows = (await res.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { vers: string; yanked: boolean })
    .filter((r) => !r.yanked && !r.vers.includes("-"))
    .map((r) => r.vers);
  return rows.reverse();
}

for (const name of crates) {
  let done = false;
  let vs: string[] = [];
  try {
    vs = await versions(name);
  } catch (error) {
    console.log(`FAIL ${name}: ${error}`);
    continue;
  }
  for (const v of vs.slice(0, 8)) {
    const url = `https://github.com/cargo-bins/cargo-quickinstall/releases/download/${name}-${v}/${name}-${v}-${TARGET}.tar.gz`;
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) continue;
    const dir = await mkdtemp(join(tmpdir(), "qi-"));
    const archive = join(dir, "a.tar.gz");
    await Bun.write(archive, await res.arrayBuffer());
    await mkdir(BIN, { recursive: true });
    const tar = Bun.spawnSync(["tar", "-xzf", archive, "-C", BIN, "--no-same-owner"]);
    await rm(dir, { recursive: true, force: true });
    if (tar.exitCode === 0) {
      console.log(`ok   ${name} ${v}`);
      done = true;
    } else {
      console.log(`FAIL ${name} ${v}: tar ${tar.stderr.toString().trim()}`);
    }
    break;
  }
  if (!done && !vs.length) console.log(`FAIL ${name}: no version`);
  else if (!done) console.log(`FAIL ${name}: no prebuilt among the 8 latest versions`);
}
