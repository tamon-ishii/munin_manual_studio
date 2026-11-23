import { copyTextToClipboard } from "./clipboardText";
import { featureDialog } from "./imageDialogs";
import { appendContentDiff } from "./manuscriptTools";
import { acceptDiff, diffParts } from "./selectableDiff";
import type { Document } from "./types";

export interface AiNoteItem {
  index: number;
  line: number;
  start: number;
  end: number;
  note: string;
  raw: string;
}

export interface SendToTerminalContext {
  title?: string;
  page: string;
  lineStart?: number;
  lineEnd?: number;
  excerpt?: string;
  imagePath?: string;
  defaultInstruction?: string;
  dirty?: boolean;
  isConnected: () => boolean;
  openTerminal: () => void;
  sendToTerminal: (prompt: string, submit: boolean) => Promise<void>;
  reportStatus: (message: string, isError?: boolean) => void;
}

export interface ExternalChangeEntry {
  page: string;
  status: "added" | "modified" | "deleted";
  before: string;
  after: string;
  base_sha256: string;
  current_sha256: string;
  added_lines: number;
  removed_lines: number;
}

export interface ExternalChangeTrayOptions {
  sessionId: string;
  changes: ExternalChangeEntry[];
  dirtyPages: Set<string>;
  onApply: (page: string, expectedSha256: string, content: string | null) => Promise<void>;
  onAcceptAll: () => Promise<void>;
  onRefresh: () => Promise<ExternalChangeEntry[]>;
  reportStatus: (message: string, isError?: boolean) => void;
}

/** Extract `<!-- ai-note: ... -->` comments outside fenced code blocks. */
export function extractAiNotes(markdown: string): AiNoteItem[] {
  const fenceRanges: Array<[number, number]> = [];
  const fenceRegex = /(^|\n)(```+|~~~+)[^\n]*\n[\s\S]*?(?:\n\2[ \t]*(?=\n|$)|$)/g;
  for (const match of markdown.matchAll(fenceRegex)) {
    const offset = match.index ?? 0;
    const start = match[1] ? offset + match[1].length : offset;
    fenceRanges.push([start, offset + match[0].length]);
  }
  const inFence = (pos: number) => fenceRanges.some(([s, e]) => pos >= s && pos < e);
  const noteRegex = /<!--\s*ai-note\s*:\s*([\s\S]*?)\s*-->/g;
  const items: AiNoteItem[] = [];
  let idx = 0;
  for (const match of markdown.matchAll(noteRegex)) {
    const start = match.index ?? 0;
    if (inFence(start)) continue;
    const end = start + match[0].length;
    const line = markdown.slice(0, start).split("\n").length;
    items.push({
      index: idx++,
      line,
      start,
      end,
      note: (match[1] || "").trim(),
      raw: match[0],
    });
  }
  return items;
}

export function formatTerminalHandoffPrompt(
  context: Pick<SendToTerminalContext, "page" | "lineStart" | "lineEnd" | "excerpt" | "imagePath" | "dirty">,
  instruction: string,
): string {
  const lines: string[] = [];
  const rangeLabel =
    context.lineStart && context.lineEnd && context.lineEnd > context.lineStart
      ? `（行 ${context.lineStart}-${context.lineEnd}）`
      : context.lineStart
        ? `（行 ${context.lineStart}）`
        : "";
  lines.push(`対象原稿: ${context.page}${rangeLabel}`);
  if (context.imagePath) {
    lines.push(`対象画像: ${context.imagePath}`);
  }
  if (context.dirty) {
    lines.push(
      "注意: エディタに未保存の変更があります。最新本文は MCP の active-editor（include_content: true）で取得してください。",
    );
  }
  lines.push("原稿を修正する際は直接上書きせず、MCP の preview-edit を使って差分確認を提示してください。");
  if (instruction.trim()) {
    lines.push(`指示: ${instruction.trim()}`);
  }
  if (context.excerpt && context.excerpt.trim()) {
    const trimmed =
      context.excerpt.length > 2000
        ? `${context.excerpt.slice(0, 2000)}\n...(省略)`
        : context.excerpt;
    lines.push("対象抜粋:");
    lines.push("```markdown");
    lines.push(trimmed);
    lines.push("```");
  }
  return lines.join("\n");
}

