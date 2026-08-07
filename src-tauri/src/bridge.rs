//! Local HTTP bridge for PetDeck.
//!
//! - POST /event          — petdeck.event.v1 (generic / scripts)
//! - POST /hooks/claude   — raw Claude Code hook JSON (HTTP hooks, low latency)
//! - GET  /health
//! - GET  /events?after=N — HTTP poll of recent events (debug / fallback)
//!
//! Default: http://127.0.0.1:7788
//!
//! Reliability: every accepted event is pushed into a ring buffer **and**
//! emitted via Tauri. The frontend polls `pull_agent_events` so the pet UI
//! still updates if the emit/listen path drops a message.

use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::Read;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use tauri::{AppHandle, Emitter, Manager};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

pub const DEFAULT_PORT: u16 = 7788;
const RING_CAP: usize = 128;
const MAX_BODY_BYTES: usize = 256 * 1024;
const BRIDGE_TOKEN_ENV: &str = "PETDECK_BRIDGE_TOKEN";

struct EventRing {
    next_seq: u64,
    /// (seq, payload) oldest → newest
    items: VecDeque<(u64, Value)>,
}

impl EventRing {
    fn new() -> Self {
        Self {
            next_seq: 1,
            items: VecDeque::with_capacity(RING_CAP),
        }
    }

    fn push(&mut self, mut event: Value) -> (u64, Value) {
        let seq = self.next_seq;
        self.next_seq = self.next_seq.saturating_add(1);
        if let Some(obj) = event.as_object_mut() {
            obj.insert("_seq".into(), json!(seq));
        }
        self.items.push_back((seq, event.clone()));
        while self.items.len() > RING_CAP {
            self.items.pop_front();
        }
        (seq, event)
    }

    fn after(&self, after_seq: u64) -> Vec<Value> {
        self.items
            .iter()
            .filter(|(s, _)| *s > after_seq)
            .map(|(_, e)| e.clone())
            .collect()
    }

    fn last_seq(&self) -> u64 {
        self.next_seq.saturating_sub(1)
    }
}

fn ring() -> &'static Mutex<EventRing> {
    static RING: OnceLock<Mutex<EventRing>> = OnceLock::new();
    RING.get_or_init(|| Mutex::new(EventRing::new()))
}

/// Store + emit + direct webview eval so UI never depends on a single path.
fn publish_event(app: &AppHandle, event: Value) {
    let (seq, stored) = {
        let mut g = ring().lock().unwrap_or_else(|e| e.into_inner());
        g.push(event)
    };
    eprintln!("[petdeck-bridge] publish seq={seq}");

    // 1) Global emit
    if let Err(e) = app.emit("agent-event", &stored) {
        eprintln!("[petdeck-bridge] app.emit failed: {e}");
    }
    // 2) Window-targeted emit
    if let Some(w) = app.get_webview_window("main") {
        if let Err(e) = w.emit("agent-event", &stored) {
            eprintln!("[petdeck-bridge] window.emit failed: {e}");
        }
        // 3) Direct JS inject — most reliable on Windows WebView2
        //    (frontend must expose window.__petdeckIngest)
        let js = format!(
            "(function(){{try{{var p={};if(window.__petdeckIngest)window.__petdeckIngest(p);else window.__petdeckPending=(window.__petdeckPending||[]).concat([p]);}}catch(e){{console.error(e)}}}})()",
            stored
        );
        if let Err(e) = w.eval(&js) {
            eprintln!("[petdeck-bridge] webview.eval failed: {e}");
        } else {
            eprintln!("[petdeck-bridge] webview.eval ok seq={seq}");
        }
    } else {
        eprintln!("[petdeck-bridge] no main window for eval");
    }
}

#[tauri::command]
pub fn pull_agent_events(after_seq: u64) -> Value {
    let g = ring().lock().unwrap_or_else(|e| e.into_inner());
    let events = g.after(after_seq);
    json!({
        "lastSeq": g.last_seq(),
        "events": events,
    })
}

