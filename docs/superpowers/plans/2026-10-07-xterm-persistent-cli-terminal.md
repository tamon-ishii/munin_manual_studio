# 常駐AI CLIセッションとxterm.js対話ターミナル統合 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Munin Manual Studio に常駐擬似端末（PTY）と `xterm.js` による対話ターミナルを統合し、初期トークンや起動遅延を抑えて単一のAI CLIセッション（Claude Code, Codex, Agy等）をAIタグ生成・更新にも使い回す。

**Architecture:** バックエンド（`manual-core`）に `portable-pty` によるクロスプラットフォームPTY管理を実装し、RPC（Tauri / manualctl dev bridge）経由でフロントエンドの `@xterm/xterm` と双方向通信する。AIタグ更新時は常駐PTYのstdinにデリミタ要求付きプロンプトを注入し、ストリームから結果を抽出・ANSI除去してMarkdown原稿へ自動反映する。

**Tech Stack:** Rust (`portable-pty`, `manual-core`, Tauri), TypeScript, `@xterm/xterm`, `@xterm/addon-fit`, FlexLayout, Vite

**Spec:** `docs/superpowers/specs/2026-10-07-xterm-persistent-cli-terminal-design.md`

## Global Constraints

- ワークスペース起動時に設定されたAI CLI（`claude`, `codex`, `agy`）をワークスペースルートでPTY起動すること。
- PTY通信はTauriデスクトップ環境とVite devサーバー（`manualctl`）の両方で動作すること。
- テーマ変更（フォレスト、ミッドナイト等）時にターミナルの配色が自動更新されること。
- 既存のE2Eスモークテストおよびチェックテスト（`npm run manual:smoke`, `npm run manual:check`）をすべてパスさせること。

## Review Focus

1. **PTYプロセス終了時の復帰**: CLIがクラッシュまたは終了した場合にUIが停止状態を表示し、再起動ボタンで安全に再生成できるか。
2. **ANSIエスケープシーケンスの混入防止**: 原稿へ反映するMarkdownにANSI装飾文字やカーソル制御コードが一切残らないか。
3. **ウィンドウおよびパネルリサイズ**: FlexLayoutのスプリッター移動や画面リサイズ時にxtermの行・列が自動でフィットし、PTYに通知されるか。
4. **マーカー欠落時のタイムアウト**: CLIがマーカーを出力せずにプロンプトに戻った場合に、処理がハングせず適切にタイムアウト・通知されるか。
5. **同時実行・入力ブロック**: AIタグ生成の実行中にユーザーのキー入力が競合しないよう適切に入力制御または通知が行われるか。

---

### Task 1: Rust PTY Manager in `manual-core`

**Files:**
- Modify: `crates/manual-core/Cargo.toml`
- Create: `crates/manual-core/src/pty.rs`
- Modify: `crates/manual-core/src/lib.rs`
- Modify: `crates/manual-core/src/bin/manualctl.rs`

**Interfaces:**
- Produces:
  - `pub fn pty_spawn(root: &Path, command: &str, args: &[String], cols: u16, rows: u16) -> Result<String, String>`
  - `pub fn pty_write(session_id: &str, data: &str) -> Result<(), String>`
  - `pub fn pty_read(session_id: &str) -> Result<String, String>`
  - `pub fn pty_resize(session_id: &str, cols: u16, rows: u16) -> Result<(), String>`
  - `pub fn pty_kill(session_id: &str) -> Result<(), String>`

- [x] **Step 1: Add `portable-pty` dependency to `crates/manual-core/Cargo.toml`**

Add `portable-pty = "0.8"` to dependencies.

