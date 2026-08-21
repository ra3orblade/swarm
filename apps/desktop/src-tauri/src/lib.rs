//! Swarm desktop shell: run the daemon as a sidecar on a free port (or reuse a healthy one already
//! running), then point the window at the discovered dashboard URL. No hard-coded port — robust to
//! a blocked/occupied 7777. Tray icon keeps it alive when the window closes.

use std::env;
use std::fs;
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::time::Duration;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};
use tauri_plugin_shell::ShellExt;

fn health(port: u16) -> bool {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_millis(300),
    )
    .is_ok()
}

/// An OS-assigned free port (bind :0, read it back, release).
fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
        .unwrap_or(7777)
}

fn swarm_home() -> PathBuf {
    if let Ok(h) = env::var("SWARM_HOME") {
        return PathBuf::from(h);
    }
    let home = env::var("HOME").or_else(|_| env::var("USERPROFILE")).unwrap_or_default();
    PathBuf::from(home).join(".swarm")
}

/// Port of a daemon already running (from ~/.swarm/daemon.json), if it's healthy — so the app
/// reuses the machine's single daemon instead of starting a second one.
fn existing_healthy_port() -> Option<u16> {
    let raw = fs::read_to_string(swarm_home().join("daemon.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let port = v.get("port")?.as_u64()? as u16;
    health(port).then_some(port)
}

fn navigate_when_ready(win: tauri::WebviewWindow, port: u16) {
    std::thread::spawn(move || {
        for _ in 0..150 {
            if health(port) {
                let _ = win.eval(&format!("location.replace('http://127.0.0.1:{port}')"));
                return;
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        let _ = win.eval("document.body.textContent = 'Could not start the Swarm daemon.'");
    });
}

fn open_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // Reuse a healthy daemon if one is running; otherwise start our own on a free port.
            let port = existing_healthy_port().unwrap_or_else(|| {
                let p = free_port();
                let web_dir = app
                    .path()
                    .resource_dir()
                    .map(|d| d.join("web"))
                    .ok()
                    .and_then(|d| d.to_str().map(String::from))
                    .unwrap_or_default();
                if let Ok(cmd) = app.shell().sidecar("swarmd") {
                    let mut cmd = cmd.env("SWARM_PORT", p.to_string());
                    if !web_dir.is_empty() {
                        cmd = cmd.env("SWARM_WEB_DIR", web_dir);
                    }
                    let _ = cmd.spawn();
                }
                p
            });

            // The window loads a splash (frontendDist); redirect it to the daemon once it's up.
            if let Some(win) = app.get_webview_window("main") {
                navigate_when_ready(win, port);
            }

            let open = MenuItem::with_id(app, "open", "Open Swarm", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Swarm")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => open_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Swarm")
        .run(|_app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                api.prevent_exit();
            }
        });
}
