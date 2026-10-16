# Local screenshots compatibility patch

Source: screenshots 0.8.10 from crates.io (https://github.com/nashaofu/screenshots-rs).
The upstream license is retained in LICENSE.

In src/linux/wayland_screenshot.rs, explicitly specify the unit return type
for the GNOME and portal D-Bus method calls. This preserves behavior and removes
Rust never-type fallback reliance. No other source changes are applied.
The workspace Cargo.toml selects this copy through patch.crates-io.