fn header_value<'a>(request: &'a Request, name: &'static str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv(name))
        .map(|header| header.value.as_str())
}

fn allowed_origin(origin: &str) -> bool {
    matches!(
        origin,
        "http://localhost:1420"
            | "http://127.0.0.1:1420"
            | "http://tauri.localhost"
            | "https://tauri.localhost"
    )
}

fn cors(
    mut response: Response<std::io::Cursor<Vec<u8>>>,
    origin: Option<&str>,
) -> Response<std::io::Cursor<Vec<u8>>> {
    response = response
        .with_header(
            Header::from_bytes(
                &b"Access-Control-Allow-Methods"[..],
                &b"GET, POST, OPTIONS"[..],
            )
            .unwrap(),
        )
        .with_header(
            Header::from_bytes(
                &b"Access-Control-Allow-Headers"[..],
                &b"Content-Type, X-PetDeck-Token"[..],
            )
            .unwrap(),
        );

    if let Some(origin) = origin.filter(|origin| allowed_origin(origin)) {
        response = response
            .with_header(
                Header::from_bytes(&b"Access-Control-Allow-Origin"[..], origin.as_bytes()).unwrap(),
            )
            .with_header(Header::from_bytes(&b"Vary"[..], &b"Origin"[..]).unwrap());
    }

    response
}

fn json_response(
    status: u16,
    body: Value,
    origin: Option<&str>,
) -> Response<std::io::Cursor<Vec<u8>>> {
    cors(
        Response::from_string(body.to_string())
            .with_status_code(StatusCode(status))
            .with_header(
                Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap(),
            ),
        origin,
    )
}

fn is_json_content_type(value: Option<&str>) -> bool {
    value
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .is_some_and(|value| value.eq_ignore_ascii_case("application/json"))
}

fn has_json_content_type(request: &Request) -> bool {
    is_json_content_type(header_value(request, "Content-Type"))
}

fn read_body(request: &mut Request) -> Result<String, &'static str> {
    let mut bytes = Vec::new();
    request
        .as_reader()
        .take((MAX_BODY_BYTES as u64) + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "failed to read request body")?;

    if bytes.len() > MAX_BODY_BYTES {
        return Err("request body too large");
    }

    String::from_utf8(bytes).map_err(|_| "request body must be UTF-8")
}

fn configured_token() -> Option<String> {
    std::env::var(BRIDGE_TOKEN_ENV)
        .ok()
        .map(|token| token.trim().to_owned())
        .filter(|token| !token.is_empty())
}

fn token_matches(expected: Option<&str>, provided: Option<&str>) -> bool {
    let Some(expected) = expected else {
        return true;
    };
    let Some(provided) = provided else {
        return false;
    };

    let mut difference = expected.len() ^ provided.len();
    for (left, right) in expected.as_bytes().iter().zip(provided.as_bytes()) {
        difference |= usize::from(*left ^ right);
    }
    difference == 0
}

