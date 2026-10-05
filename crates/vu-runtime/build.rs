// SPDX-License-Identifier: Apache-2.0
//! The test binary of this crate links the pinned shared libpython; give it the library directory of the PyO3 config
//! file as runpath so `cargo test` can start it. The `vu` binary carries its own `$ORIGIN/../lib` runpath.

use std::env;
use std::fs;

fn main() {
    println!("cargo:rerun-if-env-changed=PYO3_CONFIG_FILE");
    let Some(path) = env::var_os("PYO3_CONFIG_FILE") else {
        return;
    };
    println!("cargo:rerun-if-changed={}", path.to_string_lossy());
    let Ok(config) = fs::read_to_string(&path) else {
        return;
    };
    for line in config.lines() {
        if let Some(directory) = line.strip_prefix("lib_dir=") {
            println!("cargo:rustc-link-arg=-Wl,-rpath,{directory}");
        }
    }
}
