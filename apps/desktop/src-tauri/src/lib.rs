//! Swarm desktop shell: the app always runs its own daemon. A daemon already holding
//! `~/.swarm/daemon.json` (a `swarm start`, a dev clone's `bun run dev`) is asked to stop over
//! HTTP first, so what the window shows is always this build's daemon and dashboard — never a
//! stale bundle from wherever the other daemon was started. The daemon takes its preferred port
//! (config, else 7777) or any free one when that is taken; the app finds it by pid through
//! `daemon.json`, so no port is ever required. Tray icon keeps it alive when the window closes.

use std::env;
use std::fs;
use std::net::TcpStream;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_shell::process::{Command as ShellCommand, CommandChild};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_updater::UpdaterExt;

/// The daemon child this app spawned (None when reusing an already-running daemon).
/// Killed on real exit so quitting Swarm doesn't leave a stray swarmd behind.
struct Sidecar(Mutex<Option<CommandChild>>);

/// One small HTTP/1.0 request to the loopback daemon; the response body, if any. std only —
/// the app has no HTTP client and needs exactly two routes (`/v1/health`, `/v1/shutdown`).
fn http(port: u16, method: &str, path: &str) -> Option<String> {
    use std::io::{Read, Write};
    let addr = format!("127.0.0.1:{port}").parse().ok()?;
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(300)).ok()?;
    s.set_read_timeout(Some(Duration::from_millis(1500))).ok()?;
    s.write_all(
        format!("{method} {path} HTTP/1.0\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\n\r\n")
            .as_bytes(),
    )
    .ok()?;
    let mut buf = String::new();
    s.read_to_string(&mut buf).ok()?;
    buf.split_once("\r\n\r\n").map(|(_, body)| body.to_string())
}

/// Is a *Swarm* daemon answering on this port? A TCP connect is not enough — anything could be
/// sitting on 7777 — so it has to say `"ok":true` on /v1/health.
fn health(port: u16) -> bool {
    http(port, "GET", "/v1/health").is_some_and(|b| b.contains("\"ok\":true"))
}

/// `~/.swarm/daemon.json`: (port, pid) of whichever daemon registered last.
fn daemon_info() -> Option<(u16, u32)> {
    let raw = fs::read_to_string(swarm_home().join("daemon.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let port = v.get("port")?.as_u64()? as u16;
    let pid = v.get("pid")?.as_u64()? as u32;
    Some((port, pid))
}

/// Ask the daemon that holds `daemon.json` to stop, and wait for it to go. Returns what was
/// stopped, for the log. Nothing is signalled by pid or by name: the daemon leaves on its own
/// SIGTERM path (spawned runs stopped by registry pid, `daemon.json` cleared). A daemon that will
/// not leave (auth required, an older version without the route) is left running; ours still
/// starts and re-registers, so hooks and the CLI follow ours.
fn stop_existing_daemon() -> Option<(u16, u32)> {
    let (port, pid) = daemon_info()?;
    if !health(port) {
        return None;
    }
    let _ = http(port, "POST", "/v1/shutdown");
    let until = Instant::now() + Duration::from_secs(10);
    while Instant::now() < until {
        if !health(port) {
            return Some((port, pid));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    None
}

fn swarm_home() -> PathBuf {
    if let Ok(h) = env::var("SWARM_HOME") {
        return PathBuf::from(h);
    }
    let home = env::var("HOME").or_else(|_| env::var("USERPROFILE")).unwrap_or_default();
    PathBuf::from(home).join(".swarm")
}

/// The daemon, ready to spawn.
///
/// Everywhere but Linux it is a Tauri sidecar sitting beside the app binary. AppImage bundling
/// makes that impossible on Linux: linuxdeploy walks every ELF file in the AppDir — `usr/bin` and
/// the resource directory alike — and runs `patchelf --set-rpath` over it, which appends to the
/// file and destroys the payload `bun build --compile` glues onto the end of its executables, so
/// the bundled daemon segfaults the moment it is launched. The Linux build therefore ships the
/// daemon **gzipped** (`tools/desktop.ts`), which linuxdeploy walks past, and unpacks it under
/// `~/.swarm/bin` on the first run of each version. See M6.4 in docs/06.
#[cfg(target_os = "linux")]
fn daemon_command<R: tauri::Runtime, M: Manager<R>>(app: &M) -> Option<ShellCommand> {
    use std::io::copy;
    use std::os::unix::fs::PermissionsExt;

    let version = app.package_info().version.to_string();
    let dir = swarm_home().join("bin");
    let exe = dir.join(format!("swarmd-{version}"));
    if !exe.exists() {
        let gz = app.path().resource_dir().ok()?.join("bin/swarmd.gz");
        fs::create_dir_all(&dir).ok()?;
        // unpack beside the target and rename, so a half-written daemon is never runnable
        let tmp = dir.join(format!(".swarmd-{version}.{}", std::process::id()));
        let mut src = flate2::read::GzDecoder::new(fs::File::open(&gz).ok()?);
        let mut dst = fs::File::create(&tmp).ok()?;
        let unpacked = copy(&mut src, &mut dst).is_ok();
        drop(dst);
        if !unpacked {
            let _ = fs::remove_file(&tmp);
            return None;
        }
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o755)).ok()?;
        fs::rename(&tmp, &exe).ok()?;
        // the copies older versions unpacked are dead weight now (~80 MB each)
        for entry in fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            let stale = path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("swarmd-"));
            if stale && path != exe {
                let _ = fs::remove_file(path);
            }
        }
    }
    Some(app.shell().command(exe))
}