- [x] **Step 2: Write failing unit test for PTY lifecycle in `crates/manual-core/src/pty.rs`**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn test_pty_spawn_write_and_read() {
        let root = Path::new(".");
        #[cfg(windows)]
        let cmd = "cmd.exe";
        #[cfg(not(windows))]
        let cmd = "sh";
        let session_id = pty_spawn(root, cmd, &[], 80, 24).unwrap();
        pty_write(&session_id, "echo hello_pty\n").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));
        let output = pty_read(&session_id).unwrap();
        assert!(output.contains("hello_pty"));
        pty_kill(&session_id).unwrap();
    }
}
```

- [x] **Step 3: Run test to verify it fails**

Run: `cargo test --package manual-core pty`
Expected: FAIL (missing module / functions)

- [x] **Step 4: Implement `crates/manual-core/src/pty.rs`**

Implement global session storage with `Arc<Mutex<HashMap<String, PtySession>>>`, capturing child process, writer, and a thread reading from the PTY master into a buffer.

- [x] **Step 5: Wire PTY RPC actions into `lib.rs` and `manualctl.rs`**

Add handlers for `"pty-spawn"`, `"pty-write"`, `"pty-read"`, `"pty-resize"`, `"pty-kill"` in `run_request`.

- [x] **Step 6: Run test to verify it passes**

Run: `cargo test --package manual-core pty`
Expected: PASS

- [x] **Step 7: Commit**

```bash
git add crates/manual-core/Cargo.toml crates/manual-core/src/pty.rs crates/manual-core/src/lib.rs crates/manual-core/src/bin/manualctl.rs
git commit -m "feat(core): implement portable-pty session manager and RPC endpoints"
```

---

### Task 2: Terminal Output Parser & ANSI Stripper in `manual-studio`

**Files:**
- Create: `apps/manual-studio/src/terminalOutputParser.ts`
- Create: `scripts/test_terminal_output_parser.mjs`

**Interfaces:**
- Produces:
  - `stripAnsi(text: string): string`
  - `extractDelimitedResult(buffer: string): { completed: boolean; result?: string; remaining: string }`

- [x] **Step 1: Write test script `scripts/test_terminal_output_parser.mjs`**

```javascript
import assert from "node:assert/strict";
import { stripAnsi, extractDelimitedResult } from "../apps/manual-studio/src/terminalOutputParser.ts";

// Test ANSI stripping
const colored = "\u001b[32mHello\u001b[0m \u001b[1mWorld\u001b[0m";
assert.equal(stripAnsi(colored), "Hello World");

// Test delimited extraction
const chunk1 = "Thinking...\n<<<MANUAL_STUDIO_RESULT_START>>>\n# Title\nContent";
const res1 = extractDelimitedResult(chunk1);
assert.equal(res1.completed, false);

const chunk2 = chunk1 + "\n<<<MANUAL_STUDIO_RESULT_END>>>\nDone!";
const res2 = extractDelimitedResult(chunk2);
assert.equal(res2.completed, true);
assert.equal(res2.result?.trim(), "# Title\nContent");
console.log("terminalOutputParser tests passed!");
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --loader tsx scripts/test_terminal_output_parser.mjs`
Expected: FAIL (module not found)

- [x] **Step 3: Implement `apps/manual-studio/src/terminalOutputParser.ts`**

Implement `stripAnsi` using standard ANSI escape regex, and `extractDelimitedResult` searching for `<<<MANUAL_STUDIO_RESULT_START>>>` and `<<<MANUAL_STUDIO_RESULT_END>>>`.

- [x] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/test_terminal_output_parser.mjs`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add apps/manual-studio/src/terminalOutputParser.ts scripts/test_terminal_output_parser.mjs
git commit -m "feat(terminal): add terminal output parser and ANSI stripper"
```

---

### Task 3: xterm.js Dependency and Terminal Pane Component

**Files:**
- Modify: `package.json`
- Create: `apps/manual-studio/src/terminalPane.ts`
- Modify: `apps/manual-studio/index.html`
- Modify: `apps/manual-studio/src/style.css`

**Interfaces:**
- Produces:
  - `export function setupTerminalPane(container: HTMLElement, options: TerminalPaneOptions): TerminalController`
  - `interface TerminalController { write(data: string): void; fit(): void; kill(): Promise<void>; restart(): Promise<void>; injectPrompt(prompt: string): Promise<string>; }`

- [x] **Step 1: Install `@xterm/xterm` and `@xterm/addon-fit`**

Run: `npm install @xterm/xterm @xterm/addon-fit`

- [x] **Step 2: Add `#panel-terminal` DOM structure to `apps/manual-studio/index.html`**

Inside `#layout-panel-pool`, add:
```html
<section id="panel-terminal" class="panel panel-terminal">
  <div class="terminal-toolbar">
    <div class="terminal-status"><span id="terminal-badge" class="badge">● 接続待機中</span><span id="terminal-agent-name" class="muted">AI CLI</span></div>
    <div class="actions">
      <button type="button" id="terminal-restart-btn">再起動</button>
      <button type="button" id="terminal-clear-btn">クリア</button>
    </div>
  </div>
  <div id="terminal-container" class="terminal-container"></div>
</section>
```

