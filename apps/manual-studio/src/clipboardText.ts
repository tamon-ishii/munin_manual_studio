import { invoke } from "@tauri-apps/api/core";

/**
 * Copy text to the OS clipboard reliably from both the main window and
 * Tauri independent dialog windows (where the parent document is unfocused).
 */
export async function copyTextToClipboard(text: string): Promise<void> {
  if ("__TAURI_INTERNALS__" in window) {
    try {
      await invoke("write_clipboard_text", { text });
      return;
    } catch {
      // Fall through to web clipboard strategies if native command is unavailable.
    }
  }
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to legacy execCommand fallback when document lacks focus.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.append(textarea);
  try {
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    if (!document.execCommand("copy")) {
      throw new Error("クリップボードへのコピーが拒否されました。");
    }
  } finally {
    textarea.remove();
  }
}
