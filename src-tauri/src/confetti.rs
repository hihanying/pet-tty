//! 任务成功时的全屏礼花覆盖层。
//! macOS 没有公开的系统礼花 API（各家 App 都是自绘），这里用 Tauri 开一个
//! 透明、置顶、不可聚焦、鼠标穿透的全屏辅助窗口，加载 confetti.html 播放
//! 粒子动画，播放完由 Rust 侧定时回收。

use std::time::Duration;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "confetti";
const LIFETIME_MS: u64 = 3200;

/// 前端在任务成功时调用；每次创建新覆盖层，动画结束自动销毁。
#[tauri::command]
pub fn confetti_burst(app: AppHandle) {
    // 残留窗口先回收，避免叠加
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.destroy();
    }

    let (x, y, width, height) = primary_monitor_logical_rect(&app);
    let win = WebviewWindowBuilder::new(
        &app,
        LABEL,
        WebviewUrl::App("confetti.html".into()),
    )
    .position(x, y)
    .inner_size(width, height)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .focused(false)
    .focusable(false)
    .resizable(false)
    .skip_taskbar(true)
    .shadow(false)
    .visible_on_all_workspaces(true)
    .build();

    match win {
        Ok(w) => {
            let _ = w.set_ignore_cursor_events(true);
            let handle = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(LIFETIME_MS));
                if let Some(w) = handle.get_webview_window(LABEL) {
                    let _ = w.destroy();
                }
            });
        }
        Err(e) => eprintln!("[pettty] confetti window: {e}"),
    }
}

/// 主显示器矩形（逻辑坐标；monitor API 返回物理像素，需除以缩放比）。
fn primary_monitor_logical_rect(app: &AppHandle) -> (f64, f64, f64, f64) {
    if let Ok(Some(m)) = app.primary_monitor() {
        let scale = m.scale_factor();
        let p = m.position();
        let s = m.size();
        return (
            p.x as f64 / scale,
            p.y as f64 / scale,
            s.width as f64 / scale,
            s.height as f64 / scale,
        );
    }
    (0.0, 0.0, 1920.0, 1080.0)
}
