// SPDX-License-Identifier: Apache-2.0
//! `vu`: the Aphrody Python runtime (tier T0: the pinned uv and ruff run as sidecars, CPython is embedded).
//!
//! ```text
//! package manager   vu add|remove|sync|lock|tree|init|venv|build|publish|export|tool|cache|pip ...  (uv, unmodified)
//!                   vu install                          uv sync
//! project runner    vu run <command>                    uv run, with the managed interpreter of the project
//! lint, format      vu lint ... | vu format ...         ruff check | ruff format
//! interpreters      vu python install|list|use|pin|find|dir   managed CPython versions (3.14 and others)
//!                   vu python [arguments]               the CPython command line; the project's .python-version
//!                                                       (or VU_PYTHON) picks the interpreter, installed on demand
//! ffi               vu ffi info|check                   the one shared libpython every host loads
//! hugging face      vu hf status|download|path          cache, token, endpoint, hub-layout downloads
//! compiler          vu compile ...                      byte-compile, or bundle into one executable archive
//! vu uv ... | vu ruff ...                               the tools themselves
//! vu --version [--json]
//! ```
//!
//! The launcher never links uv or ruff: their command lines are the public interface of both tools, so the real
//! binaries are executed and keep their own behaviour (`uv run` re-invokes the uv that set `$UV`).

use std::env;
use std::ffi::OsString;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use vu_runtime::commands::{
    COMPILE_PY, DLOPEN_MODE, HF_PY, PythonCommand, Route, embedded_satisfies, ffi_info, ffi_json,
    managed_env, requested_python, route, runtime_minor, vu_home,
};
use vu_runtime::launcher::json_string;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const TARGET: &str = env!("VU_TARGET");
/// Exit status when a command line is unusable (sysexits EX_USAGE).
const USAGE_ERROR: u8 = 64;
/// Exit status when an executable cannot be run (shell convention).
const NOT_RUNNABLE: u8 = 127;

const HELP: &str = "vu: the Aphrody Python runtime\n\
\n\
usage: vu <command> [arguments]\n\
\n\
package manager (uv):\n\
  add remove sync lock tree init venv build publish export tool cache pip   as `uv <command>`\n\
  install             uv sync\n\
  run <command>       uv run, on the project's interpreter\n\
lint and format (ruff):\n\
  lint [paths]        ruff check\n\
  format [paths]      ruff format\n\
interpreters:\n\
  python install [versions]   download CPython versions (3.14, 3.13, ...) into the vu home\n\
  python list                 the runtime's interpreter and the installed ones\n\
  python use <version>        install when missing and write .python-version\n\
  python pin <version>        write .python-version\n\
  python find [version]       path of an interpreter that satisfies the request\n\
  python dir                  where managed interpreters live\n\
  python [arguments]          the CPython command line; .python-version or VU_PYTHON picks the interpreter\n\
other:\n\
  ffi info|check [--json]     the shared libpython (path, ABI, dlopen mode) for Bun, libaphrody and extensions\n\
  hf status|download|path     Hugging Face cache, token, endpoint and downloads\n\
  compile <dir|file>          byte-compile; --zipapp -m <module:function> -o <app.pyz> bundles an executable\n\
  uv <arguments>              run the pinned uv\n\
  ruff <arguments>            run the pinned ruff\n\
  --version [--json]          versions of the runtime and of its parts\n\
  --help                      this text\n\
\n\
environment: VU_HOME (default ~/.vu), VU_PYTHON (interpreter request), VU_ACCELERATOR (cpu, cuda12.8, rocm6.3:\n\
the wheel backend; default auto-detection by uv).\n";

fn main() -> ExitCode {
    let mut arguments = env::args_os();
    arguments.next();
    let arguments: Vec<OsString> = arguments.collect();
    let Some(prefix) = runtime_prefix() else {
        eprintln!("vu: cannot locate the runtime directory (expected <prefix>/bin/vu)");
        return ExitCode::from(NOT_RUNNABLE);
    };
    match route(&arguments) {
        Route::Uv(rest) => exec_sidecar(&prefix, "uv", &rest),
        Route::Ruff(rest) => exec_sidecar(&prefix, "ruff", &rest),
        Route::Python(rest) => python(&prefix, &rest),
        Route::PythonManager(command) => python_manager(&prefix, command),
        Route::Ffi(rest) => ffi(&prefix, &rest),
        Route::Hf(rest) => embedded_program(&prefix, HF_PY, &rest),
        Route::Compile(rest) => embedded_program(&prefix, COMPILE_PY, &rest),
        Route::Version { json } => {
            version(&prefix, json);
            ExitCode::SUCCESS
        }
        Route::Help => {
            print!("{HELP}");
            ExitCode::SUCCESS
        }
        Route::Unknown(other) => {
            eprintln!("vu: unknown command `{other}`\n\n{HELP}");
            ExitCode::from(USAGE_ERROR)
        }
    }
}

