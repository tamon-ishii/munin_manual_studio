import { applyEditorFontSize, isEditorFontSize, setupEditorFontSize } from "./editorFontSize";
import { setupMilkdownEditor, renderMermaid } from "./milkdownEditor";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { EditorHistory, type EditorSnapshot } from "./editorHistory";
import { completeMarkitsCapture } from "./markitsWorkflow";
import { CaptureSessionStore } from "./captureSession";
import { collectAiTagIds } from "./markdownTags";
import { setupPaneResizers } from "./paneResizers";
import { setupWindowLayout, type WindowLayoutManager } from "./windowLayout";
import { createPreviewNavigator } from "./previewNavigation";
import { sendManualRequest } from "./manualTransport";
import { renderFileTree } from "./fileTree";
import { setupPreviewTheme } from "./themePreview";
import { setupMarkdownTableEditor } from "./markdownTable";
import { setupDocumentTagsPane } from "./documentTagsPane";
import { jumpToSource } from "./editorNavigation";
import { setupWorkspaceWizard } from "./workspaceWizard";
import { showGenerationReview } from "./generationReview";
import { showUnsavedChangesDialog } from "./unsavedChangesDialog";
import { loadWorkspaceHistory, recordWorkspaceHistory, showWorkspaceHistory } from "./workspaceHistory";
import { changeHeadingLevel, toggleStrikethrough, toggleTaskList, changeIndent, continueMarkdownList, type MarkdownEdit } from "./markdownAssists";
import { applyTheme, currentTheme, initializeTheme, isThemeId, type ThemeId } from "./theme";
import { setupTerminalPane, type TerminalController } from "./terminalPane";
import { emit } from "@tauri-apps/api/event";
import "./style.css";

import type { Task, State, Document, NativeWindow, RecordingResult, LaunchCommand } from "./types";

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const input = (id: string): HTMLInputElement => element(id);
const editor = element<HTMLTextAreaElement>("markdown-editor");
const milkdown = setupMilkdownEditor(editor, message => status(message, true), source => {
  if (!documentState || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(source)) return Promise.resolve(source);
  return rpc("preview-asset", { page: documentState.page, asset: source });
}, uploadMilkdownImage, requestAiTask);
setupPreviewTheme(element<HTMLIFrameElement>("markdown-preview"));
const native = "__TAURI_INTERNALS__" in window;
const params = new URLSearchParams(location.search);
const recordingControlMode = params.get("recordingControl") === "1";
const detached = params.get("editor") === "1";
initializeTheme();
setupEditorFontSize(input("editor-font-size"), size => {
  if (native) void emit("manual-studio-editor-font-size-changed", size);
});
if (native) void listen<number>("manual-studio-editor-font-size-changed", ({ payload }) => {
  if (isEditorFontSize(payload)) applyEditorFontSize(payload, false);
});
const themePicker = element<HTMLSelectElement>("ui-theme");
themePicker.value = currentTheme();
window.addEventListener("manual-studio-theme-change", () => { themePicker.value = currentTheme(); });
if (native) void listen<ThemeId>("manual-studio-theme-changed", ({ payload }) => { if (isThemeId(payload)) applyTheme(payload, false); });
let projectRoot = "";
let workspace: State | null = null;
let documentState: Document | null = null;
let dirty = false;
let busy = false;
let previewVersion = 0;
let previewScrollWindow: Window | null = null;
let syncingScroll = false;
let progressTimer: ReturnType<typeof setInterval> | undefined;
let progressPollTimer: ReturnType<typeof setInterval> | undefined;
let progressStartedAt = 0;
let progressLastEventAt = 0;
let progressRunning = false;
let progressDisplayLogs: string[] = [];
let progressAgentTotal = 0;
let manualStudioHiddenForCapture = false;
let previewTimer: ReturnType<typeof setTimeout>;
const expandedFolders = new Set<string>();
interface AiReviewSnapshot { before: Document; after: Document; id?: string; updated: string[] }
const aiReviews = new Map<string, AiReviewSnapshot>();
const aiReviewKey = (page: string) => JSON.stringify([projectRoot, page]);
const editHistory = new EditorHistory();
let replayingHistory = false;
let operationRecording = false;
let recordingStarting = false;
let externalFinishActive = false;
let recordingFinishing: Promise<void> | null = null;
let recordingFinishActive = false;
let activeRecordingResult: RecordingResult | null = null;
let launchCommands: LaunchCommand[] = [];
let recordingPoll: ReturnType<typeof setTimeout> | undefined;
let recordingPollGeneration = 0;
const captureSessions = new CaptureSessionStore();
let acceptedRecordingResultGeneration = -1;
const ignoredCaptureFiles = new Set<string>();
let pendingScenarioFile: string | null = null;
let pendingRecordedOperations = "";
let pendingAnnotationSpec = "";
let pendingAnnotatedImageFile = "";
let pendingLaunchProgram = "";
let pendingLaunchArgs: string[] = [];
let annotationPoll: ReturnType<typeof setTimeout> | undefined;
let annotationPollRunning = false;
let screenshotSubmitRunning = false;
let screenshotStageTimer: ReturnType<typeof setInterval> | undefined;
let busyButtonStates: Map<HTMLButtonElement, boolean> | null = null;
if (detached) document.body.classList.add("detached");

let layoutManager: WindowLayoutManager | null = null;
if (!recordingControlMode) {
  try {
    layoutManager = setupWindowLayout();
  } catch (error) {
    console.error("Failed to setup FlexLayout:", error);
  }
}
setupPaneResizers();

const previewNavigator = createPreviewNavigator({
  getCurrentPage: () => documentState?.page || null,
  openPage: (page) => openPage(page),
  refreshPreview: () => renderPreview(),
});
const previewNavBar = element<HTMLElement>("preview-nav-bar");
if (previewNavBar) {
  previewNavigator.attachToolbar(previewNavBar);
}

function editSnapshot(): EditorSnapshot {
  return { value: editor.value, start: editor.selectionStart, end: editor.selectionEnd };
}
function updateHistoryButtons(): void {
  const history = milkdown.historyState() || editHistory;
  element<HTMLButtonElement>("undo-edit").disabled = busy || !documentState || !history.canUndo;
  element<HTMLButtonElement>("redo-edit").disabled = busy || !documentState || !history.canRedo;
}
function resetEditHistory(): void {
  editHistory.reset(editSnapshot());
  updateHistoryButtons();
}
function rememberCurrentSelection(start = editor.selectionStart, end = editor.selectionEnd): void {
  editHistory.rememberSelection(start, end);
}
function recordEditHistory(event: Event): void {
  if (replayingHistory || !documentState) return;
  if (editHistory.record(editSnapshot(), {
    inputType: event instanceof InputEvent ? event.inputType : "",
    isTrusted: event.isTrusted,
  })) updateHistoryButtons();
}
function stepEditHistory(direction: -1 | 1): void {
  if (busy || !documentState) return;
  if (milkdown.stepHistory(direction)) { updateHistoryButtons(); return; }
  const snapshot = editHistory.step(direction);
  if (!snapshot) return;
  replayingHistory = true;
  try {
    editor.value = snapshot.value;
    editor.focus();
    editor.setSelectionRange(snapshot.start, snapshot.end);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  } finally {
    replayingHistory = false;
  }
  updateHistoryButtons();
}

function escape(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
}
function status(message: string, error = false): void {
  element("status").textContent = message;
  element("status").classList.toggle("error", error);
}
function showScreenshotFeedback(message: string, error = true): void {
  const dialog = element<HTMLDialogElement>("screenshot-task-dialog");
  let feedback = dialog.querySelector<HTMLElement>("#screenshot-submit-feedback");
  if (!feedback) {
    feedback = document.createElement("p");
    feedback.id = "screenshot-submit-feedback";
    feedback.setAttribute("role", error ? "alert" : "status");
    feedback.setAttribute("aria-live", error ? "assertive" : "polite");
    dialog.querySelector("#screenshot-task-form > .actions")?.before(feedback);
  }
  feedback.setAttribute("role", error ? "alert" : "status");
  feedback.setAttribute("aria-live", error ? "assertive" : "polite");
  feedback.dataset.kind = error ? "error" : "wait";
  feedback.textContent = message;
  feedback.hidden = false;
  if (error) {
    element("operation-recording-status").textContent = message;
    status(message, true);
  }
}
function clearScreenshotFeedback(): void {
  const feedback = element<HTMLDialogElement>("screenshot-task-dialog").querySelector<HTMLElement>("#screenshot-submit-feedback");
  if (feedback) { feedback.textContent = ""; feedback.hidden = true; delete feedback.dataset.kind; }
}
function screenshotSubmitWaitReason(): string {
  if (operationRecording) return "操作記録中です。画面の「スクリーンショットを実行」を押し、MarkItsで注釈後に「編集終了」を押してください。";
  if (recordingStarting) return "アプリの起動と操作記録を開始しています。完了するまでお待ちください。";
  if (recordingFinishActive || externalFinishActive) return "撮影結果を処理しています。完了するまでお待ちください。";
  if (annotationPollRunning) return "MarkItsで「編集終了」を押してください。編集結果の返却を待っています。";
  if (screenshotSubmitRunning) return "撮影画像を取り込んでいます。完了するまでお待ちください。";
  return "別の処理が実行中です。完了してから指示を追加してください。";
}
function renderProgressLog(): void {
  const log = element<HTMLElement>("progress-log");
  const followTail = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
  log.textContent = progressDisplayLogs.join("\n");
  if (followTail) log.scrollTop = log.scrollHeight;
}
function logProgress(message: string): void {
  progressDisplayLogs.push(`[${new Date().toLocaleTimeString("ja-JP", { hour12: false })}] ${message}`);
  progressLastEventAt = Date.now();
  element("progress-note").textContent = message;
  renderProgressLog();
}
let progressInFlight: Promise<void> | undefined;
let progressGeneration = 0;
function pollAgentProgress(): Promise<void> {
  if (progressInFlight) return progressInFlight;
  const generation = progressGeneration;
  progressInFlight = readAgentProgress(generation).finally(() => { progressInFlight = undefined; });
  return progressInFlight;
}
async function readAgentProgress(generation: number): Promise<void> {
  try {
    const result = JSON.parse(await rpc("agent-progress")) as { logs: Array<{ time: string; message: string }>; total?: number };
    if (generation !== progressGeneration) return;
    const total = result.total ?? result.logs.length;
    if (total > progressAgentTotal) {
      const newEntries = result.logs.slice(-(total - progressAgentTotal));
      progressDisplayLogs.push(...newEntries.map((entry) => `[${entry.time}] ${entry.message}`));
      progressAgentTotal = total;
      progressLastEventAt = Date.now();
      if (progressRunning && result.logs.length) element("progress-note").textContent = result.logs.at(-1)!.message;
      renderProgressLog();
    }
  } catch { /* The progress endpoint can be briefly unavailable while the request starts. */ }
}
async function hideManualStudioForCapture(): Promise<void> {
  if (!native || manualStudioHiddenForCapture) return;
  await invoke("hide_manual_studio");
  manualStudioHiddenForCapture = true;
}
async function restoreManualStudioAfterCapture(force = false): Promise<void> {
  if (!native || (!manualStudioHiddenForCapture && !force)) return;
  await invoke("restore_manual_studio");
  manualStudioHiddenForCapture = false;
}
function startAiProgress(action: string): void {
  ++progressGeneration;
  const labels: Record<string, string> = { codex: "Codex", claude: "Claude Code", grok: "Grok Build", agy: "Agy" };
  const agent = workspace?.config.agent || element<HTMLSelectElement>("ai-agent").value || "AI";
  const operation = action === "draft" ? "原稿の下書きを生成中" : action === "generate-page" ? "文書のAI出力と撮影を実行中" : "AI文章・図を生成中";
  element("progress-label").textContent = `${labels[agent] || agent}で${operation}`;
  progressRunning = true;
  progressDisplayLogs = [];
  progressAgentTotal = 0;
  progressStartedAt = Date.now();
  progressLastEventAt = progressStartedAt;
  element("progress-track").classList.remove("progress-failed", "progress-completed");
  element("progress-track").setAttribute("aria-valuetext", "実行中");
  element("operation-progress").hidden = false;
  element("progress-open").hidden = true;
  logProgress(`${labels[agent] || agent}で${operation}。処理を開始しました。`);
  const update = () => {
    const elapsed = Math.floor((Date.now() - progressStartedAt) / 1000);
    element("progress-elapsed").textContent = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
    if (progressRunning && Date.now() - progressLastEventAt >= 15_000) {
      element("progress-note").textContent = `新しい出力を待っています（最終ログから${Math.floor((Date.now() - progressLastEventAt) / 1000)}秒）。`;
    }
  };
  update();
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = setInterval(update, 1000);
  if (progressPollTimer) clearInterval(progressPollTimer);
  progressPollTimer = setInterval(() => { void pollAgentProgress(); }, 750);
}
async function stopAiProgress(succeeded: boolean): Promise<void> {
  await pollAgentProgress();
  if (progressTimer) clearInterval(progressTimer);
  if (progressPollTimer) clearInterval(progressPollTimer);
  progressTimer = undefined;
  progressPollTimer = undefined;
  progressRunning = false;
  if (!succeeded) {
    element("progress-label").textContent = "処理の一部が完了しませんでした。ログを確認してください。";
    element("progress-track").classList.add("progress-failed");
    element("progress-track").setAttribute("aria-valuetext", "失敗");
    logProgress("未完了の処理があります。上の実行ログで失敗理由を確認してください。");
  } else {
    element("progress-label").textContent = "AI処理が完了しました";
    element("progress-track").classList.add("progress-completed");
    element("progress-track").setAttribute("aria-valuetext", "完了");
    logProgress("処理が完了しました。AI実行ログボタンから確認できます。");
    element("operation-progress").hidden = true;
    element("progress-open").hidden = false;
  }
}
element("progress-dismiss").addEventListener("click", () => {
  element("operation-progress").hidden = true;
  element("progress-open").hidden = false;
});
element("progress-open").addEventListener("click", () => {
  element("operation-progress").hidden = false;
  element("progress-open").hidden = true;
});
async function rpc(action: string, options: Record<string, unknown> = {}, root = projectRoot): Promise<string> {
  const mergedOptions = { ...options };
  const apiKey = localStorage.getItem("manual-studio-ai-api-key");
  if (apiKey && !mergedOptions.api_key) {
    mergedOptions.api_key = apiKey;
  }
  return sendManualRequest({ root, action, options: mergedOptions }, native
    ? (request) => invoke<string>("manual_request", { request })
    : undefined);
}

let terminalController: TerminalController | null = null;

function getTerminalCliCommand(): { command: string; args: string[]; label: string } {
  const agent = workspace?.config.agent || "claude";
  const labels: Record<string, string> = {
    codex: "Codex",
    claude: "Claude Code",
    grok: "Grok Build",
    agy: "Agy",
  };
  return {
    command: agent,
    args: [],
    label: labels[agent] || agent,
  };
}

const terminalPanel = element<HTMLElement>("panel-terminal");
if (terminalPanel) {
  terminalController = setupTerminalPane(terminalPanel, {
    rpc,
    getProjectRoot: () => projectRoot,
    getCliCommand: getTerminalCliCommand,
  });
}

