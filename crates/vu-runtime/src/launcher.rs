// SPDX-License-Identifier: Apache-2.0
//! Pure helpers of the `vu` launcher, kept here so that they are tested next to the embedding (this crate's test
//! binary carries the runpath of the pinned libpython; the launcher binary does not need one for tests).

use std::env;
use std::ffi::OsString;
use std::path::Path;

/// `PATH` with the runtime's `bin/` first, so nested invocations find the pinned tools.
#[must_use]
pub fn path_with(prefix: &Path, existing: Option<OsString>) -> OsString {
    let mut entries = vec![prefix.join("bin")];
    if let Some(existing) = existing {
        entries.extend(env::split_paths(&existing));
    }
    env::join_paths(entries).unwrap_or_default()
}

/// A JSON string literal (the launcher prints one small object and needs no JSON dependency).
#[must_use]
pub fn json_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if u32::from(c) < 0x20 => out.push_str(&format!("\\u{:04x}", u32::from(c))),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn json_strings_are_escaped() {
        assert_eq!(json_string("a\"b\\c\n"), "\"a\\\"b\\\\c\\n\"");
        assert_eq!(json_string("\u{1}"), "\"\\u0001\"");
        assert_eq!(json_string("plain"), "\"plain\"");
    }

    #[test]
    fn the_runtime_bin_comes_first_in_path() {
        let path = path_with(Path::new("/opt/vu"), Some(OsString::from("/usr/bin:/bin")));
        let entries: Vec<PathBuf> = env::split_paths(&path).collect();
        assert_eq!(
            entries,
            [
                PathBuf::from("/opt/vu/bin"),
                PathBuf::from("/usr/bin"),
                PathBuf::from("/bin")
            ]
        );
        let alone = path_with(Path::new("/opt/vu"), None);
        assert_eq!(
            env::split_paths(&alone).collect::<Vec<_>>(),
            [PathBuf::from("/opt/vu/bin")]
        );
    }
}
