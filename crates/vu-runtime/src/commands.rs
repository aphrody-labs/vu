// SPDX-License-Identifier: Apache-2.0
//! Command routing, Python version requests, the managed environment and the FFI report of the `vu` launcher.
//!
//! Everything here is pure (no process is started, no global state is read except through the closures and paths
//! given), so the whole surface is unit-tested without an interpreter.

use std::collections::BTreeSet;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};

use crate::launcher::{json_string, path_with};

/// The embedded `vu hf` program (standard library only), run by the embedded CPython.
pub const HF_PY: &str = include_str!("../py/hf.py");
/// The embedded `vu compile` program (standard library only), run by the embedded CPython.
pub const COMPILE_PY: &str = include_str!("../py/compile.py");

/// How a `vu python <word>` that is not a script manages interpreters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PythonCommand {
    /// `vu python install [versions]`: download and install interpreters into the vu home.
    Install(Vec<OsString>),
    /// `vu python list`: the runtime's own interpreter, then the installed ones.
    List(Vec<OsString>),
    /// `vu python use <version>`: install it when missing and write `.python-version`.
    Use(Vec<OsString>),
    /// `vu python pin <version>`: write `.python-version`.
    Pin(Vec<OsString>),
    /// `vu python find [version]`: the path of an interpreter that satisfies the request.
    Find(Vec<OsString>),
    /// `vu python dir`: the directory managed interpreters live in.
    Dir,
}

/// Where a command line goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// The pinned uv with these arguments.
    Uv(Vec<OsString>),
    /// The pinned ruff with these arguments.
    Ruff(Vec<OsString>),
    /// An interpreter command line (embedded CPython, or the managed interpreter a project asks for).
    Python(Vec<OsString>),
    /// Interpreter management.
    PythonManager(PythonCommand),
    /// `vu ffi ...`.
    Ffi(Vec<OsString>),
    /// `vu hf ...`.
    Hf(Vec<OsString>),
    /// `vu compile ...`.
    Compile(Vec<OsString>),
    /// `vu --version [--json]`.
    Version { json: bool },
    /// `vu --help` or no argument.
    Help,
    /// An unknown first word.
    Unknown(String),
}

/// uv commands that are the package manager and the project runner of `vu` under the same name.
const UV_VERBS: &[&str] = &[
    "add", "remove", "sync", "lock", "tree", "init", "venv", "build", "publish", "export", "tool",
    "cache", "run", "pip",
];

fn rest(arguments: &[OsString]) -> Vec<OsString> {
    arguments.iter().skip(1).cloned().collect()
}

fn prefixed(first: &str, arguments: &[OsString]) -> Vec<OsString> {
    let mut out = vec![OsString::from(first)];
    out.extend(arguments.iter().skip(1).cloned());
    out
}

/// Routes the arguments after `vu`.
#[must_use]
pub fn route(arguments: &[OsString]) -> Route {
    let Some(first) = arguments.first().and_then(|a| a.to_str()) else {
        return if arguments.is_empty() {
            Route::Help
        } else {
            Route::Unknown(arguments[0].to_string_lossy().into_owned())
        };
    };
    match first {
        "uv" => Route::Uv(rest(arguments)),
        "ruff" => Route::Ruff(rest(arguments)),
        "python" | "python3" => {
            let tail = rest(arguments);
            let command = |name: &str| tail.first().and_then(|a| a.to_str()) == Some(name);
            let after: Vec<OsString> = tail.iter().skip(1).cloned().collect();
            if command("install") {
                Route::PythonManager(PythonCommand::Install(after))
            } else if command("list") {
                Route::PythonManager(PythonCommand::List(after))
            } else if command("use") {
                Route::PythonManager(PythonCommand::Use(after))
            } else if command("pin") {
                Route::PythonManager(PythonCommand::Pin(after))
            } else if command("find") {
                Route::PythonManager(PythonCommand::Find(after))
            } else if command("dir") {
                Route::PythonManager(PythonCommand::Dir)
            } else {
                Route::Python(tail)
            }
        }
        "install" => Route::Uv(prefixed("sync", arguments)),
        "lint" => Route::Ruff(prefixed("check", arguments)),
        "format" | "fmt" => Route::Ruff(prefixed("format", arguments)),
        "ffi" => Route::Ffi(rest(arguments)),
        "hf" => Route::Hf(rest(arguments)),
        "compile" => Route::Compile(rest(arguments)),
        "--version" | "-V" => Route::Version {
            json: arguments.iter().any(|a| a == "--json"),
        },
        "--help" | "-h" => Route::Help,
        verb if UV_VERBS.contains(&verb) => Route::Uv(prefixed(verb, arguments)),
        other => Route::Unknown(other.to_owned()),
    }
}