function setBusy(value: boolean): void {
  busy = value;
  document.body.setAttribute("aria-busy", String(value));
  if (value && !busyButtonStates) {
    busyButtonStates = new Map([...document.querySelectorAll<HTMLButtonElement>("button:not(.progress-control)")]
      .map((button) => [button, button.disabled]));
  }
  if (value) {
    for (const button of document.querySelectorAll<HTMLButtonElement>("button:not(.progress-control)")) {
      if (!busyButtonStates!.has(button)) busyButtonStates!.set(button, button.disabled);
      const id = button.id;
      const captureControl = id === "stop-operation-recording" && operationRecording
        || id === "start-operation-recording" && captureSessions.active !== null && !operationRecording && !recordingStarting && !recordingFinishActive && !externalFinishActive && !annotationPollRunning && !pendingAnnotatedImageFile && !screenshotSubmitRunning
        || id === "cancel-screenshot-task" && captureSessions.active !== null && !operationRecording && !recordingStarting && !recordingFinishActive && !externalFinishActive && !screenshotSubmitRunning
        || button.matches('#screenshot-task-form button[type="submit"]') && captureSessions.active !== null && !operationRecording && !recordingStarting && !recordingFinishActive && !externalFinishActive && !annotationPollRunning && !screenshotSubmitRunning;
      button.disabled = !captureControl;
    }
    const submit = element<HTMLButtonElement>("screenshot-task-form").querySelector<HTMLButtonElement>('button[type="submit"]');
    if (submit?.disabled && captureSessions.active) showScreenshotFeedback(screenshotSubmitWaitReason(), false);
  } else if (busyButtonStates) {
    for (const [button, wasDisabled] of busyButtonStates) button.disabled = wasDisabled;
    busyButtonStates = null;
    if (captureSessions.active && element<HTMLDialogElement>("screenshot-task-dialog").querySelector<HTMLElement>("#screenshot-submit-feedback")?.dataset.kind === "wait") clearScreenshotFeedback();
  }
  editor.readOnly = value;
  editor.disabled = !documentState;
  updateHistoryButtons();
  renderDocumentTags();
}
function setButtonDisabled(button: HTMLButtonElement, disabled: boolean): void {
  if (busyButtonStates?.has(button)) busyButtonStates.set(button, disabled);
  else button.disabled = disabled;
}
function assertNoActiveCaptureSession(): void {
  captureSessions.assertInactive();
}
function isCurrentCaptureSession(generation: number): boolean {
  const session = captureSessions.active;
  return captureSessions.isCurrent(generation)
    && session !== null
    && captureSessions.matchesTarget(generation, projectRoot, documentState?.page || "");
}
function updateCaptureBusyState(): void {
  setBusy(captureNeedsUiLock());
}
function captureNeedsUiLock(): boolean {
  return captureSessions.active !== null
    && (operationRecording || recordingStarting || recordingFinishActive || externalFinishActive || annotationPollRunning || screenshotSubmitRunning || Boolean(pendingAnnotatedImageFile));
}
function savedBeforeOperation(): void {
  if (dirty) throw new Error("原稿に未保存の変更があります。「保存」を押してから実行してください。");
}
async function work(operation: () => Promise<void>): Promise<void> {
  if (busy) return;
  setBusy(true);
  try { await operation(); } catch (error) { status(String(error), true); }
  finally { setBusy(captureNeedsUiLock()); }
}
async function confirmDiscard(): Promise<boolean> {
  return !dirty || showUnsavedChangesDialog(documentState?.page || "原稿", async () => {
    await saveDocument();
    if (dirty) throw new Error("原稿を保存できなかったため、移動を中止しました。");
  });
}
function closeAllPanelDialogs(): void {
  document.querySelectorAll<HTMLDialogElement>("dialog.panel-dialog").forEach((d) => {
    if (d.open) d.close();
  });
}

let activeWorkspaceTab = "editor";

function openPanelDialog(panelId: string): void {
  const dlg = element<HTMLDialogElement>(panelId);
  if (!dlg) return;
  if (dlg.open) {
    dlg.close();
    return;
  }
  closeAllPanelDialogs();
  dlg.show();
}

