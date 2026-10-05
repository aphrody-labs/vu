// SPDX-License-Identifier: Apache-2.0
//! `vu`: the Aphrody Python runtime launcher (tier T0).
//!
//! ```text
//! vu uv ...        the pinned uv, unmodified, from the runtime's bin/
//! vu ruff ...      the pinned ruff, unmodified, from the runtime's bin/
//! vu python ...    the embedded CPython command line (PyO3, shared libpython of the runtime)
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

use vu_runtime::launcher::{json_string, path_with};

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
commands:\n\
  uv <arguments>      run the pinned uv\n\
  ruff <arguments>    run the pinned ruff\n\
  python [arguments]  run the embedded CPython command line\n\
  --version [--json]  versions of the runtime and of its parts\n\
  --help              this text\n";

fn main() -> ExitCode {
    let mut arguments = env::args_os();
    arguments.next();
    let arguments: Vec<OsString> = arguments.collect();
    let Some(prefix) = runtime_prefix() else {
        eprintln!("vu: cannot locate the runtime directory (expected <prefix>/bin/vu)");
        return ExitCode::from(NOT_RUNNABLE);
    };
    match arguments.first().and_then(|a| a.to_str()) {
        Some("uv") => exec_sidecar(&prefix, "uv", &arguments[1..]),
        Some("ruff") => exec_sidecar(&prefix, "ruff", &arguments[1..]),
        Some("python" | "python3") => python(&prefix, &arguments[1..]),
        Some("--version" | "-V") => {
            version(&prefix, arguments.iter().any(|a| a == "--json"));
            ExitCode::SUCCESS
        }
        Some("--help" | "-h") | None => {
            print!("{HELP}");
            ExitCode::SUCCESS
        }
        Some(other) => {
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

/// Replaces this process by a sidecar of the runtime; only returns (with a status) when that fails.
fn exec_sidecar(prefix: &Path, tool: &str, arguments: &[OsString]) -> ExitCode {
    let program = prefix.join("bin").join(tool);
    let error = Command::new(&program)
        .args(arguments)
        .env("VU_RUNTIME", prefix)
        .env("PATH", path_with(prefix, env::var_os("PATH")))
        .exec();
    eprintln!("vu: cannot run {}: {error}", program.display());
    ExitCode::from(NOT_RUNNABLE)
}

/// The embedded interpreter, with the runtime's own `python3` as `argv[0]` (see `vu_runtime::run_python`).
fn python(prefix: &Path, arguments: &[OsString]) -> ExitCode {
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
