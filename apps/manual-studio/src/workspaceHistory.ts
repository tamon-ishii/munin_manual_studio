import { invoke } from "@tauri-apps/api/core";

const storageKey = "manual-studio-workspace-history";
function validHistory(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())))].slice(0, 20) : [];
}
export async function loadWorkspaceHistory(native: boolean): Promise<string[]> {
  return validHistory(native ? await invoke("load_workspace_history") : JSON.parse(localStorage.getItem(storageKey) || "[]"));
}
export async function recordWorkspaceHistory(native: boolean, root: string): Promise<void> {
  if (native) { await invoke("record_workspace_history", { root }); return; }
  const history = await loadWorkspaceHistory(false);
  localStorage.setItem(storageKey, JSON.stringify([root, ...history.filter(entry => entry !== root)].slice(0, 20)));
}
export function showWorkspaceHistory(history: string[], current: string, open: (root: string) => Promise<void>): void {
  const dialog = document.createElement("dialog");
  dialog.id = "workspace-history-dialog";
  dialog.setAttribute("aria-labelledby", "workspace-history-title");
  dialog.innerHTML = '<h2 id="workspace-history-title">最近開いたワークスペース</h2><p class="muted">最近開いた順に表示します。</p><div class="workspace-history-list"></div><div class="actions"><button type="button" data-history-close>閉じる</button></div>';
  const list = dialog.querySelector(".workspace-history-list")!;
  if (!history.length) list.textContent = "ワークスペース履歴はまだありません。";
  for (const root of history) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.workspaceRoot = root;
    button.className = "workspace-history-entry";
    const name = document.createElement("strong");
    name.textContent = (root.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || root) + (root === current ? "（現在）" : "");
    const path = document.createElement("span");
    path.textContent = root;
    button.append(name, path);
    button.addEventListener("click", () => { dialog.close(); dialog.remove(); void open(root); });
    list.append(button);
  }
  dialog.querySelector("[data-history-close]")!.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}
