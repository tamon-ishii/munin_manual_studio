import {setupScreenshotAi} from './screenshotAi';
import {askReader,showReaderReport,type ReaderReport,type ReviewCapabilities} from './readerReview';
import {reviewDraft,type DraftCandidate} from './draftReview';
import { AiProgressManager } from './aiProgressManager';
import {imageAtSelection,renderFigure,replaceDocumentImage,type DocumentImage} from './imagePresentation';
import type {ResourceUsage} from './resourceBrowser';
import { setupImageAiSettings } from './imageAiSettings';
import { setupImageGeneration } from './imageGeneration';
import { setupToolbarCustomization } from './toolbarCustomization';
import { chooseDestination,featureDialog } from './screenshotWorkflow';
import { setupScreenshotLibrary } from "./screenshotLibrary";
import { uiIcon } from './uiIcons';
import { setupControlIcons } from './controlIcons';
import { showShortcutHelp } from './shortcutHelp';
import { setAiPhase } from './workflowPresentation';
import { readAiCredential, saveAiCredential, hasUnassignedAiCredential, assignLegacyAiCredential } from "./aiCredentials";
import { applyEditorFontSize, isEditorFontSize, setupEditorFontSize } from "./editorFontSize";
import { setupMilkdownEditor, renderMermaid } from "./milkdownEditor";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { EditorHistory, type EditorSnapshot } from "./editorHistory";
import { setupPaneResizers } from "./paneResizers";
import { setupWindowLayout, type WindowLayoutManager } from "./windowLayout";
import { createPreviewNavigator } from "./previewNavigation";
import { sendManualRequest } from "./manualTransport";
import { renderFileTree } from "./fileTree";
import { setupPreviewTheme } from "./themePreview";
import { setupMarkdownTableEditor } from "./markdownTable";
import { jumpToSource } from "./editorNavigation";
import {askSelectionInstruction,reviewSelection,type SelectionDraft} from "./selectionAi";
import { showUnsavedChangesDialog } from "./unsavedChangesDialog";
import { loadWorkspaceHistory, recordWorkspaceHistory, showWorkspaceHistory } from "./workspaceHistory";
import { changeHeadingLevel, toggleStrikethrough, toggleTaskList, changeIndent, continueMarkdownList, type MarkdownEdit } from "./markdownAssists";
import { applyTheme, currentTheme, initializeTheme, isThemeId, type ThemeId } from "./theme";
import { aiErrorAdvice } from "./aiErrors";
import { setupTerminalPane, type TerminalController } from "./terminalPane";
import { emit } from "@tauri-apps/api/event";
import "./style.css";
import { captureInsertionContext, isInsertionCurrent, STALE_INSERTION_MESSAGE } from "./insertionContext";
import {setupManuscriptSearch} from './manuscriptSearch';
import {setupManuscriptOutline} from './manuscriptOutline';
import {setupManuscriptGit} from './manuscriptGit';
import {sameOwner,type ManuscriptOwner,type ManuscriptToolsOptions} from './manuscriptTools';