/// Map Claude Code hook JSON → petdeck.event.v1
fn map_claude_hook(raw: &Value, phase_hint: &str) -> Value {
    let phase = first_str(raw, &["hook_event_name", "event", "type"])
        .or_else(|| {
            if phase_hint.is_empty() {
                None
            } else {
                Some(phase_hint.to_string())
            }
        })
        .unwrap_or_default();
    let p = phase.to_lowercase();

    let tool_name = first_str(raw, &["tool_name", "toolName", "name"]).unwrap_or_default();
    let tool_input = raw
        .get("tool_input")
        .or_else(|| raw.get("toolInput"))
        .or_else(|| raw.get("input"))
        .cloned()
        .unwrap_or(json!({}));

    let session_id = first_str(raw, &["session_id", "sessionId", "transcript_path", "cwd"])
        .unwrap_or_else(|| "claude-session".into());

    let short_sid = short_session(&session_id);

    // Declared without an initializer: every branch of the match below assigns
    // these, so a default value would be dead (and rustc warns). `detail` and
    // `needs_attention` keep defaults since not all branches set them.
    let state: &str;
    let title: String;
    let mut detail: Option<String> = None;
    let mut needs_attention = false;
    let sticky_ms: u64;

    if p.contains("pretool") {
        let n = tool_name.to_lowercase();
        if n.contains("edit") || n.contains("write") || n.contains("notebook") {
            state = "editing";
        } else if n.contains("bash") || n.contains("shell") {
            state = "tool_call";
        } else if n.contains("read") {
            state = "tool_call";
        } else if n.contains("test") {
            state = "running_tests";
        } else {
            state = "tool_call";
        }
        title = tool_title(&tool_name, &tool_input);
        detail = file_or_cmd(&tool_input).or(Some(tool_name.clone()));
        sticky_ms = 900_000; // 15 min safety; UI also treats tool states as sticky
    } else if p.contains("posttool") {
        // Keep a short "still working" hold instead of instant idle —
        // PostToolUse often fires mid-turn; Stop marks true end.
        state = "thinking";
        title = "Working…".into();
        detail = if tool_name.is_empty() {
            Some("Tool finished".into())
        } else {
            Some(format!("Finished {tool_name}"))
        };
        sticky_ms = 45_000;
    } else if p.contains("notification") || p.contains("permission") {
        state = "waiting_user";
        title = "Needs your input".into();
        detail = first_str(raw, &["message", "content"])
            .or(Some("Permission or question pending".into()));
        needs_attention = true;
        sticky_ms = 60_000;
    } else if p.contains("userprompt") {
        state = "thinking";
        title = "Claude is thinking".into();
        detail = first_str(raw, &["prompt", "message", "content"])
            .map(|s| trunc(&s, 80))
            .or(Some("Got your message".into()));
        sticky_ms = 30_000;
    } else if p.contains("messagedisplay") {
        state = "thinking";
        title = "Claude is replying".into();
        detail = first_str(raw, &["text", "message", "content"]).map(|s| trunc(&s, 80));
        sticky_ms = 8000;
    } else if p.contains("stop") {
        state = "success";
        title = "Reply finished".into();
        detail = first_str(raw, &["reason"]).or(Some("Back to idle soon".into()));
        sticky_ms = 2500;
    } else if p.contains("sessionstart") {
        state = "idle";
        title = "Claude connected".into();
        detail = Some(format!("session {short_sid} · 连接中"));
        sticky_ms = 0;
    } else if p.contains("sessionend") {
        state = "idle";
        title = "对话已关闭".into();
        detail = Some(format!("session {short_sid}"));
        sticky_ms = 0;
    } else if !tool_name.is_empty() {
        state = "tool_call";
        title = tool_title(&tool_name, &tool_input);
        sticky_ms = 8000;
    } else {
        state = "thinking";
        title = "Claude is working".into();
        detail = Some(if p.is_empty() {
            "hook".into()
        } else {
            p.clone()
        });
        sticky_ms = 8000;
    }

    json!({
        "schema": "petdeck.event.v1",
        "source": "claude-code",
        "sessionId": session_id,
        "sessionLabel": short_sid,
        "ts": chrono_lite_now(),
        "state": state,
        "title": trunc(&title, 90),
        "detail": detail.map(|d| trunc(&d, 160)),
        "progress": {
            "kind": if state == "idle" || state == "success" { "none" } else { "indeterminate" }
        },
        "needsAttention": needs_attention,
        "stickyMs": sticky_ms,
    })
}

fn chrono_lite_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

fn short_session(id: &str) -> String {
    let cleaned: String = id
        .chars()
        .rev()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(6)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    if cleaned.is_empty() {
        "sess".into()
    } else {
        cleaned
    }
}

fn first_str(v: &Value, keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Some(s) = v.get(*k).and_then(|x| x.as_str()) {
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }
    None
}

fn file_or_cmd(input: &Value) -> Option<String> {
    first_str(input, &["file_path", "path", "filePath", "command"])
}