- [x] **Step 3: Add CSS for terminal in `apps/manual-studio/src/style.css`**

Import `@xterm/xterm/css/xterm.css` and style `.panel-terminal`, `.terminal-toolbar`, and `.terminal-container` (full height, flex layout).

- [x] **Step 4: Implement `apps/manual-studio/src/terminalPane.ts`**

Initialize `Terminal` and `FitAddon`.
Implement PTY polling/communication (`pty-spawn`, `pty-read`, `pty-write`, `pty-resize`, `pty-kill`).
Synchronize theme variables from `document.documentElement` to xterm terminal colors (`background`, `foreground`, `selectionBackground`, `cursor`).

- [x] **Step 5: Build verification**

Run: `npm run manual:build`
Expected: PASS

- [x] **Step 6: Commit**

```bash
git add package.json package-lock.json apps/manual-studio/index.html apps/manual-studio/src/style.css apps/manual-studio/src/terminalPane.ts
git commit -m "feat(terminal): integrate xterm.js terminal pane and PTY client"
```

---

### Task 4: FlexLayout Dock Integration for AI Terminal

**Files:**
- Modify: `apps/manual-studio/src/windowLayout.tsx`
- Modify: `apps/manual-studio/src/main.ts`

**Interfaces:**
- `PANELS`: includes `{ id: "terminal", name: "AIターミナル", elementId: "panel-terminal" }`
- `STORAGE_KEY`: updated to `"manual-studio-flexlayout-model-v4"`

- [x] **Step 1: Update `windowLayout.tsx` with terminal panel**

Add `terminal` panel to `PANELS`.
In `defaultLayoutJson`, add `terminal` tab to `tabset-bottom` alongside `ai-tags`.
Update `STORAGE_KEY = "manual-studio-flexlayout-model-v4"`.
In `loadStoredModel()`, purge previous keys.

- [x] **Step 2: Connect `setupTerminalPane` in `apps/manual-studio/src/main.ts`**

Initialize the terminal pane on `#panel-terminal` and start the persistent PTY session when a workspace is opened.

- [x] **Step 3: Build verification**

Run: `npm run manual:build`
Expected: PASS

- [x] **Step 4: Commit**

```bash
git add apps/manual-studio/src/windowLayout.tsx apps/manual-studio/src/main.ts
git commit -m "feat(layout): dock AI terminal into FlexLayout bottom tabset"
```

---

### Task 5: AI Tag Update Integration with Persistent Terminal Session

**Files:**
- Modify: `apps/manual-studio/src/main.ts`

- [x] **Step 1: Wire tag generation to `terminalController.injectPrompt`**

In `main.ts`, update `runAiPage` / AI tag regeneration to inject prompt with delimiters into `terminalController` when terminal is connected.

- [x] **Step 2: Handle response extraction and editor update**

When the end marker is found, extract clean Markdown, strip ANSI, and update the document.
Update preview and show feedback note.

- [x] **Step 3: Add timeout and fallback handling**

If delimiter is not received within timeout (e.g. 60s), notify user and provide manual fallback.

- [x] **Step 4: Build verification**

Run: `npm run manual:build`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add apps/manual-studio/src/main.ts
git commit -m "feat(generation): multiplex AI tag generation through persistent terminal session"
```

---

### Task 6: Comprehensive Verification & Smoke Tests

**Files:**
- Modify: `scripts/smoke_manual_studio.mjs`

- [x] **Step 1: Add terminal smoke checks in `scripts/smoke_manual_studio.mjs`**

Verify `#panel-terminal`, xterm canvas/DOM elements, toolbar restart button, and AI tag generation through PTY.

- [x] **Step 2: Run `manual:smoke`**

Run: `npm run manual:smoke`
Expected: PASS

- [x] **Step 3: Run `manual:test-workflow`**

Run: `npm run manual:test-workflow`
Expected: PASS

- [x] **Step 4: Run full `manual:check`**

Run: `npm run manual:check`
Expected: PASS (all 15 check steps pass)

- [x] **Step 5: Commit**

```bash
git add scripts/smoke_manual_studio.mjs
git commit -m "test: verify persistent AI terminal and generation in smoke test suite"
```
