# SPDX-License-Identifier: Apache-2.0
"""`vu compile`: the smallest real compiler of the runtime, standard library only (decision in docs/plans/vu/PLAN.md).

Two products, both deterministic and both run by the embedded CPython of the runtime:

    vu compile <dir|file> [-O|-OO]
        byte-compiles every .py into `__pycache__` as unchecked-hash pycs (no timestamp, no source stat at import time:
        the cache is reproducible and is never rewritten by a later run);
    vu compile <dir> --zipapp -m <module:function> -o <app.pyz> [-O|-OO]
        bundles the byte-compiled tree into one executable archive with a `#!/usr/bin/env -S vu python` shebang.

Native AOT compilers (mypyc, Cython, Nuitka) are not bundled; they run through `vu uv tool run` when a project opts in.
"""

import compileall
import os
import py_compile
import shutil
import sys
import tempfile
import zipapp

SHEBANG = "/usr/bin/env -S vu python"


def optimize_level(args):
    if "-OO" in args:
        args.remove("-OO")
        return 2
    if "-O" in args:
        args.remove("-O")
        return 1
    return 0


def option(args, name):
    if name in args:
        at = args.index(name)
        if at + 1 < len(args):
            value = args[at + 1]
            del args[at : at + 2]
            return value
    return None


def compile_tree(path, level):
    """Byte-compiles `path` in place; returns the number of failures (0 is success)."""
    mode = py_compile.PycInvalidationMode.UNCHECKED_HASH
    if os.path.isdir(path):
        ok = compileall.compile_dir(path, quiet=1, force=True, optimize=level, invalidation_mode=mode)
    else:
        ok = bool(compileall.compile_file(path, quiet=1, force=True, optimize=level, invalidation_mode=mode))
    return 0 if ok else 1


def build_zipapp(source, main, output, level):
    """Copies `source`, byte-compiles the copy, and archives it; `main` is `module:function`."""
    if ":" not in main:
        raise ValueError("-m must be module:function")
    work = tempfile.mkdtemp(prefix="vu-compile-")
    try:
        tree = os.path.join(work, "app")
        shutil.copytree(source, tree, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".git"))
        if compile_tree(tree, level):
            raise RuntimeError("byte-compilation failed")
        zipapp.create_archive(tree, output, interpreter=SHEBANG, main=main, compressed=True)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main(argv):
    args = list(argv)
    level = optimize_level(args)
    use_zipapp = "--zipapp" in args
    if use_zipapp:
        args.remove("--zipapp")
    entry = option(args, "-m")
    output = option(args, "-o")
    if len(args) != 1 or (use_zipapp and not (entry and output)):
        print(
            "usage: vu compile <dir|file> [-O|-OO]\n"
            "       vu compile <dir> --zipapp -m <module:function> -o <app.pyz> [-O|-OO]",
            file=sys.stderr,
        )
        return 64
    target = args[0]
    if not os.path.exists(target):
        print("vu compile: %s does not exist" % target, file=sys.stderr)
        return 1
    try:
        if use_zipapp:
            build_zipapp(target, entry, output, level)
            os.chmod(output, 0o755)
            print(output)
            return 0
        return compile_tree(target, level)
    except (ValueError, RuntimeError, OSError) as error:
        print("vu compile: %s" % error, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
