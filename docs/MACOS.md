# PetDeck on macOS · macOS 安装与使用指南

> 本仓库是 [`Wanbinyu/pet-tty`](https://github.com/Wanbinyu/pet-tty) 的 fork。
> 上游仅官方支持 Windows（MSI/NSIS 安装包）；本 fork 通过 3 处小型补丁让 PetDeck 可以在 **macOS 上从源码构建运行**，Windows 用户请直接参考[上游 README](https://github.com/Wanbinyu/pet-tty)。

---

## English

### What you get

An always-on-top desktop pet that mirrors your Claude Code session status — thinking, reading, editing, waiting for permission — via a local bridge on `127.0.0.1:7788`. Fully local, no data leaves your machine.

### Requirements

| Dependency | Check | Install |
| --- | --- | --- |
| macOS 12+ | — | — |
| Node.js 18+ | `node -v` | [nodejs.org](https://nodejs.org) or `brew install node` |
| Rust (stable) | `rustc --version` | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Xcode Command Line Tools | `xcode-select -p` | `xcode-select --install` |

### Install

```bash
git clone https://github.com/hihanying/pet-tty.git
cd pet-tty
npm install
```

Optional but recommended — install the global `pettty` command (macOS equivalent of the upstream PowerShell installer):

```bash
npm link
```

### Start and connect Claude Code

```bash
pettty        # or: npm start  (= npm run tauri dev)
```

1. Keep the pet running (bridge listens on **7788**).
2. In another terminal: `pettty hooks` — writes HTTP + command hooks into `~/.claude/settings.json` (a timestamped backup is created automatically).
3. **Fully quit** all Claude Code windows and reopen.
4. Chat / use a tool — the pet bubble should show the working state, and the pet terminal logs `publish seq=…`.

### Faster daily startup (recommended)

`pettty` runs the dev flow (Vite + cargo check) every time — fine for development, sluggish for daily use. Build once, then start instantly:

```bash
pettty build     # one-time release build (a few minutes)
pettty release   # instant start, no Vite / cargo involved
```

Even nicer: build a macOS `.app` bundle (one extra flag — the default bundle targets are Windows-only, and this override doesn't touch them), then launch it like any macOS app (Spotlight / Dock / login items):

```bash
npm run tauri build -- --bundles app
cp -R src-tauri/target/release/bundle/macos/PetDeck.app /Applications/
```

### Commands

Same as upstream — see the table in the [README](../README.md#english). Quick reference:

| Command | What it does |
| --- | --- |
| `pettty` | Start pet, auto-repair Claude hooks |
| `pettty hooks` | Install/repair Claude hooks |
| `pettty health` | Check the local bridge |
| `pettty test` | Send a fake status event |
| `pettty build` | Build release binary (produces a macOS `.app`/binary, not an MSI) |

### What is patched for macOS

Three small, reviewable diffs — useful if you want to rebase onto upstream:

1. **`src-tauri/tauri.conf.json`** — `"macOSPrivateApi": true` under `app`. Required because the pet window is `transparent: true`, and macOS transparency needs the `macos-private-api` capability. Note: set it in this config file, **not** by hand-editing `Cargo.toml` — the tauri CLI regenerates the tauri crate features from this flag at `tauri dev`/`tauri build` startup and will strip manual edits. The key name is case-sensitive (`macOSPrivateApi`, not `macosPrivateApi`).
2. **`src-tauri/src/claude_watch.rs` → `pid_alive()`** — the non-Windows branch used `/proc/{pid}`, which is Linux-only. Replaced with a portable `kill -0` probe.
3. **`src-tauri/src/claude_watch.rs` → `process_scan_count()`** — `pgrep -af` uses `-a`, a GNU procps flag that BSD/macOS pgrep rejects. Changed to `pgrep -fl`.

### Troubleshooting

- **Blank / “can't reach this page” window** — always start via `pettty` or `npm start` (the dev flow starts Vite on port 1420 first). Launching the bare debug binary skips the frontend.
- **Pet never connects** — run `pettty health`; then `pettty hooks`; then fully restart Claude Code. Changing API keys can wipe hooks from `settings.json` — rerun `pettty hooks`.
- **Port 7788 already in use** — `lsof -i :7788` to find the stale process, quit the old pet instance.
- **Transparency broken (solid rectangle)** — make sure `"macOSPrivateApi": true` is present in `src-tauri/tauri.conf.json` (see patch #1).
- **First build is slow** — the initial `tauri dev` compiles the whole Rust dependency tree (a few minutes). Subsequent starts are incremental.

### Uninstall

```bash
npm unlink -g          # remove the pettty command (if npm link'ed)
rm -rf pet-tty         # remove the repo
```

Hooks live in `~/.claude/settings.json` — delete the `hooks` object (or restore the `settings.json.petdeck-http-*` backup) to detach Claude Code.

---

## 中文

### 你会得到什么

一个置顶的桌面小宠物，通过本机 `127.0.0.1:7788` 桥接实时显示 Claude Code 的工作状态——思考中、读取文件、编辑代码、等你确认——完全本地运行，数据不出机器。

### 环境要求

| 依赖 | 检查 | 安装 |
| --- | --- | --- |
| macOS 12+ | — | — |
| Node.js 18+ | `node -v` | [nodejs.org](https://nodejs.org) 或 `brew install node` |
| Rust（stable） | `rustc --version` | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Xcode 命令行工具 | `xcode-select -p` | `xcode-select --install` |

### 安装

```bash
git clone https://github.com/hihanying/pet-tty.git
cd pet-tty
npm install
```

推荐可选步骤——安装全局 `pettty` 命令（相当于上游 Windows 的 PowerShell 安装脚本）：

```bash
npm link
```

### 启动并连接 Claude Code

```bash
pettty        # 或者：npm start（= npm run tauri dev）
```

1. 保持宠物运行（桥接监听 **7788**）。
2. 另开终端执行 `pettty hooks`——把 HTTP + command hooks 写入 `~/.claude/settings.json`（脚本会自动生成带时间戳的备份）。
3. **完全退出**所有 Claude Code 窗口再重开。
4. 随便聊一句或用个工具——宠物气泡应显示工作状态，宠物终端会输出 `publish seq=…`。

### 日常快速启动（推荐）

`pettty` 每次都走开发流程（起 Vite + cargo 检查），开发时没问题，日常用偏慢。构建一次，之后秒开：

```bash
pettty build     # 一次性发布构建（几分钟）
pettty release   # 秒开，不再依赖 Vite / cargo
```

更省事的做法：加一个参数构建出 macOS `.app`（默认打包目标只有 Windows 格式，此参数只影响本次构建），然后当成普通 macOS 应用启动（聚焦搜索 / Dock / 登录自启都行）：

```bash
npm run tauri build -- --bundles app
cp -R src-tauri/target/release/bundle/macos/PetDeck.app /Applications/
```

### 命令速查

与上游一致，详见 [README](../README.md#中文)：

| 命令 | 作用 |
| --- | --- |
| `pettty` | 启动桌宠，自动修复 hooks |
| `pettty hooks` | 安装/修复 Claude hooks |
| `pettty health` | 检查本机桥接 |
| `pettty test` | 发送测试状态 |
| `pettty build` | 编译发布版（macOS 产物为二进制/.app，不是 MSI） |

### macOS 需要的 3 处补丁

改动很小、便于 review——如果你想把本 fork rebase 到上游更新，对照检查即可：

1. **`src-tauri/tauri.conf.json`** —— `app` 下新增 `"macOSPrivateApi": true`。桌宠窗口是 `transparent: true`，macOS 透明窗口依赖 `macos-private-api` 能力。注意：必须改这个配置文件，**不要**手改 `Cargo.toml`——tauri CLI 在 `tauri dev`/`tauri build` 启动时会根据此开关重新生成 tauri crate 的 features，手改会被还原。键名大小写敏感（是 `macOSPrivateApi`，不是 `macosPrivateApi`）。
2. **`src-tauri/src/claude_watch.rs` 的 `pid_alive()`** —— 非 Windows 分支原实现用 `/proc/{pid}`，这是 Linux 独有的机制，macOS 上不存在，改为可移植的 `kill -0` 探测。
3. **`src-tauri/src/claude_watch.rs` 的 `process_scan_count()`** —— `pgrep -af` 中的 `-a` 是 GNU procps 的参数，BSD/macOS 的 pgrep 不支持，改为 `pgrep -fl`。

### 常见问题

- **窗口空白 /「无法访问此页面」** —— 必须用 `pettty` 或 `npm start` 启动（开发流程会先在 1420 端口起 Vite）。直接运行 debug 二进制会跳过前端。
- **宠物一直连不上** —— 依次执行 `pettty health`、`pettty hooks`，然后完全重启 Claude Code。改 API Key 可能覆盖 `settings.json` 里的 hooks，重跑 `pettty hooks` 即可。
- **7788 端口被占用** —— `lsof -i :7788` 找到残留进程，退出旧的宠物实例。
- **透明失效（白色矩形）** —— 确认 `src-tauri/tauri.conf.json` 里有 `"macOSPrivateApi": true`（见补丁 1）。
- **首次构建慢** —— 第一次 `tauri dev` 要编译整个 Rust 依赖树（几分钟），之后是增量编译。

### 卸载

```bash
npm unlink -g          # 移除 pettty 命令（如果 npm link 过）
rm -rf pet-tty         # 删除仓库
```

Hooks 在 `~/.claude/settings.json` 里——删掉 `hooks` 对象（或还原 `settings.json.petdeck-http-*` 备份）即可解除与 Claude Code 的关联。

---

## License

MIT（继承上游）。PetDeck 上游：[Wanbinyu/pet-tty](https://github.com/Wanbinyu/pet-tty)。
