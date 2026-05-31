fn main() {
    // Tauri embeds the Windows .exe icon at build time; without these the
    // build script only reruns when tauri.conf.json changes, so swapping the
    // icon files alone would not re-embed them. Watch the icons explicitly.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.icns");
    tauri_build::build()
}
