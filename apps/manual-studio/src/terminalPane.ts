import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { extractDelimitedResult, DELIMITER_START } from "./terminalOutputParser";
import { currentTheme, type ThemeId } from "./theme";

export interface TerminalPaneOptions {
  rpc: (action: string, options?: Record<string, unknown>, root?: string) => Promise<string>;
  getProjectRoot: () => string;
  getCliCommand: () => { command: string; args: string[]; label: string };
  onUnload?: (ownerId: string, root: string) => void;
  onStatusChange?: (status: "connected" | "stopped" | "starting" | "stopping" | "error", message?: string) => void;
}

export interface TerminalController {
  write(data: string): void;
  fit(): void;
  kill(): Promise<void>;
  restart(): Promise<void>;
  injectPrompt(prompt: string, timeoutMs?: number): Promise<string>;
  isConnected(): boolean;
  getSelection(): string;
  disconnectOnUnload(): void;
  dispose(): void;
}

export const TERMINAL_FONT_FAMILIES: Record<string, string> = {
  jetbrains: '"JetBrains Mono", "Noto Sans Mono CJK JP", "BIZ UDGothic", "Hiragino Sans", "Ubuntu Mono", "DejaVu Sans Mono", "TakaoGothic", "IPAGothic", monospace',
  noto: '"Noto Sans Mono", "Noto Sans Mono CJK JP", "BIZ UDGothic", "Hiragino Sans", "TakaoGothic", "IPAGothic", monospace',
  system: 'ui-monospace, "SF Mono", Monaco, "Cascadia Code", Consolas, "Ubuntu Mono", "Liberation Mono", "DejaVu Sans Mono", monospace',
};

export function getTerminalFontFamily(): string {
  const saved = localStorage.getItem("manual-studio-terminal-font-family") || "jetbrains";
  return TERMINAL_FONT_FAMILIES[saved] || TERMINAL_FONT_FAMILIES.jetbrains;
}

export function getTerminalFontSize(): number {
  const raw = Number(localStorage.getItem("manual-studio-terminal-font-size"));
  return Number.isFinite(raw) && raw >= 11 && raw <= 24 ? raw : 13;
}

const terminalThemes: Record<ThemeId, ITheme> = {
  forest: {
    background: "#161e19",
    foreground: "#e2eae4",
    cursor: "#82c69a",
    cursorAccent: "#161e19",
    selectionBackground: "rgba(130, 198, 154, 0.35)",
    black: "#161e19",
    red: "#e26a64",
    green: "#5cb887",
    yellow: "#e2c275",
    blue: "#6fafe7",
    magenta: "#cd93db",
    cyan: "#61cbbb",
    white: "#e2eae4",
    brightBlack: "#4d5b52",
    brightRed: "#f0857f",
    brightGreen: "#7bd4a3",
    brightYellow: "#f3d893",
    brightBlue: "#8dc5f8",
    brightMagenta: "#e2aef0",
    brightCyan: "#7fe0d2",
    brightWhite: "#ffffff",
  },
  blue: {
    background: "#131924",
    foreground: "#e3ebf5",
    cursor: "#6299e8",
    cursorAccent: "#131924",
    selectionBackground: "rgba(98, 153, 232, 0.35)",
    black: "#131924",
    red: "#e46a78",
    green: "#57c98b",
    yellow: "#e6c675",
    blue: "#66a5f2",
    magenta: "#cb98eb",
    cyan: "#5ecbe2",
    white: "#e3ebf5",
    brightBlack: "#485469",
    brightRed: "#f38793",
    brightGreen: "#75e0a4",
    brightYellow: "#f6db91",
    brightBlue: "#8abbfa",
    brightMagenta: "#dfb4fa",
    brightCyan: "#7de2f5",
    brightWhite: "#ffffff",
  },
  warm: {
    background: "#1c1815",
    foreground: "#eee4dc",
    cursor: "#bc794f",
    cursorAccent: "#1c1815",
    selectionBackground: "rgba(188, 121, 79, 0.35)",
    black: "#1c1815",
    red: "#de6757",
    green: "#6cb773",
    yellow: "#ddb564",
    blue: "#78a6e8",
    magenta: "#ce8fd6",
    cyan: "#62c5b7",
    white: "#eee4dc",
    brightBlack: "#594f47",
    brightRed: "#ee8476",
    brightGreen: "#8ad191",
    brightYellow: "#f1ce80",
    brightBlue: "#97bdf5",
    brightMagenta: "#e1ace7",
    brightCyan: "#7edccf",
    brightWhite: "#ffffff",
  },
  charcoal: {
    background: "#181b19",
    foreground: "#edf1ee",
    cursor: "#82c69a",
    cursorAccent: "#181b19",
    selectionBackground: "rgba(130, 198, 154, 0.3)",
    black: "#181b19",
    red: "#ff978d",
    green: "#82c69a",
    yellow: "#e2c076",
    blue: "#7cb7ff",
    magenta: "#d8a0df",
    cyan: "#79d4cf",
    white: "#edf1ee",
    brightBlack: "#47504a",
    brightRed: "#ffb3ab",
    brightGreen: "#9fdaaf",
    brightYellow: "#ecd394",
    brightBlue: "#9ecbff",
    brightMagenta: "#e7bcf0",
    brightCyan: "#99e3df",
    brightWhite: "#ffffff",
  },
  midnight: {
    background: "#10141e",
    foreground: "#edf2fb",
    cursor: "#8db9ff",
    cursorAccent: "#10141e",
    selectionBackground: "rgba(141, 185, 255, 0.3)",
    black: "#10141e",
    red: "#ff9aa7",
    green: "#8bd3a0",
    yellow: "#f3ca7e",
    blue: "#8db9ff",
    magenta: "#dba4f2",
    cyan: "#84d6ef",
    white: "#edf2fb",
    brightBlack: "#3f4b63",
    brightRed: "#ffb5bf",
    brightGreen: "#a6e8b8",
    brightYellow: "#fae09c",
    brightBlue: "#afd0ff",
    brightMagenta: "#eabefb",
    brightCyan: "#a1e4f7",
    brightWhite: "#ffffff",
  },
  "dark-forest": {
    background: "#121915",
    foreground: "#eaf2ec",
    cursor: "#8bd3a0",
    cursorAccent: "#121915",
    selectionBackground: "rgba(139, 211, 160, 0.3)",
    black: "#121915",
    red: "#ff9884",
    green: "#8bd3a0",
    yellow: "#dfc776",
    blue: "#78bbf3",
    magenta: "#d6a1db",
    cyan: "#77d7bd",
    white: "#eaf2ec",
    brightBlack: "#435548",
    brightRed: "#ffb4a4",
    brightGreen: "#a5e8b8",
    brightYellow: "#f0dc91",
    brightBlue: "#9ad0fa",
    brightMagenta: "#e5bbfb",
    brightCyan: "#95e7d1",
    brightWhite: "#ffffff",
  },
};

