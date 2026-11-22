//! Gyre desktop shell.
//!
//! The shell is deliberately thin: it starts the bundled gateway sidecar (which
//! drives the user's installed `omp`), waits for its `GYRE_READY` line, and
//! opens a window on the gateway's local URL. All product logic lives in the
//! gateway and web UI, so the desktop and browser experiences are identical.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

use tauri::webview::NewWindowResponse;
use tauri::{Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};

struct Gateway(Mutex<Option<Child>>);

fn sidecar_path() -> PathBuf {
    let exe = std::env::current_exe().expect("current exe");
    let dir = exe.parent().expect("exe dir");
    let name = if cfg!(windows) {
        "gyre-gateway.exe"
    } else {
        "gyre-gateway"
    };
    dir.join(name)
}

fn is_local(url: &Url) -> bool {
    matches!(
        url.host_str(),
        Some("127.0.0.1")
            | Some("localhost")
            | Some("tauri.localhost")
            | Some("::1")
            | Some("[::1]")
    )
}

fn open_external(url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
    }
}

/// Start the gateway and block until it reports its URL and token.
fn start_gateway(
    web_dist: Option<PathBuf>,
    extension: Option<PathBuf>,
) -> Result<(Child, String), Box<dyn std::error::Error>> {
    let mut cmd = Command::new(sidecar_path());
    cmd.env("GYRE_PORT", "0")
        .env("GYRE_EXIT_ON_STDIN_CLOSE", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    if let Some(dir) = web_dist {
        cmd.env("GYRE_WEB_DIST", dir);
    }
    if let Some(path) = extension {
        cmd.env("GYRE_OMP_EXTENSION", path);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to start gateway {:?}: {e}", sidecar_path()))?;
    let stdout = child.stdout.take().ok_or("gateway stdout unavailable")?;
    let (tx, rx) = mpsc::sync_channel(1);
    let reader_thread = std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let result: Result<serde_json::Value, String> = loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break Err("the Gyre gateway exited before it was ready".into()),
                Err(error) => break Err(error.to_string()),
                Ok(_) => {
                    if let Some(rest) = line.trim().strip_prefix("GYRE_READY ") {
                        break serde_json::from_str(rest).map_err(|error| error.to_string());
                    }
                }
            }
        };
        let _ = tx.send(result);
        // Keep draining stdout so the gateway cannot block on a full pipe.
        for _ in reader.lines() {}
    });
    let startup = (|| -> Result<String, Box<dyn std::error::Error>> {
        let ready = rx
            .recv_timeout(Duration::from_secs(30))
            .map_err(|_| "gateway readiness timed out")??;
        let mut url = Url::parse(ready["url"].as_str().ok_or("ready line missing url")?)?;
        match url.host_str() {
            Some("0.0.0.0") => url.set_host(Some("127.0.0.1"))?,
            Some("::") | Some("[::]") => url.set_host(Some("[::1]"))?,
            _ => {}
        }
        let token = ready["token"].as_str().ok_or("ready line missing token")?;
        url.set_fragment(Some(&format!("token={token}")));
        Ok(url.to_string())
    })();
    let url = match startup {
        Ok(url) => url,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader_thread.join();
            return Err(error);
        }
    };
    Ok((child, url))
}

fn stop_gateway(child: &mut Child) {
    // Closing stdin asks the gateway to shut down, which also stops its omp processes.
    drop(child.stdin.take());
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            _ if Instant::now() > deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
            _ => std::thread::sleep(Duration::from_millis(100)),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let resources = app.path().resource_dir().ok();
            let web_dist = resources
                .as_ref()
                .map(|dir| dir.join("web"))
                .filter(|dir| dir.join("index.html").exists());
            // Gyre's omp extension (plan mode), shipped as TypeScript that omp loads directly.
            let extension = resources
                .as_ref()
                .map(|dir| dir.join("omp-extension").join("src").join("index.ts"))
                .filter(|path| path.exists());
            let (child, url) = start_gateway(web_dist, extension)?;
            app.manage(Gateway(Mutex::new(Some(child))));

            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse()?))
                .title("Gyre")
                .inner_size(1440.0, 900.0)
                .min_inner_size(900.0, 600.0)
                // Links to the outside world open in the system browser.
                .on_navigation(|url| {
                    if is_local(url) {
                        true
                    } else {
                        open_external(url);
                        false
                    }
                })
                .on_new_window(|url, _features| {
                    open_external(&url);
                    NewWindowResponse::Deny
                })
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Gyre")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<Gateway>() {
                    if let Some(mut child) = state.0.lock().expect("gateway lock").take() {
                        stop_gateway(&mut child);
                    }
                }
            }
        });
}