/// `<prefix>` of `<prefix>/bin/vu`, with symlinks resolved.
fn runtime_prefix() -> Option<PathBuf> {
    let executable = env::current_exe().ok()?.canonicalize().ok()?;
    Some(executable.parent()?.parent()?.to_path_buf())
}

/// The environment `vu` gives to everything it starts (see [`managed_env`]).
fn child_env(prefix: &Path) -> Vec<(String, OsString)> {
    let home = vu_home(
        env::var_os("VU_HOME").as_deref(),
        env::var_os("HOME").as_deref(),
    );
    managed_env(prefix, &home, &|name| env::var_os(name))
}

fn command_for(prefix: &Path, tool: &str, arguments: &[OsString]) -> Command {
    let mut command = Command::new(prefix.join("bin").join(tool));
    command.args(arguments);
    command.envs(child_env(prefix));
    command
}

/// Replaces this process by a sidecar of the runtime; only returns (with a status) when that fails.
fn exec_sidecar(prefix: &Path, tool: &str, arguments: &[OsString]) -> ExitCode {
    let error = command_for(prefix, tool, arguments).exec();
    eprintln!(
        "vu: cannot run {}: {error}",
        prefix.join("bin").join(tool).display()
    );
    ExitCode::from(NOT_RUNNABLE)
}

/// Runs a sidecar to completion and returns its exit status (for commands made of several steps).
fn run_sidecar(prefix: &Path, tool: &str, arguments: &[OsString]) -> Result<u8, String> {
    let status = command_for(prefix, tool, arguments)
        .status()
        .map_err(|error| format!("cannot run {tool}: {error}"))?;
    Ok(u8::try_from(status.code().unwrap_or(1).clamp(0, 255)).unwrap_or(1))
}

fn os(items: &[&str]) -> Vec<OsString> {
    items.iter().map(OsString::from).collect()
}

/// `vu python install|list|use|pin|find|dir`: interpreter management through uv, into `<vu home>/python`.
fn python_manager(prefix: &Path, command: PythonCommand) -> ExitCode {
    let with = |head: &[&str], tail: &[OsString]| {
        let mut all = os(head);
        all.extend(tail.iter().cloned());
        all
    };
    let result = match command {
        PythonCommand::Install(versions) => run_sidecar(
            prefix,
            "uv",
            &with(&["python", "install", "--no-bin"], &versions),
        ),
        PythonCommand::List(rest) => {
            if let Some(minor) = runtime_minor(prefix) {
                println!(
                    "cpython-{minor} (runtime, embedded)    {}",
                    prefix.join("bin").join("python3").display()
                );
            }
            let tail = if rest.is_empty() {
                os(&["--only-installed"])
            } else {
                rest
            };
            run_sidecar(prefix, "uv", &with(&["python", "list"], &tail))
        }
        PythonCommand::Use(versions) => run_sidecar(
            prefix,
            "uv",
            &with(&["python", "install", "--no-bin"], &versions),
        )
        .and_then(|status| {
            if status == 0 {
                run_sidecar(prefix, "uv", &with(&["python", "pin"], &versions))
            } else {
                Ok(status)
            }
        }),
        PythonCommand::Pin(rest) => run_sidecar(prefix, "uv", &with(&["python", "pin"], &rest)),
        PythonCommand::Find(rest) => run_sidecar(prefix, "uv", &with(&["python", "find"], &rest)),
        PythonCommand::Dir => run_sidecar(prefix, "uv", &os(&["python", "dir"])),
    };
    match result {
        Ok(status) => ExitCode::from(status),
        Err(message) => {
            eprintln!("vu: {message}");
            ExitCode::from(NOT_RUNNABLE)
        }
    }
}

/// The path of an interpreter that answers `request`, installing it first when none does.
fn managed_interpreter(prefix: &Path, request: &str) -> Result<PathBuf, String> {
    let find = || -> Result<Option<PathBuf>, String> {
        let output = command_for(prefix, "uv", &os(&["python", "find", request]))
            .output()
            .map_err(|error| format!("cannot run uv: {error}"))?;
        let text = String::from_utf8_lossy(&output.stdout);
        Ok(output
            .status
            .success()
            .then(|| text.lines().next().map(PathBuf::from))
            .flatten()
            .filter(|path| !path.as_os_str().is_empty()))
    };
    if let Some(path) = find()? {
        return Ok(path);
    }
    eprintln!("vu: installing Python {request} (requested by VU_PYTHON or .python-version)");
    let status = run_sidecar(
        prefix,
        "uv",
        &os(&["python", "install", "--no-bin", request]),
    )?;
    if status != 0 {
        return Err(format!("uv could not install Python {request}"));
    }
    find()?.ok_or_else(|| format!("no interpreter satisfies {request} after installation"))
}

