import { setupScreenshotLibrary } from "./screenshotLibrary";
import { showPartialFailure, showExecutionHistory, showCaptureExpectations, type ExecutionRun, type ExecutionLimits } from './executionHistory';
import { selectGenerationPages, taskStatusLabels, taskKindLabels } from './taskPresentation';
import { uiIcon } from './uiIcons';
import { showImageComparison } from './imageComparison';
import { showShortcutHelp } from './shortcutHelp';
import { setAiPhase, renderExecutionResult, type AiPhase } from './workflowPresentation';
import { readAiCredential, saveAiCredential, hasUnassignedAiCredential, assignLegacyAiCredential } from "./aiCredentials";
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
import { showGenerationInput, type GenerationInput } from "./generationInput";
import { showGenerationHistory, type GenerationHistorySummary, type GenerationHistoryEntry } from "./generationHistory";
import { aiErrorAdvice } from "./aiErrors";
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
const terminalFontSizeInput = element<HTMLInputElement>("terminal-font-size");
if (terminalFontSizeInput) {
  const savedSize = localStorage.getItem("manual-studio-terminal-font-size") || "13";
  terminalFontSizeInput.value = savedSize;
  terminalFontSizeInput.addEventListener("input", () => {
    const size = Number(terminalFontSizeInput.value);
    if (Number.isFinite(size) && size >= 11 && size <= 24) {
      localStorage.setItem("manual-studio-terminal-font-size", String(size));
      window.dispatchEvent(new CustomEvent("manual-studio-terminal-font-change"));
    }
  });
}
const terminalFontFamilySelect = element<HTMLSelectElement>("terminal-font-family");
if (terminalFontFamilySelect) {
  const savedFamily = localStorage.getItem("manual-studio-terminal-font-family") || "jetbrains";
  terminalFontFamilySelect.value = savedFamily;
  terminalFontFamilySelect.addEventListener("change", () => {
    localStorage.setItem("manual-studio-terminal-font-family", terminalFontFamilySelect.value);
    window.dispatchEvent(new CustomEvent("manual-studio-terminal-font-change"));
  });
}
let projectRoot = "";
let workspace: State | null = null;
let documentState: Document | null = null;
let dirty = false;
let documentSaveState: { owner: Document; state: 'saving' | 'error'; message?: string } | null = null;
const lastExecutions = new Map<string, ExecutionRun>();
const aiPhases = new Map<string, AiPhase>();
let busy = false;
let previewVersion = 0;
let previewRequestPending = false;
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
  openPage: (page) => work(() => openPage(page)),
  refreshPreview: () => work(() => renderPreview()),
  onError: (error) => status(`プレビュー: ${String(error)}`, true),
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
  const advice = error ? aiErrorAdvice(message) : null;
  const panel = document.getElementById("ai-error-advice");
  if (advice && panel) {
    panel.hidden = false; panel.textContent = `${advice.title}。${advice.action}`;
    element("operation-progress").hidden = false;
  }
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
async function hideManualStudioForCapture(taskId?: string): Promise<void> {
  const source = taskId ? workspace?.capture_sources[taskId] : undefined;
  // Scenario capture raises its own target; it may intentionally capture this app.
  if (source?.kind === "scenario" || (source?.kind === "window" && /manual\s*studio/i.test(source.title))) return;
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
  const operation = action === "draft" ? "原稿の下書きを生成中" : action === "generate-page" ? "文書のAI更新と撮影を実行中" : "AI文章・図を生成中";
  element("progress-label").textContent = `${labels[agent] || agent}で${operation}`;
  progressRunning = true;
  element("ai-error-advice").hidden = true;
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
let activeGenerationRoot: string | null = null;
let generationCancelled = false;
let generationCancelRequest: Promise<void> | undefined;
element("progress-cancel").addEventListener("click", () => {
  if (!activeGenerationRoot) return;
  generationCancelled = true;
  const root = activeGenerationRoot;
  element<HTMLButtonElement>("progress-cancel").disabled = true;
  logProgress("中断を要求しました。実行中の処理を停止します。");
  generationCancelRequest = rpc("agent-cancel", {}, root).then(() => {}).catch((error) => logProgress(`中断要求の送信に失敗しました: ${String(error)}`));
});
async function stopAiProgress(succeeded: boolean): Promise<void> {
  await generationCancelRequest;
  generationCancelRequest = undefined;
  await pollAgentProgress();
  if (progressTimer) clearInterval(progressTimer);
  if (progressPollTimer) clearInterval(progressPollTimer);
  progressTimer = undefined;
  progressPollTimer = undefined;
  progressRunning = false;
  activeGenerationRoot = null;
  element("progress-cancel").hidden = true;
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
  const aiActions = new Set(["generate-review", "generate-task", "generate-page", "generate", "draft", "generate-page-captures", "capture-source-auto", "fact-check", "scenario-save"]);
  if (aiActions.has(action) && mergedOptions.api_key === undefined) {
    mergedOptions.api_key = root === projectRoot ? readAiCredential(root, workspace?.config.endpoint_url || "") : "";
  }
  return sendManualRequest({ root, action, options: mergedOptions }, native
    ? (request) => invoke<string>("manual_request", { request })
    : undefined);
}

let terminalController: TerminalController | null = null;

function getTerminalCliCommand(): { command: string; args: string[]; label: string } {
  const agent = workspace?.config.agent || "claude";
  const model = workspace?.config.model?.trim();
  const labels: Record<string, string> = {
    codex: "Codex",
    claude: "Claude Code",
    grok: "Grok Build",
    agy: "Agy",
  };
  const args: string[] = [];
  if (model) {
    args.push("--model", model);
  }
  if (agent === "agy") {
    args.push("--effort", "low", "--dangerously-skip-permissions");
  } else if (agent === "claude") {
    args.push("--dangerously-skip-permissions");
  }
  return {
    command: agent,
    args,
    label: labels[agent] || agent,
  };
}

const terminalPanel = element<HTMLElement>("panel-terminal");
function openManualTerminal(): void {
  if (!terminalPanel || terminalController) return;
  terminalController = setupTerminalPane(terminalPanel, {
    rpc,
    getProjectRoot: () => projectRoot,
    getCliCommand: getTerminalCliCommand,
    onStatusChange: (state, message) => { if (state === "error" && message) status(message, true); },
    onUnload: (ownerId, root) => {
      const request = { root, action: "pty-close-owner", options: { ownerId } };
      if (native) void invoke("manual_request", { request }).catch(() => {});
      else void fetch("/__manual/rpc", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request), keepalive: true,
      }).catch(() => {});
    },
  });
}
window.addEventListener("manual-studio-terminal-open", openManualTerminal);