function tabToComponentId(name: string): string {
  switch (name) {
    case "editor": return "editor";
    case "tasks": return "ai-tags";
    case "tree": return "file-tree";
    case "preview": return "editor";
    case "terminal": return "terminal";
    default: return name;
  }
}
function chooseTab(name: string): void {
  if (name === "uimap" || name === "publish" || name === "appearance") {
    document.querySelectorAll<HTMLElement>("[data-tab]").forEach((button) => { button.classList.toggle("active", button.dataset.tab === name); });
    openPanelDialog(`panel-${name}`);
    return;
  }
  activeWorkspaceTab = name;
  closeAllPanelDialogs();
  if (layoutManager) {
    layoutManager.focusPanel(tabToComponentId(name));
  } else {
    document.querySelectorAll<HTMLElement>(".panel").forEach((panel) => { panel.hidden = panel.id !== `panel-${name}`; });
  }
  document.querySelectorAll<HTMLElement>("[data-tab]").forEach((button) => { button.classList.toggle("active", button.dataset.tab === name); });
  if (name === "terminal") {
    setTimeout(() => { terminalController?.fit(); }, 50);
  }
}
function updateSaveState(): void {
  element("save-state").textContent = documentState ? dirty ? "● 未保存の変更" : "保存済み" : "原稿を選択してください";
}
async function renderPreview(): Promise<void> {
  if (!documentState) return;
  const version = ++previewVersion;
  try {
    const html = await rpc("editor-preview", { page: documentState.page, body: editor.value });
    if (version === previewVersion) {
      element<HTMLIFrameElement>("markdown-preview").srcdoc = html;
      previewNavigator.updateToolbarState();
    }
  } catch (error) { if (version === previewVersion) status(`プレビュー: ${String(error)}`, true); }
}
function updateCursor(): void {
  const lines = editor.value.slice(0, editor.selectionStart).split("\n");
  element("cursor-position").textContent = `${lines.length}:${lines.at(-1)!.length + 1}`;
}
function previewScrollElement(): Element | null {
  try { return element<HTMLIFrameElement>("markdown-preview").contentDocument?.scrollingElement || null; }
  catch { return null; }
}
function syncScroll(source: Element, target: Element | null): void {
  if (syncingScroll || !target) return;
  const sourceMax = source.scrollHeight - source.clientHeight;
  const targetMax = target.scrollHeight - target.clientHeight;
  syncingScroll = true;
  target.scrollTop = sourceMax > 0 ? source.scrollTop / sourceMax * Math.max(0, targetMax) : 0;
  requestAnimationFrame(() => { syncingScroll = false; });
}
function onPreviewScroll(): void {
  const source = previewScrollElement();
  if (source) syncScroll(source, editor.hidden ? milkdown.host : editor);
}
let projectRequestVersion = 0;
let documentRequestVersion = 0;
let workspaceRequestVersion = 0;
async function openPage(page: string, check = true): Promise<void> {
  assertNoActiveCaptureSession();
  if (check && !await confirmDiscard()) return;
  const root = projectRoot;
  const version = ++documentRequestVersion;
  const opened = JSON.parse(await rpc("editor-read", { page }, root)) as Document;
  if (root !== projectRoot || version !== documentRequestVersion) return;
  const previousPage = documentState?.page;
  ++previewVersion;
  documentState = opened;
  editor.value = opened.content;
  resetEditHistory();
  if (previousPage !== page) editor.scrollTop = 0;
  editor.disabled = false;
  dirty = false;
  element("editor-title").textContent = page;
  document.title = `${page} — Munin Manual Studio`;
  updateSaveState(); updateCursor(); renderPages(); renderDocumentTags();
  await renderPreview();
  previewNavigator.pushPage(page);
  chooseTab("editor");
}
function renderPages(): void {
  const entries = workspace?.project_entries || [];
  element("tree-root-label").textContent = projectRoot.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || "プロジェクト";
  element("page-list").innerHTML = renderFileTree(
    entries,
    workspace?.pages || [],
    documentState?.page,
    workspace?.config.docs || "docs",
    expandedFolders,
  );
}
async function refreshWorkspace(reloadPage = false): Promise<void> {
  const root = projectRoot;
  const current = documentState;
  const content = editor.value;
  const documentVersion = documentRequestVersion;
  const version = ++workspaceRequestVersion;
  const loaded = JSON.parse(await rpc("state", {}, root)) as State;
  if (root !== projectRoot || version !== workspaceRequestVersion) return;
  workspace = loaded;
  renderPages(); renderTasks(); renderMap();
  element("task-count").textContent = String(workspace.tasks.length);
  if (reloadPage && current) {
    if (documentState !== current || documentVersion !== documentRequestVersion || editor.value !== content) return;
    const opened = JSON.parse(await rpc("editor-read", { page: current.page }, root)) as Document;
    if (root !== projectRoot || documentState !== current || documentVersion !== documentRequestVersion || editor.value !== content) return;
    documentState = opened; editor.value = opened.content; resetEditHistory(); dirty = false; updateSaveState(); renderDocumentTags(); await renderPreview();
  }
}
function escapeTaskPrompt(prompt: string): string {
  return prompt.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\r", "&#13;").replaceAll("\n", "&#10;");
}
const taskBlockPattern = /<!--\s*ai:task\b(?<attrs>(?:"[^"]*"|'[^']*'|[^>"'])*)-->[\s\S]*?<!--\s*\/ai:task\s*-->/g;
const taskPromptAttribute = /\s+prompt=(?:"[^"]*"|'[^']*'|[^\s>]+)/;
const headerAttributes = /(?:^|\s)[a-zA-Z][a-zA-Z0-9_-]*=(?:"[^"]*"|'[^']*'|[^\s>]+)/g;
function tagAttribute(attrs: string, name: string): string | null {
  for (const token of attrs.matchAll(headerAttributes)) {
    const match = /(?:^|\s)([a-zA-Z][a-zA-Z0-9_-]*)=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/.exec(token[0]);
    if (match?.[1] === name) return match[2] ?? match[3] ?? match[4];
  }
  return null;
}
function removeTagAttributes(header: string, names: string[]): string {
  return header.replace(headerAttributes, token => names.some(name => token.trimStart().startsWith(`${name}=`)) ? "" : token);
}
function renderDocumentTags(): void {
  const pageTasks = workspace && documentState ? tasksForPage(documentState.page) : [];
  const allApproved = !dirty && pageTasks.length > 0 && pageTasks.every(task => task.status === "approved");
  const generatePage = document.getElementById("generate-page") as HTMLButtonElement | null;
  if (generatePage) {
    setButtonDisabled(generatePage, !documentState || allApproved);
    generatePage.title = allApproved ? "すべて確定済みです。更新するタグの確定を解除してください。" : "この文書のAI指示を実行し、文章・図・撮影結果を更新";
  }
  const reviewAiUpdate = document.getElementById("review-ai-update") as HTMLButtonElement | null;
  if (reviewAiUpdate) {
    reviewAiUpdate.hidden = !documentState || !aiReviews.has(aiReviewKey(documentState.page));
  }
  const list = document.getElementById("document-tag-list");
  if (!list) return;
  if (!documentState) { list.innerHTML = '<span class="muted">原稿を開くとタグが表示されます。</span>'; return; }
  const content = editor.value;
  const masked = content.split("");
  const codeRanges = [...content.matchAll(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1[^\n]*$/gm)];
  for (const range of codeRanges) for (let i = range.index!; i < range.index! + range[0].length; i++) if (masked[i] !== "\n") masked[i] = " ";
  const source = masked.join("");
  const tags = new Map<string, { id: string; kind: string; status: string; start: number; end: number; generatedStart?: number; generatedEnd?: number; generatedHeaderEnd?: number; approved?: boolean }>();
  const collect = (pattern: RegExp, generated: boolean) => {
    for (const match of source.matchAll(pattern)) {
      const attrs = match.groups?.attrs || "";
      const id = tagAttribute(attrs, "id");
      if (!id) continue;
      const raw = content.slice(match.index!, match.index! + match[0].length);
      const actualAttrs = attrs;
      const existing = tags.get(id);
      const unified = /^<!--\s*ai:task\b/.test(raw) && /<!--\s*\/ai:task\s*-->$/.test(raw);
      const hasBody = !unified || raw.slice(raw.indexOf("-->") + 3, raw.lastIndexOf("<!--")).trim().length > 0;
      const isGenerated = generated && hasBody;
      const headerEnd = isGenerated ? match.index! + raw.indexOf("-->") + 3 : undefined;
      const approved = isGenerated && Boolean(tagAttribute(actualAttrs, "approved-at"));
      tags.set(id, {
        id,
        kind: tagAttribute(actualAttrs, "kind") || existing?.kind || "text",
        status: isGenerated ? (approved ? "確定済み" : "未確定") : existing?.status || "未生成",
        start: existing?.start ?? match.index!,
        end: existing?.end ?? match.index! + match[0].length,
        generatedStart: isGenerated ? match.index! : existing?.generatedStart,
        generatedEnd: isGenerated ? match.index! + match[0].length : existing?.generatedEnd,
        generatedHeaderEnd: headerEnd ?? existing?.generatedHeaderEnd,
        approved: isGenerated ? approved : existing?.approved,
      });
    }
  };
  collect(/<!--\s*ai:task\b(?<attrs>[^\r\n>]*)\r?\n[\s\S]*?\r?\n-->/g, false);
  collect(/<!--\s*ai:generated\b(?<attrs>[^>]*)-->[\s\S]*?<!--\s*\/ai:generated\s*-->/g, true);
  collect(taskBlockPattern, true);
  const kinds: Record<string, string> = { screenshot: "画像", text: "文章", diagram: "図" };
  list.innerHTML = tags.size ? [...tags.values()].map((tag) => `<div class="document-tag-row${tag.approved ? " is-approved" : ""}" data-tag-start="${tag.start}" data-tag-end="${tag.end}"${tag.generatedStart === undefined ? "" : ` data-generated-start="${tag.generatedStart}" data-generated-end="${tag.generatedEnd}" data-generated-header-end="${tag.generatedHeaderEnd}" data-approved="${tag.approved}"`}><button type="button" class="document-tag-jump" data-tag-jump><code>${escape(tag.id)}</code><span>${kinds[tag.kind] || escape(tag.kind)}</span><span class="document-tag-status${tag.approved ? " is-approved" : ""}">${tag.status}</span></button>${tag.generatedStart === undefined ? "" : `<span class="document-tag-actions"><button type="button" data-tag-confirm${tag.approved ? ' class="button-approved is-approved"' : ""}${busy || !documentState ? " disabled" : ""}>${tag.approved ? "確定解除" : "確定"}</button><button type="button" data-tag-delete${busy || !documentState ? " disabled" : ""}>生成結果を削除</button></span>`}</div>`).join("") : '<span class="muted">この文書にAIタグはありません。</span>';
}
function updateAiSettingsVisibility(): void {
  const connectionType = element<HTMLSelectElement>("ai-connection-type").value;
  const agentLabel = element<HTMLElement>("ai-agent-label");
  const endpointLabel = element<HTMLElement>("ai-endpoint-url-label");
  const apiKeyLabel = element<HTMLElement>("ai-api-key-label");
  const endpointInput = input("ai-endpoint-url");
  element("ai-model-label").style.display = connectionType === "none" ? "none" : "";

  if (connectionType === "none") {
    agentLabel.style.display = "none";
    endpointLabel.style.display = "none";
    apiKeyLabel.style.display = "none";
  } else if (connectionType === "cli") {
    agentLabel.style.display = "";
    endpointLabel.style.display = "none";
    apiKeyLabel.style.display = "none";
  } else if (connectionType === "local_llm") {
    agentLabel.style.display = "none";
    endpointLabel.style.display = "";
    apiKeyLabel.style.display = "";
    endpointInput.placeholder = "http://localhost:11434/v1";
  } else {
    agentLabel.style.display = "none";
    endpointLabel.style.display = "";
    apiKeyLabel.style.display = "";
    endpointInput.placeholder = "https://api.openai.com/v1";
  }
}
function renderSettings(): void {
  if (!workspace) return;
  input("docs-path").value = workspace.config.docs;
  input("output-path").value = workspace.config.output;
  input("site-name").value = workspace.config.mkdocs.site_name;
  input("assets-path").value = workspace.config.assets || `${workspace.config.docs || "docs"}/assets`;
  element("workspace-settings-root").textContent = projectRoot;
  setButtonDisabled(element<HTMLButtonElement>("save-workspace-settings"), false);
  setButtonDisabled(element<HTMLButtonElement>("open-workspace-settings"), false);
  element("workspace-save-state").textContent = "";
  input("ai-model").value = workspace.config.model;
  element<HTMLTextAreaElement>("manual-brief").value = workspace.brief;
  element("ai-agent").innerHTML = workspace.agents.map((agent) => `<option value="${escape(agent.id)}"${agent.available ? "" : " disabled"}>${escape(agent.label)}${agent.available ? "" : "（CLI未検出）"}</option>`).join("");
  const preferred = workspace.has_config ? workspace.config.agent : workspace.agents.find((agent) => agent.available)?.id || workspace.config.agent;
  element<HTMLSelectElement>("ai-agent").value = preferred;
  if (preferred !== workspace.config.agent) input("ai-model").value = "";

  const connectionType = workspace.config.connection_type || "cli";
  element<HTMLSelectElement>("ai-connection-type").value = connectionType;
  input("ai-endpoint-url").value = workspace.config.endpoint_url || "";
  input("ai-api-key").value = localStorage.getItem("manual-studio-ai-api-key") || "";
  updateAiSettingsVisibility();
  updateAiAvailability();
  setAiSaveState(workspace.has_config ? "保存済み" : "AI設定を変更すると自動保存します");
}
let aiSaveTimer: ReturnType<typeof setTimeout> | undefined;
let aiSaveQueue: Promise<void> = Promise.resolve();
let aiEditVersion = 0;
let aiSavePending = false;
function setAiSaveState(message: string, failed = false): void {
  element("ai-save-state").textContent = message;
  element("ai-save-retry").hidden = !failed;
}
function updateAiAvailability(): void {
  const selected = workspace?.agents.find(agent => agent.id === element<HTMLSelectElement>("ai-agent").value);
  element("ai-cli-status").textContent = element<HTMLSelectElement>("ai-connection-type").value === "cli" && selected && !selected.available
    ? `${selected.label}のCLIが見つかりません。インストールとPATHを確認してください。選択は保持されます。` : "";
}
function saveAiSettings(): Promise<void> {
  clearTimeout(aiSaveTimer);
  if (!workspace || !aiSavePending) return aiSaveQueue;
  const root = projectRoot;
  const version = aiEditVersion;
  const options = {
    mkdocs_settings: workspace.config.mkdocs,
    agent: element<HTMLSelectElement>("ai-agent").value,
    model: input("ai-model").value.trim(),
    connection_type: element<HTMLSelectElement>("ai-connection-type").value,
    endpoint_url: input("ai-endpoint-url").value.trim(),
  };
  const apiKey = input("ai-api-key").value.trim();
  aiSavePending = false;
  const operation = aiSaveQueue.catch(() => {}).then(async () => {
    if (projectRoot === root && aiEditVersion === version) setAiSaveState("保存中…");
    try {
      // AI-only options preserve other settings and unfinished form edits.
      const saved = JSON.parse(await rpc("save", options, root)) as State;
      if (apiKey) localStorage.setItem("manual-studio-ai-api-key", apiKey);
      else localStorage.removeItem("manual-studio-ai-api-key");
      if (projectRoot === root) {
        workspace!.config = saved.config;
        workspace!.has_config = saved.has_config;
        if (aiEditVersion === version) setAiSaveState("保存済み");
      }
    } catch (error) {
      if (projectRoot === root && aiEditVersion === version) {
        aiSavePending = true;
        setAiSaveState(`保存失敗: ${String(error)}`, true);
      }
      throw error;
    }
  });
  aiSaveQueue = operation;
  return operation;
}
function scheduleAiSave(): void {
  aiEditVersion++;
  aiSavePending = true;
  setAiSaveState("未保存（自動保存待ち）");
  updateAiAvailability();
  clearTimeout(aiSaveTimer);
  aiSaveTimer = setTimeout(() => { void saveAiSettings().catch(() => {}); }, 400);
}
async function ensureAiSettings(): Promise<void> {
  if (!workspace) throw new Error("先にプロジェクトを開いてください。");
  await saveAiSettings();
  const connectionType = element<HTMLSelectElement>("ai-connection-type").value;
  const agentId = element<HTMLSelectElement>("ai-agent").value;
  const model = input("ai-model").value.trim();
  const endpointUrl = input("ai-endpoint-url").value.trim();
  if (connectionType === "none") {
    chooseTab("publish");
    throw new Error("AI接続は未設定です。接続方式を選択してから実行してください。");
  }

  if (connectionType === "cli") {
    const selected = workspace.agents.find((agent) => agent.id === agentId && agent.available);
    if (!selected) {
      chooseTab("publish");
      throw new Error("利用できるAIのCLIがありません。CLIをインストールするか、ローカルLLM/API接続を選んでください。");
    }
  } else if (connectionType === "api") {
    if (!endpointUrl && !input("ai-endpoint-url").placeholder) {
      chooseTab("publish");
      throw new Error("API接続のエンドポイントURLを入力してください（例: https://api.openai.com/v1）。");
    }
  }

  const currentConnectionType = workspace.config.connection_type || "cli";
  const currentEndpointUrl = workspace.config.endpoint_url || "";
  if (
    !workspace.has_config ||
    currentConnectionType !== connectionType ||
    currentEndpointUrl !== endpointUrl ||
    workspace.config.agent !== agentId ||
    workspace.config.model !== model
  ) {
    await rpc("save", {
      agent: agentId, model, connection_type: connectionType,
      endpoint_url: endpointUrl, mkdocs_settings: workspace.config.mkdocs,
    });
    await refreshWorkspace();
    renderSettings();
  }
}
async function openProject(root: string, check = true): Promise<void> {
  assertNoActiveCaptureSession();
  if (check && !await confirmDiscard()) return;
  await saveAiSettings();
  status("プロジェクトを開いています…");
  const version = ++projectRequestVersion;
  const loaded = JSON.parse(await rpc("state", {}, root)) as State;
  if (version !== projectRequestVersion) return;
  ++documentRequestVersion; ++workspaceRequestVersion;
  if (projectRoot !== root) expandedFolders.clear();
  projectRoot = root; workspace = loaded; documentState = null; dirty = false;
  clearTimeout(previewTimer); ++previewVersion;
  editor.value = "";
  resetEditHistory();
  element<HTMLIFrameElement>("markdown-preview").srcdoc = "";
  element("editor-title").textContent = "Markdownを編集する";
  document.title = "Munin Manual Studio";
  updateSaveState(); updateCursor(); renderDocumentTags();
  input("project-root").value = root;
  localStorage.setItem("manual-studio-project", root);
  try { await recordWorkspaceHistory(native, root); }
  catch (error) { status(`ワークスペース履歴を保存できません: ${String(error)}`, true); }
  if (params.get("root") !== root) {
    params.set("root", root);
    params.delete("page");
    const url = new URL(location.href);
    url.search = params.toString();
    history.replaceState(null, "", url);
  }
  element("workspace-name").textContent = root.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || root;
  element<HTMLDialogElement>("workspace-dialog").close();
  await refreshWorkspace(); renderSettings();
  const preferred = params.get("page");
  const page = preferred && (loaded.pages.includes(preferred) || loaded.project_entries.some((entry) => entry.path === preferred && /\.md$/i.test(entry.path)))
    ? preferred
    : loaded.pages[0] || loaded.project_entries.find((entry) => !entry.directory && /\.md$/i.test(entry.path))?.path;
  if (page) await openPage(page, false);
  else { editor.value = ""; updateSaveState(); status("「＋」から最初のMarkdownページを作ってください。"); }
  if (page) status(`プロジェクトを開きました。${page}を編集できます。`);
  if (!loaded.has_config && !detached) status("AI機能は利用できるCLIを自動選択します。変更する場合は「AI設定・出力」で選べます。");
  if (terminalController) {
    void terminalController.restart();
  }
}
async function saveDocument(refresh = true): Promise<void> {
  if (!documentState) throw new Error("保存する原稿を選択してください。");
  const current = documentState;
  const root = projectRoot;
  const page = current.page;
  const content = editor.value;
  const version = documentRequestVersion;
  const saved = JSON.parse(await rpc("editor-save", { page, json: { content, revision: current.revision } }, root)) as Document;
  if (root !== projectRoot || current !== documentState || version !== documentRequestVersion) return;
  documentState = saved; dirty = editor.value !== content; updateSaveState();
  if (refresh) await refreshWorkspace();
  status(`${page}を保存しました。`);
}
function renderTasks(): void {
  if (!workspace) return;
  const kindLabel: Record<string, string> = { screenshot: "画像", text: "AI文章", diagram: "依存図" };
  const statusLabel: Record<string, string> = { missing: "未作成", stale: "更新待ち", current: "準備完了", approved: "確定済み" };
  element("task-list").innerHTML = workspace.tasks.length ? workspace.tasks.map((task) => {
    const source = workspace!.capture_sources[task.id];
    const description = source?.kind === "window" ? `${escape(source.title)} · 外枠 ${source.inset}px` : source?.kind === "scenario" ? "撮影元と撮影前の操作を設定済み" : "撮影元はまだ設定されていません。文書のAI出力で自動設定できます。";
    return `<article class="card${task.status === "approved" ? " card-approved is-approved" : ""}" data-task="${escape(task.id)}"><div class="task-header"><h2>${escape(task.id)} <small>${escape(task.page)}</small></h2><span class="badge${task.status === "approved" ? " badge-approved is-approved" : ""}">${kindLabel[task.kind]} · ${statusLabel[task.status] || escape(task.status)}</span></div><label class="task-prompt-label">AIへの指示<textarea data-prompt="${escape(task.id)}" rows="3">${escape(task.prompt)}</textarea></label><div class="actions"><button data-save-prompt="${escape(task.id)}">指示を保存</button><button data-toggle-approved="${escape(task.id)}"${task.status === "approved" ? ' class="button-approved is-approved"' : ""}${task.status === "missing" ? " disabled title=\"生成結果がある場合に確定できます\"" : ""}>${task.status === "approved" ? "確定解除" : "確定"}</button>${task.kind !== "screenshot" ? `<button data-generate="${escape(task.id)}" class="primary">${task.kind === "diagram" ? "依存図を更新" : "AIで文章を更新"}</button>` : ""}</div>${task.kind === "screenshot" ? `
      <p class="muted">${description}</p><img class="task-image" data-thumb="${escape(task.id)}" alt="${escape(task.id)}の登録画像" hidden />
      <div class="actions">${source ? `<button class="primary" data-recapture="${escape(task.id)}">${source.kind === "scenario" ? "設定した手順で更新" : "同じ撮影元で更新"}</button>` : ""}<button data-source-config="${escape(task.id)}">${source ? "撮影元を変更" : "撮影元を選ぶ"}</button><button data-register-image="${escape(task.id)}">既存のPNGを登録</button></div>
      <details class="capture-settings"><summary>撮影元の設定</summary><p class="muted">アプリの対象画面を開いて一覧を更新してください。タイトルで記憶するので、アプリを再起動しても使えます。同じタイトルが複数ある場合は自動で選びません。Waylandでは毎回OSの撮影ダイアログで対象を選びます。</p><div class="actions"><select data-window-select="${escape(task.id)}"><option value="">一覧を更新してください</option></select><button data-window-list="${escape(task.id)}">一覧を更新</button></div><div class="actions"><label>外枠を除く（px）<input type="number" min="0" max="64" data-inset="${escape(task.id)}" value="${source?.kind === "window" ? source.inset : 0}" /></label><button data-capture="${escape(task.id)}" class="primary">撮影元を保存して撮影</button></div></details>` : ""}<button class="edit-task" data-edit-page="${escape(task.page)}">原稿を開く</button></article>`;
  }).join("") : '<div class="card"><h2>更新する画像・文章・図を追加する</h2><p>原稿の編集画面で「撮影の指示」「AI文章の指示」「依存図の指示」を追加して保存してください。この一覧に表示されます。</p></div>';
  const generationRoot = projectRoot;
  for (const task of workspace.tasks.filter((item) => item.kind === "screenshot")) {
    void rpc("preview-asset", { page: task.page, asset: workspace.image_assets[task.id] || `assets/${task.id}.png` }).then((src) => {
      if (generationRoot !== projectRoot) return;
      const img = document.querySelector<HTMLImageElement>(`[data-thumb="${CSS.escape(task.id)}"]`);
      if (img) { img.src = src; img.hidden = false; }
    }).catch(() => { /* An unregistered screenshot has no image yet. */ });
  }
}
async function editTaskPage(task: Task, edit: (content: string) => string): Promise<void> {
  if (!await confirmDiscard()) return;
  const root = projectRoot;
  const page = JSON.parse(await rpc("editor-read", { page: task.page }, root)) as Document;
  if (projectRoot !== root) return;
  const content = edit(page.content);
  if (content === page.content) return;
  await rpc("editor-save", { page: task.page, json: { content, revision: page.revision } }, root);
  if (projectRoot !== root) return;
  await refreshWorkspace(documentState?.page === task.page);
  status(`${task.id}を保存しました。`);
}
function updateTaskPrompt(content: string, task: Task, prompt: string): string {
  const hasId = (attrs: string) => tagAttribute(attrs, "id") === task.id;
  const blocks = [...content.matchAll(taskBlockPattern)].filter(match => hasId(match.groups?.attrs || ""));
  if (blocks.length > 1) throw new Error(`${task.id}の指示タグが複数あります。`);
  if (blocks.length === 1) {
    const match = blocks[0];
    const headerEnd = match[0].indexOf("-->") + 3;
    const header = match[0].slice(0, headerEnd).replace(taskPromptAttribute, () => ` prompt="${escapeTaskPrompt(prompt.trim())}"`);
    return content.slice(0, match.index) + header + match[0].slice(headerEnd) + content.slice(match.index! + match[0].length);
  }
  if (prompt.includes("-->")) throw new Error("旧形式のAI指示にコメント終端「-->」は入力できません。新形式のprompt属性を使ってください。");
  const taskTag = /<!--\s*ai:task(?<attrs>[^\r\n>]*)\r?\n(?<prompt>.*?)\r?\n-->/gs;
  const taskMatches = [...content.matchAll(taskTag)].filter((match) => hasId(match.groups?.attrs || ""));
  if (taskMatches.length === 1) {
    const match = taskMatches[0];
    const replacement = `<!-- ai:task${match.groups!.attrs}\n${prompt.trim()}\n-->`;
    return content.slice(0, match.index) + replacement + content.slice(match.index! + match[0].length);
  }
  if (taskMatches.length > 1) throw new Error(`${task.id}の指示タグが複数あります。`);

  const generatedTag = /<!--\s*ai:generated\b(?<attrs>[^>]*)-->[\s\S]*?<!--\s*\/ai:generated\s*-->/g;
  const generatedMatches = [...content.matchAll(generatedTag)].filter((match) => hasId(match.groups?.attrs || ""));
  if (generatedMatches.length !== 1) throw new Error(`${task.id}の指示タグを原稿から特定できません。`);
  const match = generatedMatches[0];
  const attrs = match.groups!.attrs;
  const bytes = new TextEncoder().encode(prompt.trim());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encodedPrompt = btoa(binary);
  const nextAttrs = /\bprompt-b64=[A-Za-z0-9+/=]+/.test(attrs)
    ? attrs.replace(/\bprompt-b64=[A-Za-z0-9+/=]+/, `prompt-b64=${encodedPrompt}`)
    : `${attrs} prompt-b64=${encodedPrompt}`;
  return content.slice(0, match.index) + match[0].replace(attrs, nextAttrs) + content.slice(match.index! + match[0].length);
}
function toggleTaskApproval(content: string, task: Task): string {
  const tag = new RegExp(`<!--\\s*ai:generated\\b(?<attrs>[^>]*)-->[\\s\\S]*?<!--\\s*\\/ai:generated\\s*-->`, "g");
  const matches = [...content.matchAll(tag), ...content.matchAll(taskBlockPattern)].filter(match => tagAttribute(match.groups?.attrs || "", "id") === task.id);
  if (matches.length !== 1) throw new Error(`${task.id}の生成結果が原稿にありません。`);
  const match = matches[0];
  const attrs = match.groups!.attrs;
  const nextAttrs = Boolean(tagAttribute(attrs, "approved-at"))
    ? removeTagAttributes(attrs, ["approved-at"])
    : `${attrs} approved-at=${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}`;
  return content.slice(0, match.index) + match[0].replace(attrs, nextAttrs) + content.slice(match.index! + match[0].length);
}
function renderMap(): void {
  const map = workspace?.ui_map;
  element("uimap-list").innerHTML = map?.views.length ? `<p><strong>${map.views.length}画面・${map.total_elements}要素</strong>を登録しています。画面名を開いて内容を確認してください。コード変更後は一覧を作り直します。</p>` + map.views.map((view) => `<details class="card"><summary>${escape(view.name)}（${view.elements.length}要素）</summary><p class="muted">確認元: ${escape(view.observed_from || "プロジェクトの画面定義")}</p><ul>${view.elements.map((item) => `<li>${escape(item.name)} <small>${escape(item.role)}</small> <code>${escape(item.selector)}</code></li>`).join("")}</ul></details>`).join("") : '<div class="card"><h2>画面一覧はまだありません</h2><p>「コードから画面一覧を作る」を押してください。検出された内容をここで確認できます。</p></div>';
}
async function generateCurrentPage(): Promise<void> {
  savedBeforeOperation();
  if (!documentState || !workspace) throw new Error("先にMarkdown原稿を開いてください。");
  await generateDocument(documentState.page);
}
function buildTaskPromptForTerminal(page: string, task: Task, feedback = ""): string {
  let text = `マニュアル作成タスク（タスクID: ${task.id}、対象原稿: ${page}）の本文をMarkdownで作成してください。\n` +
    `【指示内容】\n${task.prompt}\n` +
    `【要件】\n` +
    `- 余分な挨拶や解説は出力せず、マニュアル本文となる純粋なMarkdownのみを出力してください。\n` +
    `- <!-- ai:task --> や <!-- ai:generated --> などのタグで囲まないでください。\n`;
  if (feedback.trim()) {
    text += `【修正・フィードバック指示】\n${feedback.trim()}\n`;
  }
  return text;
}

async function generateReviewed(page: string, id?: string, initialFeedback = ""): Promise<boolean> {
  savedBeforeOperation();
  await ensureAiSettings();
  const root = projectRoot;
  let feedback = initialFeedback;
  for (;;) {
    if (!progressRunning) {
      try { await rpc("agent-progress-clear", {}, root); } catch { /* Optional progress logs. */ }
      startAiProgress(id ? "generate-task" : "generate-page");
    }
    logProgress(`${page} の生成候補を準備しています。`);
    let candidate: { before: Document; content: string; updated: string[] };
    try {
      let body: string | undefined;
      const isCli = workspace?.config.connection_type === "cli" || !workspace?.config.connection_type;
      if (terminalController?.isConnected() && id && workspace && isCli) {
        const task = workspace.tasks.find((t) => t.id === id);
        if (task && task.kind !== "screenshot") {
          logProgress(`常駐AIターミナルで ${task.id} のプロンプトを実行しています…`);
          try {
            const prompt = buildTaskPromptForTerminal(page, task, feedback);
            body = await terminalController.injectPrompt(prompt, 15_000);
            logProgress(`AIターミナルから生成結果を受信しました。原稿へ反映しています。`);
          } catch (terminalErr) {
            logProgress(`AIターミナルでの生成に失敗（${String(terminalErr)}）。通常のCLI呼び出しへフォールバックします。`);
          }
        }
      }

      candidate = JSON.parse(await rpc("generate-review", { page, id, feedback, ...(body ? { body } : {}) }, root));
      await pollAgentProgress();
      await stopAiProgress(true);
    } catch (error) {
      await stopAiProgress(false);
      throw error;
    }
    if (projectRoot !== root) throw new Error("ワークスペースが切り替わったため、生成候補の反映を中止しました。");
    if (candidate.before.content === candidate.content) { status("AI生成による変更はありません。"); return true; }
    const decision = await showGenerationReview(page, candidate.before.content, candidate.content);
    if (decision.action === "restore") { status("生成候補を破棄し、現在の原稿を保持しました。"); return false; }
    if (decision.action === "retry") { feedback = decision.feedback; continue; }
    const after = JSON.parse(await rpc("editor-save", { page, json: { content: candidate.content, revision: candidate.before.revision } }, root)) as Document;
    aiReviews.set(aiReviewKey(page), { before: candidate.before, after, id, updated: candidate.updated });
    await refreshWorkspace(documentState?.page === page);
    renderDocumentTags();
    status(`${page}の生成結果を採用して保存しました。`);
    return true;
  }
}
element("review-ai-update").addEventListener("click", () => { void work(async () => {
  savedBeforeOperation();
  if (!documentState) return;
  const page = documentState.page;
  const key = aiReviewKey(page);
  const snapshot = aiReviews.get(key);
  if (!snapshot) return;
  const current = JSON.parse(await rpc("editor-read", { page })) as Document;
  if (current.content !== snapshot.after.content) throw new Error("採用後に原稿が変更されています。編集を保護するため、以前の結果への復元を中止しました。");
  const decision = await showGenerationReview(page, snapshot.before.content, snapshot.after.content, true);
  if (decision.action === "retry") { await generateReviewed(page, snapshot.id, decision.feedback); return; }
  if (decision.action === "restore") {
    await rpc("editor-save", { page, json: { content: snapshot.before.content, revision: current.revision } });
    aiReviews.delete(key);
    await refreshWorkspace(true);
    renderDocumentTags();
    status("AI更新前の原稿に戻して保存しました。");
  }
}); });
function tasksForPage(page: string): Task[] {
  const docsFolder = workspace!.config.docs.replace(/^[.\\/]+|[\\/]+$/g, "");
  const relative = page.startsWith(`${docsFolder}/`) ? page.slice(docsFolder.length + 1) : page;
  return workspace!.tasks.filter((task) => task.page === page || task.page === relative || `${docsFolder}/${task.page}` === page);
}
async function generateDocument(page: string): Promise<number> {
  if (!workspace) throw new Error("先にプロジェクトを開いてください。");
  const root = projectRoot;
  const allTasks = JSON.parse(await rpc("page-tasks", { page }, root)) as Task[];
  if (root !== projectRoot) throw new Error("プロジェクトが切り替わったため、AIタグの更新を中止しました。");
  const supported = allTasks.filter((task) => task.kind === "text" || task.kind === "diagram" || task.kind === "screenshot");
  const tasks = supported.filter((task) => task.status !== "approved");
  if (!tasks.length) {
    status(supported.length
      ? `${page}のAIタグはすべて確定済みです。更新するタグの「確定解除」を押して保存してください。`
      : `${page}にAI文章・図・撮影のタグがありません。タグがコードブロック内にないか、記法を確認してください。`, true);
    return 0;
  }
  await ensureAiSettings();
  try { await rpc("agent-progress-clear"); } catch { /* Progress logs are optional. */ }
  startAiProgress("generate-page");
  logProgress(`${page} のAI指示 ${tasks.length} 件（撮影を含む）を実行します。`);
  let succeeded = false;
  try {
    const generatedTasks = tasks.filter(task => task.kind !== "screenshot");
    if (generatedTasks.length && !await generateReviewed(page)) { succeeded = true; return 0; }
    const result = tasks.some(task => task.kind === "screenshot")
      ? JSON.parse(await rpc("generate-page-captures", { page })) as { updated: string[]; captured?: string[]; capture_errors?: Array<{ id: string; reason: string }> }
      : { updated: generatedTasks.map(task => task.id), captured: [], capture_errors: [] };
    await pollAgentProgress();
    const captureErrors = result.capture_errors ?? [];
    succeeded = captureErrors.length === 0;
    status(`${page}のAI出力を${result.updated.length}件、撮影を${result.captured?.length ?? 0}件実行しました。${captureErrors.length ? `撮影失敗 ${captureErrors.length}件。実行ログを確認してください。` : ""}`, captureErrors.length > 0);
    for (const failure of captureErrors) {
      const message = `${failure.id} の撮影に失敗しました: ${failure.reason}`;
      if (!progressDisplayLogs.some((entry) => entry.includes(message))) logProgress(message);
    }
    return captureErrors.length;
  } catch (error) {
    await pollAgentProgress();
    logProgress(`失敗: ${String(error)}`);
    throw error;
  } finally {
    try {
      logProgress("原稿とタスク一覧を読み直しています。");
      await refreshWorkspace(true);
    } finally {
      await stopAiProgress(succeeded);
      await restoreManualStudioAfterCapture().catch(() => {});
    }
  }
}
async function generateAllDocuments(): Promise<void> {
  savedBeforeOperation();
  if (!workspace) throw new Error("先にプロジェクトのフォルダーを開いてください。");
  const docsFolder = workspace.config.docs.replace(/^[.\\/]+|[\\/]+$/g, "");
  const pages = workspace.project_entries.filter((entry) => !entry.directory && /\.md$/i.test(entry.path))
    .map((entry) => entry.path)
    .filter((path) => path === docsFolder || path.startsWith(`${docsFolder}/`));
  if (!pages.length) { status("原稿フォルダーにMarkdown文書がありません。", true); return; }
  let completed = 0;
  let failedCaptures = 0;
  for (const page of pages) {
    const tasks = tasksForPage(page).filter((task) => (task.kind === "text" || task.kind === "diagram" || task.kind === "screenshot") && task.status !== "approved");
    if (!tasks.length) continue;
    if (documentState?.page !== page) {
      if (dirty) throw new Error("未保存の原稿があります。保存してからすべての文書をAI出力してください。");
      await openPage(page, false);
    }
    failedCaptures += await generateDocument(page);
    completed++;
  }
  status(`すべての文書のAI出力が完了しました（${completed}文書）。${failedCaptures ? `撮影失敗 ${failedCaptures}件は実行ログを確認してください。` : ""}`, failedCaptures > 0);
}
async function runAction(action: string, options: Record<string, unknown> = {}, resultId?: string): Promise<void> {
  savedBeforeOperation();
  const isAiAction = action === "draft" || action === "generate-task" || action === "capture-source-auto";
  if (isAiAction) await ensureAiSettings();
  if (isAiAction) {
    try { await rpc("agent-progress-clear"); } catch { /* Progress logs are optional. */ }
  }
  if (isAiAction) startAiProgress(action);
  if (isAiAction) logProgress("AIエージェントへ指示を送り、応答を待っています。");
  status(isAiAction ? "AIを実行中…" : "処理中…");
  let succeeded = false;
  let completionMessage = `${action === "recapture" || action === "capture-window" ? "画像を更新し、撮影元を保存しました" : "処理が完了しました"}。`;
  let completionHasError = false;
  try {
    const output = await rpc(action, options);
    if (isAiAction) { await pollAgentProgress(); logProgress("AIの応答を受け取りました。結果を反映しています。"); }
    if (resultId) {
      let text = output;
      try {
        const parsed = JSON.parse(output);
        if (action === "capture-source-auto") {
          const assigned = parsed.assigned as Array<{ id: string; title: string; kind: string }>;
          const skipped = parsed.skipped as string[];
          const warnings = parsed.warnings as Array<{ id: string; reason: string }>;
          const captured = parsed.captured as string[];
          const captureErrors = parsed.capture_errors as Array<{ id: string; reason: string }>;
          text = [`撮影済み: ${captured.length}件`, ...captured.map((id) => `✓ ${id}`), `新しい撮影設定: ${assigned.length}件`,
            ...assigned.map((entry) => `${entry.id} → ${entry.title}（${entry.kind === "scenario" ? "撮影手順あり" : "撮影元のみ"}）`),
            ...(skipped.length ? [`未設定: ${skipped.join(", ")}`] : []),
            ...captureErrors.map((entry) => `${entry.id}: 撮影できませんでした — ${entry.reason}`),
            ...warnings.map((entry) => `${entry.id}: ${entry.reason}`)].join("\n");
          if (captureErrors.length) {
            completionHasError = true;
            completionMessage = `画像${captured.length}件を撮影しました。${captureErrors.length}件は失敗しました。結果欄に理由を表示しています。`;
          }
          else if (captured.length === 0 && skipped.length) completionMessage = "撮影できる画像がありませんでした。対象アプリを開き、結果欄の未設定タスクを確認してください。";
          else completionMessage = `画像${captured.length}件を撮影しました。`;
        } else text = JSON.stringify(parsed, null, 2);
      } catch { /* Accessibility inspection returns text. */ }
      element(resultId).textContent = text;
    }
    if (action === "draft") {
      await refreshWorkspace();
      if (workspace?.pages.includes("index.md")) {
        await openPage("index.md", false);
        chooseTab("editor");
      }
    } else {
      await refreshWorkspace(true);
    }
    status(completionMessage, completionHasError);
    succeeded = true;
  } catch (error) {
    if (isAiAction) { await pollAgentProgress(); logProgress(`失敗: ${String(error)}`); }
    if (resultId) element(resultId).textContent = `失敗: ${String(error)}`;
    throw error;
  } finally {
    if (isAiAction) await stopAiProgress(succeeded);
    await restoreManualStudioAfterCapture().catch(() => {});
  }
}
function taskControl<T extends HTMLElement>(card: HTMLElement, attribute: string): T {
  return card.querySelector<T>(`[${attribute}]`)!;
}
document.querySelectorAll<HTMLElement>("[data-tab]").forEach((button) => button.addEventListener("click", () => chooseTab(button.dataset.tab!)));

document.querySelectorAll<HTMLDialogElement>("dialog.panel-dialog").forEach((dialog) => {
  dialog.querySelectorAll("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => dialog.close());
  });
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "Escape") dialog.close();
  });
  dialog.addEventListener("close", () => {
    document.querySelectorAll<HTMLElement>("[data-tab]").forEach((button) => {
      button.classList.toggle("active", button.dataset.tab === activeWorkspaceTab);
    });
  });
});

