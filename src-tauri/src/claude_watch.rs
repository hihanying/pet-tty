//! Detect live Claude Code even when hooks are quiet.
//!
//! Sources:
//! 1) `~/.claude/sessions/*.json` (pid + session id)
//! 2) Running process names: claude.exe / Claude / claude-code

use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSessionInfo {
    pub session_id: String,
    pub pid: u32,
    pub alive: bool,
    pub status: String,
    pub cwd: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudePresence {
    pub connected: bool,
    pub sessions: Vec<ClaudeSessionInfo>,
    pub just_disconnected: bool,
    pub just_connected: bool,
    pub live_count: usize,
}

fn sessions_dir() -> Option<PathBuf> {
    let home = dirs_next_home()?;
    Some(home.join(".claude").join("sessions"))
}

fn dirs_next_home() -> Option<PathBuf> {
    if let Ok(h) = std::env::var("USERPROFILE") {
        return Some(PathBuf::from(h));
    }
    if let Ok(h) = std::env::var("HOME") {
        return Some(PathBuf::from(h));
    }
    None
}

fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let out = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        match out {
            Ok(o) => {
                let s = String::from_utf8_lossy(&o.stdout);
                s.contains(&pid.to_string())
            }
            Err(_) => false,
        }
    }
    #[cfg(not(windows))]
    {
        // macOS/BSD 没有 /proc，用 kill -0 探测进程存活
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

/// Any claude.exe / Claude process running (not tied to sessions/*.json).
fn process_scan_count() -> usize {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let names = ["claude.exe"];
        let mut total = 0usize;
        for name in names {
            let out = Command::new("tasklist")
                .args(["/FI", &format!("IMAGENAME eq {name}"), "/NH"])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
            if let Ok(o) = out {
                let s = String::from_utf8_lossy(&o.stdout).to_lowercase();
                // tasklist prints "INFO: No tasks..." when empty
                if s.contains("claude") && !s.contains("no tasks") && !s.contains("没有") {
                    // rough count of lines with the image name
                    total += s
                        .lines()
                        .filter(|l| l.to_lowercase().contains("claude"))
                        .count()
                        .max(1);
                }
            }
        }
        // Also: wmic/command line often shows node wrapping — check for claude-code path
        let out = Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq node.exe", "/NH"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        // node alone is too broad — skip
        let _ = out;
        total
    }
    #[cfg(not(windows))]
    {
        let out = Command::new("sh")
            // BSD pgrep（macOS）不支持 -a，用 -fl 输出 pid + 完整命令行
            .args(["-c", "pgrep -fl 'claude' 2>/dev/null | head -20"])
            .output();
        match out {
            Ok(o) => {
                let s = String::from_utf8_lossy(&o.stdout);
                s.lines()
                    .filter(|l| l.contains("claude") && !l.contains("pgrep"))
                    .count()
            }
            Err(_) => 0,
        }
    }
}

fn scan_sessions() -> Vec<ClaudeSessionInfo> {
    let mut out = Vec::new();
    let Some(dir) = sessions_dir() else {
        return out;
    };
    if !dir.is_dir() {
        return out;
    }
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for ent in entries.flatten() {
        let path = ent.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let pid = v.get("pid").and_then(|p| p.as_u64()).unwrap_or(0) as u32;
        let session_id = v
            .get("sessionId")
            .or_else(|| v.get("session_id"))
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string();
        if session_id.is_empty() && pid == 0 {
            continue;
        }
        let status = v
            .get("status")
            .and_then(|s| s.as_str())
            .unwrap_or("unknown")
            .to_string();
        let cwd = v
            .get("cwd")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string();
        let name = v
            .get("name")
            .and_then(|s| s.as_str())
            .unwrap_or("claude")
            .to_string();
        let alive = pid_alive(pid);
        out.push(ClaudeSessionInfo {
            session_id: if session_id.is_empty() {
                format!("pid-{pid}")
            } else {
                session_id
            },
            pid,
            alive,
            status,
            cwd,
            name,
        });
    }
    out
}

fn build_presence() -> ClaudePresence {
    let sessions = scan_sessions();
    let mut live: Vec<_> = sessions.into_iter().filter(|s| s.alive).collect();
    let proc_n = process_scan_count();

    // If process exists but sessions dir empty, still report connected
    if live.is_empty() && proc_n > 0 {
        live.push(ClaudeSessionInfo {
            session_id: "claude-process".into(),
            pid: 0,
            alive: true,
            status: "running".into(),
            cwd: String::new(),
            name: "claude".into(),
        });
    }

    ClaudePresence {
        connected: !live.is_empty() || proc_n > 0,
        // Session-file count is the accurate "N terminals" value. (proc_n is
        // only used for the connected flag + synthetic-session fallback above.)
        live_count: live.len(),
        sessions: live,
        just_connected: false,
        just_disconnected: false,
    }
}

pub fn start(app: AppHandle) {
    thread::spawn(move || {
        let mut was_connected = false;
        loop {
            let mut payload = build_presence();
            let connected = payload.connected;
            payload.just_connected = connected && !was_connected;
            payload.just_disconnected = !connected && was_connected;
            was_connected = connected;

            if payload.just_connected {
                eprintln!(
                    "[pettty] Claude detected (live_count={})",
                    payload.live_count
                );
            }
            if payload.just_disconnected {
                eprintln!("[pettty] Claude process gone");
            }

            let _ = app.emit("claude-presence", &payload);
            thread::sleep(Duration::from_millis(1500));
        }
    });
}

#[tauri::command]
pub fn claude_presence_snapshot() -> ClaudePresence {
    build_presence()
}