export function openSendToTerminalDialog(context: SendToTerminalContext): Promise<boolean> {
  const { dialog, body } = featureDialog(context.title || "AIターミナルへ送る");
  dialog.id = "terminal-handoff-dialog";

  const targetLine = document.createElement("p");
  targetLine.className = "muted terminal-handoff-meta";
  const rangeText =
    context.lineStart && context.lineEnd && context.lineEnd > context.lineStart
      ? ` 行 ${context.lineStart}〜${context.lineEnd}`
      : context.lineStart
        ? ` 行 ${context.lineStart}`
        : "";
  targetLine.textContent = `対象: ${context.page}${rangeText}${context.imagePath ? ` / 画像: ${context.imagePath}` : ""}`;
  body.append(targetLine);

  if (context.dirty) {
    const dirtyNote = document.createElement("p");
    dirtyNote.className = "muted";
    dirtyNote.textContent =
      "※ 未保存の編集があります。AIには active-editor で編集中本文を読むよう自動で伝えます。";
    body.append(dirtyNote);
  }

  if (context.excerpt?.trim()) {
    const previewLabel = document.createElement("div");
    previewLabel.className = "terminal-handoff-section-label";
    previewLabel.textContent = "対象抜粋";
    const preview = document.createElement("pre");
    preview.className = "selection-ai-preview";
    preview.textContent = context.excerpt.slice(0, 800);
    body.append(previewLabel, preview);
  }

  const form = document.createElement("form");
  form.className = "terminal-handoff-form";
  const label = document.createElement("label");
  label.textContent = "AIへの指示";
  const instruction = document.createElement("textarea");
  instruction.rows = 4;
  instruction.setAttribute("aria-label", "AIへの指示");
  instruction.placeholder = "例: ソースコードから正確なショートカットを確認して手順を補足してください";
  instruction.value = context.defaultInstruction || "";
  label.append(instruction);

  const modeLabel = document.createElement("label");
  modeLabel.className = "setting-checkbox terminal-handoff-submit-option";
  const submitNow = document.createElement("input");
  submitNow.type = "checkbox";
  submitNow.id = "terminal-handoff-auto-submit";
  submitNow.checked = false;
  const modeText = document.createElement("span");
  modeText.textContent = "貼り付けと同時に Enter で自動送信する（オフ時は入力欄に貼るだけ）";
  modeLabel.append(submitNow, modeText);

  const statusNote = document.createElement("p");
  statusNote.className = "muted terminal-handoff-status";
  statusNote.role = "status";
  const connected = context.isConnected();
  if (!connected) {
    statusNote.textContent =
      "AIターミナルが未接続です。ターミナルを開いて接続してから送るか、プロンプトをコピーできます。";
  }

  const actions = document.createElement("div");
  actions.className = "actions dialog-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "キャンセル";
  cancelBtn.onclick = () => dialog.close();

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.textContent = "プロンプトをコピー";
  copyBtn.onclick = async () => {
    const prompt = formatTerminalHandoffPrompt(context, instruction.value);
    try {
      await copyTextToClipboard(prompt);
      statusNote.textContent = "プロンプトをクリップボードにコピーしました。";
      context.reportStatus("AIターミナル用プロンプトをクリップボードにコピーしました。");
    } catch (error) {
      statusNote.textContent = `コピーできませんでした: ${String(error)}`;
      context.reportStatus(`コピーできませんでした: ${String(error)}`, true);
    }
  };

  const sendBtn = document.createElement("button");
  sendBtn.type = "submit";
  sendBtn.className = "primary";
  const updateSendLabel = () => {
    sendBtn.textContent = !context.isConnected()
      ? "AIターミナルを開く"
      : submitNow.checked
        ? "そのまま送信"
        : "入力欄に貼り付け";
  };
  submitNow.onchange = updateSendLabel;
  updateSendLabel();

  actions.append(cancelBtn, copyBtn, sendBtn);
  form.append(label, modeLabel, statusNote, actions);
  body.append(form);
  instruction.focus();

  return new Promise((resolve) => {
    let sent = false;
    form.onsubmit = async (event) => {
      event.preventDefault();
      const prompt = formatTerminalHandoffPrompt(context, instruction.value);
      if (!context.isConnected()) {
        try {
          await copyTextToClipboard(prompt);
          context.reportStatus("プロンプトをコピーしてAIターミナルを開きました。接続後に貼り付けてください。");
        } catch {
          context.reportStatus("AIターミナルを開きました。接続してから再度送ってください。");
        }
        context.openTerminal();
        dialog.close();
        return;
      }
      sendBtn.disabled = true;
      try {
        context.openTerminal();
        await context.sendToTerminal(prompt, submitNow.checked);
        sent = true;
        context.reportStatus(
          submitNow.checked
            ? "AIターミナルへ指示を送信しました。"
            : "AIターミナルの入力欄へ指示を貼り付けました。確認してEnterで送信してください。",
        );
        dialog.close();
      } catch (error) {
        sendBtn.disabled = false;
        statusNote.textContent = `送信できませんでした: ${String(error)}`;
      }
    };
    dialog.addEventListener("close", () => resolve(sent), { once: true });
  });
}

