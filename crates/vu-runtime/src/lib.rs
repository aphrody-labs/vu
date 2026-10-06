// SPDX-License-Identifier: Apache-2.0
//! Embedded CPython for the vu runtime, through PyO3.
//!
//! The interpreter is the shared `libpython` of the pinned python-build-standalone distribution, found through the
//! runpath of the binary (`$ORIGIN/../lib`). Two entry points:
//!
//! * [`run_python`] runs the CPython command line (`Py_BytesMain`), for `vu python`;
//! * [`python_info`] uses the safe PyO3 API, for `vu --version`.
//!
//! Neither changes the environment of child processes: CPython finds its prefix from `argv[0]` in the first case,
//! and from `PYTHONHOME`, set for the duration of the initialisation only, in the second.

pub mod commands;
pub mod launcher;

use std::env;
use std::ffi::{CString, OsStr, OsString};
use std::os::raw::{c_char, c_int};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

/// Version of the PyO3 fork the runtime is built with. The repository tests assert that it equals the pin of
/// `vendor.json` and the requirement of the workspace manifest.
pub const PYO3_VERSION: &str = "0.29.3";

/// What the embedded interpreter reports about itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PythonInfo {
    /// `3.12.15`, with the suffix of a pre-release when there is one.
    pub version: String,
    /// The full `sys.version` banner.
    pub banner: String,
}

/// Why the interpreter cannot be started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeError {
    /// An argument contains a NUL byte and cannot cross the C boundary.
    NulInArgument,
    /// The argument list does not fit a C `int`.
    TooManyArguments,
}

impl std::fmt::Display for RuntimeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NulInArgument => f.write_str("an argument contains a NUL byte"),
            Self::TooManyArguments => f.write_str("too many arguments"),
        }
    }
}

impl std::error::Error for RuntimeError {}

/// The C strings of an argument vector, `interpreter` first.
fn c_arguments(interpreter: &OsStr, args: &[OsString]) -> Result<Vec<CString>, RuntimeError> {
    let mut owned = Vec::with_capacity(args.len() + 1);
    owned.push(CString::new(interpreter.as_bytes()).map_err(|_| RuntimeError::NulInArgument)?);
    for argument in args {
        owned.push(CString::new(argument.as_bytes()).map_err(|_| RuntimeError::NulInArgument)?);
    }
    Ok(owned)
}

/// Runs the CPython command line with `interpreter` as `argv[0]` and returns its exit status.
///
/// `interpreter` must be the `python3` of the runtime prefix: CPython derives `sys.prefix`, `sys.executable` and the
/// standard library location from it, so subprocesses started by the script behave like the standalone interpreter.
pub fn run_python(interpreter: &OsStr, args: &[OsString]) -> Result<i32, RuntimeError> {
    let owned = c_arguments(interpreter, args)?;
    let argc = c_int::try_from(owned.len()).map_err(|_| RuntimeError::TooManyArguments)?;
    let mut pointers: Vec<*mut c_char> = owned.iter().map(|c| c.as_ptr().cast_mut()).collect();
    pointers.push(std::ptr::null_mut());
    // SAFETY: `pointers` is a NULL-terminated array of NUL-terminated strings owned by `owned`, which outlives
    // the call; CPython copies `argv` before it returns. The interpreter has not been initialised by this
    // process (callers use either this function or `python_info`, never both).
    Ok(unsafe { pyo3::ffi::Py_BytesMain(argc, pointers.as_mut_ptr()) })
}

/// The version of the embedded interpreter through the safe PyO3 API.
///
/// `prefix` is the runtime prefix (the directory that holds `lib/python3.x`). It is exported as `PYTHONHOME` while
/// the interpreter initialises and removed again afterwards, so no child process inherits it.
pub fn python_info(prefix: &Path) -> PythonInfo {
    let previous = env::var_os("PYTHONHOME");
    // SAFETY: called from the main thread before any other thread of this process exists (the launcher is
    // single-threaded until the interpreter starts), so no concurrent reader of the environment can race.
    unsafe { env::set_var("PYTHONHOME", prefix) };
    pyo3::Python::initialize();
    // SAFETY: same single-threaded argument; the previous value is restored exactly.
    unsafe {
        match previous {
            Some(value) => env::set_var("PYTHONHOME", value),
            None => env::remove_var("PYTHONHOME"),
        }
    }
    pyo3::Python::attach(|py| {
        let info = py.version_info();
        let suffix = info.suffix.unwrap_or("");
        PythonInfo {
            version: format!("{}.{}.{}{}", info.major, info.minor, info.patch, suffix),
            banner: pyo3::Python::version_str().to_owned(),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::ffi::OsStringExt;

    #[test]
    fn nul_bytes_are_refused_before_the_interpreter_starts() {
        let bad = OsString::from_vec(vec![b'a', 0, b'b']);
        assert_eq!(
            run_python(OsStr::new("python3"), &[bad]),
            Err(RuntimeError::NulInArgument)
        );
    }

    #[test]
    fn the_interpreter_comes_first_in_the_argument_vector() {
        let owned = c_arguments(
            OsStr::new("/p/bin/python3"),
            &[OsString::from("-c"), OsString::from("1")],
        )
        .expect("plain arguments");
        let texts: Vec<&str> = owned.iter().map(|c| c.to_str().expect("utf-8")).collect();
        assert_eq!(texts, ["/p/bin/python3", "-c", "1"]);
    }

    #[test]
    fn the_pyo3_version_matches_the_manifest() {
        let manifest = include_str!("../../../Cargo.toml");
        assert!(manifest.contains(&format!("version = \"={PYO3_VERSION}\"")));
    }
}
