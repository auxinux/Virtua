// Release builds are GUI programs on Windows: without this a console window
// opened next to Virtua Desktop (and stayed for every Unified-mode launcher).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    auxinux_virtua_desktop_lib::run();
}
