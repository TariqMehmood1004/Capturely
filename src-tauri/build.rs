fn main() {
    // Expose the target triple so dev builds can locate sidecar binaries named <tool>-<triple>.exe.
    println!(
        "cargo:rustc-env=TARGET_TRIPLE={}",
        std::env::var("TARGET").unwrap_or_default()
    );
    tauri_build::build()
}