/// The version a `.python-version` file asks for: its first line that is not blank or a comment.
#[must_use]
pub fn parse_python_version(contents: &str) -> Option<String> {
    contents
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_owned)
}

/// The nearest `.python-version` at or above `start`, with its request.
#[must_use]
pub fn find_pin(start: &Path) -> Option<(PathBuf, String)> {
    for directory in start.ancestors() {
        let file = directory.join(".python-version");
        if let Ok(contents) = fs::read_to_string(&file)
            && let Some(request) = parse_python_version(&contents)
        {
            return Some((file, request));
        }
    }
    None
}

/// The interpreter a command line asks for: `VU_PYTHON`, else the nearest `.python-version`.
#[must_use]
pub fn requested_python(env_request: Option<&OsStr>, start: &Path) -> Option<String> {
    if let Some(request) = env_request.and_then(OsStr::to_str).map(str::trim)
        && !request.is_empty()
    {
        return Some(request.to_owned());
    }
    find_pin(start).map(|(_, request)| request)
}

/// Whether the runtime's own interpreter (minor `3.12`) answers `request` without asking uv: a bare minor
/// (`3.12`, `cpython-3.12`). Anything else (a patch, a flavour, a path) is resolved by uv.
#[must_use]
pub fn embedded_satisfies(request: &str, runtime_minor: &str) -> bool {
    let name = request
        .strip_prefix("cpython-")
        .or_else(|| request.strip_prefix("cpython@"))
        .unwrap_or(request);
    name == runtime_minor
}

/// `3.12` from the `lib/python3.12` directory of the runtime prefix.
#[must_use]
pub fn runtime_minor(prefix: &Path) -> Option<String> {
    let mut found: Vec<String> = fs::read_dir(prefix.join("lib"))
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter_map(|name| name.strip_prefix("python").map(str::to_owned))
        .filter(|rest| {
            rest.split_once('.').is_some_and(|(major, minor)| {
                major == "3" && !minor.is_empty() && minor.bytes().all(|b| b.is_ascii_digit())
            })
        })
        .collect();
    found.sort();
    found.pop()
}

/// The vu home: `VU_HOME`, else `<home>/.vu`.
#[must_use]
pub fn vu_home(vu_home: Option<&OsStr>, home: Option<&OsStr>) -> PathBuf {
    match (vu_home, home) {
        (Some(explicit), _) if !explicit.is_empty() => PathBuf::from(explicit),
        (_, Some(home)) => PathBuf::from(home).join(".vu"),
        _ => PathBuf::from(".vu"),
    }
}

const TORCH_CUDA: &[(u32, u32)] = &[(12, 8), (12, 6), (12, 4), (12, 1), (11, 8)];
const TORCH_ROCM: &[(u32, u32)] = &[(6, 4), (6, 3), (6, 2), (6, 1)];

fn newest(table: &[(u32, u32)], major: u32, minor: u32) -> Option<(u32, u32)> {
    table
        .iter()
        .copied()
        .find(|&(m, n)| m < major || (m == major && n <= minor))
}

fn version_pair(text: &str) -> Option<(u32, u32)> {
    let digits: String = text
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let (major, minor) = digits.split_once('.')?;
    Some((major.parse().ok()?, minor.parse().ok()?))
}