export function openInsertAiNoteDialog(): Promise<string | null> {
  const { dialog, body } = featureDialog("AIメモを挿入");
  dialog.id = "ai-note-insert-dialog";
  dialog.dataset.dialogSize = "compact";

  const help = document.createElement("p");
  help.className = "muted";
  help.textContent =
    "原稿のカーソル位置に一時的なAI依頼メモ（<!-- ai-note: ... -->）を置きます。公開HTMLには表示されず、後からまとめてAIへ依頼できます。";

  const form = document.createElement("form");
  const label = document.createElement("label");
  label.textContent = "AIに依頼したい内容";
  const input = document.createElement("textarea");
  input.rows = 3;
  input.required = true;
  input.placeholder = "例: エラー発生時の対処手順をソースコードから調べて追記する";
  label.append(input);

  const actions = document.createElement("div");
  actions.className = "actions dialog-actions";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "キャンセル";
  cancelBtn.onclick = () => dialog.close();
  const okBtn = document.createElement("button");
  okBtn.type = "submit";
  okBtn.className = "primary";
  okBtn.textContent = "メモを挿入";
  okBtn.disabled = true;
  input.oninput = () => {
    okBtn.disabled = !input.value.trim();
  };
  actions.append(cancelBtn, okBtn);
  form.append(label, actions);
  body.append(help, form);
  input.focus();

  return new Promise((resolve) => {
    let answer: string | null = null;
    form.onsubmit = (event) => {
      event.preventDefault();
      const cleaned = input.value.trim().replace(/-->/g, "→").replace(/\r?\n/g, " ");
      if (!cleaned) return;
      answer = `<!-- ai-note: ${cleaned} -->`;
      dialog.close();
    };
    dialog.addEventListener("close", () => resolve(answer), { once: true });
  });
}

export function openAiNotesManagerDialog(options: {
  page: string;
  notes: AiNoteItem[];
  onJump: (note: AiNoteItem) => void;
  onRemove: (note: AiNoteItem) => void;
  onSendSelected: (selected: AiNoteItem[]) => void;
}): void {
  const { dialog, body } = featureDialog(`AIメモ一覧（${options.page}）`);
  dialog.id = "ai-notes-dialog";

  if (!options.notes.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent =
      "現在の原稿には <!-- ai-note: ... --> メモがありません。「挿入・その他 → AIメモを挿入」から追加できます。";
    body.append(empty);
    return;
  }

  const help = document.createElement("p");
  help.className = "muted";
  help.textContent =
    "チェックしたメモをまとめてAIターミナルへ依頼できます。解決後に preview-edit で反映すると、該当メモが本文へ置き換わります。";
  body.append(help);

  const list = document.createElement("div");
  list.className = "ai-notes-list";
  const checks: Array<{ note: AiNoteItem; input: HTMLInputElement }> = [];

  for (const note of options.notes) {
    const row = document.createElement("div");
    row.className = "ai-note-row";

    const checkLabel = document.createElement("label");
    checkLabel.className = "ai-note-check";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = true;
    const text = document.createElement("span");
    text.textContent = `行 ${note.line}: ${note.note || "（内容なし）"}`;
    checkLabel.append(check, text);

    const actions = document.createElement("div");
    actions.className = "actions";
    const jumpBtn = document.createElement("button");
    jumpBtn.type = "button";
    jumpBtn.textContent = "移動";
    jumpBtn.onclick = () => {
      dialog.close();
      options.onJump(note);
    };
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.textContent = "削除";
    delBtn.onclick = () => {
      dialog.close();
      options.onRemove(note);
    };
    actions.append(jumpBtn, delBtn);
    row.append(checkLabel, actions);
    list.append(row);
    checks.push({ note, input: check });
  }
  body.append(list);

  const footer = document.createElement("div");
  footer.className = "actions dialog-actions";
  const sendBtn = document.createElement("button");
  sendBtn.type = "button";
  sendBtn.className = "primary";
  sendBtn.textContent = "選んだメモをAIターミナルへ依頼";
  sendBtn.onclick = () => {
    const picked = checks.filter((c) => c.input.checked).map((c) => c.note);
    if (!picked.length) return;
    dialog.close();
    options.onSendSelected(picked);
  };
  footer.append(sendBtn);
  body.append(footer);
}

