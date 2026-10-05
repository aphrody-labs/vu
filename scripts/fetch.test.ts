// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseArgs, pyo3Config, runtimeAsset } from "./fetch.ts";
import { readIdentity, readVendor, ROOT } from "./lib.ts";

const vendor = await readVendor();

describe("fetch", () => {
  test("the PyO3 configuration describes the shared libpython of the prefix", () => {
    expect(pyo3Config("/p/build/python", "3.12.15")).toBe(
      [
        "implementation=CPython",
        "version=3.12",
        "shared=true",
        "lib_name=python3.12",
        "lib_dir=/p/build/python/lib",
        "executable=/p/build/python/bin/python3.12",
        "pointer_width=64",
        "suppress_build_script_link_lines=false",
        "",
      ].join("\n"),
    );
  });

  test("the runtime asset is the install_only_stripped archive of the requested version", () => {
    const { asset, tag } = runtimeAsset(vendor, "3.12.15");
    expect(tag).toBe("20261003");
    expect(asset.name).toBe(
      "cpython-3.12.15+20261003-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz",
    );
    expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(runtimeAsset(vendor, "3.14.8").asset.name).toContain("3.14.8");
    expect(() => runtimeAsset(vendor, "3.9.0")).toThrow("no install_only_stripped asset");
  });

  test("arguments are parsed with defaults", () => {
    const options = parseArgs(["--python", "3.14.8", "--skip-sources"]);
    expect(options).toMatchObject({ python: "3.14.8", skipSources: true, skipPython: false });
    expect(options.root).toBe(ROOT);
  });
});

describe("pins", () => {
  test("every source is an exact commit on a branch named after the identity", async () => {
    const identity = await readIdentity();
    expect(identity.name).toBe("vu");
    for (const source of vendor.sources) {
      expect(source.ref).toMatch(/^[0-9a-f]{40}$/);
      expect(source.forkBranch).toBe(
        `${identity.name}-pin-${source.upstreamTag.replace(/^v/, "")}`,
      );
      expect(source.url).toBe(`https://github.com/aphrody-labs/${source.name}.git`);
    }
  });

  test("the embedding crate, the manifest and the pin name the same PyO3", async () => {
    const pyo3 = vendor.sources.find((source) => source.name === "pyo3");
    const version = pyo3?.upstreamTag.replace(/^v/, "");
    expect(version).toBeDefined();
    const manifest = await Bun.file(join(ROOT, "Cargo.toml")).text();
    expect(manifest).toContain(`version = "=${version}"`);
    const runtime = await Bun.file(join(ROOT, "crates/vu-runtime/src/lib.rs")).text();
    expect(runtime).toContain(`pub const PYO3_VERSION: &str = "${version}";`);
  });

  test("the default interpreter is pinned for both runtime and link inputs", () => {
    const release = vendor.releases.find((entry) => entry.name === "python-build-standalone");
    expect(release?.defaultPython).toBe("3.12.15");
    const mine = release?.assets.filter((asset) => asset.python === release.defaultPython) ?? [];
    expect(mine.map((asset) => asset.role.split(" ")[0])).toEqual(["runtime", "link"]);
  });
});