let terminalInstructionContext: { root: string; page: string; tasks: Task[] } | null = null;
element("terminal-use-selection-btn").addEventListener("click", () => {
  void work(async () => {
    if (!documentState) throw new Error("先に原稿を開いてください。");
    const root = projectRoot;
    const page = documentState.page;
    const selection = terminalController?.getSelection() || "";
    const tasks = (JSON.parse(await rpc("page-tasks", { page }, root)) as Task[])
      .filter(task => task.kind !== "screenshot" && task.status !== "approved");
    if (root !== projectRoot || page !== documentState?.page) return;
    if (!tasks.length) throw new Error("現在の原稿に生成済みの文章・図のAIタグがありません。AIタグを追加した場合は先に保存してください。");
    terminalInstructionContext = { root, page, tasks };
    const select = element<HTMLSelectElement>("terminal-instruction-task");
    select.replaceChildren(...tasks.map(task => new Option(task.id, task.id)));
    element<HTMLTextAreaElement>("terminal-instruction-text").value = selection;
    element<HTMLDialogElement>("terminal-instruction-dialog").showModal();
  });
});
element("terminal-instruction-cancel").addEventListener("click", () => {
  element<HTMLDialogElement>("terminal-instruction-dialog").close();
});
element("terminal-instruction-apply").addEventListener("click", () => {
  try {
    const text = element<HTMLTextAreaElement>("terminal-instruction-text").value.trim();
    if (!text) throw new Error("追加する指示を入力してください。");
    const id = element<HTMLSelectElement>("terminal-instruction-task").value;
    if (terminalInstructionContext?.root !== projectRoot || terminalInstructionContext?.page !== documentState?.page) {
      throw new Error("原稿が切り替わりました。相談結果の追加をやり直してください。");
    }
    const task = terminalInstructionContext?.tasks.find(task => task.id === id);
    if (!task) throw new Error("追加先のAIタグを確認してください。");
    // Read the current editor prompt so an unsaved edit is preserved.
    const block = [...editor.value.matchAll(taskBlockPattern)].find(match => tagAttribute(match.groups?.attrs || "", "id") === id);
    const encoded = block ? tagAttribute(block.groups?.attrs || "", "prompt") : null;
    const decoder = document.createElement("textarea");
    // Escape markup before decoding character references in the attribute.
    decoder.innerHTML = (encoded ?? "").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const legacy = [...editor.value.matchAll(/<!--\s*ai:task(?<attrs>[^\r\n>]*)\r?\n(?<prompt>.*?)\r?\n-->/gs)]
      .find(match => tagAttribute(match.groups?.attrs || "", "id") === id);
    const prompt = encoded !== null ? decoder.value : legacy?.groups?.prompt ?? task.prompt;
    editor.value = updateTaskPrompt(editor.value, task, `${prompt}\n\n${text}`);
    editor.dispatchEvent(new Event("input"));
    element<HTMLDialogElement>("terminal-instruction-dialog").close();
    chooseTab("editor");
    status(`${id}の生成指示へ追加しました。内容を確認して原稿を保存してください。`);
  } catch (error) { status(String(error), true); }
});

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
  updateCaptureSteps();
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
  finally { setBusy(captureNeedsUiLock()); previewNavigator.updateToolbarState(); }
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
  if (name === "uimap" || name === "publish" || name === "appearance" || name === "settings" || name === "applications") {
    document.querySelectorAll<HTMLElement>("[data-tab]").forEach((button) => { button.classList.toggle("active", button.dataset.tab === name); });
    element<HTMLDetailsElement>("settings-menu").open = false;
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
  const ownerState = documentSaveState?.owner === documentState ? documentSaveState : null;
  const badge = element("save-state");
  badge.dataset.state = !documentState ? 'empty' : ownerState?.state || (dirty ? 'dirty' : 'saved');
  const conflicted = ownerState?.state === 'error' && /変更されています|conflict|revision/i.test(ownerState.message || '');
  badge.textContent = !documentState ? '原稿を選択してください' : ownerState?.state === 'saving' ? '保存中…' : conflicted ? '外部変更と競合：編集内容を保持' : ownerState?.state === 'error' ? '保存できませんでした' : dirty ? '● 未保存の変更' : '保存済み';
  badge.title = ownerState?.message || (dirty ? '保存してからAI更新・出力を実行してください。' : '原稿の保存状態');
  badge.setAttribute('role', 'status'); badge.setAttribute('aria-live', 'polite');
  renderLastExecution();
  updateWorkspaceGuide();
}
function updateWorkspaceGuide(): void {
  const guide = element<HTMLElement>('workspace-guide');
  let dismissed = false;
  try { dismissed = localStorage.getItem(`manual-studio-guide:${projectRoot}`) === 'hidden'; } catch { /* Optional preference. */ }
  guide.hidden = detached || !workspace || dismissed || workspace.config.connection_type !== 'none' && workspace.has_config;
}
function showAiPhase(phase: AiPhase, root = projectRoot, page = documentState?.page || ''): void {
  aiPhases.set(JSON.stringify([root, page]), phase);
  if (root === projectRoot && page === documentState?.page) setAiPhase(element('ai-workflow-status'), phase);
}
function renderLastExecution(): void {
  const key = JSON.stringify([projectRoot, documentState?.page]);
  const run = documentState ? lastExecutions.get(key) : undefined;
  setAiPhase(element('ai-workflow-status'), aiPhases.get(key) || 'idle');
  renderExecutionResult(element('execution-result'), run, {
    resume: id => { void work(async () => {
      savedBeforeOperation();
      const root = projectRoot;
      const plan = JSON.parse(await rpc('execution-resume', { id }, root)) as {page:string;ids:string[];limits:ExecutionLimits};
      if (root !== projectRoot) return;
      await openPage(plan.page, false); await generateDocument(plan.page, plan.ids, plan.limits);
    }); },
    history: () => element<HTMLButtonElement>('execution-history-open').click(),
  });
}
async function renderPreview(): Promise<void> {
  if (!documentState) return;
  const version = ++previewVersion;
  previewRequestPending = true;
  previewNavigator.setStatus('loading');
  try {
    const html = await rpc("editor-preview", { page: documentState.page, body: editor.value });
    if (version === previewVersion) {
      previewRequestPending = false;
      element<HTMLIFrameElement>("markdown-preview").srcdoc = html;
      previewNavigator.updateToolbarState();
    }
  } catch (error) { if (version === previewVersion) { previewRequestPending = false; previewNavigator.setStatus('error', String(error)); status(`プレビュー: ${String(error)}`, true); } }
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
  editor.dataset.owner = JSON.stringify([root, page]);
  editor.value = opened.content;
  resetEditHistory();
  if (previousPage !== page) editor.scrollTop = 0;
  editor.disabled = false;
  dirty = false;
  element("editor-title").textContent = page;
  editor.dataset.owner = JSON.stringify([projectRoot, page]);
  document.title = `${page} — Munin Manual Studio`;
  updateSaveState(); updateCursor(); renderPages(); renderDocumentTags();
  element("page-list").querySelector("[aria-current=page]")?.scrollIntoView({ block: "nearest" });
  await renderPreview();
  previewNavigator.pushPage(page);
  chooseTab("editor");
  const previousExecution = lastExecutions.get(JSON.stringify([root,page]));
  void rpc('execution-history', { page }, root).then(output => {
    if (root !== projectRoot || version !== documentRequestVersion || documentState?.page !== page) return;
    if (lastExecutions.get(JSON.stringify([root,page])) !== previousExecution) return;
    const history = JSON.parse(output) as {runs?:ExecutionRun[]};
    const latest = history.runs?.[0];
    if (!latest || !Array.isArray(latest.entries)) return;
    const key = JSON.stringify([root, page]);
    lastExecutions.set(key, latest);
    if (!['generating','review','capturing','restored'].includes(aiPhases.get(key) || '')) aiPhases.set(key, latest.status === 'rolled_back' ? 'restored' : latest.status === 'completed' ? 'completed' : 'partial');
    renderLastExecution();
  }).catch(() => { /* Opening a document remains available if history cannot be read. */ });
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
    { query: input("tree-search").value, markdownOnly: element<HTMLSelectElement>("tree-filter").value === "markdown" },
  );
}
const screenshotLibrary = setupScreenshotLibrary({
  root: () => projectRoot, request: rpc, work, applications: () => launchCommands,
  page: () => documentState?.page,
  insert: (markdown) => { const start = editor.selectionStart; editor.value = editor.value.slice(0, start) + "\n\n" + markdown + "\n\n" + editor.value.slice(editor.selectionEnd); dirty = true; updateSaveState(); void renderPreview(); },
});
async function refreshWorkspace(reloadPage = false): Promise<void> {
  const root = projectRoot;
  const current = documentState;
  const content = editor.value;
  const documentVersion = documentRequestVersion;
  const version = ++workspaceRequestVersion;
  const loaded = JSON.parse(await rpc("state", {}, root)) as State;
  loaded.tasks = loaded.tasks.filter(task => task.kind !== "screenshot");
  if (root !== projectRoot || version !== workspaceRequestVersion) return;
  workspace = loaded;
  renderPages(); renderTasks(); renderMap(); updateWorkspaceGuide();
  await screenshotLibrary.refresh();
  element("task-count").textContent = String(workspace.tasks.length);
  if (reloadPage && current) {
    if (documentState !== current || documentVersion !== documentRequestVersion || editor.value !== content) return;
    const opened = JSON.parse(await rpc("editor-read", { page: current.page }, root)) as Document;
    if (root !== projectRoot || documentState !== current || documentVersion !== documentRequestVersion || editor.value !== content) return;
    documentState = opened; editor.value = opened.content; resetEditHistory(); dirty = false; updateSaveState(); renderDocumentTags(); await Promise.all([renderPreview(), milkdown.refreshImages()]);
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
        status: isGenerated ? (approved ? "確定済み" : "生成済み") : existing?.status || "未生成",
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
  input("ai-api-key").value = readAiCredential(projectRoot, workspace.config.endpoint_url || "");
  element("ai-key-migrate").hidden = !hasUnassignedAiCredential();
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
  saveAiCredential(root, options.endpoint_url, input("ai-api-key").value);
  aiSavePending = false;
  const operation = aiSaveQueue.catch(() => {}).then(async () => {
    if (projectRoot === root && aiEditVersion === version) setAiSaveState("保存中…");
    try {
      // AI-only options preserve other settings and unfinished form edits.
      const saved = JSON.parse(await rpc("save", options, root)) as State;
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
    chooseTab("settings");
    throw new Error("AI接続は未設定です。接続方式を選択してから実行してください。");
  }

  if (connectionType === "cli") {
    const selected = workspace.agents.find((agent) => agent.id === agentId && agent.available);
    if (!selected) {
      chooseTab("settings");
      throw new Error("利用できるAIのCLIがありません。CLIをインストールするか、ローカルLLM/API接続を選んでください。");
    }
  } else if (connectionType === "api") {
    if (!endpointUrl && !input("ai-endpoint-url").placeholder) {
      chooseTab("settings");
      throw new Error("API接続のエンドポイントURLを入力してください（例: https://api.openai.com/v1）。");
    }
  }

  const currentConnectionType = workspace.config.connection_type || "cli";
  const currentEndpointUrl = workspace.config.endpoint_url || "";
  const agentChanged = !workspace.has_config ||
    workspace.config.agent !== agentId ||
    workspace.config.model !== model;
  if (
    agentChanged ||
    currentConnectionType !== connectionType ||
    currentEndpointUrl !== endpointUrl
  ) {
    await rpc("save", {
      agent: agentId, model, connection_type: connectionType,
      endpoint_url: endpointUrl, mkdocs_settings: workspace.config.mkdocs,
    });
    await refreshWorkspace();
    renderSettings();
    if (agentChanged && terminalController) {
      await terminalController.kill();
    }
  }
}
async function openProject(root: string, check = true): Promise<void> {
  assertNoActiveCaptureSession();
  if (check && !await confirmDiscard()) return;
  await saveAiSettings();
  status("プロジェクトを開いています…");
  const version = ++projectRequestVersion;
  const loaded = JSON.parse(await rpc("state", {}, root)) as State;
  loaded.tasks = loaded.tasks.filter(task => task.kind !== "screenshot");
  if (version !== projectRequestVersion) return;
  ++documentRequestVersion; ++workspaceRequestVersion;
  if (projectRoot !== root) expandedFolders.clear();
  if (terminalController && projectRoot !== root) await terminalController.kill();
  projectRoot = root; workspace = loaded; documentState = null; dirty = false;
  documentSaveState = null;
  setAiPhase(element('ai-workflow-status'), 'idle');
  previewNavigator.setStatus('empty');
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
  if (!loaded.has_config && !detached) status("原稿の編集・保存・プレビューから始められます。AI接続は「設定 → AI・撮影設定」で確認できます。");

}
async function saveDocument(refresh = true): Promise<void> {
  if (!documentState) throw new Error("保存する原稿を選択してください。");
  const current = documentState;
  const root = projectRoot;
  const page = current.page;
  const content = editor.value;
  const version = documentRequestVersion;
  documentSaveState = { owner: current, state: 'saving' }; updateSaveState();
  let saved: Document;
  try {
    saved = JSON.parse(await rpc("editor-save", { page, json: { content, revision: current.revision } }, root)) as Document;
  } catch (error) {
    if (root === projectRoot && current === documentState && version === documentRequestVersion) {
      documentSaveState = { owner: current, state: 'error', message: String(error) }; updateSaveState();
    }
    throw error;
  }
  if (root !== projectRoot || current !== documentState || version !== documentRequestVersion) return;
  documentSaveState = null;
  if (editor.value === content && saved.content !== content) editor.value = saved.content;
  documentState = saved; dirty = editor.value !== saved.content; updateSaveState();
  if (refresh) await refreshWorkspace();
  status(`${page}を保存しました。`);
}
const taskFailures = new Map<string, string>();
function taskFailureKey(task: Pick<Task, "page" | "id">, root = projectRoot): string {
  const docs = workspace?.config.docs.replace(/^[.\\/]+|[\\/]+$/g, "") || "docs";
  const page = task.page.startsWith(`${docs}/`) ? task.page.slice(docs.length + 1) : task.page;
  return JSON.stringify([root, page, task.id]);
}
function taskDisplayStatus(task: Task): string {
  return task.status !== "approved" && (taskFailures.has(taskFailureKey(task)) || workspace?.execution_results?.[task.id]?.status === "failed") ? "failed" : task.status;
}
function recordTaskResult(task: Pick<Task, "page" | "id">, error?: string, root = projectRoot): void {
  const key = taskFailureKey(task, root);
  if (error) taskFailures.set(key, error); else taskFailures.delete(key);
}
function renderTasks(): void {
  if (!workspace) return;
  const kindLabel = taskKindLabels;
  const statusLabel = taskStatusLabels;
  const statusFilter = element<HTMLSelectElement>("task-status-filter").value;
  const kindFilter = element<HTMLSelectElement>("task-kind-filter").value;
  const visibleTasks = workspace.tasks.filter(task => (statusFilter === "all" || taskDisplayStatus(task) === statusFilter)
    && (kindFilter === "all" || task.kind === kindFilter));
  element("task-filter-summary").textContent = `${visibleTasks.length}件 / 全${workspace.tasks.length}件`;

  element("task-list").innerHTML = visibleTasks.length ? visibleTasks.map((task) => {
    const source = workspace!.capture_sources[task.id];
    const description = source?.kind === "window" ? `${escape(source.title)} · 外枠 ${source.inset}px` : source?.kind === "scenario" ? "撮影元と撮影前の操作を設定済み" : "撮影元はまだ設定されていません。文書のAI更新で自動設定できます。";
    return `<article class="card${task.status === "approved" ? " card-approved is-approved" : ""}" data-task="${escape(task.id)}"><div class="task-header"><h2>${escape(task.name || task.prompt.replace(/\s+/g, " ").slice(0, 48))} <small>${escape(task.page)}</small></h2><span data-task-status="${taskDisplayStatus(task)}" class="badge${task.status === "approved" ? " badge-approved is-approved" : ""}">${kindLabel[task.kind]} · ${statusLabel[taskDisplayStatus(task)] || escape(task.status)}</span></div>${workspace!.update_reasons?.[task.id]?.length ? `<p class="update-reasons">更新候補の理由: ${workspace!.update_reasons[task.id].map(escape).join("・")}${task.status === "approved" ? "（確定済みのため自動更新しません）" : ""}</p>` : ""}${taskDisplayStatus(task) === "failed" ? `<p class="task-failure" role="status">${escape(taskFailures.get(taskFailureKey(task)) || workspace?.execution_results?.[task.id]?.error || "前回の更新に失敗しました。実行記録から再開できます。")}</p>` : ""}<label class="task-prompt-label">AIへの指示<textarea data-prompt="${escape(task.id)}" rows="3">${escape(task.prompt)}</textarea></label><div class="actions"><button data-save-prompt="${escape(task.id)}">指示を保存</button><button data-toggle-approved="${escape(task.id)}"${task.status === "approved" ? ' class="button-approved is-approved"' : ""}${task.status === "missing" ? " disabled title=\"生成結果がある場合に確定できます\"" : ""}>${task.status === "approved" ? "確定解除" : "確定"}</button>${task.kind !== "screenshot" ? `<button data-generate="${escape(task.id)}" class="primary">${task.kind === "diagram" ? "図をAI更新" : "文章をAI更新"}</button>` : ""}</div>${task.kind === "screenshot" ? `
      <p class="muted">${description}</p><img class="task-image" data-thumb="${escape(task.id)}" alt="${escape(task.id)}の登録画像" hidden />
      <div class="actions">${source ? `<button class="primary" data-recapture="${escape(task.id)}">${source.kind === "scenario" ? "設定した手順で更新" : "同じ撮影元で更新"}</button>` : ""}<button data-source-config="${escape(task.id)}">${source ? "撮影元を変更" : "撮影元を選ぶ"}</button><button data-capture-expectations="${escape(task.id)}">撮影成功の条件</button><button data-register-image="${escape(task.id)}">既存のPNGを登録</button></div>
      <details class="capture-settings"><summary>撮影元の設定</summary><p class="muted">アプリの対象画面を開いて一覧を更新してください。タイトルで記憶するので、アプリを再起動しても使えます。同じタイトルが複数ある場合は自動で選びません。Waylandでは毎回OSの撮影ダイアログで対象を選びます。</p><div class="actions"><select data-window-select="${escape(task.id)}"><option value="">一覧を更新してください</option></select><button data-window-list="${escape(task.id)}">一覧を更新</button></div><div class="actions"><label>外枠を除く（px）<input type="number" min="0" max="64" data-inset="${escape(task.id)}" value="${source?.kind === "window" ? source.inset : 0}" /></label><button data-capture="${escape(task.id)}" class="primary">撮影元を保存して撮影</button></div></details>` : ""}<button class="edit-task" data-edit-page="${escape(task.page)}">原稿を開く</button></article>`;
  }).join("") : workspace.tasks.length ? '<p class="muted">条件に一致するAIタグがありません。</p>' : '<div class="card"><h2>更新する画像・文章・図を追加する</h2><p>原稿の編集画面で「撮影の指示」「文章の指示」「図の指示」を追加して保存してください。この一覧に表示されます。</p></div>';
  const generationRoot = projectRoot;
  for (const task of workspace.tasks.filter((item) => item.kind === "screenshot")) {
    const img = document.querySelector<HTMLImageElement>(`[data-thumb="${CSS.escape(task.id)}"]`);
    void rpc("preview-asset", { page: task.page, asset: workspace.image_assets[task.id] || `assets/${task.id}.png` }).then((src) => {
      if (generationRoot !== projectRoot || !img?.isConnected) return;
      if (img) { img.src = src; img.hidden = false; }
      if (img) {
        img.tabIndex = 0; img.setAttribute('role', 'button'); img.setAttribute('aria-label', `${task.id}の撮影画像を拡大`);
        const inspect = () => { void showImageComparison([{ label: task.id, src: img.src }]); };
        img.addEventListener('click', inspect);
        img.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); inspect(); } });
      }
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
    const originalHeader = match[0].slice(0, headerEnd);
    const header = taskPromptAttribute.test(originalHeader)
      ? originalHeader.replace(taskPromptAttribute, () => ` prompt="${escapeTaskPrompt(prompt.trim())}"`)
      : originalHeader.replace(/\s*-->$/, () => ` prompt="${escapeTaskPrompt(prompt.trim())}" -->`);
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
async function confirmGenerationInput(page: string, id?: string, feedback = "", selectedIds?: string[], defaults?: ExecutionLimits): Promise<GenerationInput | null> {
  const root = projectRoot;
  const load = async (ids?: string[], revision?: string) => JSON.parse(await rpc("generation-input", {
    page, id, feedback, json: { ...(ids ? { ids } : {}), ...(revision ? { revision } : {}) },
  }, root)) as GenerationInput;
  let initial = await load(selectedIds);
  const anonymous = [...initial.existing_content.matchAll(/<!--\s*ai:task\b((?:"[^"]*"|'[^']*'|[^>"'])*)-->/g)].some(match => !tagAttribute(match[1], 'id'));
  if (anonymous) {
    if (root !== projectRoot) throw new Error("プロジェクトが切り替わりました。");
    if (documentState?.page === page) await saveDocument(false);
    else await rpc('editor-save', {page,json:{content:initial.existing_content,revision:initial.revision}},root);
    await refreshWorkspace(); initial = await load(selectedIds);
  }
  initial.limits = defaults;
  const input = await showGenerationInput(initial, (ids, revision) => load(ids, revision), tasksForPage(page).filter(task => task.status === "approved").length);
  if (root !== projectRoot) throw new Error("ワークスペースが切り替わりました。生成入力を確認し直してください。");
  return input;
}

async function generateReviewed(page: string, id?: string, initialFeedback = "", confirmedInput?: GenerationInput): Promise<boolean> {
  savedBeforeOperation();
  await ensureAiSettings();
  const root = projectRoot;
  const input = confirmedInput ?? await confirmGenerationInput(page, id, initialFeedback);
  if (!input) { status("生成をキャンセルしました。"); return false; }
  const ids = input.tasks.filter(task => task.kind !== "screenshot").map(task => task.id);
  const execution = confirmedInput ? undefined : JSON.parse(await rpc("execution-begin", {page,json:{ids,limits:input.limits}},root)) as ExecutionRun;
  let executionSucceeded = false;
  let executionError: string | undefined;
  let operationAttempt = 0;
  let feedback = initialFeedback;
  try {
  for (;;) {
    if (!progressRunning) {
      try { await rpc("agent-progress-clear", {}, root); } catch { /* Optional progress logs. */ }
      startAiProgress(id ? "generate-task" : "generate-page");
    }
    if (execution) await rpc("execution-checkpoint",{id:execution.id,json:{results:ids.map(id=>({id,status:"running"}))}},root);
    logProgress(`${page} の生成候補を準備しています。`);
    showAiPhase('generating', root, page);
    activeGenerationRoot = root;
    generationCancelled = false;
    element("progress-cancel").hidden = false;
    element<HTMLButtonElement>("progress-cancel").disabled = false;
    let candidate: { before: Document; content: string; updated: string[] };
    try {
      // TUI output includes prompt echoes, reasoning and screen redraws. It has
      // no reliable completion signal; generate through the structured backend,
      // which waits for CLI exit and reads the final response.
      operationAttempt++;
      candidate = JSON.parse(await rpc("generate-review", {
        page,
        id,
        feedback,
        json: { ids, revision: input.revision, limits: input.limits },
      }, root));
      if (generationCancelled) throw new Error("AI生成を中断しました。生成候補は破棄しました。");
      await pollAgentProgress();
      await stopAiProgress(true);
    } catch (error) {
      if (!generationCancelled) for (const task of input.tasks.filter(task => task.kind !== "screenshot")) recordTaskResult(task, String(error), root);
      renderTasks();
      showAiPhase(generationCancelled ? 'cancelled' : 'partial', root, page);
      await stopAiProgress(false);
      if (execution && !generationCancelled && operationAttempt <= (input.limits?.retries || 0)) {
        logProgress(`生成を再試行します（${operationAttempt}/${input.limits?.retries}）。`);
        continue;
      }
      throw error;
    }
    if (projectRoot !== root) throw new Error("ワークスペースが切り替わったため、生成候補の反映を中止しました。");
    for (const task of input.tasks.filter(task => task.kind !== "screenshot")) recordTaskResult(task, undefined, root);
    renderTasks();
    if (candidate.before.content === candidate.content) { executionSucceeded = true; showAiPhase('completed', root, page); status("AI生成による変更はありません。"); return true; }
    showAiPhase('review', root, page);
    const decision = await showGenerationReview(page, candidate.before.content, candidate.content);
    if (decision.action === "restore") { showAiPhase('cancelled', root, page); status("生成候補を破棄し、現在の原稿を保持しました。"); return false; }
    if (decision.action === "retry") { feedback = decision.feedback; operationAttempt = 0; continue; }
    const after = JSON.parse(await rpc("editor-save", { page, json: { content: candidate.content, revision: candidate.before.revision } }, root)) as Document;
    aiReviews.set(aiReviewKey(page), { before: candidate.before, after, id, updated: candidate.updated });
    await refreshWorkspace(documentState?.page === page);
    renderDocumentTags();
    executionSucceeded = true;
    showAiPhase('completed', root, page);
    status(`${page}の生成結果を採用して保存しました。`);
    return true;
  }
  } catch(error) { executionError=String(error); showAiPhase(generationCancelled ? 'cancelled' : 'partial', root, page); throw error; }
  finally {
    if (execution) {
      await rpc("execution-checkpoint",{id:execution.id,json:{results:ids.map(id=>({id,status:executionSucceeded?"succeeded":executionError&&!generationCancelled?"failed":"cancelled",error:executionError}))}},root);
      const finished = JSON.parse(await rpc("execution-finish",{id:execution.id},root)) as ExecutionRun;
      if (Array.isArray(finished.entries)) { lastExecutions.set(JSON.stringify([root,page]),finished); renderLastExecution(); }
    }
  }
}
element("execution-history-open").addEventListener("click",()=>{void work(async()=>{
  savedBeforeOperation();
  const root=projectRoot;
  const history=JSON.parse(await rpc("execution-history",{},root)) as {runs:ExecutionRun[]};
  await showExecutionHistory(history.runs,{
    load:async id=>JSON.parse(await rpc("execution-entry",{id},root)),
    resume:async id=>{
      const plan=JSON.parse(await rpc("execution-resume",{id},root)) as {page:string;ids:string[];limits:ExecutionLimits};
      await openPage(plan.page,false);await generateDocument(plan.page,plan.ids,plan.limits);
    },
    restore:async id=>{
      const restored = JSON.parse(await rpc("execution-finish",{id,rollback:true},root)) as ExecutionRun;
      if (Array.isArray(restored.entries)) {
        lastExecutions.set(JSON.stringify([root,restored.page]),restored);
        showAiPhase('restored',root,restored.page);
      }
      await refreshWorkspace(true);status("文書と画像を更新前へ復元しました。");
    },
  });
});});
element("generation-history-open").addEventListener("click", () => { void work(async () => {
  if (!documentState) throw new Error("先に原稿を開いてください。");
  const root = projectRoot, page = documentState.page;
  const history = JSON.parse(await rpc("generation-history", { page }, root)) as { entries: GenerationHistorySummary[] };
  const assertContext = () => { if (root !== projectRoot || page !== documentState?.page) throw new Error("原稿が切り替わりました。履歴を開き直してください。"); };
  await showGenerationHistory(history.entries, {
    load: async id => { assertContext(); return JSON.parse(await rpc("generation-history-entry", { id }, root)) as GenerationHistoryEntry; },
    compare: async (before, after) => { assertContext(); await showGenerationReview(page, before, after, false, true); },
    reuse: async entry => {
      assertContext(); savedBeforeOperation();
      if (entry.input.page !== page) throw new Error("別の原稿の生成履歴です。");
      const before = JSON.parse(await rpc("editor-read", { page }, root)) as Document;
      const decision = await showGenerationReview(page, before.content, entry.candidate.content);
      if (decision.action === "adopt") {
        assertContext();
        await rpc("editor-save", { page, json: { content: entry.candidate.content, revision: before.revision } }, root);
        await refreshWorkspace(true);
        status("生成履歴の候補を採用して保存しました。");
      } else if (decision.action === "retry") {
        await generateReviewed(page, undefined, decision.feedback);
      }
    },
  });
}); });
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
    lastExecutions.delete(JSON.stringify([projectRoot,page]));
    showAiPhase('restored');
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
async function generateDocument(page: string, resumeIds?: string[], defaults?: ExecutionLimits): Promise<number | null> {
  if (!workspace) throw new Error("先にプロジェクトを開いてください。");
  const root = projectRoot;
  const allTasks = JSON.parse(await rpc("page-tasks", { page }, root)) as Task[];
  if (root !== projectRoot) throw new Error("プロジェクトが切り替わりました。");
  const supported = allTasks.filter(task => ["text", "diagram"].includes(task.kind));
  if (!supported.some(task => task.status !== "approved")) { status("更新できる未確定のAIタグがありません。"); return 0; }
  await ensureAiSettings();
  const input = await confirmGenerationInput(page, undefined, "", resumeIds, defaults);
  if (!input) { status("生成をキャンセルしました。"); return null; }
  const tasks = input.tasks;
  const limits = input.limits || {timeout_seconds:300,retries:0};
  const run = JSON.parse(await rpc("execution-begin", {page,json:{ids:tasks.map(task=>task.id),limits}}, root)) as ExecutionRun;
  const failures: Array<{id:string;reason:string}> = [];
  const executionEntries = tasks.map(task => ({task:{id:task.id,kind:task.kind,prompt:task.prompt},status:'pending',attempts:0,input:null,references:{},capture:null}));
  let cancelled = false;
  generationCancelled = false;
  const checkpoint = (ids: string[], state: string, error?: string) => {
    for (const entry of executionEntries) if (ids.includes(entry.task.id)) entry.status = state;
    return rpc("execution-checkpoint", {id:run.id,json:{results:ids.map(id=>({id,status:state,error}))}},root);
  };
  const attempt = async <T>(selected: Task[], action: () => Promise<T>): Promise<T> => {
    for (let count=0;;count++) {
      if (generationCancelled) throw new Error("AI更新を中断しました。");
      await checkpoint(selected.map(task=>task.id), "running");
      try { return await action(); } catch(error) {
        if (generationCancelled || count>=limits.retries) {
          await checkpoint(selected.map(task=>task.id), generationCancelled ? "cancelled" : "failed", String(error));
          throw error;
        }
        logProgress(`失敗した処理を再試行します（${count+1}/${limits.retries}）。`);
      }
    }
  };
  try {
    try { await rpc("agent-progress-clear"); } catch { /* Optional logging. */ }
    startAiProgress("generate-page");
    showAiPhase('generating', root, page);
    const generated = tasks.filter(task=>task.kind!=="screenshot");
    if (generated.length) {
      try {
        const adopted=await attempt(generated,()=>generateReviewed(page,undefined,"",input));
        if (!adopted) {cancelled=true;await checkpoint(generated.map(task=>task.id),"cancelled");}
        else await checkpoint(generated.map(task=>task.id),"succeeded");
      } catch(error) { for(const task of generated) failures.push({id:task.id,reason:String(error)}); }
    }
    if (!cancelled && !generationCancelled) {
      if (!progressRunning) startAiProgress("generate-page");
      activeGenerationRoot=root;
      element("progress-cancel").hidden=false;
      element<HTMLButtonElement>("progress-cancel").disabled=false;
      for (const task of tasks.filter(task=>task.kind==="screenshot")) {
        if (generationCancelled) { cancelled=true; break; }
        showAiPhase('capturing', root, page);
        try {
          await attempt([task],async()=>{
            const result=JSON.parse(await rpc("generate-page-captures",{page,json:{ids:[task.id],limits,execution_id:run.id}},root)) as {capture_errors?:Array<{id:string;reason:string}>};
            if(result.capture_errors?.length)throw new Error(result.capture_errors.map(item=>item.reason).join("\n"));
          });
          recordTaskResult(task,undefined,root);await checkpoint([task.id],"succeeded");
        }catch(error){recordTaskResult(task,String(error),root);failures.push({id:task.id,reason:String(error)});}
      }
    }
    let rollback=false;
    if(failures.length) rollback=input.failure_policy==="rollback" || input.failure_policy!=="keep" && await showPartialFailure(failures, executionEntries);
    const finished = JSON.parse(await rpc("execution-finish",{id:run.id,rollback},root)) as ExecutionRun;
    if (Array.isArray(finished.entries)) lastExecutions.set(JSON.stringify([root,page]),finished);
    showAiPhase(rollback ? 'restored' : cancelled || generationCancelled ? 'cancelled' : failures.length ? 'partial' : 'completed', root, page);
    renderLastExecution();
    element<HTMLDetailsElement>('execution-result').open = Boolean(failures.length || cancelled || generationCancelled);
    status(rollback ? "文書と画像を更新前へ戻しました。実行記録から再開できます。" : cancelled || generationCancelled ? "AI更新を中断しました。未実行分は実行記録から再開できます。" : `AI更新を完了しました。失敗${failures.length}件。`,failures.length>0);
    return cancelled || generationCancelled ? null : failures.length;
  } finally {
    await refreshWorkspace(true);
    await stopAiProgress(!failures.length && !cancelled);
    await restoreManualStudioAfterCapture().catch(()=>{});
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
  const root = projectRoot;
  const candidates = [];
  for (const page of pages) {
    const tasks = JSON.parse(await rpc("page-tasks", { page }, root)) as Task[];
    candidates.push({ page, tasks: tasks.filter(task => ["text", "diagram"].includes(task.kind)) });
  }
  const selectedPages = await selectGenerationPages(candidates);
  if (!selectedPages) { status("AI更新をキャンセルしました。"); return; }
  if (root !== projectRoot) throw new Error("ワークスペースが切り替わりました。");
  let completed = 0;
  let failedCaptures = 0;
  for (const page of selectedPages.pages) {
    const tasks = candidates.find(item => item.page === page)!.tasks.filter(task => task.status !== "approved");
    if (!tasks.length) continue;
    if (documentState?.page !== page) {
      if (dirty) throw new Error("未保存の原稿があります。保存してから選択した文書をAI更新してください。");
      await openPage(page, false);
    }
    const failures = await generateDocument(page,undefined,selectedPages.limits);
    if (failures === null) { status(`AI更新を中止しました（${completed}文書完了）。`); return; }
    failedCaptures += failures;
    completed++;
  }
  status(`すべての文書のAI更新が完了しました（${completed}文書）。${failedCaptures ? `撮影失敗 ${failedCaptures}件は実行ログを確認してください。` : ""}`, failedCaptures > 0);
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
  let completionMessage = `${action === "build-mkdocs" ? "MkDocsでHTMLを作成しました" : action === "recapture" || action === "capture-window" ? "画像を更新し、撮影元を保存しました" : "処理が完了しました"}。`;
  let completionHasError = false;
  try {
    const output = await rpc(action, options);
    if (typeof options.id === "string") {
      const task = workspace?.tasks.find(task => task.id === options.id);
      if (task) recordTaskResult(task);
    }
    if (isAiAction) { await pollAgentProgress(); logProgress("AIの応答を受け取りました。結果を反映しています。"); }
    if (resultId) {
      let text = output;
      try {
        const parsed = JSON.parse(output);
        if (action === "quality-check") {
          const issues=parsed.issues as Array<{page:string;tag?:string;message:string}>;
          completionHasError=!parsed.passed;
          completionMessage=parsed.passed?"公開前チェックに合格しました。":`公開前チェックで${issues.length}件の問題が見つかりました。`;
          text=completionMessage+"\n"+issues.map(issue=>`${issue.page}${issue.tag?` · ${issue.tag}`:""}: ${issue.message}`).join("\n");
        } else if (action === "capture-source-auto") {
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
    if (typeof options.id === "string") {
      const task = workspace?.tasks.find(task => task.id === options.id);
      if (task) { recordTaskResult(task, String(error)); renderTasks(); }
    }
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
element("task-status-filter").addEventListener("change", renderTasks);
element("task-kind-filter").addEventListener("change", renderTasks);
for (const [selector, name] of [["#undo-edit", "undo"], ["#redo-edit", "redo"], ["#insert-image", "image"], ['[data-format="link"]', "link"]] as const) {
  const button = document.querySelector<HTMLButtonElement>(selector);
  if (button) button.innerHTML = uiIcon(name) + (name === "image" ? " 画像" : name === "link" ? " リンク" : "");
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
  if (input("tree-search").value.trim() || element<HTMLSelectElement>("tree-filter").value === "markdown") return;
  if (folder.open) expandedFolders.add(folder.dataset.folder!);
  else expandedFolders.delete(folder.dataset.folder!);
}, true);
input("tree-search").addEventListener("input", renderPages);
element("tree-filter").addEventListener("change", renderPages);
element("editor-more").addEventListener("click", event => {
  if ((event.target as HTMLElement).closest("button")) element<HTMLDetailsElement>("editor-more").open = false;
});
document.addEventListener("click", event => {
  const menu = element<HTMLDetailsElement>("editor-more");
  if (!menu.contains(event.target as Node)) menu.open = false;
  const settings = element<HTMLDetailsElement>("settings-menu");
  if (!settings.contains(event.target as Node)) settings.open = false;
});
element("editor-more").addEventListener("keydown", event => {
  if (event.key === "Escape") {
    element<HTMLDetailsElement>("editor-more").open = false;
    element("editor-more").querySelector<HTMLElement>("summary")?.focus();
  }
});
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  const openMenu = document.querySelector<HTMLDetailsElement>("#settings-menu[open], .format-insert-menu[open]");
  if (openMenu) { openMenu.open = false; openMenu.querySelector<HTMLElement>("summary")?.focus(); }
});
document.querySelector(".format-insert-actions")?.addEventListener("click", event => {
  if ((event.target as HTMLElement).closest("button")) document.querySelector<HTMLDetailsElement>(".format-insert-menu")!.open = false;
});
type EditorView = "edit" | "split" | "preview";
let preferredEditorView: EditorView | null = null;
try {
  const stored = localStorage.getItem("manual-studio-editor-view");
  if (stored === "edit" || stored === "split" || stored === "preview") preferredEditorView = stored;
} catch { /* The view controls work without storage. */ }
let editorPanelWidth = 0;
function applyEditorView(): void {
  const view = preferredEditorView || (editorPanelWidth < 850 ? "edit" : "split");
  element("panel-editor").dataset.editorView = view;
  document.querySelectorAll<HTMLButtonElement>(".editor-view-controls button[data-editor-view]").forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.editorView === view));
  });
}
document.querySelectorAll<HTMLButtonElement>(".editor-view-controls button[data-editor-view]").forEach(button => {
  button.addEventListener("click", () => {
    preferredEditorView = button.dataset.editorView as EditorView;
    try { localStorage.setItem("manual-studio-editor-view", preferredEditorView); } catch { /* Optional persistence. */ }
    applyEditorView();
  });
});
new ResizeObserver(entries => {
  editorPanelWidth = entries[0].contentRect.width;
  applyEditorView();
}).observe(element("panel-editor"));
applyEditorView();
editor.addEventListener("editor-mode-change", () => {
  if (preferredEditorView === "preview") { preferredEditorView = "edit"; applyEditorView(); }
});
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
  if (documentState && !previewRequestPending) previewNavigator.setStatus('ready');
  previewNavigator.setupIframeInterception(element<HTMLIFrameElement>("markdown-preview"));
  previewNavigator.updateToolbarState();
  const previewDocument = element<HTMLIFrameElement>("markdown-preview").contentDocument;
  previewDocument?.addEventListener('keydown', handleDocumentShortcut);
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
        await hideManualStudioForCapture(id);
        try { await runAction("recapture", { id }); }
        finally { await restoreManualStudioAfterCapture(); }
      } else {
        status("撮影元が未設定です。「AIタグ一覧」で撮影元を設定するか、画面一覧から設定してください。", true);
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
function handleDocumentShortcut(event: KeyboardEvent): void {
  if (event.isComposing || event.repeat || event.defaultPrevented || event.altKey || !(event.ctrlKey || event.metaKey)) return;
  const target = event.target instanceof Element ? event.target : null;
  if (document.querySelector('dialog[open]') || target?.closest('#panel-terminal')) return;
  if (target?.matches('input,select,textarea') && target !== editor && !milkdown.host.contains(target)) return;
  const key = event.key.toLowerCase();
  if (key === 's' && !event.shiftKey) { event.preventDefault(); if (documentState) void work(saveDocument); return; }
  if (!event.shiftKey || !['p', 'r', 'g'].includes(key)) return;
  event.preventDefault();
  if (!documentState || busy) return;
  if (key === 'p') {
    const views: EditorView[] = ['edit', 'split', 'preview'];
    const next = views[(views.indexOf(element('panel-editor').dataset.editorView as EditorView) + 1) % views.length];
    document.querySelector<HTMLButtonElement>(`.editor-view-controls button[data-editor-view="${next}"]`)!.click();
  } else if (key === 'r') { void work(renderPreview); }
  else { void work(generateCurrentPage); }
}
document.addEventListener('keydown', handleDocumentShortcut);
element('shortcut-help').addEventListener('click', showShortcutHelp);
element('workspace-guide').querySelector('[data-guide-settings]')!.addEventListener('click', () => chooseTab('settings'));
element('workspace-guide').querySelector('[data-guide-dismiss]')!.addEventListener('click', () => {
  try { localStorage.setItem(`manual-studio-guide:${projectRoot}`, 'hidden'); } catch { /* Optional preference. */ }
  element('workspace-guide').hidden = true;
});
element('generate-page').setAttribute('aria-keyshortcuts', 'Control+Shift+G Meta+Shift+G');
element('generate-page').title += ' (Ctrl/Cmd+Shift+G)';
element('save-page').setAttribute('aria-keyshortcuts', 'Control+S Meta+S');
element('save-page').innerHTML = `${uiIcon('save')} 保存 <kbd>⌘ / Ctrl S</kbd>`;
element('open-workspace-settings').innerHTML = `${uiIcon('settings')} ワークスペース設定`;
element('open-workspace-settings').title = '原稿・画像の保存先とHTML出力先を設定';
document.querySelectorAll<HTMLButtonElement>('.editor-view-controls button[data-editor-view]').forEach(button => { button.title = `${button.textContent} (Ctrl/Cmd+Shift+Pで順に切替)`; });
let closingApproved = false;
let closingPrompt = false;
window.addEventListener("beforeunload", (event) => { if (dirty && !closingApproved) { event.preventDefault(); event.returnValue = ""; } });
window.addEventListener("pagehide", () => terminalController?.disconnectOnUnload());
if (native) void getCurrentWindow().onCloseRequested(event => {
  if (closingApproved) return;
  event.preventDefault();
  if (closingPrompt) return;
  if (busy) { status("処理の完了または中断後にアプリを閉じてください。", true); return; }
  closingPrompt = true;
  void (async () => {
    try {
      if (!await confirmDiscard()) return;
      await terminalController?.kill();
      closingApproved = true;
      await getCurrentWindow().destroy();
    } catch (error) { closingApproved = false; status(String(error), true); }
    finally { closingPrompt = false; }
  })();
});
function updateCaptureSteps(): void {
  const step = annotationPollRunning || recordingFinishActive || externalFinishActive ? 3
    : pendingAnnotatedImageFile || pendingScenarioFile || screenshotSubmitRunning ? 4
    : operationRecording || recordingStarting ? 2 : 1;
  const help = ["", "撮影するアプリの起動コマンドを選んでください。", "対象アプリを操作し、撮影ボタンまたはCtrl+Shift+F10で記録を終了します。", "撮影した画像をMarkItsで編集し、「編集終了」を押してください。", "画像と指示を原稿へ追加します。失敗時はこの画面から再試行できます。"];
  element("capture-step-help").textContent = help[step];
  document.querySelectorAll<HTMLElement>("[data-capture-step]").forEach(item => {
    const number = Number(item.dataset.captureStep);
    if (number === step) item.setAttribute("aria-current", "step"); else item.removeAttribute("aria-current");
    item.dataset.complete = String(number < step);
  });
}
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
  const selectedCommand = launchCommands.find((command) => (command.id || command.name) === element<HTMLSelectElement>("screenshot-launch-command").value);
  const program = selectedCommand?.program.trim() || input("screenshot-launch-program").value.trim();
  const issue = !native ? "操作記録はデスクトップアプリで利用できます。"
    : !program ? "起動するアプリを選択してください。"
    : !projectRoot ? "先にワークスペースを開いてください。" : "";
  if (issue) { element("operation-recording-status").textContent = issue; status(issue, true); return; }
  void work(async () => {
  const session = captureSessions.active;
  if (!session || operationRecording || recordingStarting || recordingFinishActive) return;
  const generation = session.generation;
  const args = selectedCommand?.args ?? element<HTMLTextAreaElement>("screenshot-launch-args").value.split("\n").filter((value) => value.length > 0);
  pendingLaunchProgram = program;
  pendingLaunchArgs = args;
  const progress = "アプリを起動し、ウィンドウを自動検出しています（最大30秒）。";
  element("operation-recording-status").textContent = progress; status(progress);
  let message: string;
  recordingStarting = true;
  updateCaptureBusyState();
  try {
    message = await invoke<string>("start_operation_recording", { root: session.root, program, args, windowTitle: "", taskId: session.id, markitsProgram: "" });
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
  const command = launchCommands.find((item) => (item.id || item.name) === select.value);
  summary.textContent = command ? `起動アプリ: ${command.program}${command.args.length ? `（引数 ${command.args.length} 件）` : ""}` : custom ? "アプリの実行ファイルと必要な引数を指定してください。" : "共通コマンドを登録すると、ここから選べます。";
}
function refreshLaunchCommandOptions(): void {
  const select = element<HTMLSelectElement>("screenshot-launch-command");
  const previous = select.value;
  select.replaceChildren(...launchCommands.map((command) => new Option(command.name || command.program.split(/[\\/]/).pop() || "対象アプリ", command.id || command.name)));
  select.add(new Option("カスタム起動コマンド", "__custom__"));
  select.value = previous && (previous === "__custom__" || launchCommands.some((item) => (item.id || item.name) === previous)) ? previous : launchCommands[0]?.id || launchCommands[0]?.name || "__custom__";
  updateLaunchSelection();
}
function renderLaunchCommands(): void {
  const list = element("launch-command-list");
  list.replaceChildren();
  launchCommands.forEach((command, index) => {
    const row = document.createElement("div"); row.className = "launch-command-row";
    const nameLabel = document.createElement("label"); nameLabel.textContent = "表示名（省略可）";
    const name = document.createElement("input"); name.value = command.name; name.dataset.launchName = String(index); nameLabel.append(name);
    const programLabel = document.createElement("label"); programLabel.textContent = "起動コマンド / アプリ";
    const programWrap = document.createElement("div"); programWrap.className = "app-picker-row";
    const program = document.createElement("input"); program.value = command.program; program.placeholder = "例: firefox または /usr/bin/firefox"; program.dataset.launchProgram = String(index);
    const browse = document.createElement("button"); browse.type = "button"; browse.textContent = "選択"; browse.dataset.launchBrowse = String(index);
    programWrap.append(program, browse); programLabel.append(programWrap);
    const argsLabel = document.createElement("label"); argsLabel.textContent = "起動引数（1行に1つ）";
    const args = document.createElement("textarea"); args.rows = 2; args.value = command.args.join("\n"); args.dataset.launchArgs = String(index); argsLabel.append(args);
    const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "削除"; remove.dataset.launchRemove = String(index);
    const test = document.createElement("button"); test.type = "button"; test.textContent = "起動確認";
    test.addEventListener("click", () => { void work(async () => { if (!native) throw new Error("起動確認はデスクトップ版で利用できます。"); await invoke("test_launch_application", { program: program.value, args: args.value.split("\n").filter(value => value.length > 0) }); status("対象アプリを起動しました。"); }); });
    row.append(nameLabel, programLabel, argsLabel, test, remove); list.append(row);
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
function insertAiTask(kind: string, custom?: { id: string; prompt: string }, selection?: { start: number; end: number }, insertTag?: (markdown: string) => boolean): boolean {
  if (!documentState) { status("先に原稿を開いてください。", true); return false; }
  const id = custom?.id.trim() || nextAiTaskId(kind);
  if (!/^[a-z][a-z0-9_-]*$/.test(id) || collectAiTagIds(editor.value).has(id) || workspace?.tasks.some((task) => task.id === id)) {
    status("指示IDが不正か、すでに使われています。別のIDを指定してください。", true);
    return false;
  }
  const prompt = kind === "screenshot" ? "対象アプリの画面と、表示する操作要素を指定してください。" : kind === "diagram" ? "Pythonモジュール間の依存関係を図にしてください。" : "対象読者と説明する操作手順を指定してください。";
  const markdown = `\n\n<!-- ai:task id=${id} kind=${kind} prompt="${escapeTaskPrompt(custom?.prompt ?? prompt)}" -->\n\n<!-- /ai:task -->\n`;
  if (insertTag) return insertTag(markdown);
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
  captureSessions.begin({ root: projectRoot, page: documentState.page, id, selection, insertTag: milkdown.captureAiTagInsertion() });
  acceptedRecordingResultGeneration = -1;
  activeRecordingResult = null;
  element<HTMLTextAreaElement>("screenshot-notes").value = "";
  input("screenshot-launch-program").value = "";
  element<HTMLTextAreaElement>("screenshot-launch-args").value = "";
  refreshLaunchCommandOptions();
  updateCaptureSteps();
  element("operation-recording-status").textContent = "記録中は入力した文字も保存されます。機密情報を入力しないでください。対象アプリ以外を操作しないでください。Ctrl+Shift+F9で一時停止、Ctrl+Shift+F10で終了できます。";
  pendingScenarioFile = null;
  pendingRecordedOperations = "";
  pendingAnnotationSpec = "";
  updateCaptureSteps();
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
    const selectedCommand = launchCommands.find((command) => (command.id || command.name) === element<HTMLSelectElement>("screenshot-launch-command").value);
    const configuredProgram = selectedCommand?.program.trim() || input("screenshot-launch-program").value.trim();
    const configuredArgs = selectedCommand?.args ?? element<HTMLTextAreaElement>("screenshot-launch-args").value.split("\n").filter((value) => value.length > 0);
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
            if (session.insertTag) {
              session.insertTag(`\n\n${block}\n`);
              return;
            }
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
    if (insertAiTask("screenshot", { id, prompt }, session.selection, session.insertTag)) {
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
element("refresh-tasks").addEventListener("click", () => { void work(async () => { savedBeforeOperation(); await refreshWorkspace(true); status("AIタグ一覧を更新しました。"); }); });
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
  if (button.dataset.captureExpectations) {
    const id = button.dataset.captureExpectations;
    const initial = JSON.parse(await rpc("capture-expectations-read", { id }));
    await showCaptureExpectations(initial, value => rpc("capture-expectations-save", { id, json: value }).then(() => {}));
    await refreshWorkspace(); return;
  }
  if (button.dataset.recapture) { await hideManualStudioForCapture(id); try { await runAction("recapture", { id }); } finally { await restoreManualStudioAfterCapture(); } return; }
    if (button.dataset.capture) {
      const windowId = taskControl<HTMLSelectElement>(card, "data-window-select").value;
      if (!windowId) throw new Error("一覧から撮影するウィンドウを選んでください。");
      const selectedWindow = (JSON.parse(await rpc("list-windows")) as NativeWindow[]).find(item => item.id === windowId);
      if (!selectedWindow || !/manual\s*studio/i.test(selectedWindow.title)) await hideManualStudioForCapture();
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
element("ai-key-migrate").addEventListener("click", () => {
  input("ai-api-key").value = assignLegacyAiCredential(projectRoot, input("ai-endpoint-url").value);
  element("ai-key-migrate").hidden = true;
  scheduleAiSave();
});
element("ai-endpoint-url").addEventListener("input", () => {
  input("ai-api-key").value = readAiCredential(projectRoot, input("ai-endpoint-url").value);
  scheduleAiSave();
});
element("ai-api-key").addEventListener("input", () => {
  saveAiCredential(projectRoot, input("ai-endpoint-url").value, input("ai-api-key").value);
});
for (const id of ["ai-model", "ai-api-key"]) {
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
  launchCommands.push({ id: `app-${crypto.randomUUID()}`, name: "", program: "", args: [] }); renderLaunchCommands();
  document.querySelector<HTMLInputElement>(`[data-launch-name="${launchCommands.length - 1}"]`)?.focus();
});
element("save-launch-commands").addEventListener("click", () => { void work(async () => {
  launchCommands = launchCommands.map((_command, index) => ({
    id: _command.id || `app-${crypto.randomUUID()}`,
    name: document.querySelector<HTMLInputElement>(`[data-launch-name="${index}"]`)!.value.trim(),
    program: document.querySelector<HTMLInputElement>(`[data-launch-program="${index}"]`)!.value.trim(),
    args: document.querySelector<HTMLTextAreaElement>(`[data-launch-args="${index}"]`)!.value.split("\n").filter((value) => value.length > 0),
  }));
  await invoke<void>("save_launch_commands", { commands: launchCommands });
  renderLaunchCommands(); refreshLaunchCommandOptions(); status("共通起動コマンドを保存しました。");
}); });
element("generate-draft").addEventListener("click", () => { void work(async () => {
  savedBeforeOperation();
  if (workspace?.pages.length && !window.confirm("現在の原稿をバックアップして、AIの下書きに置き換えますか？")) return;
  await runAction("draft", {}, "publish-result");
}); });
actionButton("quality-check", "quality-check", () => ({}), "publish-result");
actionButton("build-draft", "build", () => ({ draft: true }), "publish-result");
actionButton("build-final", "build", () => ({}), "publish-result");
actionButton("build-mkdocs", "build-mkdocs", () => ({ draft: true }), "publish-result");
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
