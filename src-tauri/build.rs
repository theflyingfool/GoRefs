fn main() {
  // 16KB page-size alignment for Android .so files (Google Play requirement
  // for apps targeting Android 15+/API 35 as of Nov 2025).
  //
  // NOTE: this is NOT set via `[target.'cfg(target_os = "android")']
  // rustflags` in Cargo.toml, even though that's the "normal" Rust way to
  // pass linker flags. Verified against tauri-cli 2.11.4 + cargo-mobile2
  // 0.22.4 source: `cargo tauri android build` unconditionally sets
  // `CARGO_TARGET_<TRIPLE>_RUSTFLAGS` env vars for each Android target
  // before invoking cargo (tauri-cli src/mobile/android/mod.rs
  // `configure_cargo`), and per Cargo's documented precedence rules, a
  // triple-specific rustflags source (whether set via env var or
  // `[target.<triple>]` in a config file) completely replaces — rather than
  // merges with — a `[target.'cfg(...)']`-matched source. So a cfg-based
  // entry in Cargo.toml is silently ignored by Tauri's Android build
  // pipeline. This is a known community-verified gap, not specific to this
  // repo (see e.g. github.com/tauri-apps/tauri/issues/14895 and
  // github.com/tauri-apps/cargo-mobile2/issues/393).
  //
  // `cargo:rustc-link-arg=` build-script directives are a separate,
  // additive mechanism that Cargo always honors regardless of what's in
  // RUSTFLAGS/CARGO_TARGET_*_RUSTFLAGS, so they survive Tauri's Android
  // build pipeline.
  if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
    println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
    println!("cargo:rustc-link-arg=-Wl,-z,common-page-size=16384");
  }

  tauri_build::build()
}
