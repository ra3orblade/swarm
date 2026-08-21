//! Swarm desktop shell: run the daemon as a sidecar on a free port (or reuse a healthy one already
//! running), then point the window at the discovered dashboard URL. No hard-coded port — robust to
//! a blocked/occupied 7777. Tray icon keeps it alive when the window closes.

use std::env;
use std::fs;
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    LogicalPosition, Manager, TitleBarStyle, WebviewUrl, WebviewWindowBuilder,
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
        // Keep the animated splash on screen for at least this long so it's actually watchable,
        // even when the daemon is already healthy and would otherwise flash straight past it.
        let min_splash = Duration::from_millis(3000);
        let start = Instant::now();
        // macOS uses an overlay title bar (traffic lights float over the content); the dashboard
        // reads ?chrome=inset to pad its header clear of them.
        let url = if cfg!(target_os = "macos") {
            format!("http://127.0.0.1:{port}/?chrome=inset")
        } else {
            format!("http://127.0.0.1:{port}")
        };
        let mut navigated = false;
        for _ in 0..150 {
            if health(port) {
                let elapsed = start.elapsed();
                if elapsed < min_splash {
                    std::thread::sleep(min_splash - elapsed);
                }
                // Fade the splash out, then swap to the dashboard (which fades itself in).
                let _ = win
                    .eval("document.body.style.transition='opacity .3s ease';document.body.style.opacity='0'");
                std::thread::sleep(Duration::from_millis(320));
                let _ = win.eval(&format!("location.replace('{url}')"));
                navigated = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        if !navigated {
            let _ = win.eval("document.body.textContent = 'Could not start the Swarm daemon.'");
            return;
        }
        // Watch native fullscreen: drop the traffic-light padding when the lights are hidden.
        let mut last = false;
        loop {
            std::thread::sleep(Duration::from_millis(400));
            match win.is_fullscreen() {
                Ok(fs) => {
                    if fs != last {
                        last = fs;
                        let _ = win.eval(&format!(
                            "document.documentElement.classList.toggle('fs',{fs})"
                        ));
                    }
                }
                Err(_) => break, // window gone
            }
        }
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

            // Build the window in Rust (not tauri.conf) so we can pin the macOS traffic lights
            // near the top-left instead of letting them center in the tall header. It loads a
            // splash (frontendDist); navigate_when_ready redirects it to the daemon once it's up.
            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Swarm")
                .inner_size(1280.0, 820.0)
                .min_inner_size(720.0, 480.0)
                .title_bar_style(TitleBarStyle::Overlay)
                .hidden_title(true)
                .traffic_light_position(LogicalPosition::new(19.0, 26.0))
                .build()?;
            navigate_when_ready(win, port);

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
