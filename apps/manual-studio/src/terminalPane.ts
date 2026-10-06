import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { extractDelimitedResult, DELIMITER_START, DELIMITER_END } from "./terminalOutputParser";

export interface TerminalPaneOptions {
  rpc: (action: string, options?: Record<string, unknown>, root?: string) => Promise<string>;
  getProjectRoot: () => string;
  getCliCommand: () => { command: string; args: string[]; label: string };
  onStatusChange?: (status: "connected" | "stopped" | "waiting", message?: string) => void;
}

export interface TerminalController {
  write(data: string): void;
  fit(): void;
  kill(): Promise<void>;
  restart(): Promise<void>;
  injectPrompt(prompt: string, timeoutMs?: number): Promise<string>;
  isConnected(): boolean;
  dispose(): void;
}

export function setupTerminalPane(
  panelElement: HTMLElement,
  options: TerminalPaneOptions,
): TerminalController {
  const container = panelElement.querySelector<HTMLElement>("#terminal-container") || panelElement;
  const badge = panelElement.querySelector<HTMLElement>("#terminal-badge");
  const agentLabel = panelElement.querySelector<HTMLElement>("#terminal-agent-name");
  const restartBtn = panelElement.querySelector<HTMLButtonElement>("#terminal-restart-btn");
  const clearBtn = panelElement.querySelector<HTMLButtonElement>("#terminal-clear-btn");

  let sessionId: string | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let isPolling = false;
  let isPromptInjecting = false;
  let promptAccumulator = "";
  let promptResolver: ((value: string) => void) | null = null;
  let promptRejecter: ((reason: unknown) => void) | null = null;
  let promptTimeoutTimer: ReturnType<typeof setTimeout> | undefined;

  const terminal = new Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: 13,
    lineHeight: 1.25,
    theme: getTerminalTheme(),
    convertEol: true,
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);

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

  function updateStatus(status: "connected" | "stopped" | "waiting", message?: string): void {
    if (badge) {
      badge.className = `badge ${status}`;
      badge.textContent = status === "connected" ? "● 接続中" : status === "stopped" ? "● 停止" : "● 待機中";
    }
    options.onStatusChange?.(status, message);
  }

  function getTerminalTheme() {
    const isDark = document.documentElement.classList.contains("theme-charcoal") ||
                   document.documentElement.classList.contains("theme-midnight") ||
                   document.documentElement.classList.contains("theme-dark-forest") ||
                   window.matchMedia("(prefers-color-scheme: dark)").matches;
    if (isDark) {
      return {
        background: "#181e19",
        foreground: "#dce5dc",
        cursor: "#a4c4a8",
        selectionBackground: "rgba(255, 255, 255, 0.2)",
      };
    }
    return {
      background: "#ffffff",
      foreground: "#26342f",
      cursor: "#285d46",
      selectionBackground: "rgba(40, 93, 70, 0.2)",
    };
  }

  // Update theme when theme changes
  const themeObserver = new MutationObserver(() => {
    terminal.options.theme = getTerminalTheme();
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

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
    if (!sessionId || isPolling) return;
    isPolling = true;
    try {
      const raw = await options.rpc("pty-read", { sessionId }, options.getProjectRoot());
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
      if (sessionId) {
        pollTimer = setTimeout(() => { void pollOutput(); }, 50);
      }
    }
  }

  async function spawnSession(): Promise<void> {
    if (sessionId) {
      await killSession();
    }
    const root = options.getProjectRoot();
    if (!root) {
      updateStatus("waiting", "プロジェクトが開かれていません");
      return;
    }

    const { command, args, label } = options.getCliCommand();
    if (agentLabel) {
      agentLabel.textContent = label;
    }

    updateStatus("waiting", `${label} を起動中…`);
    terminal.writeln(`\r\n\x1b[36m--- ${label} セッションを起動中 (${root}) ---\x1b[0m\r\n`);

    try {
      fitAddon.fit();
      const raw = await options.rpc("pty-spawn", {
        command,
        args,
        cols: terminal.cols || 80,
        rows: terminal.rows || 24,
      }, root);

      const res = JSON.parse(raw) as { session_id?: string; sessionId?: string };
      sessionId = res.session_id || res.sessionId || null;
      if (sessionId) {
        updateStatus("connected");
        void pollOutput();
      } else {
        updateStatus("stopped", "セッションIDの取得に失敗しました");
      }
    } catch (error) {
      updateStatus("stopped", String(error));
      terminal.writeln(`\r\n\x1b[31m起動に失敗しました: ${String(error)}\x1b[0m\r\n`);
    }
  }

  async function killSession(): Promise<void> {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = undefined;
    }
    if (sessionId) {
      const idToKill = sessionId;
      sessionId = null;
      try {
        await options.rpc("pty-kill", { sessionId: idToKill }, options.getProjectRoot());
      } catch {
        // Ignored
      }
    }
    updateStatus("stopped");
  }

  if (restartBtn) {
    restartBtn.addEventListener("click", () => {
      void spawnSession();
    });
  }

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
    injectPrompt(prompt: string, timeoutMs = 60_000): Promise<string> {
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
          "【重要】生成した結果のみを以下のマーカーで囲んで出力してください。余分な解説や挨拶は含めないでください:",
          DELIMITER_START,
          "(ここに生成結果)",
          DELIMITER_END,
          "",
        ].join("\n");

        promptTimeoutTimer = setTimeout(() => {
          if (isPromptInjecting) {
            isPromptInjecting = false;
            const rejectFn = promptRejecter;
            promptResolver = null;
            promptRejecter = null;
            rejectFn?.(new Error(`AIプロンプトの応答がタイムアウト（${Math.round(timeoutMs / 1000)}秒）しました。ターミナルの状態を確認してください。`));
          }
        }, timeoutMs);

        options.rpc("pty-write", { sessionId, data: instruction }, options.getProjectRoot())
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
    isConnected(): boolean {
      return sessionId !== null;
    },
    dispose() {
      if (promptTimeoutTimer) clearTimeout(promptTimeoutTimer);
      if (pollTimer) clearTimeout(pollTimer);
      resizeObserver.disconnect();
      themeObserver.disconnect();
      terminal.dispose();
    },
  };
}