element("open-workspace-settings").addEventListener("click", () => {
  if (!workspace) return;
  input("docs-path").value = workspace.config.docs;
  input("output-path").value = workspace.config.output;
  input("site-name").value = workspace.config.mkdocs.site_name;
  input("assets-path").value = workspace.config.assets || `${workspace.config.docs}/assets`;
  element("workspace-save-state").textContent = "";
  element<HTMLDialogElement>("workspace-settings-dialog").showModal();
});
element("open-existing-workspace").addEventListener("click", () => {
  input("project-root").value = projectRoot;
  element<HTMLDialogElement>("workspace-dialog").showModal();
  input("project-root").focus();
});
setupWorkspaceWizard({
  validate: async (root, options) => { await rpc("validate-workspace", options, root); },
  chooseParent: async () => {
    if (!native) throw new Error("ブラウザー版では親フォルダーのパスを入力してください。");
    return invoke<string | null>("choose_project");
  },
  create: async (root, options) => {
    if (busy) throw new Error("現在の処理が完了してから作成してください。");
    assertNoActiveCaptureSession();
    if (!await confirmDiscard()) throw new Error("作成を中止しました。現在の原稿を保存してからやり直してください。");
    setBusy(true);
    try {
      await saveAiSettings();
      await rpc("create-workspace", options, root);
      await openProject(root, false);
      status("ワークスペースを作成しました。最初の原稿から編集を始められます。");
    } finally { setBusy(captureNeedsUiLock()); }
  },
});
element("cancel-open-workspace").addEventListener("click", () => element<HTMLDialogElement>("workspace-dialog").close());
element("cancel-workspace-settings").addEventListener("click", () => element<HTMLDialogElement>("workspace-settings-dialog").close());
element("workspace-settings-form").addEventListener("submit", event => {
  event.preventDefault();
  void work(async () => {
    if (!workspace) throw new Error("先にワークスペースを開いてください。");
    savedBeforeOperation();
    await saveAiSettings();
    const root = projectRoot;
    element("workspace-save-state").textContent = "保存中…";
    try {
      const docs = input("docs-path").value.trim();
      await rpc("save", {
        docs, output: input("output-path").value.trim(),
        assets: input("assets-path").value.trim() || `${docs || "docs"}/assets`,
        mkdocs_settings: { ...workspace.config.mkdocs, site_name: input("site-name").value.trim() },
      }, root);
      await refreshWorkspace();
      element("workspace-save-state").textContent = "保存済み";
      status("ワークスペース設定を保存しました。");
    } catch (error) {
      element("workspace-save-state").textContent = `保存失敗: ${String(error)}`;
      throw error;
    }
  });
});
element("workspace-name").addEventListener("click", () => {
  void work(async () => {
    const history = await loadWorkspaceHistory(native);
    showWorkspaceHistory(history, projectRoot, root => work(() => openProject(root)));
  });
});
element("project-form").addEventListener("submit", (event) => { event.preventDefault(); void work(() => openProject(input("project-root").value.trim())); });
element("browse-project").addEventListener("click", () => { void work(async () => {
  if (!native) { status("ブラウザーでの開発表示では、プロジェクトのパスを入力して「開く」を押してください。"); input("project-root").focus(); return; }
  const path = await invoke<string | null>("choose_project");
  if (path) { input("project-root").value = path; await openProject(path); }
}); });
element("browse-screenshot-launch-program").addEventListener("click", () => { void work(async () => {
  if (!native) throw new Error("アプリ選択ダイアログはデスクトップアプリで利用できます。");
  const path = await invoke<string | null>("choose_application");
  if (path) input("screenshot-launch-program").value = path;
}); });
element("page-list").addEventListener("click", (event) => {
  const generateButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-generate-page]");
  if (generateButton) {
    void work(async () => {
      const page = generateButton.dataset.generatePage!;
      if (documentState?.page !== page) {
        if (!await confirmDiscard()) return;
        await openPage(page, false);
      }
      await generateCurrentPage();
    });
    return;
  }
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-page]");
  if (button) void work(() => openPage(button.dataset.page!));
});
element("page-list").addEventListener("toggle", (event) => {
  const folder = event.target as HTMLDetailsElement;
  if (!folder.matches("details[data-folder]")) return;
  if (folder.open) expandedFolders.add(folder.dataset.folder!);
  else expandedFolders.delete(folder.dataset.folder!);
}, true);
element("save-page").addEventListener("click", () => { void work(saveDocument); });
element("generate-page").addEventListener("click", () => { void work(generateCurrentPage); });
element("reload-page").addEventListener("click", () => { if (documentState) void work(() => openPage(documentState!.page)); });
element("undo-edit").addEventListener("click", () => stepEditHistory(-1));
element("redo-edit").addEventListener("click", () => stepEditHistory(1));
element("detach-editor").addEventListener("click", () => { void work(async () => {
  savedBeforeOperation();
  if (!documentState) throw new Error("原稿を選択してください。");
  if (native) await invoke("open_editor", { root: projectRoot, page: documentState.page });
  else window.open(`/?editor=1&root=${encodeURIComponent(projectRoot)}&page=${encodeURIComponent(documentState.page)}`, "_blank");
}); });
editor.addEventListener("editor-mode-change", updateHistoryButtons);
editor.addEventListener("beforeinput", (event) => {
  if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
    event.preventDefault();
    stepEditHistory(event.inputType === "historyUndo" ? -1 : 1);
  } else if (!replayingHistory) rememberCurrentSelection();
});
editor.addEventListener("input", (event) => {
  recordEditHistory(event);
  dirty = editor.value !== documentState?.content; updateSaveState(); updateCursor();
  renderDocumentTags();
  clearTimeout(previewTimer); previewTimer = setTimeout(() => { void renderPreview(); }, 250);
});
document.getElementById("document-tag-list")?.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const row = target.closest<HTMLElement>(".document-tag-row");
  if (!row) return;
  if (target.closest("[data-tag-confirm]")) {
    if (busy || row.dataset.generatedStart === undefined || row.dataset.generatedHeaderEnd === undefined || !documentState) return;
    const start = Number(row.dataset.generatedStart);
    const headerEnd = Number(row.dataset.generatedHeaderEnd);
    const oldHeader = editor.value.slice(start, headerEnd);
    const approved = row.dataset.approved === "true";
    const newHeader = approved
      ? removeTagAttributes(oldHeader, ["approved-at"])
      : oldHeader.replace(/\s*-->$/, ` approved-at=${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")} -->`);
    if (oldHeader !== newHeader) {
      replaceMarkdown(start, headerEnd, newHeader, 0, newHeader.length);
      status(approved ? "確定を解除しました。Undo で戻せます。" : "生成結果を確定しました。Undo で戻せます。");
    }
    return;
  }
  if (target.closest("[data-tag-delete]")) {
    if (busy || row.dataset.generatedStart === undefined || row.dataset.generatedEnd === undefined || !documentState) return;
    const start = Number(row.dataset.generatedStart);
    let end = Number(row.dataset.generatedEnd);
    if (editor.value[end] === "\r" && editor.value[end + 1] === "\n") end += 2;
    else if (editor.value[end] === "\n") end++;
    const block = editor.value.slice(start, Number(row.dataset.generatedEnd));
    const unified = /^<!--\s*ai:task\b/.test(block);
    const cleared = unified ? removeTagAttributes(block.slice(0, block.indexOf("-->") + 3), ["created-at", "source-sha256", "approved-at"]) + "\n\n<!-- /ai:task -->\n" : "";
    replaceMarkdown(start, end, cleared, 0);
    status(`${row.querySelector("code")?.textContent || "生成結果"}を削除しました。Undo で戻せます。`);
    return;
  }
  if (!target.closest("[data-tag-jump]")) return;
  const start = Number(row.dataset.tagStart);
  const end = Number(row.dataset.tagEnd);
  milkdown.showSource();
  jumpToSource(editor, start, end);
  updateCursor();
});
editor.addEventListener("scroll", () => syncScroll(editor, previewScrollElement()));
milkdown.host.addEventListener("scroll", () => syncScroll(milkdown.host, previewScrollElement()));
element<HTMLIFrameElement>("markdown-preview").addEventListener("load", () => {
  previewNavigator.setupIframeInterception(element<HTMLIFrameElement>("markdown-preview"));
  previewNavigator.updateToolbarState();
  const previewDocument = element<HTMLIFrameElement>("markdown-preview").contentDocument;
  previewDocument?.querySelectorAll<HTMLElement>('code.language-mermaid, pre.mermaid, .highlight.language-mermaid pre').forEach(code => {
    const target = previewDocument.createElement("div");
    target.className = "mermaid-preview";
    target.style.cssText = "overflow:auto;background:#fff;padding:12px";
    (code.closest("pre") || code).replaceWith(target);
    void renderMermaid(target, code.textContent || "");
  });
  previewScrollWindow?.removeEventListener("scroll", onPreviewScroll);
  previewScrollWindow = element<HTMLIFrameElement>("markdown-preview").contentWindow;
  previewScrollWindow?.addEventListener("scroll", onPreviewScroll);
  syncScroll(editor.hidden ? milkdown.host : editor, previewScrollElement());
});
editor.addEventListener("click", updateCursor); editor.addEventListener("keyup", updateCursor); editor.addEventListener("select", updateCursor);
function replaceMarkdown(start: number, end: number, replacement: string, selectStart: number, selectEnd = selectStart): void {
  milkdown.showSource();
  rememberCurrentSelection();
  editor.setRangeText(replacement, start, end, "end");
  editor.focus();
  editor.setSelectionRange(start + selectStart, start + selectEnd);
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}
const openTableEditor = setupMarkdownTableEditor({ editor, canEdit: () => !busy && Boolean(documentState), replace: replaceMarkdown, report: message => status(message, true) });
setupDocumentTagsPane();
window.addEventListener("manual-studio-status", (event: Event) => {
  const detail = (event as CustomEvent<{ message: string; error?: boolean }>).detail;
  if (detail?.message) status(detail.message, detail.error);
});
window.addEventListener("manual-studio-regenerate-task", (event: Event) => {
  const { id, kind } = (event as CustomEvent<{ id: string; kind: string }>).detail;
  void work(async () => {
    if (!documentState) return;
    if (dirty) await saveDocument();
    const page = documentState.page;
    if (kind === "screenshot") {
      const source = workspace?.capture_sources[id];
      if (source) {
        await hideManualStudioForCapture();
        try { await runAction("recapture", { id }); }
        finally { await restoreManualStudioAfterCapture(); }
      } else {
        status("撮影元が未設定です。「画像・文章・図」タブで撮影元を設定するか、画面一覧から設定してください。", true);
      }
    } else {
      await generateReviewed(page, id);
    }
  });
});
function applyAssist(edit: MarkdownEdit): void {
  replaceMarkdown(edit.start, edit.end, edit.text, edit.selectionStart - edit.start, edit.selectionEnd - edit.start);
}
function applyMarkdownFormat(format: string): void {
  if (busy) return;
  if (!documentState) { status("先に原稿を開いてください。", true); return; }
  milkdown.showSource();
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const selected = editor.value.slice(start, end);
  if (format === "table") { openTableEditor(); return; }
  if (format === "strike") { applyAssist(toggleStrikethrough(editor.value, start, end)); return; }
  if (format === "task-list") { applyAssist(toggleTaskList(editor.value, start, end)); return; }
  if (format === "indent" || format === "unindent") { applyAssist(changeIndent(editor.value, start, end, format)); return; }
  if (format === "bold" || format === "italic" || format === "inline-code") {
    const marker = format === "bold" ? "**" : format === "italic" ? "*" : "`";
    const placeholder = format === "bold" ? "太字" : format === "italic" ? "斜体" : "コード";
    const value = selected || placeholder;
    replaceMarkdown(start, end, `${marker}${value}${marker}`, marker.length, marker.length + value.length);
  } else if (format === "link") {
    const label = selected || "リンク文字";
    const url = "https://example.com";
    const replacement = `[${label}](${url})`;
    const focusStart = selected ? label.length + 3 : 1;
    replaceMarkdown(start, end, replacement, focusStart, focusStart + (selected ? url.length : label.length));
  } else if (format === "heading") {
    applyAssist(changeHeadingLevel(editor.value, start, end, Number(element<HTMLSelectElement>("heading-level").value)));
  } else if (format === "bullet" || format === "numbered" || format === "quote") {
    const lineStart = editor.value.lastIndexOf("\n", start - 1) + 1;
    const nextNewline = editor.value.indexOf("\n", end);
    const lineEnd = nextNewline < 0 ? editor.value.length : nextNewline;
    const lines = editor.value.slice(lineStart, lineEnd).split("\n");
    const replacement = lines.map((line, index) => `${format === "bullet" ? "- " : format === "quote" ? "> " : `${index + 1}. `}${line}`).join("\n");
    replaceMarkdown(lineStart, lineEnd, replacement, replacement.length, replacement.length);
  } else if (format === "mermaid") {
    replaceMarkdown(start, end, "\n\n```mermaid\ngraph TD\n    A[開始] --> B[完了]\n```\n", 0);
  } else if (format === "code-block" || format === "table" || format === "rule") {
    const before = editor.value.slice(0, start);
    const after = editor.value.slice(end);
    const prefix = before.endsWith("\n\n") || !before ? "" : before.endsWith("\n") ? "\n" : "\n\n";
    const suffix = after.startsWith("\n\n") || !after ? "" : after.startsWith("\n") ? "\n" : "\n\n";
    if (format === "code-block") {
      const value = selected || "コード";
      const replacement = `${prefix}\`\`\`\n${value}\n\`\`\`${suffix}`;
      const focusStart = prefix.length + 4;
      replaceMarkdown(start, end, replacement, focusStart, focusStart + value.length);
    } else if (format === "table") {
      const replacement = `${prefix}| 項目 | 内容 |\n| --- | --- |\n| 名前 | 説明 |${suffix}`;
      replaceMarkdown(start, end, replacement, prefix.length + 2, prefix.length + 4);
    } else {
      const replacement = `${prefix}---${suffix}`;
      replaceMarkdown(start, end, replacement, replacement.length);
    }
  }
}
document.querySelectorAll<HTMLButtonElement>("[data-format]").forEach((button) => button.addEventListener("click", () => applyMarkdownFormat(button.dataset.format!)));
editor.addEventListener("keydown", (event) => {
  if (busy || !documentState) return;
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "z") {
    event.preventDefault(); stepEditHistory(event.shiftKey ? 1 : -1); return;
  }
  if (event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "y") {
    event.preventDefault(); stepEditHistory(1); return;
  }
  if ((event.ctrlKey || event.metaKey) && ["b", "i", "k"].includes(event.key.toLowerCase())) {
    event.preventDefault();
    applyMarkdownFormat(({ b: "bold", i: "italic", k: "link" } as Record<string, string>)[event.key.toLowerCase()]);
    return;
  }
  if (event.key === "Enter" && !event.isComposing && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && editor.selectionStart === editor.selectionEnd) {
    event.preventDefault(); applyAssist(continueMarkdownList(editor.value, editor.selectionStart)); return;
  }
  if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    if (event.shiftKey || editor.selectionStart !== editor.selectionEnd) applyAssist(changeIndent(editor.value, editor.selectionStart, editor.selectionEnd, event.shiftKey ? "unindent" : "indent"));
    else replaceMarkdown(editor.selectionStart, editor.selectionEnd, "  ", 2);
  }
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void work(saveDocument); }
});
let closingApproved = false;
window.addEventListener("beforeunload", (event) => { if (dirty && !closingApproved) { event.preventDefault(); event.returnValue = ""; } });
if (native) void getCurrentWindow().onCloseRequested(event => {
  if (closingApproved || !dirty) return;
  event.preventDefault();
  void work(async () => {
    if (!await confirmDiscard()) return;
    closingApproved = true;
    try { await getCurrentWindow().destroy(); }
    catch (error) { closingApproved = false; throw error; }
  });
});
function resetRecordingControls(): void {
  operationRecording = false;
  recordingPollGeneration++;
  if (recordingPoll) clearTimeout(recordingPoll);
  recordingPoll = undefined;
  if (native) void invoke("close_recording_control").catch(() => {});
  setButtonDisabled(element<HTMLButtonElement>("start-operation-recording"), false);
  setButtonDisabled(element<HTMLButtonElement>("stop-operation-recording"), true);
}
async function acceptRecordingResult(result: RecordingResult, generation = captureSessions.active?.generation): Promise<void> {
  if (generation === undefined || !isCurrentCaptureSession(generation)) return;
  externalFinishActive = false;
  if (ignoredCaptureFiles.has(result.annotationFile) || acceptedRecordingResultGeneration === generation) return;
  acceptedRecordingResultGeneration = generation;
  activeRecordingResult = result;
  resetRecordingControls();
  pendingScenarioFile = result.scenarioFile;
  pendingRecordedOperations = result.operationText;
  status(`${result.message}（${result.events}件の操作）`);
  element("operation-recording-status").textContent = result.message;
  if (!result.markitsStarted) {
    await restoreManualStudioAfterCapture(true).catch(() => {});
    if (isCurrentCaptureSession(generation)) updateCaptureBusyState();
    return;
  }
  if (annotationPoll) clearTimeout(annotationPoll);
  annotationPollRunning = true;
  updateCaptureBusyState();
  const started = Date.now();
  let lastWaitNoticeAt = 0;
  const checkAnnotation = async (): Promise<void> => {
    if (!annotationPollRunning || !isCurrentCaptureSession(generation)) return;
    try {
      const annotation = await invoke<string | null>("markits_annotation_ready", { sourceFile: result.sourceFile, annotationFile: result.annotationFile, completionFile: result.completionFile });
      if (!annotationPollRunning || !isCurrentCaptureSession(generation)) return;
      if (!annotation) {
        const elapsed = Math.floor((Date.now() - started) / 1000);
        if (elapsed - lastWaitNoticeAt >= 15) {
          lastWaitNoticeAt = elapsed;
          element("operation-recording-status").textContent = `MarkItsの編集完了を待っています（${elapsed}秒）。MarkItsで「編集終了」を押してください。`;
        }
        annotationPoll = setTimeout(() => { void checkAnnotation(); }, 1000);
        return;
      }
      annotationPoll = undefined;
      pendingAnnotationSpec = annotation;
      pendingAnnotatedImageFile = result.annotationFile;
      await restoreManualStudioAfterCapture(true);
      if (!annotationPollRunning || !isCurrentCaptureSession(generation)) return;
      annotationPollRunning = false;
      updateCaptureBusyState();
      const taskForm = element<HTMLFormElement>("screenshot-task-form");
      const dialog = element<HTMLDialogElement>("screenshot-task-dialog");
      if (dialog.open && taskForm.reportValidity()) taskForm.requestSubmit();
      else {
        element("operation-recording-status").textContent = "注釈を受け取りました。入力内容を確認して「指示を追加」を押してください。";
        status("注釈を読み込みました。入力内容を確認してください。");
      }
    } catch (error) {
      if (!isCurrentCaptureSession(generation)) return;
      annotationPollRunning = false;
      annotationPoll = undefined;
      updateCaptureBusyState();
      await restoreManualStudioAfterCapture(true).catch(() => {});
      element("operation-recording-status").textContent = `MarkItsの完了確認に失敗しました: ${String(error)}`;
      status(`MarkItsの完了確認に失敗しました: ${String(error)}`, true);
    }
  };
  void checkAnnotation();
}
function finishOperationRecording(): Promise<void> {
  if (recordingFinishing) return recordingFinishing;
  if (!operationRecording) return Promise.resolve();
  const generation = captureSessions.active?.generation;
  if (generation === undefined) return Promise.resolve();
  operationRecording = false;
  recordingPollGeneration++;
  if (recordingPoll) clearTimeout(recordingPoll);
  recordingPoll = undefined;
  if (native) void invoke("close_recording_control").catch(() => {});
  recordingFinishActive = true;
  setButtonDisabled(element<HTMLButtonElement>("start-operation-recording"), true);
  setButtonDisabled(element<HTMLButtonElement>("stop-operation-recording"), true);
  updateCaptureBusyState();
  recordingFinishing = (async () => {
    try {
      await hideManualStudioForCapture();
      await new Promise((resolve) => setTimeout(resolve, 350));
      const result = await invoke<RecordingResult>("finish_operation_recording");
      if (!isCurrentCaptureSession(generation)) return;
      await acceptRecordingResult(result, generation);
    } catch (error) {
      if (!isCurrentCaptureSession(generation)) return;
      resetRecordingControls();
      updateCaptureBusyState();
      await restoreManualStudioAfterCapture(true).catch(() => {});
      status(String(error), true);
      element("operation-recording-status").textContent = String(error);
    }
  })().finally(() => {
    recordingFinishing = null;
    recordingFinishActive = false;
    updateCaptureBusyState();
  });
  return recordingFinishing;
}
async function pollRecordingStatus(generation: number): Promise<void> {
  if (!operationRecording || generation !== recordingPollGeneration) return;
  try {
    const running = await invoke<boolean>("operation_recording_running");
    if (!operationRecording || generation !== recordingPollGeneration) return;
    if (!running) { await finishOperationRecording(); return; }
  } catch (error) {
    status(`操作記録の状態確認に失敗しました: ${String(error)}`, true);
    element("operation-recording-status").textContent = `操作記録の状態確認に失敗しました。手動で終了できます。\n${String(error)}`;
  }
  if (operationRecording && generation === recordingPollGeneration) {
    recordingPoll = setTimeout(() => { void pollRecordingStatus(generation); }, 800);
  }
}
element("start-operation-recording").addEventListener("click", () => {
  if (busy) {
    const message = "別の処理が終わってから操作記録を開始してください。";
    element("operation-recording-status").textContent = message; status(message, true); return;
  }
  const selectedCommand = launchCommands.find((command) => command.name === element<HTMLSelectElement>("screenshot-launch-command").value);
  const program = selectedCommand?.program.trim() || input("screenshot-launch-program").value.trim();
  const issue = !native ? "操作記録はデスクトップアプリで利用できます。"
    : !program ? "起動するアプリを選択してください。"
    : !projectRoot ? "先にワークスペースを開いてください。" : "";
  if (issue) { element("operation-recording-status").textContent = issue; status(issue, true); return; }
  void work(async () => {
  const session = captureSessions.active;
  if (!session || operationRecording || recordingStarting || recordingFinishActive) return;
  const generation = session.generation;
  const args = selectedCommand?.args ?? element<HTMLTextAreaElement>("screenshot-launch-args").value.split("\n").map((value) => value.trim()).filter(Boolean);
  pendingLaunchProgram = program;
  pendingLaunchArgs = args;
  const progress = "アプリを起動し、ウィンドウを自動検出しています（最大30秒）。";
  element("operation-recording-status").textContent = progress; status(progress);
  let message: string;
  recordingStarting = true;
  updateCaptureBusyState();
  try {
    message = await invoke<string>("start_operation_recording", { root: session.root, program, args, windowTitle: "", taskId: session.id, markitsProgram: "markits-desktop" });
  } catch (error) {
    const failure = String(error);
    element("operation-recording-status").textContent = failure; status(failure, true); throw error;
  } finally {
    recordingStarting = false;
    updateCaptureBusyState();
  }
  if (!isCurrentCaptureSession(generation)) return;
  operationRecording = true;
  pendingScenarioFile = null;
  setButtonDisabled(element<HTMLButtonElement>("start-operation-recording"), true);
  setButtonDisabled(element<HTMLButtonElement>("stop-operation-recording"), false);
  element("operation-recording-status").textContent = message;
  status(message);
  updateCaptureBusyState();
  const pollGeneration = ++recordingPollGeneration;
  recordingPoll = setTimeout(() => { void pollRecordingStatus(pollGeneration); }, 800);
  if (native) void invoke("show_recording_control").catch((error) => status(`撮影ボタンを表示できません: ${String(error)}。Ctrl+Shift+F10で終了できます。`, true));
  });
});
element("stop-operation-recording").addEventListener("click", () => { void finishOperationRecording(); });
function nextAiTaskId(kind: string): string {
  const stem = documentState!.page.replace(/\.md$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "page";
  const prefix = `task-${stem}-${kind}`;
  const ids = collectAiTagIds(editor.value);
  let suffix = 1;
  while (ids.has(`${prefix}-${suffix}`) || workspace?.tasks.some((task) => task.id === `${prefix}-${suffix}`)) suffix++;
  return `${prefix}-${suffix}`;
}
function updateLaunchSelection(): void {
  const select = element<HTMLSelectElement>("screenshot-launch-command");
  const custom = select.value === "__custom__";
  element<HTMLElement>("custom-launch-command").hidden = !custom;
  element<HTMLElement>("custom-launch-args-label").hidden = !custom;
  const summary = element("screenshot-launch-summary");
  const command = launchCommands.find((item) => item.name === select.value);
  summary.textContent = command ? `起動アプリ: ${command.program}${command.args.length ? `（引数 ${command.args.length} 件）` : ""}` : custom ? "アプリの実行ファイルと必要な引数を指定してください。" : "共通コマンドを登録すると、ここから選べます。";
}
function refreshLaunchCommandOptions(): void {
  const select = element<HTMLSelectElement>("screenshot-launch-command");
  const previous = select.value;
  select.replaceChildren(...launchCommands.map((command) => new Option(command.name, command.name)));
  select.add(new Option("カスタム起動コマンド", "__custom__"));
  select.value = previous && (previous === "__custom__" || launchCommands.some((item) => item.name === previous)) ? previous : launchCommands[0]?.name ?? "__custom__";
  updateLaunchSelection();
}
function renderLaunchCommands(): void {
  const list = element("launch-command-list");
  list.replaceChildren();
  launchCommands.forEach((command, index) => {
    const row = document.createElement("div"); row.className = "launch-command-row";
    const nameLabel = document.createElement("label"); nameLabel.textContent = "表示名";
    const name = document.createElement("input"); name.value = command.name; name.dataset.launchName = String(index); nameLabel.append(name);
    const programLabel = document.createElement("label"); programLabel.textContent = "起動コマンド / アプリ";
    const programWrap = document.createElement("div"); programWrap.className = "app-picker-row";
    const program = document.createElement("input"); program.value = command.program; program.placeholder = "例: firefox または /usr/bin/firefox"; program.dataset.launchProgram = String(index);
    const browse = document.createElement("button"); browse.type = "button"; browse.textContent = "選択"; browse.dataset.launchBrowse = String(index);
    programWrap.append(program, browse); programLabel.append(programWrap);
    const argsLabel = document.createElement("label"); argsLabel.textContent = "起動引数（1行に1つ）";
    const args = document.createElement("textarea"); args.rows = 2; args.value = command.args.join("\n"); args.dataset.launchArgs = String(index); argsLabel.append(args);
    const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "削除"; remove.dataset.launchRemove = String(index);
    row.append(nameLabel, programLabel, argsLabel, remove); list.append(row);
  });
  list.querySelectorAll<HTMLButtonElement>("[data-launch-browse]").forEach((button) => button.addEventListener("click", () => { void work(async () => {
    if (!native) throw new Error("アプリ選択はデスクトップアプリで利用できます。");
    const path = await invoke<string | null>("choose_application");
    if (path) list.querySelector<HTMLInputElement>(`[data-launch-program="${button.dataset.launchBrowse}"]`)!.value = path;
  }); }));
  list.querySelectorAll<HTMLButtonElement>("[data-launch-remove]").forEach((button) => button.addEventListener("click", () => {
    launchCommands.splice(Number(button.dataset.launchRemove), 1); renderLaunchCommands(); refreshLaunchCommandOptions();
  }));
}
async function loadLaunchCommands(): Promise<void> {
  if (!native) { refreshLaunchCommandOptions(); return; }
  launchCommands = await invoke<LaunchCommand[]>("load_launch_commands");
  renderLaunchCommands(); refreshLaunchCommandOptions();
}
function insertAiTask(kind: string, custom?: { id: string; prompt: string }, selection?: { start: number; end: number }): boolean {
  if (!documentState) { status("先に原稿を開いてください。", true); return false; }
  const id = custom?.id.trim() || nextAiTaskId(kind);
  if (!/^[a-z][a-z0-9_-]*$/.test(id) || collectAiTagIds(editor.value).has(id) || workspace?.tasks.some((task) => task.id === id)) {
    status("指示IDが不正か、すでに使われています。別のIDを指定してください。", true);
    return false;
  }
  const prompt = kind === "screenshot" ? "対象アプリの画面と、表示する操作要素を指定してください。" : kind === "diagram" ? "Pythonモジュール間の依存関係を図にしてください。" : "対象読者と説明する操作手順を指定してください。";
  const markdown = `\n\n<!-- ai:task id=${id} kind=${kind} prompt="${escapeTaskPrompt(custom?.prompt ?? prompt)}" -->\n\n<!-- /ai:task -->\n`;
  if (milkdown.isRichEditing) return milkdown.insertAiTag(markdown);
  rememberCurrentSelection(selection?.start, selection?.end);
  editor.setRangeText(markdown, selection?.start ?? editor.selectionStart, selection?.end ?? editor.selectionEnd, "end");
  editor.dispatchEvent(new Event("input")); editor.focus();
  return true;
}
function requestAiTask(kind: string): void {
  if (busy) return;
  element("panel-editor").querySelector<HTMLDetailsElement>(".instruction-toolbar")!.open = false;
  if (kind !== "screenshot") { insertAiTask(kind); return; }
  if (!documentState) { status("先に原稿を開いてください。", true); return; }
  if (pendingAnnotatedImageFile) {
    const session = captureSessions.active;
    if (!session || session.root !== projectRoot || session.page !== documentState.page) {
      status("編集中のMarkIts画像と原稿の対応を確認できません。画像追加をキャンセルして最初からやり直してください。", true);
      return;
    }
    element<HTMLDialogElement>("screenshot-task-dialog").showModal();
    element("operation-recording-status").textContent = "前回のMarkIts画像追加が未完了です。保持した画像と入力で続きから再試行できます。";
    status("前回のMarkIts画像追加を再開できます。");
    return;
  }
  if (captureSessions.active) {
    status("撮影AIタグの作成が進行中です。現在のダイアログで完了またはキャンセルしてください。", true);
    return;
  }
  const selection = { start: editor.selectionStart, end: editor.selectionEnd };
  const id = nextAiTaskId("screenshot");
  input("screenshot-task-id").value = id;
  captureSessions.begin({ root: projectRoot, page: documentState.page, id, selection });
  acceptedRecordingResultGeneration = -1;
  activeRecordingResult = null;
  element<HTMLTextAreaElement>("screenshot-notes").value = "";
  input("screenshot-launch-program").value = "";
  element<HTMLTextAreaElement>("screenshot-launch-args").value = "";
  refreshLaunchCommandOptions();
  element("operation-recording-status").textContent = "記録中は入力した文字も保存されます。機密情報を入力しないでください。対象アプリ以外を操作しないでください。Ctrl+Shift+F9で一時停止、Ctrl+Shift+F10で終了できます。";
  pendingScenarioFile = null;
  pendingRecordedOperations = "";
  pendingAnnotationSpec = "";
  element<HTMLDialogElement>("screenshot-task-dialog").dataset.selection = JSON.stringify(selection);
  clearScreenshotFeedback();
  element<HTMLDialogElement>("screenshot-task-dialog").showModal();
  if (element<HTMLSelectElement>("screenshot-launch-command").value === "__custom__") input("screenshot-launch-program").focus();
}
document.querySelectorAll<HTMLElement>("[data-insert]").forEach(button => button.addEventListener("click", () => requestAiTask(button.dataset.insert!)));
element("screenshot-launch-command").addEventListener("change", updateLaunchSelection);
async function cancelCaptureSession(): Promise<void> {
  const session = captureSessions.active;
  if (!session) { element<HTMLDialogElement>("screenshot-task-dialog").close(); return; }
  if (operationRecording || recordingStarting || recordingFinishActive || externalFinishActive || screenshotSubmitRunning) {
    status(operationRecording ? "Ctrl+Shift+F10で操作記録を終了してからキャンセルしてください。" : "処理中はキャンセルできません。完了するまでお待ちください。", true);
    return;
  }
  captureSessions.invalidate(session.generation);
  annotationPollRunning = false;
  if (annotationPoll) clearTimeout(annotationPoll);
  annotationPoll = undefined;
  recordingPollGeneration++;
  if (recordingPoll) clearTimeout(recordingPoll);
  recordingPoll = undefined;
  if (activeRecordingResult) {
    ignoredCaptureFiles.add(activeRecordingResult.annotationFile);
    if (ignoredCaptureFiles.size > 64) ignoredCaptureFiles.delete(ignoredCaptureFiles.values().next().value!);
  }
  const imageFile = pendingAnnotatedImageFile;
  pendingScenarioFile = null;
  pendingRecordedOperations = "";
  pendingAnnotationSpec = "";
  pendingAnnotatedImageFile = "";
  pendingLaunchProgram = "";
  pendingLaunchArgs = [];
  activeRecordingResult = null;
  acceptedRecordingResultGeneration = -1;
  resetRecordingControls();
  element<HTMLDialogElement>("screenshot-task-dialog").close();
  await restoreManualStudioAfterCapture(true).catch(() => {});
  if (imageFile) await invoke("cleanup_markits_capture", { imageFile }).catch(() => {});
  updateCaptureBusyState();
  status("保持した画像の自動取り込みを停止しました。原稿の変更は必要に応じて保存またはUndoしてください。");
}
element("cancel-screenshot-task").addEventListener("click", () => { void cancelCaptureSession(); });
element<HTMLDialogElement>("screenshot-task-dialog").addEventListener("cancel", (event) => {
  event.preventDefault();
  void cancelCaptureSession();
});
element("screenshot-task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const dialog = element<HTMLDialogElement>("screenshot-task-dialog");
  const reportSubmitIssue = (message: string): void => showScreenshotFeedback(message);
  try {
    clearScreenshotFeedback();
    if (operationRecording || recordingStarting || recordingFinishActive || externalFinishActive || annotationPollRunning) {
      reportSubmitIssue("撮影処理が完了してから指示を追加してください。"); return;
    }
    const notes = element<HTMLTextAreaElement>("screenshot-notes").value.trim();
    const annotationText = pendingAnnotationSpec.trim();
    let annotationSection = "";
    if (annotationText) {
      try {
        const parsed = JSON.parse(annotationText) as { canvas?: unknown; annotations?: unknown };
        if (!Array.isArray(parsed.annotations)) throw new Error("annotations が配列ではありません。");
        if (parsed.annotations.length > 0) {
          const annotationOnly = JSON.stringify({ ...(parsed.canvas ? { canvas: parsed.canvas } : {}), annotations: parsed.annotations }, null, 2).replaceAll("<", "\\u003c").replaceAll("-->", "--\\u003e");
          annotationSection = `MarkIts アノテーション仕様:\n\`\`\`json\n${annotationOnly}\n\`\`\``;
        }
      } catch (error) { reportSubmitIssue(`MarkIts JSON を確認してください: ${String(error)}`); return; }
    }
    const recordedOperations = pendingRecordedOperations ? `記録した操作:\n${pendingRecordedOperations.replaceAll("<", "&lt;").replaceAll(">", "&gt;")}` : "";
    const hasRecordedCapture = Boolean(pendingRecordedOperations || pendingScenarioFile || pendingAnnotatedImageFile);
    const selectedCommand = launchCommands.find((command) => command.name === element<HTMLSelectElement>("screenshot-launch-command").value);
    const configuredProgram = selectedCommand?.program.trim() || input("screenshot-launch-program").value.trim();
    const configuredArgs = selectedCommand?.args ?? element<HTMLTextAreaElement>("screenshot-launch-args").value.split("\n").map((value) => value.trim()).filter(Boolean);
    const launchProgram = hasRecordedCapture ? pendingLaunchProgram : configuredProgram;
    const launchArgs = hasRecordedCapture ? pendingLaunchArgs : configuredArgs;
    const launch = launchProgram ? `起動アプリ: ${launchProgram}${launchArgs.length ? `\n起動引数:\n${launchArgs.map((arg) => `- ${arg}`).join("\n")}` : ""}` : "";
    if (!launch && !notes && !recordedOperations && !annotationSection && !pendingAnnotatedImageFile) {
      reportSubmitIssue("起動アプリまたは補足を入力してから指示を追加してください。"); return;
    }
    const prompt = [launch, recordedOperations, notes ? `補足: ${notes}` : "", annotationSection].filter(Boolean).join("\n\n");
    const id = input("screenshot-task-id").value;
    if (pendingAnnotatedImageFile) {
      if (screenshotSubmitRunning) { reportSubmitIssue("画像を取り込んでいます。完了するまでお待ちください。"); return; }
      const session = captureSessions.active;
      if (!session || !isCurrentCaptureSession(session.generation) || annotationPollRunning || session.id !== id || !/^[a-z][a-z0-9_-]*$/.test(id)) {
        reportSubmitIssue("撮影対象またはIDが一致しません。画像と入力は保持しています。やり直す場合はキャンセルして撮影AIタグを作り直してください。"); return;
      }
      if (!dialog.open) { reportSubmitIssue("撮影AIタグのダイアログを開いてから追加してください。"); return; }
      const aiTagIds = collectAiTagIds(editor.value);
      const alreadyInserted = [...editor.value.matchAll(/<!--\s*ai:(?:generated|task)\b((?:"[^"]*"|[^>"])*)-->/g)]
        .some((match) => match[1].split(/\s+/).includes(`id=${id}`));
      if (!alreadyInserted && (aiTagIds.has(id) || workspace?.tasks.some((task) => task.id === id))) {
        reportSubmitIssue("撮影IDがすでに使われています。画像と入力は保持しています。キャンセルして撮影AIタグを作り直してください。"); return;
      }
      try {
        screenshotSubmitRunning = true;
        updateCaptureBusyState();
        const submitButtons = [...dialog.querySelectorAll<HTMLButtonElement>('button[type="submit"]')];
        submitButtons.forEach((button) => { button.disabled = true; });
        let stageStartedAt = Date.now();
        let stageLabel = "";
        if (screenshotStageTimer) clearInterval(screenshotStageTimer);
        screenshotStageTimer = setInterval(() => {
          const elapsed = Math.floor((Date.now() - stageStartedAt) / 1000);
          if (elapsed >= 5) element("operation-recording-status").textContent = `${stageLabel}（処理中・${elapsed}秒）`;
        }, 1000);
        await completeMarkitsCapture({
          alreadyInserted,
          dirty,
          importImage: async () => {
            if (!isCurrentCaptureSession(session.generation)) throw new Error("撮影対象が変わりました。画像を追加せずキャンセルしてください。");
            const block = await invoke<string>("preserve_markits_capture", { root: session.root, page: session.page, taskId: session.id, imageFile: pendingAnnotatedImageFile, prompt });
            if (!isCurrentCaptureSession(session.generation)) throw new Error("撮影がキャンセルされました。タグを追加しませんでした。");
            return block;
          },
          insertTag: (block) => {
            if (!isCurrentCaptureSession(session.generation)) throw new Error("撮影対象が変わりました。タグを追加しませんでした。");
            rememberCurrentSelection(session.selection.start, session.selection.end);
            editor.setRangeText(`\n\n${block}\n`, session.selection.start, session.selection.end, "end");
            editor.dispatchEvent(new Event("input")); editor.focus();
          },
          saveDocument: async () => {
            if (!isCurrentCaptureSession(session.generation)) throw new Error("撮影対象が変わりました。原稿を保存しませんでした。");
            await saveDocument(false);
            if (!isCurrentCaptureSession(session.generation)) throw new Error("撮影がキャンセルされました。原稿の保存結果を確認してください。");
          },
          ...(pendingScenarioFile ? { saveCaptureSource: async () => {
            if (!isCurrentCaptureSession(session.generation)) throw new Error("撮影対象が変わりました。撮影元を登録しませんでした。");
            await rpc("capture-source-save", { id: session.id, input: pendingScenarioFile }, session.root);
            if (!isCurrentCaptureSession(session.generation)) throw new Error("撮影がキャンセルされました。撮影元の登録結果を確認してください。");
            pendingScenarioFile = null;
          } } : {}),
          refreshWorkspace: async () => {
            if (!isCurrentCaptureSession(session.generation)) throw new Error("撮影対象が変わりました。画面を更新しませんでした。");
            await refreshWorkspace();
            if (!isCurrentCaptureSession(session.generation)) throw new Error("撮影がキャンセルされました。画面の内容を確認してください。");
          },
          reportStage: (stage) => {
            const labels = { image: "1/3 編集済み画像を取り込んでいます…", document: "2/3 AIタグの本文を原稿へ保存しています…", "capture-source": "3/3 次回の再撮影設定を登録しています…", refresh: "保存結果を確認しています…" };
            stageLabel = labels[stage];
            stageStartedAt = Date.now();
            element("operation-recording-status").textContent = stageLabel;
          },
        });
        if (!isCurrentCaptureSession(session.generation)) return;
        await invoke("cleanup_markits_capture", { imageFile: pendingAnnotatedImageFile });
        if (!isCurrentCaptureSession(session.generation)) return;
        if (screenshotStageTimer) clearInterval(screenshotStageTimer);
        screenshotStageTimer = undefined;
        pendingAnnotatedImageFile = ""; pendingAnnotationSpec = "";
      captureSessions.invalidate(session.generation);
      pendingScenarioFile = null;
      pendingRecordedOperations = "";
      pendingAnnotationSpec = "";
      pendingAnnotatedImageFile = "";
      activeRecordingResult = null;
        acceptedRecordingResultGeneration = -1;
        dialog.close(); pendingLaunchProgram = ""; pendingLaunchArgs = [];
        element("operation-recording-status").textContent = "完了：注釈付き画像と撮影設定を保存しました。";
        status("注釈付き画像をAIタグの本文として保存し、同じ操作を再撮影する設定も登録しました。");
      } catch (error) {
        const message = `MarkIts画像の追加で停止しました。入力と画像を保持しています。再試行できます。\n${String(error)}`;
        reportSubmitIssue(message);
      } finally {
        if (screenshotStageTimer) clearInterval(screenshotStageTimer);
        screenshotStageTimer = undefined;
        screenshotSubmitRunning = false;
        dialog.querySelectorAll<HTMLButtonElement>('button[type="submit"]').forEach((button) => { button.disabled = false; });
        updateCaptureBusyState();
      }
      return;
    }
    const session = captureSessions.active;
    if (!session || !isCurrentCaptureSession(session.generation) || session.id !== id) {
      reportSubmitIssue("撮影セッションと原稿が一致しません。ダイアログを閉じて撮影AIタグを作り直してください。"); return;
    }
    if (insertAiTask("screenshot", { id, prompt }, session.selection)) {
      if (pendingScenarioFile) {
        const taskStart = editor.value.indexOf(`<!-- ai:task id=${id} kind=screenshot`);
        const taskEnd = taskStart >= 0 ? editor.value.indexOf("-->", taskStart) : -1;
        if (taskEnd >= 0) { editor.setRangeText(`\n<!-- ai:scenario file=${pendingScenarioFile} -->`, taskEnd + 3, taskEnd + 3, "end"); editor.dispatchEvent(new Event("input")); }
        pendingScenarioFile = null;
      }
      dialog.close();
      captureSessions.invalidate(session.generation);
      pendingLaunchProgram = "";
      pendingLaunchArgs = [];
      updateCaptureBusyState();
      clearScreenshotFeedback();
      const message = "撮影指示を原稿へ追加しました。保存すると実行対象になります。";
      element("operation-recording-status").textContent = message;
      status(message);
    } else {
      reportSubmitIssue("撮影IDがすでに使われています。キャンセルして撮影AIタグを作り直してください。");
    }
  } catch (error) {
    reportSubmitIssue(`撮影AIタグを追加できませんでした: ${String(error)}`);
  }
});
element<HTMLFormElement>("screenshot-task-form").addEventListener("invalid", (event) => {
  const control = event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  const message = control.validationMessage || "入力内容を確認してください。";
  showScreenshotFeedback(`指示を追加できません: ${message}`);
}, true);
element("new-page").addEventListener("click", () => {
  if (!projectRoot) { status("先にプロジェクトを開いてください。", true); return; }
  element<HTMLDialogElement>("new-page-dialog").showModal(); input("new-page-path").focus();
});
element("cancel-new-page").addEventListener("click", () => element<HTMLDialogElement>("new-page-dialog").close());
element("new-page-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void work(async () => {
    if (!await confirmDiscard()) return;
    const page = input("new-page-path").value.trim();
    await rpc("editor-save", { page, json: { content: `# ${input("new-page-title").value.trim()}\n\n`, revision: null } });
    element<HTMLDialogElement>("new-page-dialog").close();
    dirty = false; await refreshWorkspace(); await openPage(page, false); status(`${page}を作成しました。`);
  });
});
element("new-folder").addEventListener("click", () => {
  if (!projectRoot || !workspace) { status("先にプロジェクトを開いてください。", true); return; }
  element("new-folder-parent").textContent = `作成先: ${workspace.config.docs}`;
  input("new-folder-path").value = "";
  element<HTMLDialogElement>("new-folder-dialog").showModal();
  input("new-folder-path").focus();
});
element("cancel-new-folder").addEventListener("click", () => element<HTMLDialogElement>("new-folder-dialog").close());
element("new-folder-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void work(async () => {
    if (!projectRoot || !workspace) throw new Error("先にプロジェクトを開いてください。");
    const relative = input("new-folder-path").value.trim().replace(/\\/g, "/");
    const created = await rpc("create-folder", { path: relative });
    for (const [index] of created.split("/").entries()) expandedFolders.add(created.split("/").slice(0, index + 1).join("/"));
    element<HTMLDialogElement>("new-folder-dialog").close();
    await refreshWorkspace();
    status(`${created} フォルダーを作成しました。`);
  });
});
let pendingImageDataUrl: string | null = null;
let pendingImageSelection: { start: number; end: number } | null = null;
const toolbarImageInput = element<HTMLInputElement>("toolbar-image-input");
element("insert-image").addEventListener("click", () => {
  if (!documentState) { status("先にMarkdown原稿を開いてください。", true); return; }
  pendingImageSelection = null;
  toolbarImageInput.click();
});
toolbarImageInput.addEventListener("change", () => {
  const file = toolbarImageInput.files?.[0];
  const selection = { start: editor.selectionStart, end: editor.selectionEnd };
  toolbarImageInput.value = "";
  if (!file) { pendingImageSelection = null; return; }
  if (!/^image\/(png|jpeg|gif|webp|svg\+xml)$/.test(file.type)) {
    pendingImageSelection = null;
    status("PNG、JPEG、GIF、WebP、SVGの画像を選んでください。", true);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    if (typeof reader.result === "string") {
      const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      pendingImageSelection = selection;
      openImageSaveDialog(reader.result, cleanName, cleanName.replace(/\.[^.]+$/, ""));
    }
  };
  reader.onerror = () => { pendingImageSelection = null; status("画像を読み込めませんでした。", true); };
  reader.readAsDataURL(file);
});
async function uploadMilkdownImage(file: File): Promise<string> {
  if (busy || !documentState) throw new Error("先に原稿を開いてください。");
  const current = documentState;
  const root = projectRoot;
  const extension = file.name.split('.').at(-1)?.toLowerCase() || '';
  if (!['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(extension)) throw new Error("対応していない画像形式です。");
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("画像を読み込めませんでした。"));
    reader.readAsDataURL(file);
  });
  const directory = current.page.split('/').slice(0, -1).join('/');
  const path = `${directory ? `${directory}/` : ''}assets/image-${crypto.randomUUID()}.${extension}`;
  await rpc("save-asset", { path, data }, root);
  if (documentState !== current || projectRoot !== root) throw new Error("編集中の原稿が切り替わりました。画像を挿入し直してください。");
  return computeRelativeMarkdownPath(current.page, path, workspace?.config.docs || "docs");
}