#[cfg(not(target_os = "linux"))]
fn daemon_command<R: tauri::Runtime, M: Manager<R>>(app: &M) -> Option<ShellCommand> {
    app.shell().sidecar("swarmd").ok()
}

/// The port our daemon landed on: `daemon.json` once it carries our child's pid and answers
/// /v1/health. `None` = the child never registered (did not start, or died) — after a grace
/// period any healthy daemon on file is accepted so the window still shows something.
fn our_port(child_pid: Option<u32>, deadline: Instant) -> Option<u16> {
    let (port, pid) = daemon_info()?;
    let ours = child_pid.is_none_or(|c| c == pid);
    if (ours || Instant::now() > deadline) && health(port) {
        Some(port)
    } else {
        None
    }
}

fn navigate_when_ready(win: tauri::WebviewWindow, child_pid: Option<u32>) {
    std::thread::spawn(move || {
        // Keep the animated splash on screen for at least this long so it's actually watchable,
        // even when the daemon is already healthy and would otherwise flash straight past it.
        let min_splash = Duration::from_millis(3000);
        let start = Instant::now();
        let grace = start + Duration::from_secs(20);
        let mut navigated = false;
        for _ in 0..150 {
            if let Some(port) = our_port(child_pid, grace) {
                // macOS uses an overlay title bar (traffic lights float over the content); the
                // dashboard reads ?chrome=inset to pad its header clear of them.
                let url = if cfg!(target_os = "macos") {
                    format!("http://127.0.0.1:{port}/?chrome=inset")
                } else {
                    format!("http://127.0.0.1:{port}")
                };
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

/// Zoom the dashboard. The webview has no native zoom shortcuts, so the View menu drives the
/// page's own zoom (`swarmZoom` in app.js; `dir` is +1 / -1 / 0 = reset).
fn zoom(app: &tauri::AppHandle, dir: i8) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(&format!("window.swarmZoom && window.swarmZoom({dir})"));
    }
}

/// Application menu: App / Edit / View / Window. Without one, the webview gets no ⌘C/⌘V
/// (macOS routes those through the Edit menu) and there is no way to zoom the UI.
fn app_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    // Distinct id from the tray's "update": tray menu events reach the app handler too.
    let update =
        MenuItem::with_id(app, "check-updates", "Check for Updates…", true, None::<&str>)?;
    let whats_new = MenuItem::with_id(app, "whats-new", "What's New", true, None::<&str>)?;
    #[allow(unused_mut)]
    let mut app_items: Vec<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>> = vec![
        Box::new(PredefinedMenuItem::about(app, Some("About Swarm"), None)?),
        Box::new(PredefinedMenuItem::separator(app)?),
        Box::new(whats_new),
        Box::new(update),
        Box::new(PredefinedMenuItem::separator(app)?),
    ];
    #[cfg(target_os = "macos")]
    {
        app_items.push(Box::new(PredefinedMenuItem::services(app, None)?));
        app_items.push(Box::new(PredefinedMenuItem::separator(app)?));
        app_items.push(Box::new(PredefinedMenuItem::hide(app, None)?));
        app_items.push(Box::new(PredefinedMenuItem::hide_others(app, None)?));
        app_items.push(Box::new(PredefinedMenuItem::show_all(app, None)?));
        app_items.push(Box::new(PredefinedMenuItem::separator(app)?));
    }
    app_items.push(Box::new(PredefinedMenuItem::quit(app, None)?));
    let app_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
        app_items.iter().map(|i| i.as_ref()).collect();
    let swarm = Submenu::with_items(app, "Swarm", true, &app_refs)?;

    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let zoom_in = MenuItem::with_id(app, "zoom-in", "Zoom In", true, Some("CmdOrCtrl+="))?;
    let zoom_out = MenuItem::with_id(app, "zoom-out", "Zoom Out", true, Some("CmdOrCtrl+-"))?;
    let zoom_reset =
        MenuItem::with_id(app, "zoom-reset", "Actual Size", true, Some("CmdOrCtrl+0"))?;
    let reload = MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &zoom_in,
            &zoom_out,
            &zoom_reset,
            &PredefinedMenuItem::separator(app)?,
            &reload,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    Menu::with_items(app, &[&swarm, &edit, &view, &window])
}

fn open_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Show the dashboard's "What's New" (release notes for the running version). Brings the window
/// forward, then asks the webview to open the modal.
fn open_whats_new(app: &tauri::AppHandle) {
    open_window(app);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval("window.swarmWhatsNew && window.swarmWhatsNew()");
    }
}

/// Tray "Check for Updates…": ask GitHub Releases (latest.json) for a newer signed build, offer
/// to install it, and relaunch on success. Every outcome surfaces as a native dialog so the
/// click is never silent. Dialogs use the async `show` callback — `blocking_show` from a
/// worker thread deadlocks the macOS main runloop.
fn check_for_updates(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let result = match app.updater() {
            Ok(u) => u.check().await,
            Err(e) => Err(e),
        };
        match result {
            Ok(Some(update)) => {
                // The updater can only replace a running AppImage. A .deb/.rpm install has to go
                // through the package manager, so say so rather than fail mid-download.
                #[cfg(target_os = "linux")]
                if env::var_os("APPIMAGE").is_none() {
                    app.dialog()
                        .message(format!(
                            "Swarm {} is available (you have {}).\n\nThis copy was installed from \
                             a package, so it updates through your package manager: download the \
                             new .deb or .rpm from the Releases page.",
                            update.version, update.current_version
                        ))
                        .title("Update available")
                        .show(|_| {});
                    return;
                }
                let msg = format!(
                    "Swarm {} is available (you have {}).\n\nDownload and install it now? \
                     The app will restart.",
                    update.version, update.current_version
                );
                let app2 = app.clone();
                app.dialog()
                    .message(msg)
                    .title("Update available")
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        "Install & Restart".into(),
                        "Later".into(),
                    ))
                    .show(move |install| {
                        if !install {
                            return;
                        }
                        tauri::async_runtime::spawn(async move {
                            match update.download_and_install(|_, _| {}, || {}).await {
                                Ok(()) => app2.restart(),
                                Err(e) => {
                                    app2.dialog()
                                        .message(format!(
                                            "The update could not be installed.\n\n{e}"
                                        ))
                                        .title("Update failed")
                                        .kind(MessageDialogKind::Error)
                                        .show(|_| {});
                                }
                            }
                        });
                    });
            }
            Ok(None) => {
                app.dialog()
                    .message(format!(
                        "Swarm {} is the latest version.",
                        app.package_info().version
                    ))
                    .title("You're up to date")
                    .show(|_| {});
            }
            Err(e) => {
                app.dialog()
                    .message(format!("Could not check for updates.\n\n{e}"))
                    .title("Update check failed")
                    .kind(MessageDialogKind::Error)
                    .show(|_| {});
            }
        }
    });
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // The app owns the daemon it shows. Whoever registered before us is asked to stop
            // (a `swarm start`, a dev clone's daemon serving a stale bundle); then ours starts
            // on its preferred port — config, else 7777 — or any free one when that is taken.
            if let Some((port, pid)) = stop_existing_daemon() {
                eprintln!("swarm: stopped the daemon on :{port} (pid {pid}); starting our own");
            }
            // Dev builds serve the repo's live dashboard, not the staged snapshot from the
            // last desktop:prep — otherwise the app quietly shows stale UI.
            let web_dir = if cfg!(debug_assertions) {
                concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/web/public").to_string()
            } else {
                app.path()
                    .resource_dir()
                    .map(|d| d.join("web"))
                    .ok()
                    .and_then(|d| d.to_str().map(String::from))
                    .unwrap_or_default()
            };
            // Linux runs the daemon unpacked from a gzipped resource; every other platform
            // runs it as a Tauri sidecar. See `daemon_command`.
            let mut child_pid = None;
            if let Some(cmd) = daemon_command(app) {
                // the daemon watches this pid and stops when we are gone, quit or killed
                let mut cmd = cmd.env("SWARM_PARENT_PID", std::process::id().to_string());
                if !web_dir.is_empty() {
                    cmd = cmd.env("SWARM_WEB_DIR", web_dir);
                }
                if let Ok((_rx, child)) = cmd.spawn() {
                    child_pid = Some(child.pid());
                    app.manage(Sidecar(Mutex::new(Some(child))));
                }
            }
            if child_pid.is_none() {
                eprintln!("swarm: the bundled daemon did not start; showing any daemon on file");
            }

            // Build the window in Rust (not tauri.conf) so we can pin the macOS traffic lights
            // near the top-left instead of letting them center in the tall header. It loads a
            // splash (frontendDist); navigate_when_ready redirects it to the daemon once it's up.
            #[allow(unused_mut)]
            let mut builder =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("Swarm")
                    .inner_size(1280.0, 820.0)
                    .min_inner_size(720.0, 480.0);
            // Overlay title bar + traffic-light pinning are macOS-only builder APIs.
            #[cfg(target_os = "macos")]
            {
                builder = builder
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true)
                    .traffic_light_position(tauri::LogicalPosition::new(19.0, 26.0));
            }
            let win = builder.build()?;
            // Closing the window hides it (the tray keeps the app alive); "Open Swarm" and the
            // dock icon bring it back. Real quits go through ExitRequested below.
            win.on_window_event({
                let win = win.clone();
                move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = win.hide();
                    }
                }
            });
            navigate_when_ready(win, child_pid);

            app.set_menu(app_menu(app.handle())?)?;

            let open = MenuItem::with_id(app, "open", "Open Swarm", true, None::<&str>)?;
            let whats_new_tray =
                MenuItem::with_id(app, "whats-new", "What's New", true, None::<&str>)?;
            let update =
                MenuItem::with_id(app, "update", "Check for Updates…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&open, &whats_new_tray, &update, &sep, &quit])?;
            // The menu bar wants a template image — monochrome plus alpha, which macOS tints to
            // match the bar and dims while the app is inactive. The colour app icon sits visibly
            // apart from every system glyph beside it. Elsewhere there is no such convention, and
            // a black-on-alpha icon would disappear into a dark taskbar, so those keep the app one.
            #[cfg(target_os = "macos")]
            let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
            #[cfg(not(target_os = "macos"))]
            let tray_icon = app.default_window_icon().unwrap().clone();

            let tray = TrayIconBuilder::new()
                .icon(tray_icon)
                .tooltip("Swarm")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => open_window(app),
                    "whats-new" => open_whats_new(app),
                    "update" => check_for_updates(app.clone()),
                    "quit" => app.exit(0),
                    _ => {}
                });
            #[cfg(target_os = "macos")]
            let tray = tray.icon_as_template(true);
            let _tray = tray.build(app)?;

            Ok(())
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "check-updates" => check_for_updates(app.clone()),
            "whats-new" => open_whats_new(app),
            "zoom-in" => zoom(app, 1),
            "zoom-out" => zoom(app, -1),
            "zoom-reset" => zoom(app, 0),
            "reload" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.eval("location.reload()");
                }
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building Swarm")
        .run(|app, event| match event {
            // Explicit quits (tray Quit, Cmd+Q) carry an exit code — let those through.
            // The code-less request (last window gone) keeps the tray app alive.
            tauri::RunEvent::ExitRequested { api, code, .. } => {
                // Code-less request = last window gone; keep the tray app alive.
                // Explicit quits (tray Quit, Cmd+Q) carry a code and fall through.
                if code.is_none() {
                    api.prevent_exit();
                }
            }
            // Fires on every quit path (macOS Cmd+Q terminates without ExitRequested):
            // take the daemon down with us — only the one we spawned.
            tauri::RunEvent::Exit => {
                if let Some(sidecar) = app.try_state::<Sidecar>() {
                    if let Some(child) = sidecar.0.lock().ok().and_then(|mut g| g.take()) {
                        let _ = child.kill();
                    }
                }
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => open_window(app),
            _ => {}
        });
}