const STATUS_LABELS: Record<ExternalChangeEntry["status"], string> = {
  added: "新規",
  modified: "更新",
  deleted: "削除",
};

export function openExternalChangeTrayDialog(options: ExternalChangeTrayOptions): Promise<void> {
  const { dialog, body } = featureDialog("外部変更の確認トレー");
  dialog.id = "external-change-tray-dialog";

  let changes = [...options.changes];
  let selectedPage = changes[0]?.page || "";

  const intro = document.createElement("p");
  intro.className = "muted";
  intro.textContent =
    "AIターミナル稼働中にディスク上で変更されたMarkdownファイルです。ハンク単位で採用（チェック維持）または変更前へ戻す（チェック解除）を選べます。";

  const topActions = document.createElement("div");
  topActions.className = "actions external-tray-top-actions";
  const refreshBtn = document.createElement("button");
  refreshBtn.type = "button";
  refreshBtn.textContent = "最新の変更を再取得";
  const acceptAllBtn = document.createElement("button");
  acceptAllBtn.type = "button";
  acceptAllBtn.textContent = "すべて承認してトレーを閉じる";
  const feedback = document.createElement("p");
  feedback.role = "status";
  feedback.className = "muted";
  topActions.append(refreshBtn, acceptAllBtn);

  const layout = document.createElement("div");
  layout.className = "external-tray-layout";
  const fileList = document.createElement("div");
  fileList.className = "external-tray-files";
  const detailPane = document.createElement("div");
  detailPane.className = "external-tray-detail";
  layout.append(fileList, detailPane);

  body.append(intro, topActions, feedback, layout);

  function render(): void {
    fileList.replaceChildren();
    detailPane.replaceChildren();
    acceptAllBtn.disabled = changes.length === 0;

    if (!changes.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "未確認の外部変更はありません。";
      detailPane.append(empty);
      return;
    }

    if (!changes.some((c) => c.page === selectedPage)) {
      selectedPage = changes[0].page;
    }

    for (const item of changes) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "external-tray-file-btn";
      if (item.page === selectedPage) btn.classList.add("active");
      const badge = document.createElement("span");
      badge.className = `external-status-badge external-status-${item.status}`;
      badge.textContent = STATUS_LABELS[item.status];
      const name = document.createElement("span");
      name.className = "external-tray-file-name";
      name.textContent = item.page;
      const stats = document.createElement("small");
      stats.className = "muted";
      stats.textContent = `+${item.added_lines} / -${item.removed_lines}`;
      btn.append(badge, name, stats);
      if (options.dirtyPages.has(item.page)) {
        const warn = document.createElement("span");
        warn.className = "external-dirty-badge";
        warn.textContent = "未保存編集あり";
        btn.append(warn);
      }
      btn.onclick = () => {
        selectedPage = item.page;
        render();
      };
      fileList.append(btn);
    }

    const active = changes.find((c) => c.page === selectedPage)!;
    const header = document.createElement("div");
    header.className = "external-tray-detail-header";
    const h3 = document.createElement("h3");
    h3.textContent = `${active.page}（${STATUS_LABELS[active.status]}）`;
    header.append(h3);
    detailPane.append(header);

    if (options.dirtyPages.has(active.page)) {
      const warning = document.createElement("p");
      warning.role = "alert";
      warning.className = "external-tray-warning";
      warning.textContent =
        "この原稿はエディタ上に未保存の変更があります。誤上書きを防ぐため、先にエディタ側で保存または競合確認を行ってください。";
      detailPane.append(warning);
    }

    if (active.status === "added") {
      const pre = document.createElement("pre");
      pre.className = "external-tray-preview";
      pre.textContent = active.after;
      const actions = document.createElement("div");
      actions.className = "actions";
      const keepBtn = document.createElement("button");
      keepBtn.type = "button";
      keepBtn.className = "primary";
      keepBtn.textContent = "新規ファイルを採用（残す）";
      keepBtn.onclick = () => void applyOne(active, active.after);
      const revertBtn = document.createElement("button");
      revertBtn.type = "button";
      revertBtn.textContent = "新規ファイルを削除して戻す";
      revertBtn.disabled = options.dirtyPages.has(active.page);
      revertBtn.onclick = () => void applyOne(active, null);
      actions.append(revertBtn, keepBtn);
      detailPane.append(pre, actions);
      return;
    }

    if (active.status === "deleted") {
      const pre = document.createElement("pre");
      pre.className = "external-tray-preview";
      pre.textContent = active.before;
      const actions = document.createElement("div");
      actions.className = "actions";
      const restoreBtn = document.createElement("button");
      restoreBtn.type = "button";
      restoreBtn.className = "primary";
      restoreBtn.textContent = "削除されたファイルを復元";
      restoreBtn.onclick = () => void applyOne(active, active.before);
      const approveDelBtn = document.createElement("button");
      approveDelBtn.type = "button";
      approveDelBtn.textContent = "削除を承認";
      approveDelBtn.onclick = () => void applyOne(active, null);
      actions.append(approveDelBtn, restoreBtn);
      detailPane.append(pre, actions);
      return;
    }

    // Modified file: hunk-level selectable diff
    const parts = diffParts(active.before, active.after);
    const accepted = new Set<number>();
    parts.forEach((part, index) => {
      if (part.kind === "change") accepted.add(index);
    });

    const controls = document.createElement("div");
    controls.className = "actions diff-controls";
    const count = document.createElement("span");
    count.className = "muted";
    const totalChanges = parts.filter((p) => p.kind === "change").length;
    const updateCount = () => {
      count.textContent = `${accepted.size} / ${totalChanges}件の外部変更を採用`;
    };
    const diffList = document.createElement("div");
    diffList.className = "selectable-diff";

    for (const [labelText, checked] of [
      ["すべて採用", true],
      ["すべて元に戻す", false],
    ] as const) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = labelText;
      btn.onclick = () => {
        diffList.querySelectorAll<HTMLInputElement>("[data-diff-part]").forEach((input) => {
          input.checked = checked;
          const idx = Number(input.dataset.diffPart);
          if (checked) accepted.add(idx);
          else accepted.delete(idx);
        });
        updateCount();
      };
      controls.append(btn);
    }
    controls.append(count);
    updateCount();

    parts.forEach((part, index) => {
      const section = document.createElement("section");
      section.className = `diff-part diff-${part.kind}`;
      if (part.kind === "same") {
        const details = document.createElement("details");
        details.className = "diff-context";
        const summary = document.createElement("summary");
        summary.textContent = `変更のない文章（${part.before.length}行）`;
        const pre = document.createElement("pre");
        pre.textContent = part.before.join("\n");
        details.append(summary, pre);
        section.append(details);
        diffList.append(section);
        return;
      }
      const label = document.createElement("label");
      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = accepted.has(index);
      check.dataset.diffPart = String(index);
      check.onchange = () => {
        if (check.checked) accepted.add(index);
        else accepted.delete(index);
        updateCount();
      };
      label.append(check, document.createTextNode("この外部変更を採用（外すと変更前へ戻す）"));
      section.append(label);

      const columns = document.createElement("div");
      columns.className = "selection-diff-columns";
      for (const [headingText, lines] of [
        ["変更前（スナップショット）", part.before],
        ["変更後（現在のディスク）", part.after],
      ] as const) {
        const col = document.createElement("div");
        const strong = document.createElement("strong");
        strong.textContent = headingText;
        const pre = document.createElement("pre");
        pre.textContent = lines.join("\n");
        col.append(strong, pre);
        columns.append(col);
      }
      section.append(columns);
      diffList.append(section);
    });

    const footer = document.createElement("div");
    footer.className = "actions diff-footer";
    const applyBtn = document.createElement("button");
    applyBtn.type = "button";
    applyBtn.className = "primary";
    applyBtn.textContent = "選んだ変更を確定";
    applyBtn.disabled = options.dirtyPages.has(active.page);
    applyBtn.onclick = () => {
      const merged = acceptDiff(parts, accepted);
      void applyOne(active, merged);
    };
    footer.append(applyBtn);

    detailPane.append(controls, diffList, footer);
  }

  async function applyOne(item: ExternalChangeEntry, nextContent: string | null): Promise<void> {
    feedback.textContent = `${item.page} を更新しています…`;
    try {
      await options.onApply(item.page, item.current_sha256, nextContent);
      changes = await options.onRefresh();
      feedback.textContent = `${item.page} の選択を確定しました。`;
      render();
    } catch (error) {
      feedback.textContent = `確定できませんでした: ${String(error)}`;
      options.reportStatus(String(error), true);
    }
  }

  refreshBtn.onclick = async () => {
    refreshBtn.disabled = true;
    try {
      changes = await options.onRefresh();
      feedback.textContent = `最新の外部変更を取得しました（${changes.length}件）。`;
      render();
    } catch (error) {
      feedback.textContent = `取得に失敗しました: ${String(error)}`;
    } finally {
      refreshBtn.disabled = false;
    }
  };

  acceptAllBtn.onclick = async () => {
    acceptAllBtn.disabled = true;
    try {
      await options.onAcceptAll();
      dialog.close();
    } catch (error) {
      acceptAllBtn.disabled = false;
      feedback.textContent = `処理に失敗しました: ${String(error)}`;
    }
  };

  render();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(), { once: true });
  });
}