function computeRelativeMarkdownPath(pagePath: string, assetPath: string, docsFolder = "docs"): string {
  const pageRelative = pagePath.startsWith(docsFolder + "/") ? pagePath : `${docsFolder}/${pagePath}`;
  const pageDir = pageRelative.split("/").slice(0, -1);
  const targetParts = assetPath.replace(/\\/g, "/").split("/");
  let common = 0;
  while (common < pageDir.length && common < targetParts.length && pageDir[common] === targetParts[common]) {
    common++;
  }
  const upCount = pageDir.length - common;
  const up = upCount > 0 ? Array(upCount).fill("..").join("/") + "/" : "";
  const rest = targetParts.slice(common).join("/");
  return up + rest;
}
function updateMarkdownInsertPreview(): void {
  if (!documentState) return;
  const folder = input("image-save-folder").value.trim().replace(/\/+$/, "");
  const filename = input("image-save-filename").value.trim();
  const alt = input("image-save-alt").value.trim();
  const fullAssetPath = folder ? `${folder}/${filename}` : filename;
  const relPath = computeRelativeMarkdownPath(documentState.page, fullAssetPath, workspace?.config.docs || "docs");
  element("image-markdown-preview").textContent = `![${alt}](${relPath})`;
}
function openImageSaveDialog(dataUrl: string, suggestedFilename?: string, defaultAlt?: string): void {
  if (!documentState) {
    status("先にMarkdown原稿を開いてください。", true);
    return;
  }
  pendingImageDataUrl = dataUrl;
  element<HTMLImageElement>("image-save-preview").src = dataUrl;
  const defaultAssets = workspace?.config.assets || `${workspace?.config.docs || "docs"}/assets`;
  input("image-save-folder").value = defaultAssets;
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const filename = suggestedFilename || `image-${stamp}.png`;
  input("image-save-filename").value = filename;
  input("image-save-alt").value = defaultAlt || filename.replace(/\.[^.]+$/, "");
  updateMarkdownInsertPreview();
  element<HTMLDialogElement>("image-save-dialog").showModal();
  input("image-save-filename").focus();
}
element("image-save-folder").addEventListener("input", updateMarkdownInsertPreview);
element("image-save-filename").addEventListener("input", updateMarkdownInsertPreview);
element("image-save-alt").addEventListener("input", updateMarkdownInsertPreview);
element("cancel-image-save").addEventListener("click", () => {
  pendingImageDataUrl = null;
  pendingImageSelection = null;
  element<HTMLDialogElement>("image-save-dialog").close();
});
element("image-save-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!pendingImageDataUrl || !documentState) return;
  const folder = input("image-save-folder").value.trim().replace(/\/+$/, "");
  const filename = input("image-save-filename").value.trim();
  const alt = input("image-save-alt").value.trim();
  if (!filename) {
    status("ファイル名を入力してください。", true);
    return;
  }
  const fullAssetPath = folder ? `${folder}/${filename}` : filename;
  const dataUrl = pendingImageDataUrl;
  void work(async () => {
    await rpc("save-asset", { path: fullAssetPath, data: dataUrl });
    element<HTMLDialogElement>("image-save-dialog").close();
    pendingImageDataUrl = null;
    const relPath = computeRelativeMarkdownPath(documentState!.page, fullAssetPath, workspace?.config.docs || "docs");
    const markdownCode = `![${alt}](${relPath})`;
    const start = pendingImageSelection?.start ?? editor.selectionStart;
    const end = pendingImageSelection?.end ?? editor.selectionEnd;
    pendingImageSelection = null;
    rememberCurrentSelection(start, end);
    editor.setRangeText(markdownCode, start, end, "end");
    dirty = true;
    updateSaveState();
    editor.dispatchEvent(new Event("input"));
    editor.focus();
    status(`画像を ${fullAssetPath} に保存し、原稿に挿入しました。`);
  });
});
let lastPastedTimestamp = "";
let pasteCounter = 0;
let isPastingImage = false;
let lastImagePasteTime = 0;