/// `vu python [arguments]`: the embedded interpreter, or the one the project asks for.
fn python(prefix: &Path, arguments: &[OsString]) -> ExitCode {
    let start = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if let Some(request) = requested_python(env::var_os("VU_PYTHON").as_deref(), &start) {
        let embedded =
            runtime_minor(prefix).is_some_and(|minor| embedded_satisfies(&request, &minor));
        if !embedded {
            return match managed_interpreter(prefix, &request) {
                Ok(interpreter) => {
                    let error = Command::new(&interpreter)
                        .args(arguments)
                        .envs(child_env(prefix))
                        .exec();
                    eprintln!("vu: cannot run {}: {error}", interpreter.display());
                    ExitCode::from(NOT_RUNNABLE)
                }
                Err(message) => {
                    eprintln!("vu: {message}");
                    ExitCode::from(NOT_RUNNABLE)
                }
            };
        }
    }
    embedded_python(prefix, arguments)
}

/// The embedded interpreter, with the runtime's own `python3` as `argv[0]` (see `vu_runtime::run_python`).
fn embedded_python(prefix: &Path, arguments: &[OsString]) -> ExitCode {
    let interpreter = prefix.join("bin").join("python3");
    if !interpreter.exists() {
        eprintln!("vu: {} is missing from the runtime", interpreter.display());
        return ExitCode::from(NOT_RUNNABLE);
    }
    match vu_runtime::run_python(interpreter.as_os_str(), arguments) {
        Ok(status) => ExitCode::from(u8::try_from(status.clamp(0, 255)).unwrap_or(1)),
        Err(error) => {
            eprintln!("vu: {error}");
            ExitCode::from(USAGE_ERROR)
        }
    }
}

/// Runs a program shipped inside the binary (`vu hf`, `vu compile`) on the embedded interpreter.
fn embedded_program(prefix: &Path, source: &str, arguments: &[OsString]) -> ExitCode {
    let mut all = vec![OsString::from("-c"), OsString::from(source)];
    all.extend(arguments.iter().cloned());
    embedded_python(prefix, &all)
}

/// `vu ffi info|check [--json]`: what a host needs to load the one shared libpython of this runtime.
fn ffi(prefix: &Path, arguments: &[OsString]) -> ExitCode {
    let json = arguments.iter().any(|a| a == "--json");
    let command = arguments
        .iter()
        .find_map(|a| a.to_str().filter(|text| !text.starts_with("--")))
        .unwrap_or("info");
    let info = match ffi_info(prefix) {
        Ok(info) => info,
        Err(message) => {
            eprintln!("vu ffi: {message}");
            return ExitCode::from(NOT_RUNNABLE);
        }
    };
    match command {
        "info" => {
            if json {
                println!("{}", ffi_json(&info));
            } else {
                println!("prefix     {} (PYTHONHOME)", info.prefix.display());
                println!("libpython  {}", info.libpython.display());
                println!("python     {}", info.minor);
                println!(
                    "include    {}",
                    info.include
                        .as_ref()
                        .map_or_else(|| "none".to_owned(), |p| p.display().to_string())
                );
                println!("dlopen     {DLOPEN_MODE} (abi3 extensions do not link libpython)");
            }
            ExitCode::SUCCESS
        }
        "check" => {
            if info.libraries == 1 {
                println!("ok: one shared libpython ({})", info.soname);
                ExitCode::SUCCESS
            } else {
                eprintln!(
                    "vu ffi: {} libpython files in the runtime, the contract is one",
                    info.libraries
                );
                ExitCode::from(1)
            }
        }
        other => {
            eprintln!("vu ffi: unknown command `{other}` (info, check)");
            ExitCode::from(USAGE_ERROR)
        }
    }
}

/// The first line of `<tool> --version`, or `unavailable`.
fn tool_version(prefix: &Path, tool: &str) -> String {
    Command::new(prefix.join("bin").join(tool))
        .arg("--version")
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|text| text.lines().next().map(str::to_owned))
        .unwrap_or_else(|| "unavailable".to_owned())
}

fn version(prefix: &Path, json: bool) {
    let uv = tool_version(prefix, "uv");
    let ruff = tool_version(prefix, "ruff");
    let python = vu_runtime::python_info(prefix);
    if json {
        println!(
            "{{\"schema\":\"aphrody.vu/1\",\"vu\":{},\"uv\":{},\"ruff\":{},\"python\":{},\"pyo3\":{},\"target\":{}}}",
            json_string(VERSION),
            json_string(&uv),
            json_string(&ruff),
            json_string(&python.version),
            json_string(vu_runtime::PYO3_VERSION),
            json_string(TARGET),
        );
    } else {
        println!(
            "vu {VERSION} ({uv}; {ruff}; CPython {} through PyO3 {}; {TARGET})",
            python.version,
            vu_runtime::PYO3_VERSION
        );
    }
}
