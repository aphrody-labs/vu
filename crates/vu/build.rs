// SPDX-License-Identifier: Apache-2.0
//! The runtime directory carries `lib/libpython3.x.so.1.0` next to `bin/vu`: look it up relative to the binary.

use std::env;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rustc-link-arg-bins=-Wl,-rpath,$ORIGIN/../lib");
    println!(
        "cargo:rustc-env=VU_TARGET={}",
        env::var("TARGET").unwrap_or_default()
    );
}