async function saveAndInsertImage(dataUrl: string, defaultFileType = "image/png"): Promise<void> {
  document.body.setAttribute("aria-busy", "true");
  try {
    if (!documentState) {
      status("先にMarkdown原稿を開いてください。", true);
      return;
    }
    let fileType = defaultFileType;
    if (dataUrl.startsWith("data:")) {
      const mime = dataUrl.slice(5, dataUrl.indexOf(";"));
      if (mime) fileType = mime;
    }
    const rawExt = fileType.split("/")[1]?.replace(/[^a-zA-Z0-9]/g, "") || "png";
    const ext = rawExt.toLowerCase() === "jpeg" ? "jpg" : rawExt.toLowerCase();
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    let filename = `image-${stamp}.${ext}`;
    if (stamp === lastPastedTimestamp) {
      pasteCounter++;
      filename = `image-${stamp}-${pasteCounter}.${ext}`;
    } else {
      lastPastedTimestamp = stamp;
      pasteCounter = 0;
    }
    const folder = (workspace?.config.assets || `${workspace?.config.docs || "docs"}/assets`).trim().replace(/\/+$/, "");
    const fullAssetPath = folder ? `${folder}/${filename}` : filename;

    await rpc("save-asset", { path: fullAssetPath, data: dataUrl });
    const relPath = computeRelativeMarkdownPath(documentState.page, fullAssetPath, workspace?.config.docs || "docs");
    const alt = filename.replace(/\.[^.]+$/, "");
    const markdownCode = `![${alt}](${relPath})`;
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    rememberCurrentSelection(start, end);
    editor.setRangeText(markdownCode, start, end, "end");
    dirty = true;
    updateSaveState();
    editor.dispatchEvent(new Event("input"));
    editor.focus();
    status(`画像を ${fullAssetPath} に保存し、貼り付けました。`);
  } catch (error) {
    status(String(error), true);
  } finally {
    document.body.setAttribute("aria-busy", "false");
  }
}