function getTerminalTheme(): ITheme {
  const id = currentTheme();
  return terminalThemes[id] || terminalThemes.forest;
}

export function setupTerminalPane(
  panelElement: HTMLElement,
  options: TerminalPaneOptions,
): TerminalController {
  const container = panelElement.querySelector<HTMLElement>("#terminal-container") || panelElement;
  const badge = panelElement.querySelector<HTMLElement>("#terminal-badge");
  const agentLabel = panelElement.querySelector<HTMLElement>("#terminal-agent-name");
  const connectBtn = panelElement.querySelector<HTMLButtonElement>("#terminal-connect-btn");
  const disconnectBtn = panelElement.querySelector<HTMLButtonElement>("#terminal-disconnect-btn");
  const stateNote = panelElement.querySelector<HTMLElement>("#terminal-state-note");
  const clearBtn = panelElement.querySelector<HTMLButtonElement>("#terminal-clear-btn");

  let sessionId: string | null = null;
  let sessionGeneration = 0;
  let sessionRoot = "";
  let ownerId: string | null = null;
  let disposed = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let isPolling = false;
  let isPromptInjecting = false;
  let promptAccumulator = "";
  let promptResolver: ((value: string) => void) | null = null;
  let promptRejecter: ((reason: unknown) => void) | null = null;
  let promptTimeoutTimer: ReturnType<typeof setTimeout> | undefined;

  const terminal = new Terminal({
    cursorBlink: true,
    fontFamily: getTerminalFontFamily(),
    fontSize: getTerminalFontSize(),
    lineHeight: 1.3,
    letterSpacing: 0,
    theme: getTerminalTheme(),
    convertEol: true,
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);

  if (typeof document !== "undefined" && (document as any).fonts?.ready) {
    (document as any).fonts.ready.then(() => {
      try {
        fitAddon.fit();
        if (terminal.rows && terminal.cols) {
          terminal.refresh(0, terminal.rows - 1);
        }
      } catch {
        // Ignored
      }
    });
  }

  function applyActiveTheme(): void {
    const t = getTerminalTheme();
    terminal.options.theme = t;
    if (t.background) {
      container.style.backgroundColor = t.background;
      panelElement.style.backgroundColor = t.background;
    }
  }

  function applyActiveFont(): void {
    const fontFamily = getTerminalFontFamily();
    const fontSize = getTerminalFontSize();
    if (terminal.options.fontFamily !== fontFamily) {
      terminal.options.fontFamily = fontFamily;
    }
    if (terminal.options.fontSize !== fontSize) {
      terminal.options.fontSize = fontSize;
    }
    try {
      fitAddon.fit();
      if (sessionId) {
        void options.rpc("pty-resize", {
          sessionId,
          cols: terminal.cols,
          rows: terminal.rows,
        }, options.getProjectRoot());
      }
    } catch {
      // Ignored
    }
  }

  applyActiveTheme();

  window.addEventListener("manual-studio-theme-change", applyActiveTheme);
  window.addEventListener("manual-studio-terminal-font-change", applyActiveFont);
  const themeObserver = new MutationObserver(applyActiveTheme);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "style"],
  });

  // ResizeObserver to automatically fit on pane resize
  const resizeObserver = new ResizeObserver(() => {
    try {
      if (container.clientWidth > 0 && container.clientHeight > 0) {
        fitAddon.fit();
        if (sessionId) {
          void options.rpc("pty-resize", {
            sessionId,
            cols: terminal.cols,
            rows: terminal.rows,
          }, options.getProjectRoot());
        }
      }
    } catch {
      // Ignored if detached
    }
  });
  resizeObserver.observe(container);

  function updateStatus(status: "connected" | "stopped" | "starting" | "stopping" | "error", message?: string): void {
    const labels = { connected: "接続中", stopped: "未接続", starting: "起動中", stopping: "終了中", error: "接続失敗" };
    if (badge) { badge.className = `badge ${status}`; badge.textContent = `● ${labels[status]}`; }
    if (connectBtn) connectBtn.disabled = status === "connected" || status === "starting" || status === "stopping" || (status === "error" && sessionId !== null);
    if (disconnectBtn) disconnectBtn.disabled = status !== "connected" && status !== "starting" && !(status === "error" && ownerId !== null);
    if (stateNote) stateNote.textContent = message || (status === "stopped" ? "接続ボタンでAI CLIを起動します。" : labels[status]);
    options.onStatusChange?.(status, message);
  }

  // Terminal input handler -> pty-write
  terminal.onData((data) => {
    if (!sessionId) return;
    if (isPromptInjecting) {
      // Prevent user input collision while prompt injection is running
      return;
    }
    void options.rpc("pty-write", { sessionId, data }, options.getProjectRoot()).catch((err) => {
      console.warn("Failed to write to terminal:", err);
    });
  });

  // Terminal resize handler -> pty-resize
  terminal.onResize(({ cols, rows }) => {
    if (!sessionId) return;
    void options.rpc("pty-resize", { sessionId, cols, rows }, options.getProjectRoot()).catch(() => {});
  });

  async function pollOutput(): Promise<void> {
    if (!sessionId || isPolling || disposed) return;
    const readingSessionId = sessionId;
    const readingGeneration = sessionGeneration;
    isPolling = true;
    try {
      const raw = await options.rpc("pty-read", { sessionId: readingSessionId }, sessionRoot);
      if (readingGeneration !== sessionGeneration || readingSessionId !== sessionId || disposed) return;
      const res = JSON.parse(raw) as { data?: string; alive?: boolean };
      if (res.data) {
        terminal.write(res.data);
        if (isPromptInjecting) {
          promptAccumulator += res.data;
          const parsed = extractDelimitedResult(promptAccumulator);
          if (parsed.completed && parsed.result !== undefined) {
            if (promptTimeoutTimer) clearTimeout(promptTimeoutTimer);
            promptTimeoutTimer = undefined;
            const finalResult = parsed.result;
            isPromptInjecting = false;
            const resolve = promptResolver;
            promptResolver = null;
            promptRejecter = null;
            resolve?.(finalResult);
          }
        }
      }
      if (res.alive === false) {
        updateStatus("stopped");
        sessionId = null;
      }
    } catch {
      // Ignore transient errors
    } finally {
      isPolling = false;
      if (sessionId && !disposed) {
        pollTimer = setTimeout(() => { void pollOutput(); }, 50);
      }
    }
  }

  async function spawnSession(): Promise<void> {
    if (disposed || sessionId) return;
    const generation = ++sessionGeneration;
    const root = options.getProjectRoot();
    if (!root) { updateStatus("stopped", "先にプロジェクトを開いてください。"); return; }
    ownerId = crypto.randomUUID();
    sessionRoot = root;
    const spawningOwner = ownerId;
    const { command, args, label } = options.getCliCommand();
    if (agentLabel) {
      agentLabel.textContent = label;
    }

    updateStatus("starting", `${label} を起動中…`);
    terminal.writeln(`\r\n\x1b[36m--- ${label} セッションを起動中 (${root}) ---\x1b[0m\r\n`);

    try {
      fitAddon.fit();
      const raw = await options.rpc("pty-spawn", {
        command,
        args,
        ownerId: spawningOwner,
        cols: terminal.cols || 80,
        rows: terminal.rows || 24,
      }, root);

      const res = JSON.parse(raw) as { session_id?: string; sessionId?: string };
      const spawnedId = res.session_id || res.sessionId || null;
      if (generation !== sessionGeneration) {
        if (spawnedId) await options.rpc("pty-kill", { sessionId: spawnedId }, root).catch(() => {});
        return;
      }
      sessionId = spawnedId;
      sessionRoot = root;
      if (sessionId) {
        updateStatus("connected");
        void pollOutput();
      } else {
        updateStatus("stopped", "セッションIDの取得に失敗しました");
      }
    } catch (error) {
      if (generation !== sessionGeneration) return;
      updateStatus("error", String(error));
      terminal.writeln(`\r\n\x1b[31m起動に失敗しました: ${String(error)}\x1b[0m\r\n`);
    }
  }

  async function killSession(): Promise<void> {
    const generation = ++sessionGeneration;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = undefined; }
    const id = sessionId, root = sessionRoot, owner = ownerId;
    sessionId = null;
    ownerId = null;
    updateStatus("stopping");
    try {
      if (owner) await options.rpc("pty-close-owner", { ownerId: owner }, root);
      else if (id) await options.rpc("pty-kill", { sessionId: id }, root);
    }
    catch (error) { if (generation === sessionGeneration) { sessionId = id; ownerId = owner; updateStatus("error", `切断に失敗しました: ${String(error)}`); throw error; } }
    if (generation === sessionGeneration) updateStatus("stopped");
  }

  connectBtn?.addEventListener("click", () => { void spawnSession(); });
  disconnectBtn?.addEventListener("click", () => { void killSession().catch(() => {}); });
  updateStatus("stopped");

  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      terminal.clear();
    });
  }

  return {
    write(data: string) {
      terminal.write(data);
    },
    fit() {
      try {
        if (container.clientWidth > 0 && container.clientHeight > 0) {
          fitAddon.fit();
        }
      } catch {
        // Ignored
      }
    },
    async kill() {
      await killSession();
    },
    async restart() {
      await spawnSession();
    },
    injectPrompt(prompt: string, timeoutMs = 120_000): Promise<string> {
      if (!sessionId) {
        return Promise.reject(new Error("AIターミナルが接続されていません。再起動してください。"));
      }
      if (isPromptInjecting) {
        return Promise.reject(new Error("現在別のAI処理がターミナルで実行中です。"));
      }

      return new Promise<string>((resolve, reject) => {
        isPromptInjecting = true;
        promptAccumulator = "";
        promptResolver = resolve;
        promptRejecter = reject;

        const instruction = [
          prompt.trim(),
          "",
          "【重要】生成した結果のみを出力してください。余分な解説や挨拶は含めないでください。",
          `出力の最初の行にマーカー ${DELIMITER_START} を出力し、`,
          "出力の最後の行に上記マーカーの START を END に置き換えた終了マーカーを出力してください。",
          "",
        ].join("\n");

        promptTimeoutTimer = setTimeout(() => {
          if (isPromptInjecting) {
            isPromptInjecting = false;
            const rejectFn = promptRejecter;
            promptResolver = null;
            promptRejecter = null;
            void options.rpc("pty-write", { sessionId, data: "\x03" }, options.getProjectRoot()).catch(() => {});
            rejectFn?.(new Error(`AIプロンプトの応答がタイムアウト（${Math.round(timeoutMs / 1000)}秒）しました。ターミナルの状態を確認してください。`));
          }
        }, timeoutMs);

        const useBracketed = Boolean((terminal as any).modes?.bracketedPasteMode);
        const dataToSend = useBracketed
          ? `\x1b[200~${instruction}\x1b[201~\r`
          : `${instruction}\n`;

        options.rpc("pty-write", { sessionId, data: dataToSend }, options.getProjectRoot())
          .catch((err) => {
            if (promptTimeoutTimer) clearTimeout(promptTimeoutTimer);
            isPromptInjecting = false;
            const rejectFn = promptRejecter;
            promptResolver = null;
            promptRejecter = null;
            rejectFn?.(err);
          });
      });
    },
    getSelection(): string { return terminal.getSelection(); },
    isConnected(): boolean {
      return sessionId !== null;
    },
    disconnectOnUnload() {
      ++sessionGeneration;
      if (pollTimer) clearTimeout(pollTimer);
      const owner = ownerId;
      sessionId = null;
      ownerId = null;
      if (owner) options.onUnload?.(owner, sessionRoot);
    },
    dispose() {
      disposed = true;
      void killSession().catch(() => {});
      if (promptTimeoutTimer) clearTimeout(promptTimeoutTimer);
      if (pollTimer) clearTimeout(pollTimer);
      window.removeEventListener("manual-studio-theme-change", applyActiveTheme);
      window.removeEventListener("manual-studio-terminal-font-change", applyActiveFont);
      themeObserver.disconnect();
      resizeObserver.disconnect();
      terminal.dispose();
    },
  };
}