fn tool_title(name: &str, input: &Value) -> String {
    if name.is_empty() {
        return "Working".into();
    }
    let lower = name.to_lowercase();
    if lower.contains("edit") || lower.contains("write") {
        if let Some(p) = file_or_cmd(input) {
            let base = p.rsplit(['/', '\\']).next().unwrap_or(&p);
            return format!("Editing {base}");
        }
        return "Editing".into();
    }
    if lower.contains("read") {
        if let Some(p) = file_or_cmd(input) {
            let base = p.rsplit(['/', '\\']).next().unwrap_or(&p);
            return format!("Reading {base}");
        }
        return "Reading".into();
    }
    if lower.contains("bash") {
        if let Some(c) = input.get("command").and_then(|x| x.as_str()) {
            let short: String = c.chars().take(40).collect();
            return format!("Shell: {short}");
        }
        return "Shell".into();
    }
    name.to_string()
}

fn trunc(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

pub fn start(app: AppHandle, port: u16) {
    let expected_token = configured_token();
    if expected_token.is_some() {
        eprintln!("[petdeck-bridge] token auth enabled for POST /event and /hooks/claude");
    }

    thread::spawn(move || {
        let addr = format!("127.0.0.1:{port}");
        let server = match Server::http(&addr) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[petdeck-bridge] failed to bind {addr}: {e}");
                let _ = app.emit(
                    "bridge-status",
                    json!({"ok": false, "port": port, "error": e.to_string()}),
                );
                return;
            }
        };

        eprintln!("[petdeck-bridge] listening on http://{addr}");
        let _ = app.emit(
            "bridge-status",
            json!({"ok": true, "port": port, "url": format!("http://{addr}")}),
        );

        let app = Arc::new(app);
        for mut request in server.incoming_requests() {
            let method = request.method().clone();
            let url = request.url().to_string();
            let path = url.split('?').next().unwrap_or("/").to_string();
            let query = url.split('?').nth(1).unwrap_or("");
            let origin = header_value(&request, "Origin").map(str::to_owned);

            if let Some(origin) = origin.as_deref() {
                if !allowed_origin(origin) {
                    let _ = request.respond(json_response(
                        403,
                        json!({"ok": false, "error": "origin not allowed"}),
                        None,
                    ));
                    continue;
                }
            }

            if method == Method::Options {
                let _ = request.respond(cors(
                    Response::from_string("").with_status_code(StatusCode(204)),
                    origin.as_deref(),
                ));
                continue;
            }

            if method == Method::Get && (path == "/" || path == "/health") {
                let g = ring().lock().unwrap_or_else(|e| e.into_inner());
                let _ = request.respond(json_response(
                    200,
                    json!({
                        "service": "petdeck-bridge",
                        "ok": true,
                        "port": port,
                        "lastSeq": g.last_seq(),
                        "endpoints": ["/event", "/hooks/claude", "/events", "/health"],
                    }),
                    origin.as_deref(),
                ));
                continue;
            }

            // HTTP poll fallback (same ring as Tauri command)
            if method == Method::Get && path == "/events" {
                let after: u64 = query
                    .split('&')
                    .find_map(|p| p.strip_prefix("after="))
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0);
                let g = ring().lock().unwrap_or_else(|e| e.into_inner());
                let events = g.after(after);
                let _ = request.respond(json_response(
                    200,
                    json!({ "lastSeq": g.last_seq(), "events": events }),
                    origin.as_deref(),
                ));
                continue;
            }

            let is_event_post = method == Method::Post && path == "/event";
            let is_hook_post =
                method == Method::Post && (path == "/hooks/claude" || path == "/hook/claude");

            if is_event_post || is_hook_post {
                if !has_json_content_type(&request) {
                    let _ = request.respond(json_response(
                        415,
                        json!({"ok": false, "error": "Content-Type must be application/json"}),
                        origin.as_deref(),
                    ));
                    continue;
                }

                if !token_matches(
                    expected_token.as_deref(),
                    header_value(&request, "X-PetDeck-Token"),
                ) {
                    let _ = request.respond(json_response(
                        401,
                        json!({"ok": false, "error": "bridge token required"}),
                        origin.as_deref(),
                    ));
                    continue;
                }

                let body = match read_body(&mut request) {
                    Ok(body) => body,
                    Err(error) => {
                        let status = if error == "request body too large" {
                            413
                        } else {
                            400
                        };
                        let _ = request.respond(json_response(
                            status,
                            json!({"ok": false, "error": error}),
                            origin.as_deref(),
                        ));
                        continue;
                    }
                };

                if is_event_post {
                    match serde_json::from_str::<Value>(&body) {
                        Ok(payload) => {
                            eprintln!(
                                "[petdeck-bridge] event state={} session={}",
                                payload.get("state").and_then(|s| s.as_str()).unwrap_or("?"),
                                payload
                                    .get("sessionId")
                                    .and_then(|s| s.as_str())
                                    .unwrap_or("?")
                            );
                            publish_event(&app, payload);
                            let _ = request.respond(json_response(
                                200,
                                json!({"ok": true}),
                                origin.as_deref(),
                            ));
                        }
                        Err(e) => {
                            let _ = request.respond(json_response(
                                400,
                                json!({"ok": false, "error": e.to_string()}),
                                origin.as_deref(),
                            ));
                        }
                    }
                    continue;
                }

                let phase_hint = query
                    .split('&')
                    .find_map(|p| p.strip_prefix("phase="))
                    .unwrap_or("")
                    .to_string();
                match serde_json::from_str::<Value>(&body) {
                    Ok(raw) => {
                        let event = map_claude_hook(&raw, &phase_hint);
                        eprintln!(
                            "[petdeck-bridge] claude-hook phase={} state={} session={}",
                            phase_hint,
                            event.get("state").and_then(|s| s.as_str()).unwrap_or("?"),
                            event
                                .get("sessionLabel")
                                .and_then(|s| s.as_str())
                                .unwrap_or("?")
                        );
                        publish_event(&app, event);
                        let _ = request.respond(json_response(
                            200,
                            json!({"ok": true}),
                            origin.as_deref(),
                        ));
                    }
                    Err(e) => {
                        eprintln!("[petdeck-bridge] bad claude hook json: {e}");
                        let _ = request.respond(json_response(
                            200,
                            json!({"ok": false, "error": e.to_string()}),
                            origin.as_deref(),
                        ));
                    }
                }
                continue;
            }

            let _ = request.respond(json_response(
                404,
                json!({"ok": false, "error": "not found"}),
                origin.as_deref(),
            ));
        }
    });
}