export interface GlossaryReplacePlanDoc {
  page: string;
  revision: string;
  before: string;
  after: string;
  count: number;
  replacements: Array<{ line: number; matched: string; preferred: string; term_id: string }>;
}

export function openGlossaryBatchReplaceDialog(options: {
  documents: GlossaryReplacePlanDoc[];
  dirtyPages: Set<string>;
  onApply: (docs: Document[]) => Promise<{ before: Document[]; documents: Document[] }>;
  onUndo: (batch: { before: Document[]; documents: Document[] }) => Promise<void>;
  reportStatus: (message: string, isError?: boolean) => void;
}): Promise<boolean> {
  const { dialog, body } = featureDialog("用語集違反の一括置換（Diff確認）");
  dialog.id = "glossary-batch-replace-dialog";

  if (!options.documents.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "一括置換の対象となる用語集違反は見つかりませんでした。";
    body.append(empty);
    return new Promise((resolve) => {
      dialog.addEventListener("close", () => resolve(false), { once: true });
    });
  }

  const totalCount = options.documents.reduce((sum, d) => sum + d.count, 0);
  const statusEl = document.createElement("p");
  statusEl.className = "muted";
  statusEl.role = "status";
  statusEl.textContent = `${options.documents.length}原稿・合計 ${totalCount}箇所の置換候補。変更前後を確認して適用する原稿を選んでください。`;

  const toolbar = document.createElement("div");
  toolbar.className = "actions";
  const selectAllBtn = document.createElement("button");
  selectAllBtn.type = "button";
  selectAllBtn.textContent = "すべて選択";
  const selectNoneBtn = document.createElement("button");
  selectNoneBtn.type = "button";
  selectNoneBtn.textContent = "選択解除";
  const applyBtn = document.createElement("button");
  applyBtn.type = "button";
  applyBtn.className = "primary";
  applyBtn.textContent = "選んだ原稿を一括置換";
  const undoBtn = document.createElement("button");
  undoBtn.type = "button";
  undoBtn.textContent = "直前の一括置換を元に戻す";
  undoBtn.hidden = true;
  toolbar.append(selectAllBtn, selectNoneBtn, applyBtn, undoBtn);

  const list = document.createElement("div");
  list.className = "glossary-batch-list";

  const selected = new Set<string>();
  const checkboxes: Array<{ page: string; input: HTMLInputElement; dirty: boolean }> = [];

  for (const item of options.documents) {
    const dirty = options.dirtyPages.has(item.page);
    if (!dirty) selected.add(item.page);

    const card = document.createElement("div");
    card.className = "glossary-batch-item";
    const head = document.createElement("div");
    head.className = "glossary-batch-item-head";

    const lbl = document.createElement("label");
    lbl.className = "glossary-batch-check";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !dirty;
    cb.disabled = dirty;
    cb.dataset.glossaryBatchPage = item.page;
    cb.onchange = () => {
      if (cb.checked) selected.add(item.page);
      else selected.delete(item.page);
      applyBtn.disabled = selected.size === 0;
    };
    const titleSpan = document.createElement("span");
    titleSpan.textContent = `${item.page}（${item.count}箇所）`;
    lbl.append(cb, titleSpan);
    head.append(lbl);

    if (dirty) {
      const warn = document.createElement("span");
      warn.className = "quality-badge quality-badge-error";
      warn.textContent = "未保存の編集があるため対象外（先に保存してください）";
      head.append(warn);
    }

    const diffHost = document.createElement("div");
    appendContentDiff(diffHost, item.before, item.after, item.page);
    card.append(head, diffHost);
    list.append(card);
    checkboxes.push({ page: item.page, input: cb, dirty });
  }

  selectAllBtn.onclick = () => {
    for (const c of checkboxes) {
      if (c.dirty) continue;
      c.input.checked = true;
      selected.add(c.page);
    }
    applyBtn.disabled = selected.size === 0;
  };
  selectNoneBtn.onclick = () => {
    for (const c of checkboxes) {
      c.input.checked = false;
      selected.delete(c.page);
    }
    applyBtn.disabled = true;
  };

  let lastBatch: { before: Document[]; documents: Document[] } | null = null;
  let appliedAny = false;

  applyBtn.disabled = selected.size === 0;
  applyBtn.onclick = async () => {
    const targets: Document[] = options.documents
      .filter((d) => selected.has(d.page))
      .map((d) => ({ page: d.page, content: d.after, revision: d.revision }));
    if (!targets.length) return;
    applyBtn.disabled = true;
    statusEl.textContent = `${targets.length}原稿を一括置換しています…`;
    try {
      lastBatch = await options.onApply(targets);
      appliedAny = true;
      undoBtn.hidden = false;
      undoBtn.disabled = false;
      selectAllBtn.disabled = true;
      selectNoneBtn.disabled = true;
      for (const c of checkboxes) c.input.disabled = true;
      statusEl.textContent = `${lastBatch.documents.length}原稿の用語集違反を一括置換しました。必要なら「直前の一括置換を元に戻す」で戻せます。`;
      options.reportStatus(`${lastBatch.documents.length}原稿の用語集違反を一括置換しました。`);
    } catch (error) {
      applyBtn.disabled = false;
      statusEl.textContent = `一括置換できませんでした: ${String(error)}`;
      options.reportStatus(String(error), true);
    }
  };

  undoBtn.onclick = async () => {
    if (!lastBatch) return;
    undoBtn.disabled = true;
    statusEl.textContent = "一括置換を元に戻しています…";
    try {
      await options.onUndo(lastBatch);
      lastBatch = null;
      undoBtn.hidden = true;
      statusEl.textContent = "用語集の一括置換を元に戻しました。";
      options.reportStatus("用語集の一括置換を元に戻しました。");
    } catch (error) {
      undoBtn.disabled = false;
      statusEl.textContent = `元に戻せませんでした: ${String(error)}`;
      options.reportStatus(String(error), true);
    }
  };

  body.append(statusEl, toolbar, list);
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(appliedAny), { once: true });
  });
}
