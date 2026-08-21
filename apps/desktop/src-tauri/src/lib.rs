//! Swarm desktop shell: start the daemon as a sidecar, then show the dashboard in a native
//! window with a tray icon. The dashboard itself is served by the daemon over 127.0.0.1.

use std::net::TcpStream;
use std::time::Duration;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

const PORT: u16 = 7777;

fn daemon_up() -> bool {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{PORT}").parse().unwrap(),
        Duration::from_millis(300),
    )
    .is_ok()
}

fn open_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let url = format!("http://127.0.0.1:{PORT}");
    let _ = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse().unwrap()))
        .title("Swarm")
        .inner_size(1280.0, 820.0)
        .min_inner_size(720.0, 480.0)
        .build();
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {

            // Start the daemon sidecar unless one is already listening.
            if !daemon_up() {
                let web_dir = app
                    .path()
                    .resource_dir()
                    .map(|d| d.join("web"))
                    .ok()
                    .and_then(|d| d.to_str().map(String::from))
                    .unwrap_or_default();
                if let Ok(cmd) = app.shell().sidecar("swarmd") {
                    let cmd = if web_dir.is_empty() {
                        cmd
                    } else {
                        cmd.env("SWARM_WEB_DIR", web_dir)
                    };
                    if let Ok((mut rx, _child)) = cmd.spawn() {
                        tauri::async_runtime::spawn(async move {
                            while let Some(ev) = rx.recv().await {
                                if let CommandEvent::Terminated(_) = ev {
                                    break;
                                }
                            }
                        });
                    }
                }
            }

            // Tray icon with a small menu.
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
            // keep running in the tray when the last window closes
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                api.prevent_exit();
            }
        });
}