/// The PyTorch backend tag for a `VU_ACCELERATOR` override (`cpu`, `cuda12.8`, `cu128`, `rocm6.3`); the newest tag
/// the named driver can run, `cpu` when none, `None` when the text is not an accelerator.
#[must_use]
pub fn torch_backend(accelerator: &str) -> Option<String> {
    if accelerator == "cpu" {
        return Some("cpu".to_owned());
    }
    if let Some(rest) = accelerator.strip_prefix("rocm") {
        let (major, minor) = version_pair(rest)?;
        return Some(
            newest(TORCH_ROCM, major, minor)
                .map_or_else(|| "cpu".to_owned(), |(m, n)| format!("rocm{m}.{n}")),
        );
    }
    let rest = accelerator
        .strip_prefix("cuda")
        .or_else(|| accelerator.strip_prefix("cu"))?;
    let (major, minor) = if rest.contains('.') {
        version_pair(rest)?
    } else if rest.len() >= 3 {
        let (major, minor) = rest.split_at(rest.len() - 1);
        (major.parse().ok()?, minor.parse().ok()?)
    } else {
        return None;
    };
    Some(
        newest(TORCH_CUDA, major, minor)
            .map_or_else(|| "cpu".to_owned(), |(m, n)| format!("cu{m}{n}")),
    )
}

/// The environment `vu` gives to uv, ruff and the interpreters it starts. Variables the caller already set are kept
/// (except `PATH` and `VU_RUNTIME`, which always lead to this runtime).
///
/// * `UV_PYTHON_INSTALL_DIR`: managed interpreters live in `<vu home>/python`;
/// * `UV_PYTHON_PREFERENCE=managed`: a project's `.python-version` is served by a managed interpreter first;
/// * `UV_TORCH_BACKEND`: `auto` (uv detects the GPU and resolves CUDA, ROCm or CPU wheels), or the tag chosen by
///   `VU_ACCELERATOR`.
#[must_use]
pub fn managed_env(
    prefix: &Path,
    home: &Path,
    get: &dyn Fn(&str) -> Option<OsString>,
) -> Vec<(String, OsString)> {
    let mut out: Vec<(String, OsString)> = vec![
        ("VU_RUNTIME".to_owned(), prefix.as_os_str().to_owned()),
        ("PATH".to_owned(), path_with(prefix, get("PATH"))),
    ];
    let mut default = |name: &str, value: OsString| {
        if get(name).is_none_or(|existing| existing.is_empty()) {
            out.push((name.to_owned(), value));
        }
    };
    default(
        "UV_PYTHON_INSTALL_DIR",
        home.join("python").into_os_string(),
    );
    default("UV_PYTHON_PREFERENCE", OsString::from("managed"));
    let backend = get("VU_ACCELERATOR")
        .and_then(|value| value.into_string().ok())
        .and_then(|text| torch_backend(text.trim()))
        .unwrap_or_else(|| "auto".to_owned());
    default("UV_TORCH_BACKEND", OsString::from(backend));
    out
}

/// What the shared CPython library of a runtime is, for every process that loads it (Bun, libaphrody, an extension host).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FfiInfo {
    /// The runtime prefix (`PYTHONHOME`).
    pub prefix: PathBuf,
    /// The library file, `libpython3.12.so.1.0`.
    pub libpython: PathBuf,
    /// `libpython3.12.so.1.0`.
    pub soname: String,
    /// `3.12`.
    pub minor: String,
    /// The header directory, when the runtime ships headers.
    pub include: Option<PathBuf>,
    /// How many distinct libpython files the runtime ships (the contract is exactly one).
    pub libraries: usize,
}

/// The dlopen mode every host must use: symbols global, so abi3 extensions (which do not link libpython) resolve
/// their `Py*` references against the one loaded library.
pub const DLOPEN_MODE: &str = "RTLD_NOW|RTLD_GLOBAL";