#[tauri::command]
pub fn bridge_info() -> serde_json::Value {
    json!({
        "port": DEFAULT_PORT,
        "url": format!("http://127.0.0.1:{}", DEFAULT_PORT),
        "postEvent": format!("http://127.0.0.1:{}/event", DEFAULT_PORT),
        "claudeHook": format!("http://127.0.0.1:{}/hooks/claude", DEFAULT_PORT),
        "health": format!("http://127.0.0.1:{}/health", DEFAULT_PORT),
        "events": format!("http://127.0.0.1:{}/events", DEFAULT_PORT),
        "tokenRequired": configured_token().is_some(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_only_known_origins() {
        assert!(allowed_origin("http://localhost:1420"));
        assert!(allowed_origin("http://tauri.localhost"));
        assert!(!allowed_origin("https://example.com"));
        assert!(!allowed_origin("null"));
    }

    #[test]
    fn accepts_json_with_parameters_only() {
        assert!(is_json_content_type(Some("application/json")));
        assert!(is_json_content_type(Some(
            "application/json; charset=utf-8"
        )));
        assert!(!is_json_content_type(Some("text/plain")));
        assert!(!is_json_content_type(None));
    }

    #[test]
    fn token_is_optional_but_constant_time_checked_when_configured() {
        assert!(token_matches(None, None));
        assert!(token_matches(Some("abc"), Some("abc")));
        assert!(!token_matches(Some("abc"), Some("abd")));
        assert!(!token_matches(Some("abc"), None));
    }
}