function handleImagePaste(clipboardData: DataTransfer | null): boolean {
  if (!documentState || !clipboardData) return false;
  const items = clipboardData.items;
  const files = clipboardData.files;
  let targetFile: File | null = null;
  let fileType = "";

  if (items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) {
          targetFile = f;
          fileType = item.type;
          break;
        }
      }
    }
  }

  if (!targetFile && files && files.length > 0) {
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (f.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg)$/i.test(f.name)) {
        targetFile = f;
        fileType = f.type || `image/${f.name.split(".").pop()?.toLowerCase() || "png"}`;
        break;
      }
    }
  }

  if (!targetFile) return false;

  document.body.setAttribute("aria-busy", "true");
  const reader = new FileReader();
  reader.onload = () => {
    if (typeof reader.result === "string") {
      void saveAndInsertImage(reader.result, fileType || targetFile!.type);
    } else {
      document.body.setAttribute("aria-busy", "false");
    }
  };
  reader.onerror = () => {
    document.body.setAttribute("aria-busy", "false");
  };
  reader.readAsDataURL(targetFile);
  return true;
}

async function readBrowserClipboardImage(): Promise<string | null> {
  if (typeof navigator?.clipboard?.read !== "function") return null;
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      for (const type of item.types) {
        if (type.startsWith("image/")) {
          const blob = await item.getType(type);
          return new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.readAsDataURL(blob);
          });
        }
      }
    }
  } catch {
    // Permission denied or not supported in this browser context
  }
  return null;
}