/// Reads the shared library of a runtime prefix.
///
/// # Errors
/// When `lib/` holds no `libpython3.*.so.*` file.
pub fn ffi_info(prefix: &Path) -> Result<FfiInfo, String> {
    let lib = prefix.join("lib");
    let entries = fs::read_dir(&lib).map_err(|error| format!("{}: {error}", lib.display()))?;
    let mut files = BTreeSet::new();
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("libpython3.") && name.contains(".so.") {
            let real = fs::canonicalize(entry.path()).unwrap_or_else(|_| entry.path());
            files.insert(real);
        }
    }
    let libpython = files
        .iter()
        .next()
        .cloned()
        .ok_or_else(|| format!("no shared libpython under {}", lib.display()))?;
    let soname = libpython
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let minor = soname
        .strip_prefix("libpython")
        .and_then(|rest| rest.split(".so").next())
        .unwrap_or_default()
        .to_owned();
    let include =
        Some(prefix.join("include").join(format!("python{minor}"))).filter(|path| path.is_dir());
    Ok(FfiInfo {
        prefix: prefix.to_path_buf(),
        libpython,
        soname,
        minor,
        include,
        libraries: files.len(),
    })
}

/// The JSON report of `vu ffi info --json` (schema `aphrody.vu-ffi/1`).
#[must_use]
pub fn ffi_json(info: &FfiInfo) -> String {
    let include = info.include.as_ref().map_or_else(
        || "null".to_owned(),
        |path| json_string(&path.to_string_lossy()),
    );
    format!(
        "{{\"schema\":\"aphrody.vu-ffi/1\",\"prefix\":{},\"libpython\":{},\"soname\":{},\"python\":{},\"include\":{},\"libraries\":{},\"dlopen\":{},\"pythonhome\":{},\"abi\":\"cpython-c-api; abi3-py311 extensions\"}}",
        json_string(&info.prefix.to_string_lossy()),
        json_string(&info.libpython.to_string_lossy()),
        json_string(&info.soname),
        json_string(&info.minor),
        include,
        info.libraries,
        json_string(DLOPEN_MODE),
        json_string(&info.prefix.to_string_lossy()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    #[test]
    fn package_manager_verbs_go_to_uv() {
        assert_eq!(
            route(&args(&["add", "httpx"])),
            Route::Uv(args(&["add", "httpx"]))
        );
        assert_eq!(
            route(&args(&["pip", "install", "x"])),
            Route::Uv(args(&["pip", "install", "x"]))
        );
        assert_eq!(
            route(&args(&["run", "a.py", "--x"])),
            Route::Uv(args(&["run", "a.py", "--x"]))
        );
        assert_eq!(route(&args(&["install"])), Route::Uv(args(&["sync"])));
        assert_eq!(
            route(&args(&["install", "--frozen"])),
            Route::Uv(args(&["sync", "--frozen"]))
        );
    }

    #[test]
    fn lint_and_format_go_to_ruff() {
        assert_eq!(
            route(&args(&["lint", "src"])),
            Route::Ruff(args(&["check", "src"]))
        );
        assert_eq!(
            route(&args(&["format", "--check"])),
            Route::Ruff(args(&["format", "--check"]))
        );
        assert_eq!(route(&args(&["fmt"])), Route::Ruff(args(&["format"])));
        assert_eq!(
            route(&args(&["ruff", "check"])),
            Route::Ruff(args(&["check"]))
        );
        assert_eq!(
            route(&args(&["uv", "--version"])),
            Route::Uv(args(&["--version"]))
        );
    }

    #[test]
    fn python_words_manage_interpreters_and_the_rest_runs_one() {
        assert_eq!(
            route(&args(&["python", "install", "3.14"])),
            Route::PythonManager(PythonCommand::Install(args(&["3.14"])))
        );
        assert_eq!(
            route(&args(&["python", "list"])),
            Route::PythonManager(PythonCommand::List(args(&[])))
        );
        assert_eq!(
            route(&args(&["python", "use", "3.14"])),
            Route::PythonManager(PythonCommand::Use(args(&["3.14"])))
        );
        assert_eq!(
            route(&args(&["python", "dir"])),
            Route::PythonManager(PythonCommand::Dir)
        );
        assert_eq!(
            route(&args(&["python", "-c", "1"])),
            Route::Python(args(&["-c", "1"]))
        );
        assert_eq!(
            route(&args(&["python", "script.py"])),
            Route::Python(args(&["script.py"]))
        );
        assert_eq!(route(&args(&["python"])), Route::Python(args(&[])));
    }

    #[test]
    fn the_other_commands_and_unknown_words() {
        assert_eq!(
            route(&args(&["hf", "status"])),
            Route::Hf(args(&["status"]))
        );
        assert_eq!(
            route(&args(&["compile", "src"])),
            Route::Compile(args(&["src"]))
        );
        assert_eq!(route(&args(&["ffi", "info"])), Route::Ffi(args(&["info"])));
        assert_eq!(
            route(&args(&["--version", "--json"])),
            Route::Version { json: true }
        );
        assert_eq!(route(&args(&["-V"])), Route::Version { json: false });
        assert_eq!(route(&args(&[])), Route::Help);
        assert_eq!(route(&args(&["nope"])), Route::Unknown("nope".to_owned()));
    }

    #[test]
    fn python_version_files_are_parsed() {
        assert_eq!(parse_python_version("3.14\n"), Some("3.14".to_owned()));
        assert_eq!(
            parse_python_version("# note\n\n  cpython-3.14.8  \n3.12"),
            Some("cpython-3.14.8".to_owned())
        );
        assert_eq!(parse_python_version("# only a comment\n"), None);
        assert_eq!(parse_python_version(""), None);
    }

    #[test]
    fn the_nearest_pin_wins_and_the_environment_overrides_it() {
        let root = std::env::temp_dir().join(format!("vu-pin-{}", std::process::id()));
        let inner = root.join("a/b");
        fs::create_dir_all(&inner).expect("directories");
        fs::write(root.join(".python-version"), "3.13\n").expect("outer pin");
        assert_eq!(find_pin(&inner).map(|(_, v)| v), Some("3.13".to_owned()));
        fs::write(root.join("a/.python-version"), "3.14\n").expect("inner pin");
        assert_eq!(find_pin(&inner).map(|(_, v)| v), Some("3.14".to_owned()));
        assert_eq!(
            requested_python(Some(OsStr::new("3.11")), &inner),
            Some("3.11".to_owned())
        );
        assert_eq!(
            requested_python(Some(OsStr::new("")), &inner),
            Some("3.14".to_owned())
        );
        assert_eq!(requested_python(None, Path::new("/nonexistent/vu")), None);
        fs::remove_dir_all(&root).expect("cleanup");
    }

    #[test]
    fn the_embedded_interpreter_answers_only_a_bare_minor() {
        assert!(embedded_satisfies("3.12", "3.12"));
        assert!(embedded_satisfies("cpython-3.12", "3.12"));
        assert!(!embedded_satisfies("3.14", "3.12"));
        assert!(!embedded_satisfies("3.12.15", "3.12"));
        assert!(!embedded_satisfies("3.12t", "3.12"));
    }

    #[test]
    fn the_runtime_minor_is_read_from_its_lib_directory() {
        let prefix = std::env::temp_dir().join(format!("vu-minor-{}", std::process::id()));
        fs::create_dir_all(prefix.join("lib/python3.12/site-packages")).expect("lib");
        fs::create_dir_all(prefix.join("lib/pkgconfig")).expect("noise");
        assert_eq!(runtime_minor(&prefix), Some("3.12".to_owned()));
        assert_eq!(runtime_minor(Path::new("/nonexistent/vu")), None);
        fs::remove_dir_all(&prefix).expect("cleanup");
    }

    #[test]
    fn accelerator_overrides_map_to_the_newest_runnable_tag() {
        assert_eq!(torch_backend("cpu").as_deref(), Some("cpu"));
        assert_eq!(torch_backend("cuda12.9").as_deref(), Some("cu128"));
        assert_eq!(torch_backend("cuda12.5").as_deref(), Some("cu124"));
        assert_eq!(torch_backend("cu126").as_deref(), Some("cu126"));
        assert_eq!(torch_backend("cuda10.2").as_deref(), Some("cpu"));
        assert_eq!(torch_backend("rocm6.3").as_deref(), Some("rocm6.3"));
        assert_eq!(torch_backend("rocm5.0").as_deref(), Some("cpu"));
        assert_eq!(torch_backend("tpu"), None);
    }

    #[test]
    fn the_managed_environment_keeps_what_the_caller_set() {
        let prefix = Path::new("/opt/vu/runtime/x");
        let home = Path::new("/h/.vu");
        let none = |_: &str| -> Option<OsString> { None };
        let env = managed_env(prefix, home, &none);
        let lookup = |name: &str| env.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone());
        assert_eq!(
            lookup("VU_RUNTIME"),
            Some(OsString::from("/opt/vu/runtime/x"))
        );
        assert_eq!(
            lookup("UV_PYTHON_INSTALL_DIR"),
            Some(OsString::from("/h/.vu/python"))
        );
        assert_eq!(
            lookup("UV_PYTHON_PREFERENCE"),
            Some(OsString::from("managed"))
        );
        assert_eq!(lookup("UV_TORCH_BACKEND"), Some(OsString::from("auto")));

        let set = |name: &str| -> Option<OsString> {
            match name {
                "UV_PYTHON_PREFERENCE" => Some(OsString::from("system")),
                "VU_ACCELERATOR" => Some(OsString::from("cuda12.8")),
                "PATH" => Some(OsString::from("/usr/bin")),
                _ => None,
            }
        };
        let env = managed_env(prefix, home, &set);
        let lookup = |name: &str| env.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone());
        assert_eq!(lookup("UV_PYTHON_PREFERENCE"), None);
        assert_eq!(lookup("UV_TORCH_BACKEND"), Some(OsString::from("cu128")));
        assert_eq!(
            lookup("PATH"),
            Some(OsString::from("/opt/vu/runtime/x/bin:/usr/bin"))
        );
    }

    #[test]
    fn the_vu_home_prefers_the_variable() {
        assert_eq!(
            vu_home(Some(OsStr::new("/data/vu")), Some(OsStr::new("/h"))),
            PathBuf::from("/data/vu")
        );
        assert_eq!(
            vu_home(None, Some(OsStr::new("/h"))),
            PathBuf::from("/h/.vu")
        );
        assert_eq!(
            vu_home(Some(OsStr::new("")), Some(OsStr::new("/h"))),
            PathBuf::from("/h/.vu")
        );
    }

    #[test]
    fn the_ffi_report_names_the_single_shared_library() {
        let prefix = std::env::temp_dir().join(format!("vu-ffi-{}", std::process::id()));
        fs::create_dir_all(prefix.join("lib")).expect("lib");
        fs::create_dir_all(prefix.join("include/python3.12")).expect("include");
        fs::write(prefix.join("lib/libpython3.12.so.1.0"), b"").expect("library");
        std::os::unix::fs::symlink("libpython3.12.so.1.0", prefix.join("lib/libpython3.12.so"))
            .expect("link");
        let info = ffi_info(&prefix).expect("a library");
        assert_eq!(info.soname, "libpython3.12.so.1.0");
        assert_eq!(info.minor, "3.12");
        assert_eq!(info.libraries, 1);
        assert!(info.include.is_some());
        let json = ffi_json(&info);
        assert!(json.contains("\"schema\":\"aphrody.vu-ffi/1\""));
        assert!(json.contains("\"dlopen\":\"RTLD_NOW|RTLD_GLOBAL\""));
        fs::remove_dir_all(&prefix).expect("cleanup");
        assert!(ffi_info(Path::new("/nonexistent/vu")).is_err());
    }

    #[test]
    fn the_embedded_programs_are_present() {
        assert!(HF_PY.contains("def download_file"));
        assert!(COMPILE_PY.contains("def build_zipapp"));
    }
}