import type { State, Document, RecordingResult, LaunchCommand } from "./types";

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const input = (id: string): HTMLInputElement => element(id);
const editor = element<HTMLTextAreaElement>("markdown-editor");
const milkdown = setupMilkdownEditor(editor, message => status(message, true), source => {
  if (!documentState || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(source)) return Promise.resolve(source);
  return rpc("preview-asset", { page: documentState.page, asset: source });
}, async file => {
  const uploadInput=Array.from(milkdown.host.querySelectorAll<HTMLInputElement>('input[type=file]')).find(input=>input.files?.[0]===file);
  try {
    const reference=await uploadMilkdownImage(file);
    status('画像を保存しました。');
    return reference;
  }
  catch (error) {
    if(uploadInput)uploadInput.value='';
    status(`画像を挿入できませんでした。${String(error)} 画像を選び直して再試行できます。`, true);
    throw error;
  }
}, undefined, (source, img) => { void handleEditDocumentImage(source, img); },img=>showImagePresentation(img));
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
let manuscriptOutline:ReturnType<typeof setupManuscriptOutline>|null=null;
let dirty = false;
let documentAutosaveTimer: ReturnType<typeof setTimeout> | undefined;
let documentSavePending: Promise<void> | undefined;
let documentSaveState: { owner: Document; state: 'saving' | 'error'; message?: string } | null = null;
let busy = false;
let previewVersion = 0;
let previewRequestPending = false;
let previewScrollWindow: Window | null = null;
let syncingScroll = false;
let progressTimer: ReturnType<typeof setInterval> | undefined;
let progressPollTimer: ReturnType<typeof setInterval> | undefined;
let progressRunning = false;
let progressDisplayLogs: string[] = [];
let progressConnection = "AI";
let manualStudioHiddenForCapture = false;
let previewTimer: ReturnType<typeof setTimeout>;
const expandedFolders = new Set<string>();
let editHistory = new EditorHistory();
let replayingHistory = false;
let pendingEditorFocus = false;
let launchCommands: LaunchCommand[] = [];
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
function renderProgressLog(): void {
  const log = element<HTMLElement>("progress-log");
  const followTail = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
  log.textContent = progressDisplayLogs.join("\n");
  if (followTail) log.scrollTop = log.scrollHeight;
}
function saveAiProgressLogs(): void {
  if (!projectRoot) return;
  try {
    localStorage.setItem(`manual-studio-ai-logs:${projectRoot}`, JSON.stringify({
      logs: progressDisplayLogs.slice(-200),
      running: progressRunning,
      stage: aiProgress.currentStage,
      timestamp: Date.now(),
    }));
  } catch { /* LocalStorage error */ }
}
function loadAiProgressLogs(root: string): void {
  try {
    const raw = localStorage.getItem(`manual-studio-ai-logs:${root}`);
    if (!raw) return;
    const data = JSON.parse(raw) as { logs?: string[]; running?: boolean; stage?: string };
    if (Array.isArray(data.logs) && data.logs.length > 0) {
      progressDisplayLogs = [...data.logs];
      if (data.running) {
        progressDisplayLogs.push(`[${new Date().toLocaleTimeString("ja-JP", { hour12: false })}] アプリ再起動: 前回のAI処理は中断されました。`);
        saveAiProgressLogs();
      }
      renderProgressLog();
      element("progress-open").textContent = `直近のAI実行ログ (${progressDisplayLogs.length}件)`;
      element("progress-open").hidden = false;
    }
  } catch { /* LocalStorage error */ }
}
const aiProgress = new AiProgressManager();
function logProgress(message: string): void {
  aiProgress.log(message);
  progressDisplayLogs = aiProgress.logs;
  element("progress-note").textContent = message;
  renderProgressLog();
  saveAiProgressLogs();
}
let progressInFlight: Promise<void> | undefined;
let progressGeneration = 0;
function logAiFailure(error: unknown): void {
  aiProgress.recordFailure(error);
  progressDisplayLogs = aiProgress.logs;
  renderProgressLog();
  saveAiProgressLogs();
}
function pollAgentProgress(): Promise<void> {
  if (progressInFlight) return progressInFlight;
  const generation = progressGeneration;
  progressInFlight = readAgentProgress(generation).finally(() => { progressInFlight = undefined; });
  return progressInFlight;
}
async function readAgentProgress(generation: number): Promise<void> {
  try {
    const result = JSON.parse(await rpc("agent-progress", {}, activeGenerationRoot || projectRoot)) as { logs: Array<{ time: string; message: string }>; total?: number };
    if (generation !== progressGeneration) return;
    if (aiProgress.recordAgentLogs(result.logs, result.total)) {
      progressDisplayLogs = aiProgress.logs;
      if (aiProgress.isRunning && result.logs.length) {
        element("progress-note").textContent = aiProgress.currentStage;
      }
      renderProgressLog();
      saveAiProgressLogs();
    }
  } catch { /* The progress endpoint can be briefly unavailable while the request starts. */ }
}
async function restoreManualStudioAfterCapture(force = false): Promise<void> {
  if (!native || (!manualStudioHiddenForCapture && !force)) return;
  await invoke("restore_manual_studio");
  manualStudioHiddenForCapture = false;
}
async function beginAiProgress(action: string, root: string): Promise<void> {
  ++progressGeneration;
  if (progressInFlight) await progressInFlight;
  try { await rpc("agent-progress-clear", {}, root); } catch { /* Progress logs are optional. */ }
  startAiProgress(action);
}
function startAiProgress(action: string): void {
  ++progressGeneration;
  const labels: Record<string, string> = { codex: "Codex", claude: "Claude Code", grok: "Grok Build", agy: "Agy" };
  const agent = workspace?.config.agent || element<HTMLSelectElement>("ai-agent").value || "AI";
  const connection=workspace?.config.connection_type;
  progressConnection=connection==='api'?`API（${workspace?.config.model||'設定済みモデル'}）`:connection==='local_llm'?`ローカルAI（${workspace?.config.model||'設定済みモデル'}）`:labels[agent]||agent;
  const operation = ({
    draft: "原稿の下書きを生成中",
    "draft-propose": "原稿の下書き候補を生成中",
    "document-review": "文章をレビュー・校正中",
    "screenshot-ai-application": "撮影するアプリの起動設定を調査中",
    "screenshot-ai-plan": "撮影手順を作成中",
    "screenshot-ai-capture": "スクリーンショットを撮影中",
    "screenshot-ai-annotate": "撮影画像の注釈を作成中",
  } as Record<string, string>)[action] || "AI文書の候補を作成中";
  activeGenerationRoot = projectRoot;
  aiProgress.start({ connection: progressConnection, operation, root: projectRoot });
  element("progress-label").textContent = `${progressConnection}で${operation}`;
  progressRunning = true;
  element("ai-error-advice").hidden = true;
  progressDisplayLogs = aiProgress.logs;
  element("progress-track").classList.remove("progress-failed", "progress-completed");
  element("progress-track").setAttribute("aria-valuetext", "実行中");
  element("operation-progress").hidden = false;
  element("progress-open").hidden = true;
  element("progress-compact-cancel").hidden = true;
  element<HTMLButtonElement>('progress-compact-cancel').disabled=false;
  logProgress(`${progressConnection}で${operation}。処理を開始しました。`);
  status(`${labels[agent] || agent}で${operation}…`);
  const update = () => {
    const elapsed = aiProgress.computeElapsed();
    element("progress-elapsed").textContent = elapsed.formatted;
    if (aiProgress.isRunning && elapsed.isWaitingLong) {
      element("progress-note").textContent = elapsed.waitingMessage;
    }
    if (aiProgress.isRunning) {
      element('progress-open').textContent = `${progressConnection}・${operation}・経過 ${elapsed.seconds}秒 — ${element('progress-note').textContent}`;
    }
  };
  update();
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = setInterval(update, 1000);
  if (progressPollTimer) clearInterval(progressPollTimer);
  progressPollTimer = setInterval(() => { void pollAgentProgress(); }, 750);
}
let activeGenerationRoot: string | null = null;
let generationCancelRequest: Promise<void> | undefined;
function cancelAiGeneration():void {
  if (!activeGenerationRoot || generationCancelRequest) return;
  element<HTMLButtonElement>("progress-cancel").disabled = true;
  element<HTMLButtonElement>("progress-compact-cancel").disabled = true;
  logProgress("中断を要求しました。実行中の処理を停止します。");
  generationCancelRequest = aiProgress.requestCancel(root => rpc("agent-cancel", {}, root).then(() => {}));
}
element('progress-cancel').addEventListener('click',cancelAiGeneration);
element('progress-compact-cancel').addEventListener('click',cancelAiGeneration);
async function stopAiProgress(succeeded: boolean): Promise<void> {
  const cancelPromise = generationCancelRequest;
  generationCancelRequest = undefined;
  if (cancelPromise) await cancelPromise;
  const outcome = await aiProgress.stop();
  await pollAgentProgress();
  if (progressTimer) clearInterval(progressTimer);
  if (progressPollTimer) clearInterval(progressPollTimer);
  progressTimer = undefined;
  progressPollTimer = undefined;
  progressRunning = false;
  activeGenerationRoot = null;
  element("progress-cancel").hidden = true;
  element("progress-compact-cancel").hidden = true;
  element('progress-open').textContent='AI実行ログを表示';
  if (!succeeded && outcome.cancelled) {
    element("progress-label").textContent = "AI処理を中断しました";
    element("progress-track").classList.add("progress-failed");
    element("progress-track").setAttribute("aria-valuetext", "中断");
    logProgress("処理を中断しました。原稿は変更していません。再実行できます。");
  } else if (!succeeded) {
    element("progress-label").textContent = "AI処理に失敗しました";
    element("progress-track").classList.add("progress-failed");
    element("progress-track").setAttribute("aria-valuetext", "失敗");
    logProgress(outcome.failure ? `処理に失敗しました: ${outcome.failure}` : "AI処理を完了できませんでした。実行ログを確認してください。");
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
  element("progress-compact-cancel").hidden = !progressRunning;
});
element("progress-open").addEventListener("click", () => {
  element("operation-progress").hidden = false;
  element("progress-open").hidden = true;
  element("progress-compact-cancel").hidden = true;
});
async function rpc(action: string, options: Record<string, unknown> = {}, root = projectRoot): Promise<string> {
  const mergedOptions = { ...options };
  const aiActions = new Set(["selection-generate", "document-review", "screenshot-ai-application", "screenshot-ai-plan", "screenshot-ai-annotate", "draft", "draft-propose", "fact-check", "scenario-save"]);
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
      button.disabled = true;
    }
  } else if (busyButtonStates) {
    for (const [button, wasDisabled] of busyButtonStates) button.disabled = wasDisabled;
    busyButtonStates = null;
  }
  editor.readOnly = value;
  editor.disabled = !documentState;
  updateHistoryButtons();
  if (!value && pendingEditorFocus) { pendingEditorFocus = false; milkdown.focus(); }
  manuscriptOutline?.refresh();

}
function setButtonDisabled(button: HTMLButtonElement, disabled: boolean): void {
  if (busyButtonStates?.has(button)) busyButtonStates.set(button, disabled);
  else button.disabled = disabled;
}
async function savedBeforeOperation(): Promise<void> {
  await saveBriefSettings();
  while (documentSavePending) await documentSavePending;
  if (dirty) await saveDocument(false);
  if (dirty) throw new Error("原稿の保存が完了しませんでした。編集内容を確認して再試行してください。");
}
async function work(operation: () => Promise<void>): Promise<void> {
  if (busy) return;
  setBusy(true);
  try { await operation(); } catch (error) { status(String(error), true); }
  finally { setBusy(false); previewNavigator.updateToolbarState(); }
}
async function confirmDiscard(): Promise<boolean> {
  return !dirty || showUnsavedChangesDialog(documentState?.page || "原稿", async () => {
    await saveDocument();
    if (dirty) throw new Error("原稿を保存できなかったため、移動を中止しました。");
  });
}
function closeAllPanelDialogs(all = false): void {
  document.querySelectorAll<HTMLDialogElement>(all ? 'dialog.panel-dialog' : 'dialog.panel-dialog[id^="panel-"]').forEach((d) => {
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

    case "tree": return "file-tree";
    case "preview": return "editor";
    case "terminal": return "terminal";
    default: return name;
  }
}
function chooseTab(name: string): void {
  if (name === "applications" && !workspace) return;
  if (name === "brief" || name === "publish" || name === "appearance" || name === "settings" || name === "applications") {
    if(name==='settings')void imageAiSettings.refresh();
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
interface OpenDocumentTab { document: Document; content: string; start: number; end: number; scroll: number; richScroll: number; history: EditorHistory; richState: ReturnType<typeof milkdown.captureState>; }
const documentTabs = new Map<string, OpenDocumentTab>();
let restoringDocumentTabs = false;
function saveDocumentTabSession(active: string | null = documentState?.page || null): void {
  if (!projectRoot || restoringDocumentTabs || !workspace) return;
  if (!documentTabs.size && !workspace.pages.length && !workspace.project_entries.some(entry => !entry.directory && /\.md$/i.test(entry.path))) return;
  try { localStorage.setItem(`manual-studio-document-tabs:${projectRoot}`, JSON.stringify({pages:[...documentTabs.keys()],active})); }
  catch { /* Session preferences must not interrupt editing. */ }
}
const imageTabs = new Set<string>();
let activeImageTab: string | null = null;
function showDocumentView(): void { activeImageTab = null; element('panel-editor').removeAttribute('data-image-open'); element('image-tab-view').hidden = true; }
async function openImageTab(path: string): Promise<void> {
   retainDocumentTab();
  const root = projectRoot;
  const source = await rpc('preview-asset', { page: documentState?.page || `${workspace?.config.docs || 'docs'}/index.md`, asset: path }, root);
  if (root !== projectRoot) return;
  imageTabs.add(path); activeImageTab = path; chooseTab('editor'); layoutManager?.focusPanel('editor');
  element('panel-editor').dataset.imageOpen = 'true'; element('image-tab-view').hidden = false;
  element<HTMLImageElement>('image-tab-preview').src = source;
  element<HTMLImageElement>('image-tab-preview').alt = path.split('/').at(-1) || '画像';
  element('editor-title').textContent = path; renderDocumentTabs();
}

function retainDocumentTab(): void {
  if (!documentState) return;
  documentTabs.set(documentState.page, { document: documentState, content: editor.value, start: editor.selectionStart, end: editor.selectionEnd, scroll: editor.scrollTop, richScroll: milkdown.host.scrollTop, history: editHistory, richState: milkdown.captureState() });
}
function renderDocumentTabs(): void {
  const strip = element('document-tabs'); strip.replaceChildren();
  for (const [page, tab] of documentTabs) {
    const active = !activeImageTab && documentState?.page === page;
    const changed = active ? dirty : tab.content !== tab.document.content;
    const group = document.createElement('div'); group.className = 'document-tab';
    const button = document.createElement('button'); button.type = 'button'; button.role = 'tab'; button.setAttribute('aria-selected', String(active)); button.title = page;
    button.textContent = `${page.split('/').at(-1)}${changed ? ' *' : ''}`; button.dataset.documentPage = page;
    button.setAttribute('aria-label', `${page}${changed ? '（未保存の変更）' : ''}`);
    button.onclick = () => { void work(() => openPage(page)); };
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', `${page}を閉じる`);
    close.onclick = () => { void work(async () => {

      if (documentState?.page !== page) await openPage(page);
      if (!await confirmDiscard()) return;
      documentTabs.delete(page); documentState = null; documentSaveState = null; dirty = false;
      const next = [...documentTabs.keys()].at(-1);
      if (next) await openPage(next);
      else { editor.value = ''; resetEditHistory(); ++previewVersion; element<HTMLIFrameElement>('markdown-preview').srcdoc = ''; element('editor-title').textContent = 'Markdownを編集する'; updateSaveState(); renderPages();  }
    }); };
    group.append(button, close); strip.append(group);
  }
  for (const path of imageTabs) {
    const group = document.createElement('div'); group.className = 'document-tab';
    const button = document.createElement('button'); button.type = 'button'; button.role = 'tab'; button.textContent = path.split('/').at(-1) || path; button.title = path; button.dataset.imagePage = path; button.setAttribute('aria-selected', String(activeImageTab === path)); button.onclick = () => { void work(() => openImageTab(path)); };
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', `${path}を閉じる`);
    close.onclick = () => { void work(async () => { imageTabs.delete(path); if (activeImageTab === path) { showDocumentView(); if (documentState) { element('editor-title').textContent = documentState.page; chooseTab('editor'); } else if (imageTabs.size) await openImageTab([...imageTabs].at(-1)!); } renderDocumentTabs(); }); };
    group.append(button, close); strip.append(group);
  }
  strip.hidden = !documentTabs.size && !imageTabs.size;
  element('editor-title').hidden = !strip.hidden;
  saveDocumentTabSession();
  updateEditorEmptyState();
}
async function confirmAllDocumentTabs(): Promise<boolean> {
  retainDocumentTab();
  for (const [page, tab] of documentTabs) {
    if (tab.content === tab.document.content) continue;
    if (documentState?.page !== page) await openPage(page);
    if (!await confirmDiscard()) return false;
  }
  return true;
}
function updateSaveState(): void {
  const ownerState = documentSaveState?.owner === documentState ? documentSaveState : null;
  clearTimeout(documentAutosaveTimer);
  if (dirty && documentState && !ownerState) {
    const owner = documentState;
    const root = projectRoot;
    documentAutosaveTimer = setTimeout(() => {
      if (documentState !== owner || projectRoot !== root || !dirty) return;
      if (busy || document.querySelector('dialog[open]')) { updateSaveState(); return; }
      void saveDocument(false).catch(error => status(`自動保存できませんでした：${String(error)}`, true));
    }, 800);
  }
  renderDocumentTabs();
  const badge = element("save-state");
  badge.hidden = !documentState;
  badge.dataset.state = !documentState ? 'empty' : ownerState?.state || (dirty ? 'dirty' : 'saved');
  const conflicted = ownerState?.state === 'error' && /変更されています|conflict|revision/i.test(ownerState.message || '');
  badge.textContent = !documentState ? '原稿を選択してください' : ownerState?.state === 'saving' ? '保存中…' : conflicted ? '外部変更と競合：編集内容を保持' : ownerState?.state === 'error' ? '保存できませんでした' : dirty ? '● 未保存の変更' : '保存済み';
  badge.title = ownerState?.message || (dirty ? '自動保存を待っています。' : '原稿の保存状態');
  badge.setAttribute('role', 'status'); badge.setAttribute('aria-live', 'polite');
  element('save-retry').hidden = ownerState?.state !== 'error' || conflicted;
  element('save-conflict').hidden = !conflicted;
  updateEditorEmptyState(); updateSelectionAction();


  updateWorkspaceGuide();
  manuscriptOutline?.refresh();
}
function updateWorkspaceGuide(): void {
  const guide = element<HTMLElement>('workspace-guide');
  let dismissed = false;
  try { dismissed = localStorage.getItem(`manual-studio-guide:${projectRoot}`) === 'hidden'; } catch { /* Optional preference. */ }
  guide.hidden = detached || !workspace || dismissed || workspace.config.connection_type !== 'none' && workspace.has_config;
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
  updateSelectionAction();
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

  const docsPrefix = (workspace?.config.docs || 'docs').replace(/\/$/,'') + '/';
  if (page.startsWith(docsPrefix) && workspace?.pages.includes(page.slice(docsPrefix.length))) page = page.slice(docsPrefix.length);
  if (check && documentState?.page === page && !activeImageTab) { chooseTab('editor'); return; }
  while (documentSavePending) await documentSavePending;
  if (dirty && documentState && documentSaveState?.state !== 'error') await saveDocument(false);
  retainDocumentTab();
  showDocumentView();
  let cached = check ? documentTabs.get(page) : undefined;
  const root = projectRoot;
  const version = ++documentRequestVersion;
  const opened = cached && cached.content !== cached.document.content
    ? cached.document
    : JSON.parse(await rpc("editor-read", { page }, root)) as Document;
  if (cached && cached.document.revision !== opened.revision) cached = undefined;
  if (root !== projectRoot || version !== documentRequestVersion) return;
  ++previewVersion;
  documentState = opened;
  editor.dataset.owner = JSON.stringify([root, page]);
  editor.value = cached?.content ?? opened.content;
  editHistory = cached?.history || new EditorHistory();
  if (!cached) resetEditHistory();
  if (cached?.richState) milkdown.restoreState(cached.richState);
  editor.setSelectionRange(cached?.start || 0, cached?.end || 0);
  editor.scrollTop = cached?.scroll || 0; milkdown.host.scrollTop = cached?.richScroll || 0;
  editor.disabled = false;
  dirty = editor.value !== opened.content;
  retainDocumentTab();
  element("editor-title").textContent = page;
  editor.dataset.owner = JSON.stringify([projectRoot, page]);
  document.title = `${page} — Munin Manual Studio`;
  updateSaveState(); updateCursor(); renderPages();
  element("page-list").querySelector("[aria-current=page]")?.scrollIntoView({ block: "nearest" });
  await renderPreview();
  previewNavigator.pushPage(page);
  chooseTab("editor");
  loadReaderReviewSession(projectRoot, page);

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
function chooseImageDestination(): Promise<boolean> { return chooseDestination({
    root: projectRoot,
    pages: [...new Set([...(workspace?.pages || []), ...documentTabs.keys(), ...(workspace?.project_entries.filter(entry=>!entry.directory && /\.md$/i.test(entry.path)).map(entry=>entry.path.startsWith(`${workspace!.config.docs}/`) ? entry.path.slice(workspace!.config.docs.length+1) : entry.path) || [])])],
    current: () => documentState ? {page:documentState.page,content:editor.value} : null,
    read: async page => documentTabs.get(page)?.content ?? (JSON.parse(await rpc('editor-read',{page})) as Document).content,
    open: async page => { if (page!==documentState?.page || activeImageTab) await openPage(page); },
    select: (offset,heading) => { editor.setSelectionRange(offset,offset);milkdown.selectInsertionHeading(heading); },
  }); }
function insertDocumentMarkdown(markdown:string): void {
    pendingEditorFocus = true;
    showDocumentView(); chooseTab("editor");
    if (documentState) element("editor-title").textContent = documentState.page;
    if (preferredEditorView === "preview") { preferredEditorView = "edit"; applyEditorView(); }
    const richInsertion = milkdown.captureSelectionEdit(true);
    if (richInsertion) richInsertion.apply(markdown, true);
    else {
      rememberCurrentSelection();
      editor.setRangeText("\n\n" + markdown + "\n\n", editor.selectionStart, editor.selectionStart, "end");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.focus();
    }
    status("画像を原稿に挿入しました。原稿は自動保存されます。");
  }
async function insertResourceAsset(path:string):Promise<boolean>{
  if(!await chooseImageDestination()||!documentState)return false;
  insertDocumentMarkdown(`![${path.split('/').at(-1)||'画像'}](<${relativeProjectAsset(path,documentState.page)}>)`);return true;
}
interface QualityIssue extends Partial<ResourceUsage> {page:string;tag?:string;kind?:string;message:string}
function renderQualityReport(target:HTMLElement,report:{passed:boolean;issues:QualityIssue[]},root:string){
  target.replaceChildren();
  const summary=document.createElement('p');summary.textContent=report.passed?'公開前チェックに合格しました。':`公開前チェックで${report.issues.length}件の問題が見つかりました。`;target.append(summary);
  for(const issue of report.issues){
    const row=document.createElement('div');row.className='quality-issue';
    const jump=document.createElement('button');jump.type='button';jump.textContent=`${issue.page}${issue.line?`:${issue.line}`:''} — 該当箇所を開く`;
    jump.onclick=()=>{void work(async()=>{if(root!==projectRoot)return;await openResourceUsage({page:issue.page,line:issue.line||1,start:issue.start??-1,end:issue.end??-1,snippet:issue.snippet||''});});};
    const message=document.createElement('span');message.textContent=issue.message;row.append(jump,message);target.append(row);
  }
}
async function openResourceUsage(usage:ResourceUsage):Promise<void>{
  const root=projectRoot;const docsPrefix=(workspace?.config.docs||'docs').replace(/\/$/,'')+'/';
  const expectedPage=usage.page.startsWith(docsPrefix)&&workspace?.pages.includes(usage.page.slice(docsPrefix.length))?usage.page.slice(docsPrefix.length):usage.page;
  await openPage(usage.page);
  if(root!==projectRoot||documentState?.page!==expectedPage)return;
  showDocumentView();chooseTab('editor');
  if(preferredEditorView==='preview'){preferredEditorView='edit';applyEditorView();}
  milkdown.showSource();
  let start=usage.snippet&&editor.value.slice(usage.start,usage.start+usage.snippet.length)!==usage.snippet?editor.value.indexOf(usage.snippet,Math.max(0,usage.start-100)):usage.start;
  if(start<0&&usage.snippet)start=editor.value.indexOf(usage.snippet);
  if(start<0){start=editor.value.split('\n').slice(0,usage.line-1).join('\n').length;}
  jumpToSource(editor,start,start+(usage.snippet?.length||0));updateCursor();
}
const screenshotLibrary = setupScreenshotLibrary({
  root: () => projectRoot, request: rpc, work, applications: () => launchCommands,
  refreshAssets: async root => {
    if (root !== projectRoot) return;
    if (documentState) await Promise.all([renderPreview(), milkdown.refreshImages()]);
    const image = activeImageTab;
    if (image) {
      const src = await rpc('preview-asset', {page:documentState?.page || `${workspace?.config.docs || 'docs'}/index.md`,asset:image}, root);
      if (root === projectRoot && activeImageTab === image) element<HTMLImageElement>('image-tab-preview').src = src;
    }
  },
  annotateScreenshot:id=>screenshotAi.annotate(id),
  page: () => documentState?.page,
  openPage: async page => { await openPage(page); },
  chooseDestination: chooseImageDestination,
  insert: insertDocumentMarkdown,
  insertAsset:insertResourceAsset,openImage:openImageTab,
  editImage:async path=>{await handleEditDocumentImage(path,element<HTMLImageElement>('image-tab-preview'));},
  openUsage:openResourceUsage,generateImage:(entry,edit)=>imageGeneration.open(entry,edit),
});
setupToolbarCustomization();
const imageAiSettings=setupImageAiSettings({root:()=>projectRoot,request:rpc,prepare:saveAiSettings});
const imageGeneration=setupImageGeneration({prepare:async()=>{await saveAiSettings();await imageAiSettings.flush();},imageKey:(root,url)=>imageAiSettings.key(root,url),sharedKey:root=>root===projectRoot?readAiCredential(root,workspace?.config.endpoint_url||''):'',root:()=>projectRoot,page:()=>documentState?.page,request:rpc,work,refresh:()=>refreshWorkspace(),insert:async path=>{if(!await chooseImageDestination()||!documentState)return false;insertDocumentMarkdown(`![AI生成画像](<${relativeProjectAsset(path,documentState.page)}>)`);return true;}});

let documentImageEditing = false;
let retryDocumentImageEdit: (() => Promise<void>) | null = null;
element('document-image-retry').addEventListener('click', () => {
  if (retryDocumentImageEdit) void work(retryDocumentImageEdit);
});
function changeImageMarkdown(next:string,expected:string){
  if(editor.value!==expected)throw new Error('原稿が変更されました。画像を選び直してください。');
  if(!milkdown.replaceMarkdownDocument(next,expected)){rememberCurrentSelection();editor.setRangeText(next,0,editor.value.length,'end');editor.dispatchEvent(new Event('input',{bubbles:true}));}
}
function showImagePresentation(image?:HTMLImageElement){
  if(!documentState||activeImageTab||busy)return;
  const selected=image?milkdown.imageSourceRange(image):milkdown.selectedImageSourceRange()||imageAtSelection(editor.value,editor.selectionStart,editor.selectionEnd);
  if(!selected){status('画像にカーソルを合わせるか、画像記法を選択してください。',true);return;}
  const root=projectRoot,page=documentState.page,expected=editor.value;
  const {dialog,body}=featureDialog('画像の表示設定');dialog.dataset.imagePresentation='true';
  const widthLabel=document.createElement('label');widthLabel.textContent='表示幅（本文に対する％）';const width=document.createElement('input');width.type='number';width.min='1';width.max='100';width.value=String(selected.width);width.setAttribute('aria-label','表示幅（％）');widthLabel.append(width);
  const alignLabel=document.createElement('label');alignLabel.textContent='配置';const align=document.createElement('select');for(const [value,label] of [['left','左寄せ'],['center','中央寄せ'],['right','右寄せ']])align.add(new Option(label,value));align.value=selected.align;align.setAttribute('aria-label','画像の配置');alignLabel.append(align);
  const captionLabel=document.createElement('label');captionLabel.textContent='キャプション';const caption=document.createElement('input');caption.value=selected.caption;caption.setAttribute('aria-label','画像のキャプション');captionLabel.append(caption);
  const help=document.createElement('p');help.textContent='画像の下に説明を表示します。表示幅と配置はプレビュー・公開にも反映されます。';
  const feedback=document.createElement('p');feedback.role='status';const apply=document.createElement('button');apply.type='button';apply.className='primary';apply.textContent='表示設定を適用';
  apply.onclick=()=>{try{if(root!==projectRoot||documentState?.page!==page)throw new Error('原稿が切り替わりました。');const value=Number(width.value);if(!Number.isInteger(value)||value<1||value>100)throw new Error('表示幅は1〜100の整数で指定してください。');
    const raw=renderFigure({...selected,width:value,align:align.value as DocumentImage['align'],caption:caption.value,configured:true});const before=expected.slice(0,selected.start),after=expected.slice(selected.end);const gapBefore=before&&!before.endsWith('\n\n')?(before.endsWith('\n')?'\n':'\n\n'):'';const gapAfter=after&&!after.startsWith('\n\n')?(after.startsWith('\n')?'\n':'\n\n'):'';changeImageMarkdown(before+gapBefore+raw+gapAfter+after,expected);dialog.close();void milkdown.refreshImages();status('画像の表示設定を更新しました。');
  }catch(error){feedback.textContent=String(error);}};
  body.append(widthLabel,alignLabel,captionLabel,help,feedback,apply);
}
element('image-presentation').addEventListener('click',()=>showImagePresentation());
async function handleEditDocumentImage(imageSource: string, _img: HTMLImageElement): Promise<void> {
  if (documentImageEditing) {
    status(retryDocumentImageEdit ? "保存待ちの画像があります。「画像の編集保存を再試行」で保存してください。" : "他の画像をMarkItsで編集中です。MarkItsの編集を完了してください。", true);
    return;
  }
  if (!native) {
    status("MarkItsによる画像編集はデスクトップ版（Tauri）でのみ利用できます。", true);
    return;
  }
  if (!projectRoot) {
    status("プロジェクトが開かれていません。", true);
    return;
  }
  documentImageEditing = true;
  const editingRoot = projectRoot;
  try {
    status("MarkItsを起動しています…");
    const result = await invoke<{
      sourceFile: string;
      annotationFile: string;
      completionFile: string;
      targetFile: string;
      relativePath: string;
      managedScreenshotId?: string;
      revision?: string;
    }>("edit_document_image", {
      root: editingRoot,
      relativePath: imageSource,
      page: documentState?.page || null,
    });
    if (result.managedScreenshotId) {
      await screenshotLibrary.editManaged(result.managedScreenshotId, result.revision, editingRoot);
      documentImageEditing = false;
      status('MarkItsで編集中です。編集終了後に候補を保存します。リソース一覧で比較して採用してください。');
      return;
    }
    status("MarkItsで画像を編集中です。編集が完了したらMarkItsで「編集終了」または「Manual Studioへ注釈を返す」を押してください。");
    const checkReady = async () => {
      try {
        const ready = await invoke<boolean | null>("document_image_edit_ready", {
          completionFile: result.completionFile,
          annotationFile: result.annotationFile,
        });
        if (!ready) {
          window.setTimeout(() => { void checkReady(); }, 600);
          return;
        }
        await invoke("apply_document_image_edit", {
          targetFile: result.targetFile,
          annotationFile: result.annotationFile,
        });
        documentImageEditing = false;
        retryDocumentImageEdit = null;
        element('document-image-retry').hidden = true;
        if (editingRoot !== projectRoot) return;
        status(`編集コピーを保存しました: ${result.relativePath}。元画像と原稿は保持しています。リソース一覧から挿入・差し替えできます。`);
        await milkdown.refreshImages();
        void renderPreview();
        await refreshWorkspace();
        if (activeImageTab) {
          void openImageTab(activeImageTab);
        }
      } catch (err) {
        const message = String(err);
        const ended = message.includes('編集を中止しました') || message.includes('編集完了前に終了しました') || message.includes('保存前に終了しました');
        if (ended) {
          documentImageEditing = false;
          retryDocumentImageEdit = null;
          element('document-image-retry').hidden = true;
        } else {
          retryDocumentImageEdit = checkReady;
          element('document-image-retry').hidden = false;
        }
        status(ended ? message : `画像の編集保存に失敗しました: ${message}。編集結果は保持しています。保存を再試行できます。`, true);
      }
    };
    void checkReady();
  } catch (err) {
    documentImageEditing = false;
    status(`MarkItsの起動に失敗しました: ${String(err)}`, true);
  }
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
  renderPages();  updateWorkspaceGuide();
  await screenshotLibrary.refresh();
  if (reloadPage && current) {
    if (documentState !== current || documentVersion !== documentRequestVersion || editor.value !== content) return;
    const opened = JSON.parse(await rpc("editor-read", { page: current.page }, root)) as Document;
    if (root !== projectRoot || documentState !== current || documentVersion !== documentRequestVersion || editor.value !== content) return;
    documentState = opened; editor.value = opened.content; resetEditHistory(); dirty = false; updateSaveState();  await Promise.all([renderPreview(), milkdown.refreshImages()]);
  }
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
  void imageAiSettings.refresh();
  setButtonDisabled(element<HTMLButtonElement>("open-applications"), false);
  input("ai-model").value = workspace.config.model;
  if (!briefDirty && !briefSaving) {
    element<HTMLTextAreaElement>("manual-brief").value = workspace.brief;
    setBriefSaveState("保存済み");
  }
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
let briefSaveTimer: ReturnType<typeof setTimeout> | undefined;
let briefSaveQueue: Promise<void> = Promise.resolve();
let briefDirty = false;
let briefSaving = 0;
let briefEditVersion = 0;
function setBriefSaveState(message: string, failed = false): void {
  element("brief-save-state").textContent = message;
  element("brief-save-retry").hidden = !failed;
}
function saveBriefSettings(): Promise<void> {
  clearTimeout(briefSaveTimer);
  if (!workspace || !briefDirty) return briefSaveQueue;
  const root = projectRoot, version = briefEditVersion;
  const brief = element<HTMLTextAreaElement>("manual-brief").value;
  briefDirty = false; briefSaving++;
  const operation = Promise.all([briefSaveQueue.catch(() => {}), aiSaveQueue.catch(() => {})]).then(async () => {
    if (projectRoot === root && briefEditVersion === version) setBriefSaveState("保存中…");
    try {
      await rpc("save", { brief }, root);
      if (projectRoot === root && briefEditVersion === version) {
        workspace!.brief = brief;
        setBriefSaveState("保存済み");
      }
    } catch (error) {
      if (projectRoot === root && briefEditVersion === version) {
        briefDirty = true;
        setBriefSaveState(`保存失敗: ${String(error)}`, true);
      }
      throw error;
    } finally { briefSaving--; }
  });
  briefSaveQueue = operation;
  return operation;
}
function scheduleBriefSave(): void {
  if (!workspace) return;
  briefDirty = true; briefEditVersion++;
  setBriefSaveState("未保存（自動保存待ち）");
  clearTimeout(briefSaveTimer);
  briefSaveTimer = setTimeout(() => { void saveBriefSettings().catch(() => {}); }, 400);
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
  const operation = Promise.all([aiSaveQueue.catch(() => {}), briefSaveQueue.catch(() => {})]).then(async () => {
    if (projectRoot === root && aiEditVersion === version) setAiSaveState("保存中…");
    try {
      // AI-only options preserve the existing project settings.
      const saved = JSON.parse(await rpc("save", options, root)) as State;
      if (projectRoot === root) {
        workspace!.config = saved.config;
        workspace!.has_config = saved.has_config;
        void imageAiSettings.updateShared();
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
  await saveBriefSettings();
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

  if (check && !await confirmAllDocumentTabs()) return;
  await saveAiSettings();
  await saveBriefSettings();
  status("プロジェクトを開いています…");
  const version = ++projectRequestVersion;
  const loaded = JSON.parse(await rpc("state", {}, root)) as State;
  if (version !== projectRequestVersion) return;
  ++documentRequestVersion; ++workspaceRequestVersion;
  if (projectRoot !== root) expandedFolders.clear();
  if (terminalController && projectRoot !== root) await terminalController.kill();
  closeAllPanelDialogs(true);
  saveDocumentTabSession();
  restoringDocumentTabs = true;
  documentTabs.clear(); imageTabs.clear(); showDocumentView();
  projectRoot = root; workspace = loaded; documentState = null; dirty = false;
  await loadLaunchCommands();
  if (version !== projectRequestVersion) return;
  documentSaveState = null;
  setAiPhase(element('ai-workflow-status'), 'idle');
  previewNavigator.setStatus('empty');
  clearTimeout(previewTimer); ++previewVersion;
  editor.value = "";
  resetEditHistory();
  element<HTMLIFrameElement>("markdown-preview").srcdoc = "";
  element("editor-title").textContent = "Markdownを編集する";
  document.title = "Munin Manual Studio";
  updateSaveState(); updateCursor();
  input("project-root").value = root;
  localStorage.setItem("manual-studio-project", root);
  try { await recordWorkspaceHistory(native, root); }
  catch (error) { status(`最近開いたフォルダーの履歴を保存できません: ${String(error)}`, true); }
  if (params.get("root") !== root) {
    params.set("root", root);
    params.delete("page");
    const url = new URL(location.href);
    url.search = params.toString();
    history.replaceState(null, "", url);
  }
  element("workspace-name-label").textContent = root.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || root;
  element<HTMLDialogElement>("workspace-dialog").close();
  await refreshWorkspace(); renderSettings(); loadAiProgressLogs(root);
  const validPage = (page:unknown): page is string => typeof page === 'string' && (loaded.pages.includes(page) || loaded.project_entries.some(entry => !entry.directory && entry.path === page && /\.md$/i.test(entry.path)));
  let saved: {pages:string[];active:string|null} | null = null;
  try {
    const value = JSON.parse(localStorage.getItem(`manual-studio-document-tabs:${root}`) || 'null');
    if (value && Array.isArray(value.pages)) saved = {pages:[...new Set(value.pages.filter(validPage))] as string[],active:validPage(value.active)?value.active:null};
  } catch { /* Ignore invalid optional session data. */ }
  const preferred = params.get("page");
  let page = validPage(preferred) ? preferred : saved?.active || saved?.pages.at(-1);
  try {
    for (const tab of saved?.pages || []) {
      if (version !== projectRequestVersion) return;
      try {
        const opened = JSON.parse(await rpc('editor-read', {page:tab}, root)) as Document;
        if (version !== projectRequestVersion) return;
        const history = new EditorHistory(); history.reset({value:opened.content,start:0,end:0});
        documentTabs.set(tab, {document:opened,content:opened.content,start:0,end:0,scroll:0,richScroll:0,history,richState:null});
      } catch { /* A removed/unreadable page does not prevent restoring the remaining tabs. */ }
    }
    if (page && saved?.pages.includes(page) && !documentTabs.has(page)) page = [...documentTabs.keys()].at(-1);
    if (!page && !saved) page = loaded.pages[0] || loaded.project_entries.find(entry => !entry.directory && /\.md$/i.test(entry.path))?.path;
    if (page) await openPage(page, false);
    else if (!documentTabs.size) { editor.value = ""; updateSaveState(); status("一覧から原稿を開くか、「＋」で原稿を作成してください。"); }
  } finally {
    if (version === projectRequestVersion) { restoringDocumentTabs = false; saveDocumentTabSession(); }
  }
  const restoredDocument = documentState as Document | null;
  if (restoredDocument) status(`プロジェクトを開きました。${restoredDocument.page}を編集できます。`);
  if (!loaded.has_config && !detached) status("原稿の編集・保存・プレビューから始められます。AI接続は「設定 → AI・撮影設定」で確認できます。");

}
async function saveDocument(refresh = true): Promise<void> {
  while (documentSavePending) await documentSavePending;
  const pending = persistDocument(refresh);
  documentSavePending = pending;
  try { await pending; }
  finally { if (documentSavePending === pending) documentSavePending = undefined; }
}
async function persistDocument(refresh: boolean): Promise<void> {
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
  documentState = saved; dirty = editor.value !== saved.content; retainDocumentTab(); updateSaveState();
  if (refresh) await refreshWorkspace();
  status(`${page}を保存しました。`);
}
async function runAction(action: string, options: Record<string, unknown> = {}, resultId?: string): Promise<void> {
  await savedBeforeOperation();
  const isAiAction = action === "draft";
  if (isAiAction) await ensureAiSettings();
  if (isAiAction) {
    activeGenerationRoot = projectRoot;
    element("progress-cancel").hidden = false;
    element<HTMLButtonElement>("progress-cancel").disabled = false;
    await beginAiProgress(action, projectRoot);
  }
  if (isAiAction) logProgress("AIエージェントへ指示を送り、応答を待っています。");
  status(isAiAction ? "AIを実行中…" : "処理中…");
  let succeeded = false;
  let completionMessage = `${action === "build-mkdocs" ? "MkDocsでHTMLを作成しました" : action === "recapture" || action === "capture-window" ? "画像を更新し、撮影元を保存しました" : "処理が完了しました"}。`;
  let completionHasError = false;
  try {
    const actionRoot=projectRoot;
    const output = await rpc(action, options,actionRoot);
    if(actionRoot!==projectRoot)return;
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
      if(action==='quality-check')renderQualityReport(element(resultId),JSON.parse(output),actionRoot);
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
    if (isAiAction) { await pollAgentProgress(); logAiFailure(error); }
    if (resultId) element(resultId).textContent = `失敗: ${String(error)}`;
    throw error;
  } finally {
    if (isAiAction) await stopAiProgress(succeeded);
    await restoreManualStudioAfterCapture().catch(() => {});
  }
}
setupControlIcons();
for (const [selector, name] of [["#undo-edit", "undo"], ["#redo-edit", "redo"], ["#insert-image", "image"], ['[data-format="link"]', "link"]] as const) {
  const button = document.querySelector<HTMLButtonElement>(selector);
  if (button) button.innerHTML = uiIcon(name) + (name === "image" ? " 画像" : name === "link" ? " リンク" : "");
}
document.querySelectorAll<HTMLElement>("[data-tab]").forEach((button) => button.addEventListener("click", () => chooseTab(button.dataset.tab!)));

document.querySelectorAll<HTMLDialogElement>('dialog.panel-dialog[id^="panel-"]').forEach((dialog) => {
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

element("open-existing-workspace").addEventListener("click", () => {
  input("project-root").value = projectRoot;
  element<HTMLDialogElement>("workspace-dialog").showModal();
  input("project-root").focus();
});
element("cancel-open-workspace").addEventListener("click", () => element<HTMLDialogElement>("workspace-dialog").close());
element("workspace-name").addEventListener("click", () => {
  if (document.getElementById("workspace-history-dialog")) return;
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
element("page-list").addEventListener("click", (event) => {
  const image = (event.target as HTMLElement).closest<HTMLElement>('[data-image]');
  if (image) { void work(() => openImageTab(image.dataset.image!)); return; }
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
});
element("editor-more").addEventListener("keydown", event => {
  if (event.key === "Escape") {
    element<HTMLDetailsElement>("editor-more").open = false;
    element("editor-more").querySelector<HTMLElement>("summary")?.focus();
  }
});
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  const openMenu = document.querySelector<HTMLDetailsElement>(".format-insert-menu[open]");
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
  document.querySelectorAll<HTMLButtonElement>("#panel-editor button[data-editor-view]").forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.editorView === view));
  });
}
document.querySelectorAll<HTMLButtonElement>("#panel-editor button[data-editor-view]").forEach(button => {
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
function updateSelectionAction(): void {
  const selected = milkdown.isRichEditing ? Boolean(milkdown.captureSelectionEdit()?.text) : editor.selectionEnd > editor.selectionStart;
  const button = element('selection-ai');
  const label = selected ? '選択範囲をAIで編集' : 'AIで文章を挿入';
  button.innerHTML = `${uiIcon('sparkle')} ${label}`;
  button.title = selected ? '選択した文章を確認して変更候補を作成' : 'カーソル位置を確認して挿入候補を作成';
}
function updateEditorEmptyState(): void {
  const empty = !documentState && !activeImageTab;
  element('editor-empty-state').hidden = !empty;
  element('editor-empty-title').textContent = workspace ? '原稿を選ぶか、作成してください' : 'フォルダーを開いて始める';
  element('editor-empty-description').textContent = workspace ? '左のファイルツリーから原稿を選択できます。' : '原稿と画像を保存しているフォルダーを選択してください。';
  element('empty-open-folder').hidden = Boolean(workspace);
  element('empty-select-page').hidden = !workspace || !workspace.pages.length;
  element('empty-create-page').hidden = !workspace;
  element('panel-editor').classList.toggle('editor-is-empty', empty);
}
element('empty-open-folder').addEventListener('click', () => element('open-existing-workspace').click());
element('empty-create-page').addEventListener('click', () => { contextCreateParent = null; element('new-page').click(); });
element('empty-select-page').addEventListener('click', () => { layoutManager?.focusPanel('file-tree'); element('tree-search').focus(); });
element('save-retry').addEventListener('click', () => { void work(() => saveDocument(false)); });
element('save-conflict').addEventListener('click', () => { void work(async () => {
  if (!documentState) return;
  const owner = documentState, root = projectRoot, draft = editor.value;
  const stored = JSON.parse(await rpc('editor-read', { page: owner.page }, root)) as Document;
  if (root !== projectRoot || owner !== documentState || draft !== editor.value) return;
  const {dialog,body} = featureDialog('外部変更を確認'); dialog.id = 'save-conflict-dialog';
  const note = document.createElement('p'); note.textContent = '編集中の内容は保持しています。保存先の内容と比較してください。';
  const columns = document.createElement('div'); columns.className = 'selection-diff-columns';
  for (const [label,content] of [['編集中の内容',draft],['保存先の内容',stored.content]]) {
    const column = document.createElement('section'), heading = document.createElement('h3'), pre = document.createElement('pre'); heading.textContent = label; pre.textContent = content; column.append(heading,pre); columns.append(column);
  }
  const keep = document.createElement('button'); keep.textContent = '編集中の内容を保持して閉じる'; keep.onclick = () => dialog.close();
  const reload = document.createElement('button'); reload.textContent = '保存先の内容を読み直す'; reload.onclick = () => { dialog.close(); element('reload-page').click(); };
  body.append(note,columns,keep,reload);
}); });
editor.addEventListener('select', updateSelectionAction);
editor.addEventListener('editor-selection-change', updateSelectionAction);
editor.addEventListener('editor-mode-change', updateSelectionAction);
document.addEventListener('selectionchange', () => { if (milkdown.host.contains(document.activeElement) || document.activeElement === editor) updateSelectionAction(); });
element('workspace-name').addEventListener('keydown', event => { if (event.key === 'ArrowDown' && !document.getElementById('workspace-history-dialog')) { event.preventDefault(); element('workspace-name').click(); } });
for (const id of ['tree-create-menu','resource-management-menu']) {
  const menu = element<HTMLDetailsElement>(id);
  menu.addEventListener('click', event => { if ((event.target as HTMLElement).closest('button')) menu.open = false; });
  menu.addEventListener('keydown', event => { if (event.key === 'Escape') { menu.open = false; menu.querySelector<HTMLElement>('summary')?.focus(); } });
  document.addEventListener('click', event => { if (!menu.contains(event.target as Node)) menu.open = false; });
}
element("reload-page").addEventListener("click", () => { if (documentState) void work(async () => {
  if (!await confirmDiscard() || !documentState) return;
  await openPage(documentState.page, false);
}); });
element("undo-edit").addEventListener("click", () => stepEditHistory(-1));
element("redo-edit").addEventListener("click", () => stepEditHistory(1));
element("detach-editor").addEventListener("click", () => { void work(async () => {
  await savedBeforeOperation();
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

  clearTimeout(previewTimer); previewTimer = setTimeout(() => { void renderPreview(); }, 250);
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

window.addEventListener("manual-studio-status", (event: Event) => {
  const detail = (event as CustomEvent<{ message: string; error?: boolean }>).detail;
  if (detail?.message) status(detail.message, detail.error);
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
  if (key === 's' && !event.shiftKey) { event.preventDefault(); if (documentState && !activeImageTab) void work(saveDocument); return; }
  if (!event.shiftKey || !['p', 'r', 'g'].includes(key)) return;
  event.preventDefault();
  if (!documentState || busy) return;
  if (key === 'p') {
    const views: EditorView[] = ['edit', 'split', 'preview'];
    const next = views[(views.indexOf(element('panel-editor').dataset.editorView as EditorView) + 1) % views.length];
    document.querySelector<HTMLButtonElement>(`#panel-editor button[data-editor-view="${next}"]`)!.click();
  } else if (key === 'r') { void work(renderPreview); }
  else { void createSelectionDocument(); }
}
document.addEventListener('keydown', handleDocumentShortcut);
element('shortcut-help').addEventListener('click', showShortcutHelp);
element('workspace-guide').querySelector('[data-guide-settings]')!.addEventListener('click', () => chooseTab('settings'));
element('workspace-guide').querySelector('[data-guide-dismiss]')!.addEventListener('click', () => {
  try { localStorage.setItem(`manual-studio-guide:${projectRoot}`, 'hidden'); } catch { /* Optional preference. */ }
  element('workspace-guide').hidden = true;
});
document.querySelectorAll<HTMLButtonElement>('#panel-editor button[data-editor-view]').forEach(button => { button.title = `${button.getAttribute("aria-label") || button.textContent} (Ctrl/Cmd+Shift+Pで順に切替)`; });
let closingApproved = false;
let closingPrompt = false;
window.addEventListener("beforeunload", (event) => { if ((briefDirty || briefSaving > 0 || dirty || [...documentTabs.entries()].some(([page,tab]) => page !== documentState?.page && tab.content !== tab.document.content)) && !closingApproved) { event.preventDefault(); event.returnValue = ""; } });
window.addEventListener("pagehide", () => terminalController?.disconnectOnUnload());
if (native) void getCurrentWindow().onCloseRequested(event => {
  if (closingApproved) return;
  event.preventDefault();
  if (closingPrompt) return;
  if (busy) { status("処理の完了または中断後にアプリを閉じてください。", true); return; }
  closingPrompt = true;
  void (async () => {
    try {
      const activeAtClose = documentState?.page || null;
      await saveBriefSettings();
      if (!await confirmAllDocumentTabs()) return;
      saveDocumentTabSession(activeAtClose);
      await terminalController?.kill();
      closingApproved = true;
      await getCurrentWindow().destroy();
    } catch (error) { closingApproved = false; status(String(error), true); }
    finally { closingPrompt = false; }
  })();
});
function renderLaunchCommands(): void {
  const list = element("launch-command-list");
  list.replaceChildren();
  launchCommands.forEach((command, index) => {
    const row = document.createElement("div"); row.className = "launch-command-row";
    const nameLabel = document.createElement("label"); nameLabel.textContent = "表示名（省略可）";
    const name = document.createElement("input"); name.value = command.name; name.dataset.launchName = String(index); nameLabel.append(name);
    const programLabel = document.createElement("label"); programLabel.className = "launch-program-field"; programLabel.textContent = "起動パス";
    const programWrap = document.createElement("div"); programWrap.className = "app-picker-row";
    const program = document.createElement("input"); program.value = command.program; program.placeholder = "例: firefox または /usr/bin/firefox"; program.dataset.launchProgram = String(index);
    const browse = document.createElement("button"); browse.type = "button"; browse.textContent = "選択"; browse.dataset.launchBrowse = String(index);
    programWrap.append(program, browse); programLabel.append(programWrap);
    const argsLabel = document.createElement("label"); argsLabel.textContent = "起動引数（1行に1つ）";
    const args = document.createElement("textarea"); args.rows = 2; args.value = command.args.join("\n"); args.dataset.launchArgs = String(index); argsLabel.append(args);
    name.addEventListener("input", () => { command.name = name.value; });
    program.addEventListener("input", () => { command.program = program.value; });
    args.addEventListener("input", () => { command.args = args.value.split("\n").filter(value => value.length > 0); });
    const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "削除"; remove.dataset.launchRemove = String(index);
    const test = document.createElement("button"); test.type = "button"; test.textContent = "起動確認";
    test.addEventListener("click", () => { void work(async () => { if (!native) throw new Error("起動確認はデスクトップ版で利用できます。"); await invoke("test_launch_application", { program: program.value, args: args.value.split("\n").filter(value => value.length > 0) }); status("対象アプリを起動しました。"); }); });
    const actions = document.createElement("div"); actions.className = "actions launch-row-actions"; actions.append(test, remove);
    row.append(nameLabel, programLabel, argsLabel, actions); list.append(row);
  });
  list.querySelectorAll<HTMLButtonElement>("[data-launch-browse]").forEach((button) => button.addEventListener("click", () => { void work(async () => {
    if (!native) throw new Error("アプリ選択はデスクトップアプリで利用できます。");
    const path = await invoke<string | null>("choose_application");
    if (path) {
      const program = list.querySelector<HTMLInputElement>(`[data-launch-program="${button.dataset.launchBrowse}"]`)!;
      program.value = path;
      program.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }); }));
  list.querySelectorAll<HTMLButtonElement>("[data-launch-remove]").forEach((button) => button.addEventListener("click", () => {
    launchCommands.splice(Number(button.dataset.launchRemove), 1); renderLaunchCommands();
  }));
}
async function loadLaunchCommands(): Promise<void> {
  const root = projectRoot;
  launchCommands = [];
  renderLaunchCommands();
  if (!native || !root) return;
  const commands = await invoke<LaunchCommand[]>("load_launch_commands", { root });
  if (projectRoot !== root) return;
  launchCommands = commands;
  renderLaunchCommands();
}
element<HTMLImageElement>('image-tab-preview').addEventListener('load',()=>{ const image=element<HTMLImageElement>('image-tab-preview');element('image-tab-size').textContent=`${image.naturalWidth} × ${image.naturalHeight}`; });
element('image-tab-zoom').addEventListener('click',()=>{const canvas=element('image-tab-preview').parentElement!;const actual=canvas.dataset.actual!=='true';canvas.dataset.actual=String(actual);element('image-tab-zoom').textContent=actual?'画面に合わせる':'実寸表示';});
let contextCreateParent: string | null = null;
element("new-page").addEventListener("click", (event) => {
  element<HTMLDetailsElement>("tree-create-menu").open = false;
  if (event.isTrusted) contextCreateParent = null;
  if (!projectRoot) { status("先にプロジェクトを開いてください。", true); return; }
  if (contextCreateParent !== null) { input('new-page-path').value = contextCreateParent ? contextCreateParent + '/' : ''; input('new-page-title').value = ''; }
  element<HTMLDialogElement>("new-page-dialog").showModal(); input("new-page-path").focus();
});
const treeContextMenu = document.createElement('div'); treeContextMenu.id = 'tree-context-menu'; treeContextMenu.className = 'tree-context-menu'; treeContextMenu.role = 'menu'; treeContextMenu.hidden = true;
for (const [label, id] of [['Markdownを作成','new-page'],['フォルダーを作成','new-folder']]) {
  const button = document.createElement('button'); button.type = 'button'; button.role = 'menuitem'; button.textContent = label; button.onclick = () => { treeContextMenu.hidden = true; element<HTMLButtonElement>(id).click(); }; treeContextMenu.append(button);
}
document.body.append(treeContextMenu);
element('page-list').addEventListener('contextmenu', event => {
  if (!workspace || busy) return; event.preventDefault();
  const target = event.target as HTMLElement;
  const file = target.closest<HTMLElement>('[data-page],[data-image],[data-file]');
  contextCreateParent = file ? (file.dataset.page || file.dataset.image || file.dataset.file || '').split('/').slice(0,-1).join('/') : target.closest<HTMLElement>('[data-folder]')?.dataset.folder || workspace.config.docs;
  treeContextMenu.hidden = false;
  const box = treeContextMenu.getBoundingClientRect(); treeContextMenu.style.left = `${Math.max(0,Math.min(event.clientX,innerWidth-box.width))}px`; treeContextMenu.style.top = `${Math.max(0,Math.min(event.clientY,innerHeight-box.height))}px`;
  treeContextMenu.querySelector<HTMLButtonElement>('button')!.focus();
});
document.addEventListener('pointerdown',event=>{ if (!treeContextMenu.contains(event.target as Node)) treeContextMenu.hidden = true; });
document.addEventListener('keydown',event=>{if(event.key==='Escape')treeContextMenu.hidden=true;});
element('page-list').addEventListener('dragstart', event => {
  const image = (event.target as HTMLElement).closest<HTMLElement>('[data-image]');
  if (!image || !event.dataTransfer) return;
  event.dataTransfer.setData('application/x-munin-image', JSON.stringify({root:projectRoot,path:image.dataset.image})); event.dataTransfer.effectAllowed = 'copy';
});
function relativeProjectAsset(asset: string, page: string): string {
  const docs = workspace?.config.docs.replace(/\\/g,'/').replace(/\/$/,'') || 'docs';
  const projectPage = workspace?.project_entries.some(entry=>entry.path===page) ? page : `${docs}/${page}`;
  const from = projectPage.split('/').slice(0,-1), to = asset.split('/');
  while (from.length && to.length && from[0]===to[0]) { from.shift(); to.shift(); }
  return '../'.repeat(from.length)+to.join('/');
}
for (const target of [editor,milkdown.host] as HTMLElement[]) {
  target.addEventListener('dragover',event=>{if(event.dataTransfer?.types.includes('application/x-munin-image')){event.preventDefault();event.dataTransfer.dropEffect='copy';}});
  target.addEventListener('drop',event=>{
    const data = event.dataTransfer?.getData('application/x-munin-image'); if (!data) return;
    event.preventDefault();event.stopImmediatePropagation();
    if (!documentState || activeImageTab || busy) { status('画像を挿入する原稿を開いてください。',true);return; }
    let asset:{root:string;path:string;screenshot_id?:string};
    try{asset=JSON.parse(data);if(typeof asset.path!=='string'||!asset.path)throw new Error();}catch{status('画像のドラッグ情報を読み込めません。',true);return;}
    if (asset.root !== projectRoot) {status('同じプロジェクトの画像を選択してください。',true);return;}
    const page=documentState.page,root=projectRoot,start=editor.selectionStart,end=editor.selectionEnd,left=event.clientX,top=event.clientY;
    const expected=editor.value;const droppedImage=(event.target as Element).closest<HTMLImageElement>('img');
    const existing=target===milkdown.host?(droppedImage?milkdown.imageSourceRange(droppedImage):undefined):imageAtSelection(expected,start,end);
    if(existing){
      const next=replaceDocumentImage(expected,existing,relativeProjectAsset(asset.path,page),asset.screenshot_id);
      try{changeImageMarkdown(next,expected);void milkdown.refreshImages();status('画像の参照を置き換えました。説明と表示設定は保持しています。');}catch(error){status(String(error),true);}return;
    }
    const origin=captureInsertionContext(insertionState());
    // Resolve rich viewport coordinates before awaiting a reference or changing readonly layout.
    const richDrop=target===milkdown.host?milkdown.captureSelectionEdit(true,{left,top}):undefined;
    const insert=(markdown:string)=>{
      if(!isInsertionCurrent(origin,insertionState())||activeImageTab)throw new Error('原稿が変更されました。挿入位置を選び直してください。');
      if(target===milkdown.host){if(!richDrop)throw new Error('挿入する位置を選択してください。');richDrop.apply(markdown,true);}
      else {rememberCurrentSelection(start,end);editor.setRangeText(markdown,start,end,'end');editor.dispatchEvent(new Event('input',{bubbles:true}));}
      status('画像の参照を挿入しました。');
    };
    if(asset.screenshot_id){void work(async()=>{insert(await rpc('screenshots-reference',{id:asset.screenshot_id,page},root));});}
    else {const path=relativeProjectAsset(asset.path,page);insert(`![${(asset.path.split('/').at(-1)||'画像').replace(/[\[\]\\]/g,'\\$&')}](<${path}>)`);}

  },true);
}
let resourceDragHover:ReturnType<typeof setTimeout>|undefined;
const editorNavigation=document.querySelector<HTMLElement>('[data-tab="editor"]');
editorNavigation?.addEventListener('dragover',event=>{
  if(!event.dataTransfer?.types.includes('application/x-munin-image'))return;
  event.preventDefault();event.dataTransfer.dropEffect='copy';
  resourceDragHover??=setTimeout(()=>{resourceDragHover=undefined;if(documentState&&!busy)chooseTab('editor');},400);
});
function clearResourceDragHover(){if(resourceDragHover)clearTimeout(resourceDragHover);resourceDragHover=undefined;}
editorNavigation?.addEventListener('dragleave',clearResourceDragHover);document.addEventListener('dragend',clearResourceDragHover);document.addEventListener('drop',clearResourceDragHover);
element("cancel-new-page").addEventListener("click", () => element<HTMLDialogElement>("new-page-dialog").close());
element("new-page-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void work(async () => {
    let page = input("new-page-path").value.trim().replace(/\\/g, "/");
    const docsRoot = `${workspace?.config.docs || "docs"}/`;
    if (page.startsWith(docsRoot)) page = page.slice(docsRoot.length);
    await rpc("editor-save", { page, json: { content: `# ${input("new-page-title").value.trim()}\n\n`, revision: null } });
    element<HTMLDialogElement>("new-page-dialog").close();
    await refreshWorkspace(); await openPage(page, false); status(`${page}を作成しました。`);
  });
});
element("new-folder").addEventListener("click", (event) => {
  element<HTMLDetailsElement>("tree-create-menu").open = false;
  if (event.isTrusted) contextCreateParent = null;
  if (!projectRoot || !workspace) { status("先にプロジェクトを開いてください。", true); return; }
  element("new-folder-parent").textContent = `作成先: ${workspace.config.docs}`;
  input("new-folder-path").value = contextCreateParent ? contextCreateParent + '/' : '';
  if (contextCreateParent !== null) element('new-folder-parent').textContent = `作成先: ${contextCreateParent || 'プロジェクト直下'}`;
  element<HTMLDialogElement>("new-folder-dialog").showModal();
  input("new-folder-path").focus();
});
element("cancel-new-folder").addEventListener("click", () => element<HTMLDialogElement>("new-folder-dialog").close());
element("new-folder-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void work(async () => {
    if (!projectRoot || !workspace) throw new Error("先にプロジェクトを開いてください。");
    const relative = input("new-folder-path").value.trim().replace(/\\/g, "/");
    const created = await rpc("create-folder", { path: relative, json: { project_relative: contextCreateParent !== null } });
    for (const [index] of created.split("/").entries()) expandedFolders.add(created.split("/").slice(0, index + 1).join("/"));
    element<HTMLDialogElement>("new-folder-dialog").close();
    await refreshWorkspace();
    status(`${created} フォルダーを作成しました。`);
  });
});
let pendingImageDataUrl: string | null = null;
let pendingImageSelection: { start: number; end: number } | null = null;
let pendingImageOwner: {root:string;page:string;content:string;documentSession:number} | null = null;
const toolbarImageInput = element<HTMLInputElement>("toolbar-image-input");
element("insert-image").addEventListener("click", () => {
  if (!documentState) { status("先にMarkdown原稿を開いてください。", true); return; }
  pendingImageSelection = null;
  toolbarImageInput.click();
});
toolbarImageInput.addEventListener("change", () => {
  const origin = captureInsertionContext(insertionState());
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
    if (!isInsertionCurrent(origin, insertionState())) {
      pendingImageSelection = null;
      status(STALE_INSERTION_MESSAGE, true);
      return;
    }
    if (typeof reader.result === "string") {
      const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      pendingImageSelection = selection;
      openImageSaveDialog(reader.result, cleanName, cleanName.replace(/\.[^.]+$/, ""));
    }
  };
  reader.onerror = () => { pendingImageSelection = null; status("画像を読み込めませんでした。", true); };
  reader.readAsDataURL(file);
});
const insertionState = () => ({ document: documentState, root: projectRoot, content: editor.value, documentSession: documentRequestVersion });
async function uploadMilkdownImage(file: File): Promise<string> {
  if (busy || !documentState) throw new Error("先に原稿を開いてください。");
  const current = documentState;
  const root = projectRoot;
  // The rich editor edits the text while the upload waits, so only document and project identity are compared.
  const origin = captureInsertionContext(insertionState(), { checksContent: false });
  const extension = file.name.split('.').at(-1)?.toLowerCase() || '';
  if (!['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(extension)) throw new Error("対応していない画像形式です。");
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (!isInsertionCurrent(origin, insertionState())) {
        reject(new Error(STALE_INSERTION_MESSAGE));
        return;
      }
      resolve(String(reader.result));
    };
    reader.onerror = () => reject(new Error("画像を読み込めませんでした。"));
    reader.readAsDataURL(file);
  });
  const directory = current.page.split('/').slice(0, -1).join('/');
  const path = `${directory ? `${directory}/` : ''}assets/image-${crypto.randomUUID()}.${extension}`;
  await rpc("save-asset", { path, data }, root);
  if (!isInsertionCurrent(origin, insertionState())) throw new Error(STALE_INSERTION_MESSAGE);
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
  if(!documentState)return;
  pendingImageOwner={root:projectRoot,page:documentState.page,content:editor.value,documentSession:documentRequestVersion};
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
function cancelImageSave():void {
  const owner=pendingImageOwner,selection=pendingImageSelection;
  const restore=owner&&owner.root===projectRoot&&owner.page===documentState?.page&&owner.content===editor.value&&owner.documentSession===documentRequestVersion;
  pendingImageDataUrl = null;
  pendingImageSelection = null;
  pendingImageOwner = null;
  element<HTMLDialogElement>("image-save-dialog").close();
  if(restore&&selection){editor.focus();editor.setSelectionRange(selection.start,selection.end);updateCursor();}
}
element("cancel-image-save").addEventListener("click", cancelImageSave);
element("image-save-dialog").addEventListener("cancel", event=>{event.preventDefault();cancelImageSave();});
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
  const owner=pendingImageOwner;
  const selection=pendingImageSelection||{start:editor.selectionStart,end:editor.selectionEnd};
  void work(async () => {
    const valid=()=>owner&&pendingImageOwner===owner&&owner.root===projectRoot&&owner.page===documentState?.page&&owner.content===editor.value&&owner.documentSession===documentRequestVersion;
    if(!valid())throw new Error('原稿が変更されました。画像の挿入をやり直してください。');
    await rpc("save-asset", { path: fullAssetPath, data: dataUrl },owner!.root);
    if(pendingImageOwner!==owner){if(owner!.root===projectRoot)status('画像を保存しました。挿入はキャンセルされました。');return;}
    if(!valid())throw new Error('原稿が変更されました。保存した画像はリソース一覧に残しています。');
    element<HTMLDialogElement>("image-save-dialog").close();
    pendingImageDataUrl = null;
    pendingImageOwner = null;
    const relPath = computeRelativeMarkdownPath(documentState!.page, fullAssetPath, workspace?.config.docs || "docs");
    const markdownCode = `![${alt}](${relPath})`;
    const start = selection.start;
    const end = selection.end;
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

type ImagePaste = { origin: ReturnType<typeof captureInsertionContext<Document>>; start:number; end:number; cancelled:boolean };
let activeImagePaste: ImagePaste | null = null;
function beginImagePaste(): ImagePaste | null {
  if (activeImagePaste || !documentState) return null;
  const paste = { origin:captureInsertionContext(insertionState()), start:editor.selectionStart, end:editor.selectionEnd, cancelled:false };
  activeImagePaste = paste;
  element('cancel-image-paste').hidden = false;
  document.body.setAttribute('aria-busy','true');
  return paste;
}
function finishImagePaste(paste:ImagePaste):void {
  if(activeImagePaste!==paste)return;
  activeImagePaste=null;
  element('cancel-image-paste').hidden=true;
  document.body.setAttribute('aria-busy',String(busy));
}
element('cancel-image-paste').addEventListener('click',()=>{
  if(!activeImagePaste)return;
  activeImagePaste.cancelled=true;
  element('cancel-image-paste').hidden=true;
  status('画像の挿入をキャンセルしました。保存処理の完了を待っています。');
});
function allowImagePaste(paste:ImagePaste):boolean {
  if(paste.cancelled){status('画像の挿入はキャンセルされました。保存した画像はリソース一覧に残しています。');return false;}
  if(!isInsertionCurrent(paste.origin,insertionState()))throw new Error('原稿が変更されました。保存した画像はリソース一覧に残しています。');
  return true;
}
async function saveAndInsertImage(dataUrl: string, defaultFileType: string, paste:ImagePaste): Promise<void> {
  document.body.setAttribute("aria-busy", "true");
  try {
    if (!documentState) {
      status("先にMarkdown原稿を開いてください。", true);
      return;
    }
    const owner={root:paste.origin.root,page:paste.origin.document!.page,start:paste.start,end:paste.end};
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

    await rpc("save-asset", { path: fullAssetPath, data: dataUrl },owner.root);
    if(!allowImagePaste(paste))return;
    const relPath = computeRelativeMarkdownPath(owner.page, fullAssetPath, workspace?.config.docs || "docs");
    const alt = filename.replace(/\.[^.]+$/, "");
    const markdownCode = `![${alt}](${relPath})`;
    const start = owner.start;
    const end = owner.end;
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
    finishImagePaste(paste);
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

  const paste=beginImagePaste();
  if(!paste)return true;
  const reader = new FileReader();
  reader.onload = () => {
    if (paste.cancelled || !isInsertionCurrent(paste.origin, insertionState())) {
      finishImagePaste(paste);
      status(paste.cancelled ? "画像の挿入をキャンセルしました。" : STALE_INSERTION_MESSAGE, !paste.cancelled);
      return;
    }
    if (typeof reader.result === "string") {
      void saveAndInsertImage(reader.result, fileType || targetFile!.type, paste);
    } else {
      finishImagePaste(paste);
    }
  };
  reader.onerror = () => {
    finishImagePaste(paste);
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

  const paste=beginImagePaste();
  if(!paste)return false;
  isPastingImage = true;
  try {
    if (native) {
      const folder = (workspace?.config.assets || `${workspace?.config.docs || "docs"}/assets`).trim().replace(/\/+$/, "");
      const result = await invoke<PastedImageResult | null>("paste_clipboard_image", {
        root: paste.origin.root,
        page: paste.origin.document!.page,
        assetsFolder: folder,
      });
      if (!result) return false;
      if (!allowImagePaste(paste)) return true;
      lastImagePasteTime = Date.now();
      const relPath = computeRelativeMarkdownPath(documentState.page, result.filePath, workspace?.config.docs || "docs");
      const markdownCode = `![${result.alt}](${relPath})`;
      const start = paste.start;
      const end = paste.end;
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
      await saveAndInsertImage(dataUrl, "image/png", paste);
      return true;
    }
  } catch (error) {
    status(String(error), true);
    return false;
  } finally {
    isPastingImage = false;
    finishImagePaste(paste);
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
    const origin = captureInsertionContext(insertionState());
    const selection = { start: editor.selectionStart, end: editor.selectionEnd };
    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.type.startsWith("image/") || /\.(png|jpe?g|gif|svg|webp)$/i.test(file.name)) {
        const reader = new FileReader();
        reader.onload = () => {
          if (!isInsertionCurrent(origin, insertionState())) {
            pendingImageSelection = null;
            status(STALE_INSERTION_MESSAGE, true);
            return;
          }
          if (typeof reader.result === "string") {
            const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
            const alt = cleanName.replace(/\.[^.]+$/, "");
            pendingImageSelection = selection;
            openImageSaveDialog(reader.result, cleanName, alt);
          }
        };
        reader.readAsDataURL(file);
        break;
      }
    }
  });
}
function actionButton(id: string, action: string, options: () => Record<string, unknown> = () => ({}), result?: string): void {
  element(id).addEventListener("click", () => { void work(() => runAction(action, options(), result)); });
}
element("manual-brief").addEventListener("input", scheduleBriefSave);
element("brief-save-retry").addEventListener("click", () => { void saveBriefSettings().catch(() => {}); });
element("panel-brief").addEventListener("close", () => { void saveBriefSettings().catch(() => {}); });
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
element("import-launch-commands").addEventListener("click", () => { void work(async () => {
  if (!workspace || !native) throw new Error("プロジェクトを開いてデスクトップ版で取り込んでください。");
  const root = projectRoot;
  const commands = await invoke<LaunchCommand[]>("import_launch_commands", { root });
  if (projectRoot !== root) return;
  launchCommands = commands;
  renderLaunchCommands();
  status("以前の共通設定をこのプロジェクトへ取り込みました。");
}); });
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
  await invoke<void>("save_launch_commands", { root: projectRoot, commands: launchCommands });
  renderLaunchCommands();  status("このプロジェクトの撮影するアプリの登録を保存しました。");
}); });
function saveDraftCandidate(root: string, candidate: DraftCandidate): void {
  try { localStorage.setItem(`manual-studio-draft-candidate:${root}`, JSON.stringify(candidate)); }
  catch { /* LocalStorage error */ }
}
function clearDraftCandidate(root: string): void {
  try { localStorage.removeItem(`manual-studio-draft-candidate:${root}`); }
  catch { /* LocalStorage error */ }
}
function loadDraftCandidate(root: string): DraftCandidate | null {
  try {
    const raw = localStorage.getItem(`manual-studio-draft-candidate:${root}`);
    return raw ? JSON.parse(raw) as DraftCandidate : null;
  } catch { return null; }
}
async function createFullDraft():Promise<void>{
  if(busy)return;
  await savedBeforeOperation();
  const root=projectRoot;
  element<HTMLDialogElement>("panel-publish").close();
  let candidate:DraftCandidate|undefined = loadDraftCandidate(root) || undefined;
  if (!candidate) {
    await work(async()=>{
      await ensureAiSettings();activeGenerationRoot=root;element('progress-cancel').hidden=false;element<HTMLButtonElement>('progress-cancel').disabled=false;await beginAiProgress('draft-propose',root);let success=false;
      try{candidate=JSON.parse(await rpc('draft-propose',{},root)) as DraftCandidate;success=true;saveDraftCandidate(root,candidate);}
      catch(error){logAiFailure(error);throw error;}
      finally{await stopAiProgress(success);}
    });
  }
  if(!candidate||root!==projectRoot)return;
  const pages=await reviewDraft(candidate,()=>root===projectRoot&&!dirty&&!Array.from(documentTabs.values()).some(tab=>tab.content!==tab.document.content));
  if(!pages){clearDraftCandidate(root);status('下書き候補を破棄しました。原稿は変更していません。');return;}
  await work(async()=>{
    if(root!==projectRoot||dirty)throw new Error('原稿が変更されました。候補を作り直してください。');
    const result=JSON.parse(await rpc('draft-apply',{json:{docs:candidate!.docs,pages}},root)) as {applied:number};
    clearDraftCandidate(root);
    for(const page of pages){documentTabs.delete(page.path);documentTabs.delete(`${candidate!.docs.replace(/\/$/,'')}/${page.path}`);}
    await refreshWorkspace();
    const selectedPage=pages.find(page=>page.path==='index.md')||pages[0];
    if(selectedPage){await openPage(`${candidate!.docs.replace(/\/$/,'')}/${selectedPage.path}`,false);chooseTab('editor');}
    status(`${result.applied}ページへ選んだ変更を反映しました。変更前の原稿はバックアップしました。`);
  });
}
element('generate-draft').addEventListener('click',()=>{void createFullDraft().catch(error=>status(String(error),true));});
actionButton("quality-check", "quality-check", () => ({}), "publish-result");
setBusy(false);
updateSaveState();
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
      await invoke<RecordingResult>("finish_operation_recording");
    } catch (error) {
      await invoke("show_recording_control_again").catch(() => {});
      const message = `撮影に失敗しました: ${String(error)}`;
      const notice = document.createElement("span");
      notice.className = "recording-control-error";
      notice.textContent = message;
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
  const initialRoot = params.get("root") || localStorage.getItem("manual-studio-project");
  if (initialRoot) void work(() => openProject(initialRoot));
}

async function createSelectionDocument(initial=""):Promise<boolean|void>{
  if(busy||!documentState||activeImageTab)return;
  const owner=documentState,root=projectRoot,insertionAt=editor.selectionStart;
  let selection:SelectionDraft;
  if(milkdown.isRichEditing){
    const rich=milkdown.captureSelectionEdit();
    if(!rich){status('挿入する位置を選択してください。',true);return;}
    selection=rich;
  }else{
    const start=editor.selectionStart,end=editor.selectionEnd,expected=editor.value;
    selection={text:expected.slice(start,end),apply:content=>{
      if(editor.value!==expected)throw new Error('原稿が変更されました。範囲を選び直してください。');
      replaceMarkdown(start,end,content,0,content.length);
    }};
  }
  const captured=editor.value;
  let instruction=await askSelectionInstruction(selection.text,initial);
  if(!instruction)return;
  if(root!==projectRoot||documentState?.page!==owner.page||editor.value!==captured)throw new Error('原稿が変更されました。範囲を選び直してください。');
  await savedBeforeOperation();
  const expected=editor.value,page=owner.page,revision=documentState?.revision;
  let previousCandidate:{content:string;accepted:number[];feedback:string}|undefined;
  while(instruction){
    if(root!==projectRoot||documentState?.page!==page||editor.value!==expected){status('原稿が変更されました。範囲を選び直してください。',true);return;}
    let candidate:string|undefined,failure="",cancelled=false;
    await work(async()=>{
      await saveAiSettings();activeGenerationRoot=root;element('progress-cancel').hidden=false;element<HTMLButtonElement>('progress-cancel').disabled=false;await beginAiProgress('selection-generate',root);let succeeded=false;
      try{candidate=(JSON.parse(await rpc('selection-generate',{page,json:{selected:selection.text,mode:selection.text?"replace":"insert",insertion_at:insertionAt,instruction,revision}},root)) as {content:string}).content;succeeded=true;}
      catch(error){failure=String(error);logAiFailure(error);throw error;}
      finally{cancelled=Boolean(generationCancelRequest);await stopAiProgress(succeeded);}
    });
    if(candidate===undefined){
      if(root!==projectRoot||documentState?.page!==page||editor.value!==expected)return;
      if(previousCandidate){candidate=previousCandidate.content;failure=`再作成を完了できませんでした。前の候補と採用の選択を保持しています。${failure}`;}
      else{if(cancelled)return;instruction=await askSelectionInstruction(selection.text,instruction,failure||'候補を作成できませんでした。');continue;}
    }
    const decision=await reviewSelection(page,selection.text,candidate,failure?previousCandidate:undefined,failure);
    if(decision.action==='restore')return;
    if(decision.action==='retry'){previousCandidate={content:candidate,accepted:decision.accepted,feedback:decision.feedback};instruction=decision.feedback||instruction;continue;}
    if(root!==projectRoot||documentState?.page!==page||editor.value!==expected){status('原稿が変更されました。範囲を選び直してください。',true);return;}
    if(decision.content===selection.text){status("採用する変更はありません。本文を保持しました。");return;}
    selection.apply(decision.content);updateHistoryButtons();await saveDocument(false);status(selection.text?'指定範囲へAI文書を反映しました。':'カーソル位置にAI文書を挿入しました。');return true;
  }
}
element('selection-ai').addEventListener('click',()=>{void createSelectionDocument().catch(error=>status(String(error),true));});

function saveReaderReviewSession(root: string, page: string, expected: string, report: ReaderReport): void {
  try { localStorage.setItem(`manual-studio-reader-review:${root}:${page}`, JSON.stringify({ expected, report })); }
  catch { /* LocalStorage error */ }
}
function loadReaderReviewSession(root: string, page: string): void {
  reopenReaderReview = undefined;
  try {
    const raw = localStorage.getItem(`manual-studio-reader-review:${root}:${page}`);
    if (!raw) return;
    const data = JSON.parse(raw) as { expected: string; report: ReaderReport };
    if (typeof data.expected === 'string' && Array.isArray(data.report?.issues)) {
      installReaderReport(root, page, data.expected, data.report);
    }
  } catch { /* LocalStorage error */ }
}
let reopenReaderReview:(()=>boolean)|undefined;
function installReaderReport(root:string,page:string,expected:string,result:ReaderReport):void {
  const valid=()=>root===projectRoot&&documentState?.page===page&&editor.value===expected;
  reopenReaderReview=()=>{
    if(!valid())return false;
    showReaderReport(result,valid,finding=>{
      if(preferredEditorView==='preview'){preferredEditorView='edit';applyEditorView();}
      milkdown.showSource();jumpToSource(editor,finding.start,finding.end);updateCursor();
    },finding=>{
      if(typeof finding.replacement!=='string'||finding.replacement===finding.quote)return;
      const before=expected,previousFilter=document.querySelector<HTMLSelectElement>('#reader-review-results select')?.value||'all';
      void(async()=>{
        const decision=await reviewSelection(page,finding.quote,finding.replacement!,undefined,'',false);
        if(decision.action!=='adopt'||decision.content===finding.quote)return;
        if(!valid()||expected!==before||before.slice(finding.start,finding.end)!==finding.quote){
          status('原稿が変更されました。レビューを実行し直してください。',true);return;
        }
        if(preferredEditorView==='preview'){preferredEditorView='edit';applyEditorView();}
        milkdown.showSource();
        replaceMarkdown(finding.start,finding.end,decision.content,0,decision.content.length);
        updateHistoryButtons();
        const after=editor.value,delta=after.length-before.length;
        result.issues=result.issues.filter(issue=>issue.end<=finding.start||issue.start>=finding.end);
        for(const issue of result.issues)if(issue.start>=finding.end){issue.start+=delta;issue.end+=delta;}
        expected=after;saveReaderReviewSession(root,page,expected,result);
        document.querySelector<HTMLDialogElement>('#reader-review-results')?.close();
        reopenReaderReview?.();
        const filter=document.querySelector<HTMLSelectElement>('#reader-review-results select');
        if(filter){filter.value=previousFilter;filter.dispatchEvent(new Event('change'));}
        await saveDocument(false);status('レビューの修正案を反映しました。');
      })().catch(error=>status(String(error),true));
    });
    return true;
  };
}
async function reviewCurrentDocument():Promise<void>{
  if(busy||!documentState||activeImageTab)return;
  if(!document.querySelector<HTMLDialogElement>('#reader-review-results')?.open&&reopenReaderReview?.())return;
  const root=projectRoot,page=documentState.page,captured=editor.value;
  const start=editor.selectionStart,end=editor.selectionEnd;
  await savedBeforeOperation();await saveAiSettings();
  const choices=await askReader(workspace?.brief||'',start!==end,async scope=>JSON.parse(await rpc('document-review-capabilities',{page,json:{range:scope==='selection'?{start,end}:undefined}},root)) as ReviewCapabilities);if(choices===null)return;
  if(root!==projectRoot||documentState?.page!==page||editor.value!==captured)throw new Error('原稿が変更されました。レビューを実行し直してください。');
  await savedBeforeOperation();let expected=editor.value;const revision=documentState?.revision;
  const range=choices.scope==='selection'?{start,end}:undefined;
  let report:ReaderReport|undefined;
  await work(async()=>{
    await saveAiSettings();activeGenerationRoot=root;element('progress-cancel').hidden=false;element<HTMLButtonElement>('progress-cancel').disabled=false;await beginAiProgress('document-review',root);let success=false;
    try{report=JSON.parse(await rpc('document-review',{page,json:{reader:choices.reader,revision,range}},root)) as ReaderReport;success=true;}
    catch(error){logAiFailure(error);throw error;}
    finally{await stopAiProgress(success);}
  });
  const valid=()=>root===projectRoot&&documentState?.page===page&&editor.value===expected;
  if(!valid()){status('原稿が変更されました。レビューを実行し直してください。',true);return;}
  if(report){
    document.querySelector<HTMLDialogElement>('#reader-review-results')?.close();
    installReaderReport(root,page,expected,report);
    saveReaderReviewSession(root,page,expected,report);
    reopenReaderReview?.();status(`レビュー完了：指摘 ${report.issues.length}件。`);
  }
}
element('reader-review').addEventListener('click',()=>{void reviewCurrentDocument().catch(error=>status(String(error),true));});

const screenshotAi=setupScreenshotAi({root:()=>projectRoot,applications:()=>launchCommands,refresh:()=>screenshotLibrary.refresh(),reloadApplications:loadLaunchCommands,report:status,work,
  request:async(action,json,root)=>{
    if(action==='list-accessible-windows')return rpc(action,{},root);
    activeGenerationRoot=root;element('progress-cancel').hidden=false;element<HTMLButtonElement>('progress-cancel').disabled=false;await beginAiProgress(action,root);let success=false;
    try{await saveAiSettings();const result=await rpc(action,{json},root);success=true;return result;}
    catch(error){logAiFailure(error);throw error;}
    finally{await stopAiProgress(success);}
  }
});


async function insertScreenshotHere():Promise<void>{
  if(busy||!documentState||activeImageTab)return;
  const root=projectRoot,page=documentState.page,position=editor.selectionStart;
  const origin=captureInsertionContext(insertionState());
  const rich=milkdown.isRichEditing?milkdown.captureSelectionEdit(true):undefined;
  if(milkdown.isRichEditing&&!rich)throw new Error('挿入する位置を選択してください。');
  const valid=()=>isInsertionCurrent(origin,insertionState())&&!activeImageTab;
  await savedBeforeOperation();
  if(!valid())throw new Error('原稿が変更されました。挿入位置を選び直してください。');
  const method=await chooseScreenshotMethod();
  if(!method||!valid())return;
  const existing=method==='existing'?await chooseExistingScreenshot(root,valid):undefined;
  const id=method==='ai'?await screenshotAi.create(true):method==='manual'?await screenshotLibrary.recordForInsertion():existing?.id;
  if(!id)return;
  if(!valid()){status('撮影画像はリソース一覧に保存しました。原稿が変更されたため挿入していません。',true);return;}
  const library=JSON.parse(await rpc('screenshots-list',{},root)) as {items:Array<{id:string;edits:Array<{id:string}>}>};
  if(!valid())return;
  const revision=existing?.revision||library.items.find(item=>item.id===id)?.edits.at(-1)?.id;
  if(!revision)throw new Error('撮影候補が見つかりません。');
  const image=JSON.parse(await rpc('screenshots-image',{id,json:{revision}},root)) as {data:string;edit:{id:string};screenshot:{adopted:string|null}};
  if(!valid())return;
  const {dialog,body}=featureDialog('スクショを確認して挿入');dialog.id='editor-screenshot-preview';
  if(method==='ai'&&screenshotAi.insertionWarning()){const warning=document.createElement('p');warning.className='error';warning.setAttribute('role','alert');warning.textContent=screenshotAi.insertionWarning()!;body.append(warning);}
  const note=document.createElement('p');note.textContent=`${page} の指定位置に挿入します。閉じた場合も撮影画像と手順はリソース一覧に残ります。`;
  const preview=document.createElement('img');preview.src=image.data;preview.alt='挿入するスクリーンショットの候補';preview.style.maxWidth='100%';preview.style.maxHeight='50vh';preview.style.objectFit='contain';
  const insert=document.createElement('button');insert.type='button';insert.className='primary';insert.dataset.uiIcon='image';insert.textContent='この位置に挿入';body.append(note,preview,insert);
  const accepted=await new Promise<boolean>(resolve=>{let answer=false;insert.onclick=()=>{answer=true;dialog.close();};dialog.addEventListener('close',()=>{resolve(answer);dialog.remove();},{once:true});});
  if(!accepted)return;
  await work(async()=>{
    if(!valid())throw new Error('原稿が変更されました。画像はリソース一覧から挿入してください。');
    if(!existing)await rpc('screenshots-change',{id,json:{adopt:image.edit.id,expected_revision:image.screenshot.adopted}},root);
    const markdown=await rpc('screenshots-reference',{id,page},root);
    if(!valid())throw new Error('原稿が変更されました。画像はリソース一覧から挿入してください。');
    if(rich)rich.apply(markdown,true);else replaceMarkdown(position,position,`\n\n${markdown}\n\n`,0,markdown.length+4);
    updateHistoryButtons();await saveDocument(false);await screenshotLibrary.refresh();status('指定位置にスクショを挿入しました。');
  });
}
element('editor-screenshot-ai').addEventListener('click',()=>{void insertScreenshotHere().catch(error=>status(String(error),true));});

function chooseScreenshotMethod():Promise<'manual'|'ai'|'existing'|undefined>{
  const {dialog,body}=featureDialog('スクリーンショットを挿入');dialog.id='editor-screenshot-method';
  const help=document.createElement('p');help.textContent='指定した位置に入れるスクショの用意方法を選んでください。';body.append(help);
  return new Promise(resolve=>{let selected:'manual'|'ai'|'existing'|undefined;
    for(const [method,text,icon,description] of [['manual','手動で撮影','camera','アプリを操作して撮影。AI設定は不要です。'],['ai','AIに撮影を指示','sparkle','撮影する画面や番号・注釈を文章で指示します。'],['existing','撮影済み画像を選ぶ','library','リソースに保存した採用済みの画像から選びます。']] as const){
      const button=document.createElement('button');button.type='button';button.className='screenshot-method';button.dataset.uiIcon=icon;button.textContent=text;button.onclick=()=>{selected=method;dialog.close();};const note=document.createElement('p');note.className='muted';note.textContent=description;body.append(button,note);
    }
    dialog.addEventListener('close',()=>resolve(selected),{once:true});
  });
}
const recentScreenshotSelections=new Map<string,string>();
async function chooseExistingScreenshot(root:string,valid:()=>boolean):Promise<{id:string;revision:string}|undefined>{
  const shots=JSON.parse(await rpc('screenshots-list',{},root)) as {items:Array<{id:string;name:string;output:string;adopted:string|null;thumbnail:string|null}>};
  if(root!==projectRoot||!valid()){status('原稿が変更されたため挿入していません。画像はリソース一覧から選び直してください。',true);return;}
  const {dialog,body}=featureDialog('撮影済み画像を選ぶ');dialog.id='editor-screenshot-existing';
  const available=shots.items.filter(shot=>shot.adopted);
  const selectionKey=`manual-studio-recent-screenshot:${root}`;
  let recentId=recentScreenshotSelections.get(root);
  if(!recentId){try{recentId=localStorage.getItem(selectionKey)||undefined;}catch{/* Selection remains available in memory when storage is unavailable. */}}
  const recentIndex=available.findIndex(shot=>shot.id===recentId);
  if(recentIndex>=0){
    const [recent]=available.splice(recentIndex,1);available.unshift(recent);
    const help=document.createElement('p');help.className='muted';help.textContent='前回選んだ画像を先頭に表示しています。現在の採用版を確認して選べます。';body.append(help);
  }else if(recentId){
    recentScreenshotSelections.delete(root);
    try{localStorage.removeItem(selectionKey);}catch{/* Storage is optional. */}
    recentId=undefined;
  }
  if(!available.length){const empty=document.createElement('p');empty.textContent='採用済みの画像がありません。手動撮影・AI撮影、またはリソース一覧のPNG取り込みで画像を用意してください。';body.append(empty);}
  return new Promise(resolve=>{let selected:{id:string;revision:string}|undefined;
    for(const shot of available){
      const card=document.createElement('section');card.className='card';
      const title=document.createElement('h2');title.textContent=shot.name||shot.output;card.append(title);
      if(shot.id===recentId){const label=document.createElement('p');label.className='muted';label.textContent='前回選択した画像';card.append(label);}
      if(shot.thumbnail){const image=document.createElement('img');image.src=shot.thumbnail;image.alt=title.textContent;image.style.maxWidth='100%';image.style.maxHeight='160px';card.append(image);}
      const button=document.createElement('button');button.type='button';button.textContent='この画像を選ぶ';button.dataset.screenshotId=shot.id;
      button.onclick=()=>{
        if(root!==projectRoot||!valid()){dialog.close();return;}
        selected={id:shot.id,revision:shot.adopted!};
        recentScreenshotSelections.set(root,shot.id);
        try{localStorage.setItem(selectionKey,shot.id);}catch{/* Selection remains available in memory. */}
        dialog.close();
      };
      card.append(button);body.append(card);
    }
    dialog.addEventListener('close',()=>resolve(selected),{once:true});
  });
}

function manuscriptPagePath(page:string):string {
  return workspace?.project_entries.some(entry=>!entry.directory&&entry.path===page)?page:`${(workspace?.config.docs||'docs').replace(/\/$/,'')}/${page}`;
}
function manuscriptOwner():ManuscriptOwner|null {
  return documentState&&!activeImageTab?{...documentState,content:editor.value,root:projectRoot,session:documentRequestVersion}:null;
}
const manuscriptToolOptions:ManuscriptToolsOptions={
  root:()=>projectRoot,current:manuscriptOwner,busy:()=>busy,request:rpc,work,
  prepare:async pages=>{
    await savedBeforeOperation();retainDocumentTab();
    if(!pages)return;
    const paths=new Set(pages.map(manuscriptPagePath));
    for(const tab of documentTabs.values())if(paths.has(manuscriptPagePath(tab.document.page))&&tab.content!==tab.document.content)
      throw new Error(`${tab.document.page} に未保存の編集があります。先に保存してください。`);
  },
  navigate:async(page,start,end)=>{
    const root=projectRoot;await openPage(page);
    if(root!==projectRoot)return;
    showDocumentView();chooseTab('editor');
    if(preferredEditorView==='preview'){preferredEditorView='edit';applyEditorView();}
    milkdown.showSource();jumpToSource(editor,start,end);
  },
  applyContent:(next,expected)=>{
    if(!sameOwner(manuscriptOwner(),expected))throw new Error('原稿が変更されています。操作をやり直してください。');
    showDocumentView();chooseTab('editor');
    if(preferredEditorView==='preview'){preferredEditorView='edit';applyEditorView();}
    milkdown.showSource();
    changeImageMarkdown(next,expected.content);updateHistoryButtons();
  },
  changed:async documents=>{
    const current=documentState;
    for(const saved of documents){
      const path=manuscriptPagePath(saved.page);
      if(current&&manuscriptPagePath(current.page)===path){
        showDocumentView();chooseTab('editor');
        if(preferredEditorView==='preview'){preferredEditorView='edit';applyEditorView();}
        milkdown.showSource();
        const before=editor.value;if(before!==saved.content)changeImageMarkdown(saved.content,before);
        documentState={...saved,page:current.page};dirty=false;documentSaveState=null;updateSaveState();retainDocumentTab();
      }
      for(const [page,tab] of documentTabs){
        if(manuscriptPagePath(page)!==path||page===documentState?.page)continue;
        tab.history.record({value:saved.content,start:Math.min(tab.start,saved.content.length),end:Math.min(tab.end,saved.content.length)},{inputType:'insertReplacementText',isTrusted:false});
        tab.document={...saved,page};tab.content=saved.content;tab.richState=null;
      }
    }
    renderDocumentTabs();renderPages();await renderPreview();
  },
  report:status,
};
const openManuscriptSearch=setupManuscriptSearch(manuscriptToolOptions);
element('manuscript-search-open').addEventListener('click',openManuscriptSearch);
manuscriptOutline=setupManuscriptOutline(manuscriptToolOptions);manuscriptOutline.refresh();
const openManuscriptGit=setupManuscriptGit(manuscriptToolOptions);
const manuscriptGitButton=document.createElement('button');manuscriptGitButton.type='button';manuscriptGitButton.id='manuscript-git-open';manuscriptGitButton.textContent='Git履歴・復元';
manuscriptGitButton.addEventListener('click',openManuscriptGit);
element('editor-more').querySelector('.editor-more-menu')!.append(manuscriptGitButton);