interface PastedImageResult {
  filePath: string;
  filename: string;
  alt: string;
}

async function tryNativeImagePaste(): Promise<boolean> {
  if (isPastingImage || Date.now() - lastImagePasteTime < 600) return false;
  if (!documentState) {
    status("先にMarkdown原稿を開いてください。", true);
    return false;
  }

  isPastingImage = true;
  try {
    if (native) {
      const folder = (workspace?.config.assets || `${workspace?.config.docs || "docs"}/assets`).trim().replace(/\/+$/, "");
      const result = await invoke<PastedImageResult | null>("paste_clipboard_image", {
        root: projectRoot,
        page: documentState.page,
        assetsFolder: folder,
      });
      if (!result) return false;
      lastImagePasteTime = Date.now();
      const relPath = computeRelativeMarkdownPath(documentState.page, result.filePath, workspace?.config.docs || "docs");
      const markdownCode = `![${result.alt}](${relPath})`;
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      rememberCurrentSelection(start, end);
      editor.setRangeText(markdownCode, start, end, "end");
      dirty = true;
      updateSaveState();
      editor.dispatchEvent(new Event("input"));
      editor.focus();
      status(`画像を ${result.filePath} に保存し、貼り付けました。`);
      return true;
    } else {
      const dataUrl = await readBrowserClipboardImage();
      if (!dataUrl) return false;
      lastImagePasteTime = Date.now();
      await saveAndInsertImage(dataUrl);
      return true;
    }
  } catch (error) {
    console.error("Failed to read image from clipboard:", error);
    return false;
  } finally {
    isPastingImage = false;
  }
}

editor.addEventListener("paste", (event: ClipboardEvent) => {
  if (handleImagePaste(event.clipboardData)) {
    event.preventDefault();
    lastImagePasteTime = Date.now();
    return;
  }
  if (native) {
    void tryNativeImagePaste();
  }
});

document.addEventListener("paste", (event: ClipboardEvent) => {
  if (event.target instanceof Node && milkdown.host.contains(event.target)) return;
  if (event.defaultPrevented) return;
  const active = document.activeElement;
  if (active && active !== editor && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
    return;
  }
  if (!element("panel-editor").hidden) {
    if (!documentState) {
      status("先にMarkdown原稿を開いてください。", true);
      return;
    }
    if (handleImagePaste(event.clipboardData)) {
      event.preventDefault();
      lastImagePasteTime = Date.now();
      return;
    }
    if (native) {
      void tryNativeImagePaste();
    }
  }
});

window.addEventListener("keydown", (event: KeyboardEvent) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
    const active = document.activeElement;
    if (active && milkdown.host.contains(active)) return;
    if (active && active !== editor && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
      return;
    }
    if (!element("panel-editor").hidden) {
      if (!documentState) {
        status("先にMarkdown原稿を開いてください。", true);
        return;
      }
      if (native) {
        void tryNativeImagePaste();
      }
    }
  }
});
const editorColumn = document.querySelector<HTMLElement>(".editor-column");
if (editorColumn) {
  ["dragenter", "dragover"].forEach((type) => {
    editorColumn.addEventListener(type, (event) => {
      if (event.target instanceof Node && milkdown.host.contains(event.target)) return;
      event.preventDefault();
      if (documentState) {
        editorColumn.classList.add("drag-over");
      }
    });
  });
  ["dragleave", "dragend"].forEach((type) => {
    editorColumn.addEventListener(type, (event) => {
      if (event.target instanceof Node && milkdown.host.contains(event.target)) return;
      event.preventDefault();
      editorColumn.classList.remove("drag-over");
    });
  });
  editorColumn.addEventListener("drop", (event) => {
    if (event.target instanceof Node && milkdown.host.contains(event.target)) return;
    event.preventDefault();
    editorColumn.classList.remove("drag-over");
    if (!documentState) {
      status("先にMarkdown原稿を開いてください。", true);
      return;
    }
    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.type.startsWith("image/") || /\.(png|jpe?g|gif|svg|webp)$/i.test(file.name)) {
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === "string") {
            const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
            const alt = cleanName.replace(/\.[^.]+$/, "");
            openImageSaveDialog(reader.result, cleanName, alt);
          }
        };
        reader.readAsDataURL(file);
        break;
      }
    }
  });
}
element("refresh-tasks").addEventListener("click", () => { void work(async () => { savedBeforeOperation(); await refreshWorkspace(true); status("画像・文章・図の一覧を更新しました。"); }); });
element("generate-all-pages").addEventListener("click", () => { void work(generateAllDocuments); });
element("task-list").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
  const card = button?.closest<HTMLElement>("[data-task]");
  if (!button || !card) return;
  const id = card.dataset.task!;
  void work(async () => {
    const task = workspace!.tasks.find((item) => item.id === id)!;
    if (button.dataset.savePrompt) {
      const prompt = taskControl<HTMLTextAreaElement>(card, "data-prompt").value;
      await editTaskPage(task, (content) => updateTaskPrompt(content, task, prompt));
      return;
    }
    if (button.dataset.toggleApproved) {
      await editTaskPage(task, (content) => toggleTaskApproval(content, task));
      return;
    }
    if (button.dataset.editPage) { await openPage(button.dataset.editPage); return; }
    if (button.dataset.sourceConfig || button.dataset.windowList) {
      card.querySelector<HTMLDetailsElement>("details")!.open = true;
      const windows = JSON.parse(await rpc("list-windows")) as NativeWindow[];
      const select = taskControl<HTMLSelectElement>(card, "data-window-select");
      select.innerHTML = '<option value="">撮影するウィンドウを選ぶ</option>' + windows.map((item) => `<option value="${escape(item.id)}">${escape(item.title)}（${item.width}×${item.height}）</option>`).join("");
      const source = workspace!.capture_sources[id];
      const matches = source?.kind === "window" ? windows.filter((item) => item.title === source.title) : [];
      if (matches.length === 1) select.value = matches[0].id;
      return;
    }
  if (button.dataset.recapture) { await hideManualStudioForCapture(); try { await runAction("recapture", { id }); } finally { await restoreManualStudioAfterCapture(); } return; }
    if (button.dataset.capture) {
      const windowId = taskControl<HTMLSelectElement>(card, "data-window-select").value;
      if (!windowId) throw new Error("一覧から撮影するウィンドウを選んでください。");
      await hideManualStudioForCapture();
      try { await runAction("capture-window", { id, window: windowId, inset: taskControl<HTMLInputElement>(card, "data-inset").value }); }
      finally { await restoreManualStudioAfterCapture(); }
      return;
    }
    if (button.dataset.generate) {
      const page = workspace!.project_entries.some(entry => entry.path === task.page) ? task.page : `${workspace!.config.docs}/${task.page}`;
      await generateReviewed(page, id);
      return;
    }
    if (button.dataset.registerImage) {
      if (!native) throw new Error("PNGのファイル選択はデスクトップアプリで利用できます。");
      const image = await invoke<string | null>("choose_image");
      if (image) await runAction("record-screenshot", { id, image });
    }
  });
});
function actionButton(id: string, action: string, options: () => Record<string, unknown> = () => ({}), result?: string): void {
  element(id).addEventListener("click", () => { void work(() => runAction(action, options(), result)); });
}
actionButton("map-refresh", "ui-map", () => ({ refresh: true }));
actionButton("explore-web", "ui-explore", () => ({ url: input("explore-url").value.trim(), max_pages: "10" }));
actionButton("import-map", "ui-map-import", () => ({ input: input("observation-path").value.trim() }));
element("save-settings").addEventListener("click", () => { void work(async () => {
  await saveAiSettings();
  await runAction("save", {
    brief: element<HTMLTextAreaElement>("manual-brief").value,
    mkdocs_settings: workspace!.config.mkdocs,
  });
}); });
element("ai-connection-type").addEventListener("change", updateAiSettingsVisibility);
element("ai-agent").addEventListener("change", () => {
  input("ai-model").value = "";
  scheduleAiSave();
});
element("ai-connection-type").addEventListener("change", scheduleAiSave);
for (const id of ["ai-model", "ai-endpoint-url", "ai-api-key"]) {
  element(id).addEventListener("input", scheduleAiSave);
  element(id).addEventListener("change", scheduleAiSave);
}
element("ai-save-retry").addEventListener("click", () => { void saveAiSettings().catch(() => {}); });
themePicker.addEventListener("change", () => {
  if (!isThemeId(themePicker.value)) return;
  applyTheme(themePicker.value);
  if (native) void emit("manual-studio-theme-changed", themePicker.value);
});
element("add-launch-command").addEventListener("click", () => {
  launchCommands.push({ name: "", program: "", args: [] }); renderLaunchCommands();
  document.querySelector<HTMLInputElement>(`[data-launch-name="${launchCommands.length - 1}"]`)?.focus();
});
element("save-launch-commands").addEventListener("click", () => { void work(async () => {
  launchCommands = launchCommands.map((_command, index) => ({
    name: document.querySelector<HTMLInputElement>(`[data-launch-name="${index}"]`)!.value.trim(),
    program: document.querySelector<HTMLInputElement>(`[data-launch-program="${index}"]`)!.value.trim(),
    args: document.querySelector<HTMLTextAreaElement>(`[data-launch-args="${index}"]`)!.value.split("\n").map((value) => value.trim()).filter(Boolean),
  }));
  await invoke<void>("save_launch_commands", { commands: launchCommands });
  renderLaunchCommands(); refreshLaunchCommandOptions(); status("共通起動コマンドを保存しました。");
}); });
element("generate-draft").addEventListener("click", () => { void work(async () => {
  savedBeforeOperation();
  if (workspace?.pages.length && !window.confirm("現在の原稿をバックアップして、AIの下書きに置き換えますか？")) return;
  await runAction("draft", {}, "publish-result");
}); });
actionButton("build-draft", "build", () => ({ draft: true }), "publish-result");
actionButton("build-final", "build", () => ({}), "publish-result");
actionButton("impact-plan", "impact-plan", () => ({ git_ref: input("git-ref").value.trim() || "HEAD" }), "publish-result");
actionButton("fact-check", "fact-check", () => ({ check: true }), "publish-result");
element("open-output").addEventListener("click", () => { void work(async () => {
  if (native) await invoke("open_output", { root: projectRoot });
  else status(`出力フォルダー: ${projectRoot}/${workspace?.config.output || "manual"}`);
}); });
setBusy(false);
if (native && !recordingControlMode) {
  void listen("manual-studio-screenshot-requested", () => {
    if (!captureSessions.active) return;
    operationRecording = false;
    externalFinishActive = true;
    recordingPollGeneration++;
    if (recordingPoll) clearTimeout(recordingPoll);
    recordingPoll = undefined;
    setButtonDisabled(element<HTMLButtonElement>("start-operation-recording"), true);
    setButtonDisabled(element<HTMLButtonElement>("stop-operation-recording"), true);
    element("operation-recording-status").textContent = "指定ウィンドウを撮影しています…";
    updateCaptureBusyState();
  });
  void listen<RecordingResult>("manual-studio-screenshot-finished", (event) => { void acceptRecordingResult(event.payload); });
  void listen<string>("manual-studio-screenshot-failed", (event) => {
    externalFinishActive = false;
    resetRecordingControls(); updateCaptureBusyState(); status(event.payload, true); element("operation-recording-status").textContent = event.payload;
  });
}
if (recordingControlMode) {
  document.body.classList.add("recording-control-mode");
  const control = document.createElement("main");
  control.id = "recording-control";
  control.innerHTML = '<span data-tauri-drag-region title="ここをドラッグして移動">対象アプリの操作が終わったら　⠿</span><button type="button">スクリーンショットを実行</button><small>撮影後、MarkItsの編集画面が開きます</small>';
  control.querySelector("span")!.addEventListener("mousedown", (event) => {
    if (event.button === 0) void getCurrentWindow().startDragging().catch((error) => status(`撮影ウィンドウを移動できません: ${String(error)}`, true));
  });
  control.querySelector("button")!.addEventListener("click", async () => {
    const button = control.querySelector("button")!;
    button.disabled = true; button.textContent = "撮影してMarkItsを起動中…";
    try {
      await emitTo("main", "manual-studio-screenshot-requested");
      await invoke("hide_recording_control");
      await invoke("hide_manual_studio");
      await new Promise((resolve) => setTimeout(resolve, 350));
      const result = await invoke<RecordingResult>("finish_operation_recording");
      await emitTo("main", "manual-studio-screenshot-finished", result);
      await getCurrentWindow().close();
    } catch (error) {
      await invoke("show_recording_control_again").catch(() => {});
      const message = `撮影に失敗しました: ${String(error)}`;
      const notice = document.createElement("span");
      notice.className = "recording-control-error";
      notice.textContent = "撮影に失敗しました。Munin Manual Studioに戻って詳細を確認してください。";
      notice.title = message;
      const returnButton = document.createElement("button");
      returnButton.type = "button";
      returnButton.className = "recording-control-return";
      returnButton.textContent = "閉じてMunin Manual Studioに戻る";
      returnButton.addEventListener("click", () => { void invoke("return_to_manual_studio"); });
      control.replaceChildren(notice, returnButton);
      await emitTo("main", "manual-studio-screenshot-failed", message).catch(() => {});
    }
  });
  document.body.append(control);
  if (native) {
    void (async () => {
      await document.fonts.ready;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const width = Math.min(310, window.innerWidth);
      const height = Math.ceil(control.getBoundingClientRect().height);
      await getCurrentWindow().setSize(new LogicalSize(width, height));
    })().catch((error) => status(`撮影ウィンドウのサイズを調整できません: ${String(error)}`, true));
  }
}
if (!recordingControlMode) {
  void loadLaunchCommands().catch((error) => status(`共通起動コマンドを読み込めません: ${String(error)}`, true));
  const initialRoot = params.get("root") || localStorage.getItem("manual-studio-project");
  if (initialRoot) void work(() => openProject(initialRoot));
}
