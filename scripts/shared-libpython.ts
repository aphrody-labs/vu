// SPDX-License-Identifier: Apache-2.0
//! One libpython for Bun, Python and Rust: Bun loads the runtime's shared CPython with bun:ffi, initialises it in its own
//! process, and runs Python code that imports a Rust extension (the aphrody wheel, PyO3) and hands a value back to Bun.
//! Only one libpython is mapped in the process: the extension resolves its `Py*` symbols against it (it does not link
//! libpython itself).
//!
//! ABI (documented in the plan, section 14): the C API of CPython 3.12 (`Py_InitializeEx`, `PyRun_SimpleString`,
//! `Py_FinalizeEx`), loaded from `<artifact>/lib/libpython3.12.so.1.0` with `PYTHONHOME=<artifact>`; extensions are abi3
//! (`abi3-py311`), so any 3.11+ shared libpython satisfies them. Python code returns values through a file or a pipe
//! (no object crosses the boundary).
//!
//!   bun scripts/shared-libpython.ts <artifact dir> [--site <site-packages with the aphrody wheel>]

import { dlopen, FFIType, ptr } from "bun:ffi";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SharedResult {
  readonly libpython: string;
  readonly version: string;
  readonly value: string;
}

export function findLibpython(artifact: string): string | null {
  const lib = join(artifact, "lib");
  if (!existsSync(lib)) return null;
  const name = readdirSync(lib).find((file) => /^libpython3\.\d+\.so\.\d/.test(file));
  return name === undefined ? null : join(lib, name);
}

const cstr = (text: string): Uint8Array => new TextEncoder().encode(`${text}\0`);

/**
 * Runs `code` inside the runtime's libpython loaded into this process and returns what the code wrote to the result
 * file (`RESULT_PATH` in its globals). Python is initialised once per process; call it in a child process in tests.
 */
export interface SharedOptions {
  /**
   * Promote the mapping to global from inside Python (`ctypes`). The default is true because stock Bun maps with
   * RTLD_LOCAL; with the yolo fork (`dlopen(..., { global: true })`) pass false to prove no promotion is needed.
   */
  readonly promote?: boolean;
}

export function runInSharedPython(
  artifact: string,
  code: string,
  site?: string,
  options: SharedOptions = {},
): SharedResult {
  const libpython = findLibpython(artifact);
  if (libpython === null) throw new Error(`no shared libpython under ${artifact}/lib`);
  process.env["PYTHONHOME"] = artifact;
  process.env["PYTHONDONTWRITEBYTECODE"] = "1";
  const promote = options.promote ?? true;
  const symbols = {
    Py_InitializeEx: { args: [FFIType.i32], returns: FFIType.void },
    Py_GetVersion: { args: [], returns: FFIType.cstring },
    PyRun_SimpleString: { args: [FFIType.ptr], returns: FFIType.i32 },
    Py_FinalizeEx: { args: [], returns: FFIType.i32 },
  } as const;
  // The yolo fork opens the library RTLD_NOW|RTLD_GLOBAL with `{ global: true }`; stock Bun ignores the option.
  const python = (
    dlopen as (
      path: string,
      symbols: typeof symbols,
      options?: { global?: boolean },
    ) => ReturnType<typeof dlopen<typeof symbols>>
  )(libpython, symbols, { global: true });
  const directory = mkdtempSync(join(tmpdir(), "vu-shared-"));
  const resultPath = join(directory, "result.txt");
  try {
    python.symbols.Py_InitializeEx(0);
    const version = String(python.symbols.Py_GetVersion()).split(" ")[0] ?? "";
    const prelude = [
      promote ? "import sys, ctypes" : "import sys",
      // bun:ffi maps the library RTLD_LOCAL; promote that same mapping to global so abi3 extensions (which do not link
      // libpython) resolve their Py* symbols against it. The yolo fork dlopens with RTLD_GLOBAL: no promotion needed.
      promote ? `ctypes.CDLL(${JSON.stringify(libpython)}, mode=ctypes.RTLD_GLOBAL)` : "",
      site === undefined ? "" : `sys.path.insert(0, ${JSON.stringify(site)})`,
      `RESULT_PATH = ${JSON.stringify(resultPath)}`,
    ].join("\n");
    for (const source of [prelude, code]) {
      if (python.symbols.PyRun_SimpleString(ptr(cstr(source))) !== 0)
        throw new Error("the Python code raised an exception (see stderr)");
    }
    const value = existsSync(resultPath) ? readFileSync(resultPath, "utf8") : "";
    return { libpython, version, value };
  } finally {
    python.symbols.Py_FinalizeEx();
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const artifact = process.argv[2];
  const siteAt = process.argv.indexOf("--site");
  const site = siteAt >= 0 ? process.argv[siteAt + 1] : undefined;
  if (artifact === undefined) {
    console.error("usage: bun scripts/shared-libpython.ts <artifact dir> [--site <dir>]");
    process.exit(2);
  }
  const code =
    site === undefined
      ? "open(RESULT_PATH, 'w').write(sys.version.split()[0])"
      : "from aphrody import aphrody_rust as r\nopen(RESULT_PATH, 'w').write(repr(r.cosine_similarity([1.0, 2.0], [1.0, 2.0])))";
  console.log(JSON.stringify(runInSharedPython(artifact, code, site)));
}
