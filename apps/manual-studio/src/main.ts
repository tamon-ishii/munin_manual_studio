import {setupGfmSourceToolbar} from './gfmEditor';
import {installShortcutRouter,currentBindings,bindingLabel,keyStroke,type ShortcutCommand} from './keyboardShortcuts';
import {setupShortcutSettings} from './shortcutSettings';
import {setupSettingsTabs} from './settingsTabs';
import {setupDialogDragging} from './dialogDragging';
import {currentLine} from './editorLineCommands';
import {setupCliAiSettings} from './cliAiSettings';
import {setupProofreadingSkillSettings} from './proofreadingSkillSettings';
import { setupFileMove, type FileMoveResult } from './fileMove';
import { PreviewScheduler } from './previewScheduler';
import {rememberPreviewContent,rememberPreviewReplacement,updatePreviewContent} from './previewContent';
import { DocumentPersistence, isRevisionConflict } from './documentPersistence';
import { mergeDocumentChanges } from './selectableDiff';
import {OperationTiming} from './operationTimings';
import {showWorkspacePaths,showOperationTimings} from './workspaceSettings';
import {applyReviewCorrections} from './reviewCorrections';
import {showReaderReport,type ReaderReport} from './readerReview';
import {reviewDraft,type DraftCandidate} from './draftReview';
import {askTemplateDestination} from './templateCreation';
import {configureTargetApplication,type TargetApplication} from './targetApplication';
import {setupPathPickers,addPathBrowse} from './pathPicker';
import {setupFileTabMenu,type FileTab} from './fileTabMenu';
import { AiProgressManager } from './aiProgressManager';
import {imageAtSelection,renderFigure,replaceDocumentImage,type DocumentImage} from './imagePresentation';
import type {ResourceUsage} from './types';
import { setupToolbarCustomization } from './toolbarCustomization';
import { chooseDestination,featureDialog } from './imageDialogs';
import { setupMarkitsImages, cursorCapturePreference } from "./markitsImages";
import {setupCaptureResources} from './captureResources';
import { uiIcon } from './uiIcons';
import { setupControlIcons } from './controlIcons';
import { setAiPhase } from './workflowPresentation';
import { readAiCredential, saveAiCredential, hasUnassignedAiCredential, assignLegacyAiCredential } from "./aiCredentials";
import { applyEditorFontSize, isEditorFontSize, setupEditorFontSize } from "./editorFontSize";
import { applyPreviewFontSize, isPreviewFontSize, setupPreviewFontSize } from "./previewFontSize";
import { setupMilkdownEditor, renderMermaid } from "./milkdownEditor";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { getCurrentWindow } from "@tauri-apps/api/window";
import { EditorHistory, type EditorSnapshot } from "./editorHistory";
import { setupPaneResizers } from "./paneResizers";
import { setupWindowLayout, type WindowLayoutManager } from "./windowLayout";
import { createPreviewNavigator } from "./previewNavigation";
import { sendManualRequest } from "./manualTransport";
import { renderFileTree } from "./fileTree";
import { setupPreviewImageSizing, setupPreviewTheme } from "./themePreview";
import { alertIconStyles } from "./alertIcons";
import { setupMarkdownTableEditor } from "./markdownTable";
import { jumpToSource } from "./editorNavigation";
import {reviewSelection} from "./selectionAi";
import {reviewProofreading} from './proofreadingReview';
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
import {sameOwner,type ManuscriptOwner,type ManuscriptToolsOptions} from './manuscriptTools';
import {setupGlossarySettings} from './glossarySettings';
import {
  extractAiNotes,
  openAiNotesManagerDialog,
  openExternalChangeTrayDialog,
  openGlossaryBatchReplaceDialog,
  openInsertAiNoteDialog,
  openSendToTerminalDialog,
  type ExternalChangeEntry,
  type GlossaryReplacePlanDoc,
} from './aiCollaboration';
import { openAiCollabHubDialog, type HubTabId } from './aiCollabHub';
import { copyTextToClipboard } from './clipboardText';

import type { State, Document } from "./types";

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const input = (id: string): HTMLInputElement => element(id);
const cliAiSettings=setupCliAiSettings((agent,model)=>{
  if(element<HTMLSelectElement>('ai-connection-type').value==='cli'&&element<HTMLSelectElement>('ai-agent').value===agent)input('ai-model').value=model;
  scheduleAiSave();
});
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
}, undefined, (source, img) => { void handleEditDocumentImage(source, img); },img=>showImagePresentation(img),source=>{void recaptureDocumentImage(source);},(source)=>{void openImageSendToTerminal(source);});
setupPreviewTheme(element<HTMLIFrameElement>("markdown-preview"));
setupPreviewImageSizing(element<HTMLIFrameElement>("markdown-preview"), milkdown.host);
const native = "__TAURI_INTERNALS__" in window;
setupDialogDragging();
const glossarySettings = setupGlossarySettings({
  rpc,
  getProjectRoot: () => projectRoot,
  reportStatus: (message, isError) => status(message, isError),
});
const selectSettingsCategory=setupSettingsTabs({ glossary: [glossarySettings.element] });
setupShortcutSettings(element('keyboard-shortcut-settings'));
element('application-settings').addEventListener('click',()=>{
  chooseTab('settings');
  void glossarySettings.reload();
});
const markitsCaptureKey=input('markits-capture-key');
markitsCaptureKey.dataset.keyRecorder='all';
const defaultIncludeCursor=input('capture-default-include-cursor');
defaultIncludeCursor.checked=cursorCapturePreference();
defaultIncludeCursor.addEventListener('change',()=>{
  try {
    localStorage.setItem('manual-studio-capture-include-cursor',String(defaultIncludeCursor.checked));
    element('capture-default-include-cursor-status').textContent='保存しました。次の撮影から反映します。';
  } catch(error) {defaultIncludeCursor.checked=cursorCapturePreference();element('capture-default-include-cursor-status').textContent=`保存できませんでした: ${String(error)}`;}
});
let markitsKey='Control+Shift+E';
let markitsKeyEdited=false;
let markitsKeySave:Promise<void>=Promise.resolve();
const displayMarkitsKey=()=>{markitsCaptureKey.value=markitsKey.replace('Control','Ctrl').replace('Super','Cmd');};
displayMarkitsKey();
const markitsKeyLoaded=native?invoke<string>('get_markits_capture_shortcut').then(value=>{if(!markitsKeyEdited){markitsKey=value;displayMarkitsKey();}}).catch(error=>{element('markits-capture-key-status').textContent=String(error);}):Promise.resolve();
function persistMarkitsCaptureKey():void {
  if(!native){element('markits-capture-key-status').textContent='撮影キーはデスクトップ版で設定できます。';return;}
  const selected=markitsKey;
  element('markits-capture-key-status').textContent='撮影キーを保存しています…';
  markitsKeySave=markitsKeySave.catch(()=>{}).then(async()=>{
    await invoke('set_markits_capture_shortcut',{shortcut:selected});
  });
  void markitsKeySave.then(()=>{if(markitsKey===selected)element('markits-capture-key-status').textContent='保存しました。次の撮影ではこのキーを使います。';}).catch(error=>{if(markitsKey===selected)element('markits-capture-key-status').textContent=`保存できませんでした: ${String(error)}`;});
}
markitsCaptureKey.addEventListener('keydown',event=>{
  if(event.key==='Tab')return;
  event.preventDefault();event.stopPropagation();
  const key=keyStroke(event);if(!key)return;
  markitsKeyEdited=true;markitsKey=key.replace('Mod',/Mac|iPhone|iPad/.test(navigator.platform)?'Super':'Control');displayMarkitsKey();persistMarkitsCaptureKey();
});
element('markits-capture-key-reset').addEventListener('click',()=>{markitsKeyEdited=true;markitsKey='Control+Shift+E';displayMarkitsKey();persistMarkitsCaptureKey();});
element('markits-capture-key-save').addEventListener('click',persistMarkitsCaptureKey);
const params = new URLSearchParams(location.search);

const detached = params.get("editor") === "1";
initializeTheme();
setupEditorFontSize(input("editor-font-size"), size => {
  if (native) void emit("manual-studio-editor-font-size-changed", size);
});
if (native) void listen<number>("manual-studio-editor-font-size-changed", ({ payload }) => {
  if (isEditorFontSize(payload)) applyEditorFontSize(payload, false);
});
setupPreviewFontSize(input("preview-font-size"), size => {
  if (native) void emit("manual-studio-preview-font-size-changed", size);
});
if (native) void listen<number>("manual-studio-preview-font-size-changed", ({ payload }) => {
  if (isPreviewFontSize(payload)) applyPreviewFontSize(payload, false);
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
const alertIconsInput = document.createElement('input');
alertIconsInput.type = 'checkbox';
alertIconsInput.id = 'project-alert-icons';
alertIconsInput.disabled = true;
const alertIconsLabel = document.createElement('label');
alertIconsLabel.className = 'setting-checkbox';
alertIconsLabel.append(alertIconsInput, '原稿の注釈に共通アイコンを使う（Material for MkDocsにも適用）');
themePicker.closest('.card')?.append(alertIconsLabel);
const alertIconsStyle = document.createElement('style');
alertIconsStyle.textContent = alertIconStyles(false);
document.head.append(alertIconsStyle);
function applyAlertIconSetting(): void {
  const enabled = workspace?.alert_icons === true;
  alertIconsInput.checked = enabled;
  alertIconsInput.disabled = !projectRoot;
  document.documentElement.toggleAttribute('data-alert-icons', enabled);
}
alertIconsInput.addEventListener('change', () => {
  if (!projectRoot || !workspace || busy) { applyAlertIconSetting(); return; }
  const root = projectRoot;
  const enabled = alertIconsInput.checked;
  void work(async () => {
    try {
      await rpc('save-alert-icons', { json: { enabled } }, root);
      if (root === projectRoot && workspace) {
        workspace.alert_icons = enabled;
        status('注釈のアイコン設定を保存しました。');
      }
    } finally { applyAlertIconSetting(); }
  });
});
setupPathPickers({root:()=>projectRoot,entries:()=>workspace?.project_entries||[]});
addPathBrowse(input('new-page-path'),()=> 'file',()=>contextCreateParent!==null?'.':workspace?.config.docs||'docs');
addPathBrowse(input('new-folder-path'),()=> 'folder',()=>contextCreateParent!==null?'.':workspace?.config.docs||'docs');
addPathBrowse(input('image-save-folder'),()=> 'folder');
addPathBrowse(input('image-save-filename'),()=> 'file',()=>input('image-save-folder').value.trim()||'.');
let documentState: Document | null = null;
let dirty = false;
const documentPersistence = new DocumentPersistence({
  context: () => documentState ? { document: documentState, root: projectRoot, content: editor.value, version: documentRequestVersion } : null,
  write: async context => {
    const {document: current, root, content, version} = context;
    const write = async (body: string, revision: string) => JSON.parse(await rpc('editor-save', {
      page: current.page, json: {content: body, revision},
    }, root)) as Document;
    try {
      return await write(content, current.revision);
    } catch (error) {
      if (!isRevisionConflict(error)) throw error;
      const stored = JSON.parse(await rpc('editor-read', {page: current.page}, root)) as Document;
      if (documentState !== current || projectRoot !== root || documentRequestVersion !== version || editor.value !== content) throw error;
      const merged = mergeDocumentChanges(current.content, content, stored.content);
      if (merged === null) throw error;
      context.rebased = merged !== content;
      return merged === stored.content.replace(/\r\n/g, '\n') ? {...stored, content: merged} : await write(merged, stored.revision);
    }
  },
  stateChanged: updateSaveState,
  apply: (saved, { content, rebased }) => {
    // A newer editor draft still needs the original base to incorporate the external changes.
    if (rebased && editor.value !== content) { dirty = true; retainDocumentTab(); return; }
    if (editor.value === content && saved.content !== content) {
      const {selectionStart, selectionEnd, scrollTop} = editor;
      const richScroll = milkdown.scrollElement.scrollTop;
      editor.value = saved.content;
      editor.setSelectionRange(selectionStart, selectionEnd);
      editor.scrollTop = scrollTop;
      milkdown.scrollElement.scrollTop = richScroll;
      if (rebased) {
        resetEditHistory();
        void renderPreview();
      }
    }
    documentState = saved; dirty = editor.value !== saved.content; retainDocumentTab();
  },
  refresh: () => refreshWorkspace(false, false),
  saved: page => status(`${page}を保存しました。`),
});
let busy = false;
let previewRequestPending = false;
let previewScrollWindow: Window | null = null;
let syncingScroll = false;
let progressTimer: ReturnType<typeof setInterval> | undefined;
let progressPollTimer: ReturnType<typeof setInterval> | undefined;
let progressRunning = false;
let progressDisplayLogs: string[] = [];
let progressConnection = "AI";
let manualStudioHiddenForCapture = false;
const expandedFolders = new Set<string>();
let editHistory = new EditorHistory();
let replayingHistory = false;
let pendingEditorFocus = false;
let busyButtonStates: Map<HTMLButtonElement, boolean> | null = null;
if (detached) document.body.classList.add("detached");

let layoutManager: WindowLayoutManager | null = null;
{
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
  refreshPreview: () => work(() => renderPreview(true)),
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
      element('operation-progress').dataset.running = 'false';
      element('progress-track').hidden = true;
      element('progress-label').textContent = '直近のAI実行ログ';
      element('progress-note').textContent = data.running ? '前回の処理は中断されました。現在は実行していません。' : '保存された実行ログです。現在は実行していません。';
      element('progress-elapsed').textContent = '';
      element('progress-cancel').hidden = true;
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
    const result = JSON.parse(await rpc("agent-progress", {}, activeGenerationRoot || projectRoot)) as { logs: Array<{ time: string; message: string; detail?: string }>; total?: number };
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
async function beginAiProgress(action: string, root: string, cliAgent?:string): Promise<void> {
  ++progressGeneration;
  if (progressInFlight) await progressInFlight;
  try { await rpc("agent-progress-clear", {}, root); } catch { /* Progress logs are optional. */ }
  startAiProgress(action,cliAgent);
}
function startAiProgress(action: string,cliAgent?:string): void {
  ++progressGeneration;
  const labels: Record<string, string> = { codex: "Codex", claude: "Claude Code", grok: "Grok Build", agy: "Agy" };
  const agent = cliAgent || workspace?.config.agent || element<HTMLSelectElement>("ai-agent").value || "AI";
  const connection=cliAgent?'cli':workspace?.config.connection_type;
  progressConnection=connection==='api'?`API（${workspace?.config.model||'設定済みモデル'}）`:connection==='local_llm'?`ローカルAI（${workspace?.config.model||'設定済みモデル'}）`:labels[agent]||agent;
  const operation = ({
    draft: "原稿の下書きを生成中",
    "draft-propose": "原稿の下書き候補を生成中",
    "draft-plan": "操作計画の候補を生成中",
    "operation-workbench": "操作・再撮影を実行中",
    "document-review": "文章をレビュー・校正中",
  } as Record<string, string>)[action] || "AI文書の候補を作成中";
  activeGenerationRoot = projectRoot;
  aiProgress.start({ connection: progressConnection, operation, root: projectRoot });
  element("progress-label").textContent = `${progressConnection}で${operation}`;
  progressRunning = true;
  element('operation-progress').dataset.running = 'true';
  element('progress-track').hidden = false;
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
  element('operation-progress').dataset.running = 'false';
  element('progress-track').hidden = true;
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
  if (!progressRunning) {
    element('operation-progress').dataset.running = 'false';
    element('progress-track').hidden = true;
    element('progress-label').textContent = '直近のAI実行ログ';
    element('progress-note').textContent = '過去の実行ログです。現在は実行していません。';
    element('progress-cancel').hidden = true;
  }
  element("operation-progress").hidden = false;
  element("progress-open").hidden = true;
  element("progress-compact-cancel").hidden = true;
});
async function rpc(action: string, options: Record<string, unknown> = {}, root = projectRoot): Promise<string> {
  const mergedOptions = { ...options };
  const aiActions = new Set(["proofread-text", "draft", "draft-propose", "draft-plan", "operation-workbench", "fact-check", "scenario-save"]);
  if (aiActions.has(action) && mergedOptions.api_key === undefined) {
    mergedOptions.api_key = root === projectRoot ? readAiCredential(root, workspace?.config.endpoint_url || "") : "";
  }
  return sendManualRequest({ root, action, options: mergedOptions }, native
    ? (request) => invoke<string>("manual_request", { request })
    : undefined);
}

setupProofreadingSkillSettings(element('ai-cli-status'), async (agent, skill) => {
  if (!projectRoot) throw new Error('プロジェクトを開いてください。');
  return JSON.parse(await rpc('proofreading-skill-install', {agent, skill}));
});

let terminalController: TerminalController | null = null;

function getTerminalCliCommand(): { command: string; args: string[]; label: string } {
  const agent = element<HTMLSelectElement>('terminal-cli-agent').value;
  const model = cliAiSettings.get(agent);
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
    args.push("--effort", "low");
  }
  return {
    command: agent,
    args,
    label: labels[agent] || agent,
  };
}

let terminalSnapshotId = '';
let terminalSnapshotRoot = '';
let externalChangesCache: ExternalChangeEntry[] = [];
let externalChangesPollPending = false;

function updateExternalChangesButton(): void {
  const btn = element<HTMLButtonElement>('terminal-external-changes-btn');
  if (!btn) return;
  const count = externalChangesCache.length;
  btn.hidden = count === 0;
  btn.textContent = count > 0 ? `外部変更を確認 (${count})` : '外部変更を確認';
}

async function ensureTerminalSnapshot(root = projectRoot): Promise<void> {
  if (!root) return;
  if (terminalSnapshotId && terminalSnapshotRoot === root) return;
  try {
    const raw = await rpc('external-snapshot-create', {}, root);
    const created = JSON.parse(raw) as { session_id?: string };
    if (created?.session_id && root === projectRoot) {
      terminalSnapshotId = created.session_id;
      terminalSnapshotRoot = root;
      externalChangesCache = [];
      updateExternalChangesButton();
    }
  } catch {
    // Optional snapshot support; do not interrupt terminal connection.
  }
}

async function refreshExternalSnapshotDiff(): Promise<ExternalChangeEntry[]> {
  const root = projectRoot;
  const snapId = terminalSnapshotId;
  if (!root || !snapId || terminalSnapshotRoot !== root || document.hidden || externalChangesPollPending) {
    return externalChangesCache;
  }
  externalChangesPollPending = true;
  try {
    const raw = await rpc('external-snapshot-diff', { id: snapId }, root);
    if (root !== projectRoot || snapId !== terminalSnapshotId) return externalChangesCache;
    const parsed = JSON.parse(raw) as { changes?: ExternalChangeEntry[] };
    externalChangesCache = Array.isArray(parsed?.changes) ? parsed.changes : [];
    updateExternalChangesButton();
    return externalChangesCache;
  } catch {
    return externalChangesCache;
  } finally {
    externalChangesPollPending = false;
  }
}

function showTerminalPanel(): void {
  if (layoutManager && !layoutManager.isPanelVisible('terminal')) {
    layoutManager.togglePanel('terminal', true);
  }
  chooseTab('terminal');
  openManualTerminal();
}

function lineRangeFromOffsets(text: string, start: number, end: number): { lineStart: number; lineEnd: number } {
  const lineStart = text.slice(0, start).split('\n').length;
  const lineEnd = text.slice(0, Math.max(start, end)).split('\n').length;
  return { lineStart, lineEnd };
}

async function openEditorSendToTerminal(overrides?: {
  title?: string;
  page?: string;
  lineStart?: number;
  lineEnd?: number;
  excerpt?: string;
  imagePath?: string;
  defaultInstruction?: string;
}): Promise<void> {
  if (!documentState && !overrides?.page) {
    status('先に原稿を開いてください。', true);
    return;
  }
  const page = overrides?.page || (documentState ? manuscriptPagePath(documentState.page) : '');
  const content = editor.value;
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const hasSelection = end > start;
  const computedLines = lineRangeFromOffsets(content, start, end);
  let excerpt = overrides?.excerpt;
  if (excerpt === undefined && documentState && !activeImageTab) {
    if (hasSelection) {
      excerpt = content.slice(start, end);
    } else {
      const lines = content.split('\n');
      const idx = Math.max(0, computedLines.lineStart - 1);
      excerpt = lines.slice(Math.max(0, idx - 2), Math.min(lines.length, idx + 4)).join('\n');
    }
  }
  await openSendToTerminalDialog({
    title: overrides?.title,
    page,
    lineStart: overrides?.lineStart ?? (documentState ? computedLines.lineStart : undefined),
    lineEnd: overrides?.lineEnd ?? (documentState ? computedLines.lineEnd : undefined),
    excerpt,
    imagePath: overrides?.imagePath,
    defaultInstruction: overrides?.defaultInstruction,
    dirty: Boolean(dirty && documentState && manuscriptPagePath(documentState.page) === page),
    isConnected: () => Boolean(terminalController?.isConnected()),
    openTerminal: showTerminalPanel,
    sendToTerminal: async (prompt, submit) => {
      if (!terminalController?.isConnected()) throw new Error('AIターミナルが接続されていません。');
      await terminalController.sendInput(prompt, submit);
    },
    reportStatus: (message, isError) => status(message, isError),
  });
}

async function openImageSendToTerminal(source: string): Promise<void> {
  if (!documentState || activeImageTab) return;
  const page = manuscriptPagePath(documentState.page);
  const content = editor.value;
  const idx = content.indexOf(source);
  let lineStart: number | undefined;
  let excerpt = '';
  if (idx >= 0) {
    const lines = content.slice(0, idx).split('\n');
    lineStart = lines.length;
    const all = content.split('\n');
    excerpt = all.slice(Math.max(0, lineStart - 1), Math.min(all.length, lineStart + 8)).join('\n');
  }
  await openEditorSendToTerminal({
    title: '画像についてAIターミナルへ相談',
    page,
    lineStart,
    excerpt,
    imagePath: source,
    defaultInstruction: 'この画像の内容・MarkIts注釈と直後の説明文を確認し、不足やズレがあれば修正案を提示してください。',
  });
}

async function insertAiNoteAtCursor(): Promise<void> {
  if (!documentState || activeImageTab || busy) {
    status('編集する原稿を開いてください。', true);
    return;
  }
  const comment = await openInsertAiNoteDialog();
  if (!comment || !documentState || activeImageTab || busy) return;
  insertDocumentMarkdown(comment);
  status('AIメモを挿入しました。あとで「AIメモ一覧・依頼」からまとめてAIへ依頼できます。');
}

function openCurrentAiNotes(): void {
  if (!documentState || activeImageTab || busy) {
    status('編集する原稿を開いてください。', true);
    return;
  }
  const page = manuscriptPagePath(documentState.page);
  const currentContent = editor.value;
  const notes = extractAiNotes(currentContent);
  openAiNotesManagerDialog({
    page,
    notes,
    onJump: (note) => {
      showDocumentView();
      chooseTab('editor');
      if (preferredEditorView === 'preview') {
        preferredEditorView = 'edit';
        applyEditorView();
      }
      milkdown.showSource();
      jumpToSource(editor, note.start, note.end);
      updateCursor();
    },
    onRemove: (note) => {
      if (!documentState || editor.value !== currentContent) {
        status('原稿が変更されています。AIメモ一覧を開き直してください。', true);
        return;
      }
      const next = currentContent.slice(0, note.start) + currentContent.slice(note.end);
      changeImageMarkdown(next, currentContent);
      status('AIメモを削除しました。');
    },
    onSendSelected: (selected) => {
      const listText = selected.map((n, i) => `${i + 1}. 行 ${n.line}: ${n.note}`).join('\n');
      void openEditorSendToTerminal({
        title: `AIメモ ${selected.length}件をAIターミナルへ依頼`,
        page,
        lineStart: selected[0]?.line,
        lineEnd: selected.at(-1)?.line,
        excerpt: selected.map((n) => `行 ${n.line}: ${n.raw}`).join('\n'),
        defaultInstruction: `以下の <!-- ai-note: ... --> メモを順番に解決し、本文へ反映して解決済みの ai-note コメントは削除してください。\n${listText}`,
      });
    },
  });
}

async function openExternalChangeTray(): Promise<void> {
  if (!projectRoot || !terminalSnapshotId) return;
  const root = projectRoot;
  const snapId = terminalSnapshotId;
  const latest = await refreshExternalSnapshotDiff();
  const dirtyPages = new Set<string>();
  if (documentState && (dirty || editor.value !== documentState.content)) {
    dirtyPages.add(manuscriptPagePath(documentState.page));
  }
  for (const [tabPage, tab] of documentTabs) {
    if (tab.content !== tab.document.content) {
      dirtyPages.add(manuscriptPagePath(tabPage));
    }
  }
  await openExternalChangeTrayDialog({
    sessionId: snapId,
    changes: latest,
    dirtyPages,
    onApply: async (page, expectedSha256, content) => {
      await rpc('external-snapshot-apply', { id: snapId, page, expected_sha256: expectedSha256, content }, root);
      await refreshWorkspace(true, false);
      await refreshFileTree();
    },
    onAcceptAll: async () => {
      await rpc('external-snapshot-clear', { id: snapId }, root);
      terminalSnapshotId = '';
      externalChangesCache = [];
      updateExternalChangesButton();
      if (terminalController?.isConnected()) {
        await ensureTerminalSnapshot(root);
      }
      await refreshWorkspace(true, false);
      await refreshFileTree();
      status('外部変更をすべて承認しました。');
    },
    onRefresh: async () => refreshExternalSnapshotDiff(),
    reportStatus: (message, isError) => status(message, isError),
  });
}

function updateRichAiNotesBanner(): void {
  const banner = element('rich-ai-notes-banner');
  if (!banner) return;
  if (!documentState || activeImageTab) {
    banner.hidden = true;
    banner.replaceChildren();
    return;
  }
  const notes = extractAiNotes(editor.value);
  if (!notes.length) {
    banner.hidden = true;
    banner.replaceChildren();
    return;
  }
  banner.hidden = false;
  banner.replaceChildren();
  const label = document.createElement('span');
  label.className = 'rich-ai-notes-summary';
  const preview = notes[0].note.length > 56 ? `${notes[0].note.slice(0, 56)}…` : notes[0].note;
  label.textContent = `AIメモ ${notes.length}件（行 ${notes[0].line}: ${preview || '内容なし'}）`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '一覧・AIへ依頼';
  btn.onclick = () => openCurrentAiNotes();
  banner.append(label, btn);
}

function openAiCollabHub(initialTab: HubTabId = 'dashboard'): void {
  const docsPrefix = (workspace?.config.docs || 'docs').replace(/\/$/, '');
  const listPages = (): string[] =>
    (workspace?.pages || []).map((p) => (docsPrefix === '.' ? p : `${docsPrefix}/${p}`));
  openAiCollabHubDialog(
    {
      rpc,
      getProjectRoot: () => projectRoot,
      getWorkingDirectory: () => terminalWorkingDirectory || projectRoot,
      getCurrentPage: () => (documentState && !activeImageTab ? manuscriptPagePath(documentState.page) : null),
      getCurrentContent: () => editor.value,
      getPages: listPages,
      openPage: async (page, line = 1) => {
        await openResourceUsage({ page, line, start: -1, end: -1, snippet: '' });
      },
      insertMarkdownWithDiff: async (markdown, title) => {
        if (!documentState || activeImageTab || busy) {
          status('挿入先の原稿を開いてから実行してください。', true);
          return;
        }
        const page = documentState.page;
        const before = editor.value;
        const pos = editor.selectionEnd;
        const gapBefore = pos > 0 && !before.slice(0, pos).endsWith('\n\n') ? '\n\n' : '';
        const gapAfter = pos < before.length && !before.slice(pos).startsWith('\n\n') ? '\n\n' : '';
        const after = before.slice(0, pos) + gapBefore + markdown.trim() + gapAfter + before.slice(pos);
        const decision = await reviewSelection(`${page} — ${title}`, before, after, undefined, '', false);
        if (decision.action !== 'adopt' || decision.content === before) return;
        if (!documentState || documentState.page !== page || editor.value !== before) {
          status('原稿が変更されたため挿入を中止しました。', true);
          return;
        }
        changeImageMarkdown(decision.content, before);
        status(`${title}を原稿に反映しました。`);
      },
      createPageWithContent: async (relativePage, markdown) => {
        const root = projectRoot;
        const target = relativePage.replace(/^\/+/, '');
        const cleanPage = docsPrefix !== '.' && target.startsWith(`${docsPrefix}/`)
          ? target.slice(docsPrefix.length + 1)
          : target;
        await rpc('editor-save', { page: cleanPage, json: { content: markdown } }, root);
        await refreshWorkspace(false, false);
        await openPage(cleanPage, false);
        showDocumentView();
        chooseTab('editor');
        status(`${cleanPage} を作成して開きました。`);
      },
      sendToTerminal: async (opts) => {
        await openEditorSendToTerminal(opts);
      },
      reportStatus: (message, isError) => status(message, isError),
    },
    initialTab,
  );
}

const terminalPanel = element<HTMLElement>("panel-terminal");
let terminalWorkingDirectory='';
function openManualTerminal(): void {
  if (!terminalPanel || terminalController) return;
  terminalController = setupTerminalPane(terminalPanel, {
    rpc,
    getProjectRoot: () => projectRoot,
    getCliCommand: getTerminalCliCommand,
    editorRequest: async (action, args, root, signal) => {
      if (action === 'proofread-text') {
        if (root !== projectRoot || signal.aborted || busy) throw new Error('Studioの処理が完了してから推敲を実行してください。');
        return JSON.parse(await rpc('proofread-text', {json:{source:args.source,skill:args.skill}}, root));
      }
      if (root !== projectRoot || !documentState || activeImageTab || busy || editor.disabled || editor.readOnly) {
        throw new Error('編集する原稿を開いてから実行してください。');
      }
      const page = documentState.page;
      const before = editor.value;
      if (action === 'active-editor') {
        if (args.include_content === true && new TextEncoder().encode(before).byteLength > 250_000) {
          throw new Error('原稿が250 kBを超えています。本文を含めずに状態を確認してください。');
        }
        const start = editor.selectionStart, end = editor.selectionEnd;
        const lines = before.slice(0, start).split('\n');
        return { page, dirty, cursor: { line: lines.length, column: lines.at(-1)!.length + 1, start, end, units: 'utf16' },
          ...(args.include_content === true ? { content: before } : {}) };
      }
      if (action === 'insert-image' && typeof args.path === 'string') {
        const path = args.path;
        const relative = relativeProjectAsset(path, page);
        const alt = typeof args.alt === 'string' ? args.alt : '撮影画像';
        const description = alt.replace(/[\r\n]+/g, ' ').replace(/[\[\]\\]/g, '\\$&');
        insertDocumentMarkdown(`![${description}](<${relative}>)`);
        return { page, output: path, inserted: true, saved: false };
      }
      if (action === 'preview-edit' || action === 'proofread') {
        if (args.page !== page || args.before !== before) throw new Error('原稿が変更されています。active-editorで最新の原稿を確認してください。');
        if (document.querySelector('#selection-diff-dialog[open],#proofreading-dialog[open]')) throw new Error('開いている差分を先に確認してください。');
        const version = documentRequestVersion;
        let content: string|null;
        let accepted: number|undefined;
        if (action === 'proofread') {
          if (!args.drafts || typeof args.drafts !== 'object' || Array.isArray(args.drafts)) throw new Error('推敲案を指定してください。');
          const variants = Object.entries(args.drafts).map(([id, draft]) => {
            if (typeof draft !== 'string') throw new Error(`推敲案が必要です（${id}）。`);
            return {id, content: draft};
          });
          content = variants.every(variant => variant.content === before) ? null :
            await reviewProofreading(before, variants, {separate: true, signal});
        } else {
          if (typeof args.after !== 'string') throw new Error('差分案が必要です。');
          const review = before === args.after ? null :
            await reviewSelection(page, before, args.after, undefined, '', false, signal);
          content = review?.action === 'adopt' ? review.content : null;
          accepted = review?.accepted.length;
        }
        if (signal.aborted || content === null || content === before) return { page, applied: false, saved: false };
        if (root !== projectRoot || page !== documentState?.page || version !== documentRequestVersion ||
            activeImageTab || editor.value !== before || busy) {
          throw new Error('原稿が変更されたため、差分を適用しませんでした。');
        }
        changeImageMarkdown(content, before);
        status('承認した変更を原稿に反映しました。');
        return { page, applied: true, saved: false, ...(accepted === undefined ? {} : {accepted}) };
      }
      throw new Error('不明なエディター操作です。');
    },
    getWorkingDirectory:()=>terminalWorkingDirectory||projectRoot,
    prepareSession: async (root,workingDirectory) => {
      await saveAiSettings();
      const prepared=JSON.parse(await rpc('terminal-prepare',{working_directory:workingDirectory},root)) as {prompt:string};
      if(!prepared.prompt)throw new Error('AIターミナルのMarkIts案内を準備できませんでした。');
      return prepared.prompt;
    },
    onStatusChange: (state, message) => {
      element<HTMLSelectElement>('terminal-cli-agent').disabled=['connected','starting','stopping'].includes(state);
      for(const id of ['terminal-directory-settings','terminal-working-directory','terminal-choose-directory','terminal-project-directory'])element<HTMLInputElement|HTMLButtonElement>(id).disabled=['connected','starting','stopping'].includes(state);
      if (state === 'connected') {
        void ensureTerminalSnapshot(projectRoot);
      }
      if (state === "error" && message) status(message, true);
    },
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
element('terminal-directory-settings').addEventListener('click',()=>{
  input('terminal-working-directory').value=terminalWorkingDirectory||projectRoot;
  element<HTMLDialogElement>('terminal-directory-dialog').showModal();
  input('terminal-working-directory').focus();
});
element('terminal-directory-form').addEventListener('submit',event=>{
  event.preventDefault();
  terminalWorkingDirectory=input('terminal-working-directory').value.trim()||projectRoot;
  element('terminal-directory-settings').title=terminalWorkingDirectory;
  element<HTMLDialogElement>('terminal-directory-dialog').close();
});
document.querySelectorAll('#terminal-directory-dialog [data-close-dialog]').forEach(button=>button.addEventListener('click',()=>element<HTMLDialogElement>('terminal-directory-dialog').close()));
element('terminal-choose-directory').addEventListener('click',()=>{
  if(!native){status('作業フォルダのパスを入力してください。');return;}
  void invoke<string|null>('choose_project',{initialDirectory:input('terminal-working-directory').value.trim()||projectRoot}).then(path=>{if(path)input('terminal-working-directory').value=path;}).catch(error=>status(String(error),true));
});
element('terminal-project-directory').addEventListener('click',()=>{input('terminal-working-directory').value=projectRoot;});

function setBusy(value: boolean, lockControls = true): void {
  busy = value;
  document.body.setAttribute("aria-busy", String(value));
  if (!lockControls) return;
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

}
function setButtonDisabled(button: HTMLButtonElement, disabled: boolean): void {
  if (busyButtonStates) {
    busyButtonStates.set(button, disabled);
    button.disabled = true;
  }
  else button.disabled = disabled;
}
async function savedBeforeOperation(allowUnsaved=false): Promise<void> {
  await saveBriefSettings();
  await documentPersistence.wait();
  if (dirty&&!allowUnsaved) throw new Error('原稿に未保存の変更があります。保存ボタンまたはCtrl/Cmd+Sで保存してください。');
}
async function work(operation: () => Promise<void>, { lockControls = true } = {}): Promise<void> {
  if (busy) return;
  setBusy(true, lockControls);
  try { await operation(); } catch (error) { status(String(error), true); }
  finally { setBusy(false, lockControls); previewNavigator.updateToolbarState(); }
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
  if (panelId === 'panel-settings') {
    input('settings-site-name').value = workspace?.config.mkdocs.site_name ?? '';
    input('settings-site-output').value = workspace?.config.output ?? '';
    input('settings-site-exclude-unused').checked = Boolean(workspace?.config.mkdocs.exclude_unused_assets);
    element('settings-site-result').textContent = '';
    element<HTMLButtonElement>('settings-site-browse').hidden = !native;
    for (const id of ['settings-site-name','settings-site-output','settings-site-exclude-unused','settings-site-save','settings-site-browse']) {
      element<HTMLInputElement | HTMLButtonElement>(id).disabled = !projectRoot;
    }
  }
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
  if(name==='appearance'){
    selectSettingsCategory('appearance');
    const dialog=element<HTMLDialogElement>('panel-settings');
    if(!dialog.open)openPanelDialog('panel-settings');
    return;
  }
  if (name === "brief" || name === "appearance" || name === "settings") {
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
  if (name === "editor") void renderPreview();
  if (name === "terminal") {
    setTimeout(() => { terminalController?.fit();terminalController?.focus(); }, 50);
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
  documentTabs.set(documentState.page, { document: documentState, content: editor.value, start: editor.selectionStart, end: editor.selectionEnd, scroll: editor.scrollTop, richScroll: milkdown.scrollElement.scrollTop, history: editHistory, richState: milkdown.captureState() });
}
let documentTabsSignature = '';
async function closeFileTabs(targets:FileTab[]):Promise<void>{
  await documentPersistence.wait();retainDocumentTab();
  const originalDocument=documentState?.page,originalImage=activeImageTab,root=projectRoot;
  for(const target of targets){
    if(target.kind!=='document')continue;
    const tab=documentTabs.get(target.path);if(!tab||tab.content===tab.document.content)continue;
    await openPage(target.path);
    if(!await confirmDiscard()){
      if(originalImage)await openImageTab(originalImage);
      else if(originalDocument)await openPage(originalDocument);
      return;
    }
    if(root!==projectRoot)return;
    retainDocumentTab();
  }
  retainDocumentTab();
  for(const target of targets){if(target.kind==='document')documentTabs.delete(target.path);else imageTabs.delete(target.path);}
  if(documentState&&!documentTabs.has(documentState.page)){documentState=null;documentPersistence.state=null;dirty=false;}
  const nextDocument=originalDocument&&documentTabs.has(originalDocument)?originalDocument:[...documentTabs.keys()].at(-1);
  if(nextDocument)await openPage(nextDocument);
  else if(!documentState){editor.value='';resetEditHistory();element<HTMLIFrameElement>('markdown-preview').srcdoc='';element('editor-title').textContent='Markdownを編集する';}
  const nextImage=originalImage&&imageTabs.has(originalImage)?originalImage:!nextDocument?[...imageTabs].at(-1):undefined;
  if(nextImage)await openImageTab(nextImage);else showDocumentView();
  updateSaveState();renderPages();renderDocumentTabs();
}
setupFileTabMenu({tabs:()=>[...[...documentTabs.keys()].map(path=>({kind:'document' as const,path})),...[...imageTabs].map(path=>({kind:'image' as const,path}))],busy:()=>busy,close:targets=>work(()=>closeFileTabs(targets)),report:error=>status(String(error),true)});
function renderDocumentTabs(): void {
  const signature = JSON.stringify([projectRoot, activeImageTab, documentState?.page,
    [...documentTabs].map(([page, tab]) => [page, documentState?.page === page ? dirty : tab.content !== tab.document.content]),
    [...imageTabs]]);
  if (signature === documentTabsSignature) { updateEditorEmptyState(); return; }
  documentTabsSignature = signature;
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
    close.onclick = () => { void work(()=>closeFileTabs([{kind:'document',path:page}])).catch(error=>status(String(error),true)); };
    group.append(button, close); strip.append(group);
  }
  for (const path of imageTabs) {
    const group = document.createElement('div'); group.className = 'document-tab';
    const button = document.createElement('button'); button.type = 'button'; button.role = 'tab'; button.textContent = path.split('/').at(-1) || path; button.title = path; button.dataset.imagePage = path; button.setAttribute('aria-selected', String(activeImageTab === path)); button.onclick = () => { void work(() => openImageTab(path)); };
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', `${path}を閉じる`);
    close.onclick = () => { void work(()=>closeFileTabs([{kind:'image',path}])).catch(error=>status(String(error),true)); };
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
  const ownerState = documentPersistence.state?.owner === documentState ? documentPersistence.state : null;
  renderDocumentTabs();
  const badge = element("save-state");
  badge.hidden = !documentState || ownerState?.state !== 'error';
  badge.parentElement!.hidden = badge.hidden;
  badge.dataset.state = !documentState ? 'empty' : ownerState?.state || (dirty ? 'dirty' : 'saved');
  const conflicted = ownerState?.state === 'error' && isRevisionConflict(ownerState.message);
  badge.textContent = !documentState ? '原稿を選択してください' : ownerState?.state === 'saving' ? '保存中…' : conflicted ? '外部変更と競合：編集内容を保持' : ownerState?.state === 'error' ? '保存できませんでした' : dirty ? '● 未保存の変更' : '保存済み';
  badge.title = ownerState?.message || (dirty ? '保存ボタンまたはCtrl/Cmd+Sで保存してください。' : '原稿の保存状態');
  badge.setAttribute('role', 'status'); badge.setAttribute('aria-live', 'polite');
  element('save-retry').hidden = ownerState?.state !== 'error' || conflicted;
  element('save-conflict').hidden = !conflicted;
  updateEditorEmptyState();
}
type PreviewSnapshot = { root: string; page: string; body: string; version: number };
let previewContentKey='';
let renderedPreviewDocument:HTMLDocument|null=null;
const previewScheduler = new PreviewScheduler<PreviewSnapshot>({
  snapshot: () => documentState ? {root: projectRoot, page: documentState.page, body: editor.value, version: documentRequestVersion} : null,
  key: snapshot => JSON.stringify(snapshot),
  visible: () => element('panel-editor').dataset.editorView !== 'edit' && !activeImageTab && Boolean(element('markdown-preview').getClientRects().length),
  generate: snapshot => rpc('editor-preview', {page: snapshot.page, body: snapshot.body}, snapshot.root),
  loading: () => { previewRequestPending = true; previewNavigator.setStatus('loading'); },
  apply: html => {
    previewRequestPending=false;
    const frame=element<HTMLIFrameElement>('markdown-preview');const key=JSON.stringify([projectRoot,documentState?.page]);
    if(key===previewContentKey&&frame.contentDocument===renderedPreviewDocument&&renderedPreviewDocument?.body&&renderedPreviewDocument.head.querySelector('meta[http-equiv="Content-Security-Policy"]')){updatePreviewContent(renderedPreviewDocument,html);initializePreview();}
    else{previewContentKey=key;renderedPreviewDocument=null;frame.srcdoc=html;}
    previewNavigator.updateToolbarState();
  },
  error: error => { previewRequestPending = false; previewNavigator.setStatus('error', String(error)); status(`プレビュー: ${String(error)}`, true); },
});
function renderPreview(force = false): Promise<void> { return previewScheduler.request(force); }
function updateCursor(): void {

  const lines = editor.value.slice(0, editor.selectionStart).split("\n");
  element("cursor-position").textContent = `${lines.length}:${lines.at(-1)!.length + 1}`;
  updateRichAiNotesBanner();
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
  if (source) syncScroll(source, editor.hidden ? milkdown.scrollElement : editor);
}
let projectRequestVersion = 0;
let documentRequestVersion = 0;
let workspaceRequestVersion = 0;
async function openPage(page: string, check = true, restored?: Document): Promise<void> {

  const docsPrefix = (workspace?.config.docs || 'docs').replace(/\/$/,'') + '/';
  if (page.startsWith(docsPrefix) && workspace?.pages.includes(page.slice(docsPrefix.length))) page = page.slice(docsPrefix.length);
  if (check && documentState?.page === page && !activeImageTab) { chooseTab('editor'); return; }
  await documentPersistence.wait();
  retainDocumentTab();
  showDocumentView();
  let cached = check ? documentTabs.get(page) : undefined;
  const root = projectRoot;
  const version = ++documentRequestVersion;
  const opened = cached && cached.content !== cached.document.content
    ? cached.document
    : restored ?? JSON.parse(await rpc("editor-read", { page }, root)) as Document;
  if (cached && cached.document.revision !== opened.revision) cached = undefined;
  if (root !== projectRoot || version !== documentRequestVersion) return;
  documentState = opened;
  editor.dataset.owner = JSON.stringify([root, page]);
  editor.value = cached?.content ?? opened.content;
  editHistory = cached?.history || new EditorHistory();
  if (!cached) resetEditHistory();
  if (cached?.richState) milkdown.restoreState(cached.richState);
  editor.setSelectionRange(cached?.start || 0, cached?.end || 0);
  editor.scrollTop = cached?.scroll || 0; milkdown.scrollElement.scrollTop = cached?.richScroll || 0;
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
    const richInsertion = milkdown.captureSelectionEdit(true);
    const position = editor.selectionStart;
    pendingEditorFocus = true;
    showDocumentView(); chooseTab("editor");
    if (documentState) element("editor-title").textContent = documentState.page;
    if (preferredEditorView === "preview") { preferredEditorView = "edit"; applyEditorView(); }
    if (richInsertion) richInsertion.apply(markdown, true);
    else {
      rememberCurrentSelection();
      editor.setRangeText("\n\n" + markdown + "\n\n", position, position, "end");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.focus();
    }
    status("画像を原稿に挿入しました。保存ボタンまたはCtrl/Cmd+Sで保存してください。");
  }
interface QualityIssue extends Partial<ResourceUsage> {
  page: string;
  tag?: string;
  kind?: string;
  severity?: 'error' | 'warning';
  message: string;
  details?: Record<string, unknown>;
}
interface QualityReport {
  passed: boolean;
  has_warnings?: boolean;
  error_count?: number;
  warning_count?: number;
  issues: QualityIssue[];
}
function qualityCategory(kind?: string): 'error' | 'annotation' | 'glossary' | 'ai-note' {
  if (kind === 'annotation_step_mismatch' || kind === 'annotation_target_mismatch' || kind === 'annotation_step_order') return 'annotation';
  if (kind === 'glossary_violation') return 'glossary';
  if (kind === 'unresolved_ai_note') return 'ai-note';
  return 'error';
}
function renderQualityReport(target: HTMLElement, report: QualityReport, root: string) {
  target.replaceChildren();
  const errorCount = report.error_count ?? report.issues.filter((i) => (i.severity || 'error') === 'error').length;
  const warningCount = report.warning_count ?? report.issues.length - errorCount;

  const summary = document.createElement('p');
  summary.className = 'quality-summary';
  summary.textContent = report.passed
    ? warningCount > 0
      ? `公開前チェックに合格しました（警告 ${warningCount}件）。`
      : '公開前チェックに合格しました。'
    : `公開前チェックでエラー ${errorCount}件${warningCount > 0 ? `・警告 ${warningCount}件` : ''}が見つかりました。`;
  target.append(summary);

  if (!report.issues.length) return;

  const filterBar = document.createElement('div');
  filterBar.className = 'actions quality-filter-bar';
  const filterSelect = document.createElement('select');
  filterSelect.setAttribute('aria-label', '原稿チェックの絞り込み');
  for (const [value, label] of [
    ['all', `すべて (${report.issues.length})`],
    ['error', `エラー (${errorCount})`],
    ['annotation', `注釈・UIMap整合 (${report.issues.filter((i) => qualityCategory(i.kind) === 'annotation').length})`],
    ['glossary', `用語集 (${report.issues.filter((i) => qualityCategory(i.kind) === 'glossary').length})`],
    ['ai-note', `AIメモ (${report.issues.filter((i) => qualityCategory(i.kind) === 'ai-note').length})`],
  ] as const) {
    filterSelect.add(new Option(label, value));
  }
  filterBar.append(filterSelect);
  const glossaryCount = report.issues.filter((i) => qualityCategory(i.kind) === 'glossary').length;
  if (glossaryCount > 0) {
    const batchReplaceBtn = document.createElement('button');
    batchReplaceBtn.type = 'button';
    batchReplaceBtn.id = 'quality-glossary-batch-replace';
    batchReplaceBtn.textContent = `用語集違反を一括置換 (${glossaryCount})`;
    batchReplaceBtn.onclick = () => {
      void work(async () => {
        if (root !== projectRoot) return;
        const plan = JSON.parse(await rpc('glossary-replace-plan', {}, root)) as {
          total_replacements: number;
          documents: GlossaryReplacePlanDoc[];
        };
        if (root !== projectRoot) return;
        const dirtyPages = new Set<string>();
        if (documentState && dirty) dirtyPages.add(manuscriptPagePath(documentState.page));
        for (const [page, tab] of documentTabs) {
          if (tab.content !== tab.document.content) dirtyPages.add(manuscriptPagePath(page));
        }
        const applied = await openGlossaryBatchReplaceDialog({
          documents: plan.documents,
          dirtyPages,
          onApply: async (docs) => {
            const saved = JSON.parse(
              await rpc('editor-batch-save', { json: { documents: docs } }, root),
            ) as { before: Document[]; documents: Document[] };
            if (root === projectRoot) await manuscriptToolOptions.changed(saved.documents);
            return saved;
          },
          onUndo: async (batch) => {
            const docs = batch.before.map((before, i) => ({
              ...before,
              revision: batch.documents[i].revision,
            }));
            const restored = JSON.parse(
              await rpc('editor-batch-save', { json: { documents: docs } }, root),
            ) as { before: Document[]; documents: Document[] };
            if (root === projectRoot) await manuscriptToolOptions.changed(restored.documents);
          },
          reportStatus: status,
        });
        if (applied && root === projectRoot) {
          const fresh = JSON.parse(await rpc('quality-check', {}, root)) as QualityReport;
          if (root === projectRoot) renderQualityReport(target, fresh, root);
        }
      });
    };
    filterBar.append(batchReplaceBtn);
  }
  target.append(filterBar);

  const list = document.createElement('div');
  list.className = 'quality-issue-list';
  target.append(list);

  const renderRows = () => {
    list.replaceChildren();
    const selected = filterSelect.value;
    const visible = report.issues.filter((issue) => selected === 'all' || qualityCategory(issue.kind) === selected);
    for (const issue of visible) {
      const row = document.createElement('div');
      const severity = issue.severity || (qualityCategory(issue.kind) === 'error' ? 'error' : 'warning');
      row.className = `quality-issue quality-severity-${severity}`;
      const badge = document.createElement('span');
      badge.className = `quality-badge quality-badge-${severity}`;
      badge.textContent = severity === 'error' ? 'エラー' : '警告';

      const jump = document.createElement('button');
      jump.type = 'button';
      jump.textContent = `${issue.page}${issue.line ? `:${issue.line}` : ''} — 該当箇所を開く`;
      jump.onclick = () => {
        void work(async () => {
          if (root !== projectRoot) return;
          await openResourceUsage({
            page: issue.page,
            line: issue.line || 1,
            start: issue.start ?? -1,
            end: issue.end ?? -1,
            snippet: issue.snippet || '',
          });
        });
      };

      const message = document.createElement('span');
      message.className = 'quality-issue-message';
      message.textContent = issue.message;

      const rowActions = document.createElement('div');
      rowActions.className = 'actions quality-issue-actions';
      rowActions.append(jump);

      if (issue.kind === 'glossary_violation' && typeof issue.details?.preferred === 'string' && issue.snippet) {
        const preferred = issue.details.preferred;
        const replaceBtn = document.createElement('button');
        replaceBtn.type = 'button';
        replaceBtn.textContent = `「${preferred}」に置換`;
        replaceBtn.onclick = () => {
          void work(async () => {
            if (root !== projectRoot) return;
            await openResourceUsage({
              page: issue.page,
              line: issue.line || 1,
              start: issue.start ?? -1,
              end: issue.end ?? -1,
              snippet: issue.snippet || '',
            });
            const s = editor.selectionStart;
            const e = editor.selectionEnd;
            if (editor.value.slice(s, e) !== issue.snippet) {
              status('対象文字列の位置が変わっています。原稿チェックを再実行してください。', true);
              return;
            }
            const before = editor.value;
            const next = before.slice(0, s) + preferred + before.slice(e);
            changeImageMarkdown(next, before);
            status(`「${issue.snippet}」を「${preferred}」に置換しました。`);
          });
        };
        rowActions.append(replaceBtn);
      } else if (qualityCategory(issue.kind) === 'annotation') {
        const image = typeof issue.details?.image === 'string' ? issue.details.image : undefined;
        if (image) {
          const editImgBtn = document.createElement('button');
          editImgBtn.type = 'button';
          editImgBtn.textContent = 'MarkItsで編集';
          editImgBtn.onclick = () => {
            void handleEditDocumentImage(image, element<HTMLImageElement>('image-tab-preview'));
          };
          rowActions.append(editImgBtn);
        }
        const fixBtn = document.createElement('button');
        fixBtn.type = 'button';
        fixBtn.textContent = 'AIターミナルで補正';
        fixBtn.onclick = () => {
          const detailsSummary = issue.details ? JSON.stringify(issue.details) : '';
          void openEditorSendToTerminal({
            title: '注釈と本文のズレをAIターミナルで補正',
            page: issue.page,
            lineStart: issue.line || 1,
            imagePath: image,
            excerpt: issue.snippet || '',
            defaultInstruction: `原稿チェックで以下の注釈整合の警告が出ました。画像と直後の本文を確認し、番号とUI表記が一致するよう修正案を preview-edit で提示してください。\n警告: ${issue.message}\n詳細: ${detailsSummary}`,
          });
        };
        rowActions.append(fixBtn);
      } else if (issue.kind === 'unresolved_ai_note') {
        const resolveBtn = document.createElement('button');
        resolveBtn.type = 'button';
        resolveBtn.textContent = 'AIターミナルで解決';
        resolveBtn.onclick = () => {
          const note = typeof issue.details?.note === 'string' ? issue.details.note : issue.message;
          void openEditorSendToTerminal({
            title: 'AIメモを解決',
            page: issue.page,
            lineStart: issue.line || 1,
            excerpt: issue.snippet || '',
            defaultInstruction: `以下の <!-- ai-note: ... --> メモを解決して本文に反映し、解決済みの ai-note コメントを削除してください。\n内容: ${note}`,
          });
        };
        rowActions.append(resolveBtn);
      }

      row.append(badge, message, rowActions);
      list.append(row);
    }
  };
  filterSelect.onchange = renderRows;
  renderRows();
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
const markitsImages = setupMarkitsImages({
  captureShortcut:async()=>{await markitsKeyLoaded;await markitsKeySave;return markitsKey;},
  root: () => projectRoot,
  refreshAssets: async root => {
    if (root !== projectRoot) return;
    await captureDock.refresh();
    previewScheduler.invalidate();
    if (documentState) await Promise.all([renderPreview(), milkdown.refreshImages()]);
    const image = activeImageTab;
    if (image) {
      const src = await rpc('preview-asset', {page:documentState?.page || `${workspace?.config.docs || 'docs'}/index.md`,asset:image}, root);
      if (root === projectRoot && activeImageTab === image) element<HTMLImageElement>('image-tab-preview').src = src;
    }
  },
});
const captureDock=setupCaptureResources({root:()=>projectRoot,rpc,
  edited:async path=>{await handleEditDocumentImage(path,element<HTMLImageElement>('image-tab-preview'));},
  changed:async()=>{previewScheduler.invalidate();if(documentState)await Promise.all([renderPreview(),milkdown.refreshImages()]);},
  usage:usage=>openResourceUsage({...usage,snippet:usage.snippet||'',end:usage.start+(usage.snippet?.length||0)}),status,setButtonDisabled,
});
setupToolbarCustomization();

let documentImageEditing = false;
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
  const widthLabel=document.createElement('label');widthLabel.textContent='表示幅（本文に対する％）';const width=document.createElement('input');width.type='number';width.min='1';width.max='100';width.value=selected.width===null?'':String(selected.width);width.placeholder='指定なし';width.setAttribute('aria-label','表示幅（％）');widthLabel.append(width);
  const alignLabel=document.createElement('label');alignLabel.textContent='配置';const align=document.createElement('select');for(const [value,label] of [['left','左寄せ'],['center','中央寄せ'],['right','右寄せ']])align.add(new Option(label,value));align.value=selected.align;align.setAttribute('aria-label','画像の配置');alignLabel.append(align);
  const captionLabel=document.createElement('label');captionLabel.textContent='キャプション';const caption=document.createElement('input');caption.value=selected.caption;caption.setAttribute('aria-label','画像のキャプション');captionLabel.append(caption);
  const widthControls=document.createElement('div');widthControls.className='image-presentation-width';
  const noWidth=document.createElement('button');noWidth.type='button';noWidth.textContent='指定なし';
  noWidth.onclick=()=>{width.value='';feedback.textContent='表示幅を指定なしにしました。「表示設定を適用」で反映します。';};
  widthControls.append(widthLabel,noWidth);
  const help=document.createElement('p');help.textContent='「指定なし」で表示幅の指定を解除できます。配置とキャプションは引き続き設定できます。';
  const feedback=document.createElement('p');feedback.role='status';const apply=document.createElement('button');apply.type='button';apply.className='primary';apply.textContent='表示設定を適用';
  apply.onclick=()=>{try{if(root!==projectRoot||documentState?.page!==page)throw new Error('原稿が切り替わりました。');const value=width.value===''?null:Number(width.value);if(width.validity.badInput||(value!==null&&(!Number.isInteger(value)||value<1||value>100)))throw new Error('表示幅は空欄、または1〜100の整数で指定してください。');
    const raw=renderFigure({...selected,width:value,align:align.value as DocumentImage['align'],caption:caption.value,configured:true});const before=expected.slice(0,selected.start),after=expected.slice(selected.end);const gapBefore=before&&!before.endsWith('\n\n')?(before.endsWith('\n')?'\n':'\n\n'):'';const gapAfter=after&&!after.startsWith('\n\n')?(after.startsWith('\n')?'\n':'\n\n'):'';changeImageMarkdown(before+gapBefore+raw+gapAfter+after,expected);dialog.close();void milkdown.refreshImages();previewScheduler.invalidate();void renderPreview();status('画像の表示設定を更新しました。');
  }catch(error){feedback.textContent=String(error);}};
  body.classList.add('image-presentation-fields');
  body.append(widthControls,alignLabel,captionLabel,help,feedback);
  const actions=document.createElement('div');actions.className='image-presentation-actions';actions.append(apply);dialog.append(actions);
}
async function recaptureDocumentImage(imageSource:string):Promise<void>{
  if(documentImageEditing||!projectRoot)return;
  documentImageEditing=true;
  try{
    await captureDock.recaptureImage(imageSource,documentState?.page);
  }finally{documentImageEditing=false;}
}
async function handleEditDocumentImage(imageSource:string,img:HTMLImageElement):Promise<void>{
  if(documentImageEditing||!projectRoot)return;
  if(!native){status('MarkItsはデスクトップ版で利用できます。',true);return;}
  const root=projectRoot,page=documentState?.page,expected=editor.value;
  const candidate=milkdown.imageSourceRange(img)||imageAtSelection(expected,editor.selectionStart,editor.selectionEnd);
  const selected=!activeImageTab&&candidate?.src===imageSource?candidate:undefined;
  documentImageEditing=true;
  try{
    status('選択した画像をMarkItsの編集画面で開いています。保存すると編集結果を取り込みます。');
    const imported=await markitsImages.editImage(imageSource,page);
    if(!imported||root!==projectRoot)return;
    if(selected&&page===documentState?.page&&editor.value===expected){
      changeImageMarkdown(replaceDocumentImage(expected,selected,relativeProjectAsset(imported.path,page!)),expected);
      await milkdown.refreshImages();previewScheduler.invalidate();void renderPreview();
      status('MarkItsの完成画像へ参照を更新しました。');
    }else{
      status('完成画像を取り込みました: '+imported.path+'。リソース一覧から挿入・差し替えできます。');
      await openImageTab(imported.path);
    }
  }catch(error){status(String(error),true);}
  finally{documentImageEditing=false;}
}
async function refreshWorkspace(reloadPage = false, refreshResources = true): Promise<void> {
  const root = projectRoot;
  const current = documentState;
  const content = editor.value;
  const documentVersion = documentRequestVersion;
  const version = ++workspaceRequestVersion;
  const loaded = JSON.parse(await rpc("state", {json:{editor:true}}, root)) as State;
  if (root !== projectRoot || version !== workspaceRequestVersion) return;
  workspace = loaded;
  renderPages();
  if (reloadPage && current && documentState === current &&
      documentVersion === documentRequestVersion && editor.value === content) {
    const opened = JSON.parse(await rpc("editor-read", { page: current.page }, root)) as Document;
    if (root === projectRoot && version === workspaceRequestVersion && documentState === current &&
        documentVersion === documentRequestVersion && editor.value === content) {
      documentState = opened; editor.value = opened.content; resetEditHistory(); dirty = false; updateSaveState();
      await Promise.all([renderPreview(), milkdown.refreshImages()]);
    }
  }
  if (refreshResources && root === projectRoot && version === workspaceRequestVersion) await markitsImages.refresh();
}

let treeRefreshPending = false;
async function refreshFileTree(): Promise<void> {
  const root = projectRoot;
  const current = workspace;
  if (!root || !current || document.hidden || treeRefreshPending) return;
  const version = workspaceRequestVersion;
  treeRefreshPending = true;
  try {
    const next = JSON.parse(await rpc("workspace-tree", {}, root)) as Pick<State, "pages" | "project_entries">;
    if (root !== projectRoot || current !== workspace || version !== workspaceRequestVersion) return;
    if (next.pages.length === current.pages.length &&
        next.pages.every((page, index) => page === current.pages[index]) &&
        next.project_entries.length === current.project_entries.length &&
        next.project_entries.every((entry, index) => {
          const previous = current.project_entries[index];
          return entry.path === previous.path && entry.directory === previous.directory;
        })) return;

    const tree = element("page-list");
    const focused = document.activeElement;
    const row = focused instanceof HTMLElement && tree.contains(focused)
      ? focused.closest<HTMLElement>("[data-page], [data-file], [data-folder]")
      : null;
    const key = row?.dataset.page ?? row?.dataset.file ?? row?.dataset.folder;
    current.pages = next.pages;
    current.project_entries = next.project_entries;
    renderPages();
    if (key !== undefined) {
      const escaped = CSS.escape(key);
      const replacement = row?.dataset.folder !== undefined
        ? tree.querySelector<HTMLElement>(`[data-folder="${escaped}"] > summary`)
        : tree.querySelector<HTMLElement>(`[data-page="${escaped}"], [data-file="${escaped}"]`);
      replacement?.focus({ preventScroll: true });
    }
  } catch {
    // A missing or temporarily inaccessible folder can be read on the next poll.
  } finally {
    treeRefreshPending = false;
  }
}
let documentRefreshPending = false;
const reportedDocumentUpdates = new WeakMap<Document, string>();
async function refreshOpenDocument(): Promise<void> {
  const current = documentState;
  const root = projectRoot;
  const version = documentRequestVersion;
  if (!current || activeImageTab || busy || document.hidden || documentRefreshPending) return;
  documentRefreshPending = true;
  try {
    const opened = JSON.parse(await rpc('editor-read-if-changed', { page: current.page, revision: current.revision }, root)) as Document | null;
    if (!opened?.revision || busy || activeImageTab || documentState !== current || root !== projectRoot || version !== documentRequestVersion) return;
    if (dirty || editor.value !== current.content) {
      if (reportedDocumentUpdates.get(current) !== opened.revision) {
        reportedDocumentUpdates.set(current, opened.revision);
        status('原稿が外部で更新されました。エディターの未保存の編集は保持しています。', true);
      }
      return;
    }
    const start = editor.selectionStart, end = editor.selectionEnd;
    const scroll = editor.scrollTop, richScroll = milkdown.scrollElement.scrollTop;
    documentState = opened;
    documentPersistence.state = null;
    if (opened.content !== current.content) {
      editor.value = opened.content;
      editor.setSelectionRange(start, end);
      editor.scrollTop = scroll;
      milkdown.scrollElement.scrollTop = richScroll;
      resetEditHistory();
    }
    retainDocumentTab();
    updateSaveState();
    updateCursor();
    status('外部で更新された原稿を読み直しました。');
    await Promise.all([renderPreview(), milkdown.refreshImages()]);
  } catch {
    // Editors may temporarily replace a file when saving; the next poll retries.
  } finally {
    documentRefreshPending = false;
  }
}
function refreshExternalChanges(): void {
  void refreshFileTree();
  void refreshOpenDocument();
  void captureDock.refreshVisible();
  void refreshExternalSnapshotDiff();
}
window.setInterval(refreshExternalChanges, 4000);
document.addEventListener("visibilitychange", refreshExternalChanges);
window.addEventListener('focus', refreshExternalChanges);

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
  applyAlertIconSetting();
  input("ai-model").value = workspace.config.model;
  cliAiSettings.load({...workspace.config.cli_models,...(workspace.config.connection_type==='cli'?{[workspace.config.agent]:workspace.config.model}:{})});
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
    agent: element<HTMLSelectElement>("ai-agent").value,
    model: input("ai-model").value.trim(),
    connection_type: element<HTMLSelectElement>("ai-connection-type").value,
    endpoint_url: input("ai-endpoint-url").value.trim(),
    json:{cli_models:cliAiSettings.snapshot()},
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
  if(element<HTMLSelectElement>('ai-connection-type').value==='cli')cliAiSettings.set(element<HTMLSelectElement>('ai-agent').value,input('ai-model').value.trim());
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
      endpoint_url: endpointUrl,
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
  const loaded = JSON.parse(await rpc("state", {json:{editor:true}}, root)) as State;
  if (version !== projectRequestVersion) return;
  ++documentRequestVersion; ++workspaceRequestVersion;
  if (projectRoot !== root) expandedFolders.clear();
  if (terminalController && projectRoot !== root) await terminalController.kill();
  closeAllPanelDialogs(true);
  saveDocumentTabSession();
  restoringDocumentTabs = true;
  documentTabs.clear(); imageTabs.clear(); showDocumentView();
  if(version!==projectRequestVersion)return;
  projectRoot = root; workspace = loaded; documentState = null; dirty = false;
  terminalSnapshotId = '';
  terminalSnapshotRoot = '';
  externalChangesCache = [];
  updateExternalChangesButton();
  void glossarySettings.reload(root);
  terminalWorkingDirectory=root;
  element('terminal-directory-settings').title=root;
  if (version !== projectRequestVersion) return;
  documentPersistence.state = null;
  setAiPhase(element('ai-workflow-status'), 'idle');
  previewNavigator.setStatus('empty');
  previewScheduler.invalidate();
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
  if(version!==projectRequestVersion)return;
  if (params.get("root") !== root) {
    params.set("root", root);
    params.delete("page");
    const url = new URL(location.href);
    url.search = params.toString();
    history.replaceState(null, "", url);
  }
  element("workspace-name-label").textContent = root.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || root;
  element<HTMLDialogElement>("workspace-dialog").close();
  renderPages(); renderSettings(); loadAiProgressLogs(root);
  const validPage = (page:unknown): page is string => typeof page === 'string' && (loaded.pages.includes(page) || loaded.project_entries.some(entry => !entry.directory && entry.path === page && /\.md$/i.test(entry.path)));
  let saved: {pages:string[];active:string|null} | null = null;
  try {
    const value = JSON.parse(localStorage.getItem(`manual-studio-document-tabs:${root}`) || 'null');
    if (value && Array.isArray(value.pages)) saved = {pages:[...new Set(value.pages.filter(validPage))] as string[],active:validPage(value.active)?value.active:null};
  } catch { /* Ignore invalid optional session data. */ }
  const preferred = params.get("page");
  let page = validPage(preferred) ? preferred : saved?.active || saved?.pages.at(-1);
  try {
    const savedPages=saved?.pages||[];
    const restored:Array<Document|null>=new Array(savedPages.length).fill(null);
    let nextTab=0;
    await Promise.all(Array.from({length:Math.min(4,savedPages.length)},async()=>{
      while(nextTab<savedPages.length){
        const index=nextTab++;
        try{restored[index]=JSON.parse(await rpc('editor-read',{page:savedPages[index]},root)) as Document;}
        catch{/* Removed/unreadable pages do not prevent restoring other tabs. */}
      }
    }));
    if (version !== projectRequestVersion) return;
    for (let index=0;index<restored.length;index++) {
      const opened=restored[index];
      if(!opened)continue;
      const tab=saved!.pages[index];
      const history=new EditorHistory();history.reset({value:opened.content,start:0,end:0});
      documentTabs.set(tab,{document:opened,content:opened.content,start:0,end:0,scroll:0,richScroll:0,history,richState:null});
    }
    if (page && saved?.pages.includes(page) && !documentTabs.has(page)) page = [...documentTabs.keys()].at(-1);
    if (!page && !saved) page = loaded.pages[0] || loaded.project_entries.find(entry => !entry.directory && /\.md$/i.test(entry.path))?.path;
    if (page) await openPage(page, false, documentTabs.get(page)?.document);
    else if (!documentTabs.size) { editor.value = ""; updateSaveState(); status("一覧から原稿を開くか、「＋」で原稿を作成してください。"); }
  } finally {
    if (version === projectRequestVersion) { restoringDocumentTabs = false; saveDocumentTabSession(); }
  }
  if(version!==projectRequestVersion)return;
  const restoredDocument = documentState as Document | null;
  await captureDock.refresh();
  if(version!==projectRequestVersion)return;
  if (restoredDocument) status(`プロジェクトを開きました。${restoredDocument.page}を編集できます。`);
  if (!loaded.has_config && !detached) status("原稿の編集・保存・プレビューから始められます。AI接続は上部の「設定 → 文章・図のAI」で設定できます。");

}
function saveDocument(refresh = true): Promise<void> {
  return documentPersistence.save(refresh);
}

function saveFromEditor(refresh = true): Promise<void> {
  if (!documentState || activeImageTab) return Promise.resolve();
  // Toggling read-only rebuilds ProseMirror plugin views and resets its viewport.
  return work(() => saveDocument(refresh), { lockControls: false });
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
  let completionMessage = action === "build-zensical" ? "ZensicalでHTMLを作成しました。" :
    action === "build-mkdocs" ? "MkDocsでHTMLを作成しました。" :
    action === "recapture" || action === "capture-window" ? "画像を更新し、撮影元を保存しました。" : "処理が完了しました。";
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
          const issues=parsed.issues as Array<{page:string;tag?:string;severity?:string;message:string}>;
          const errorCount=typeof parsed.error_count==='number'?parsed.error_count:issues.filter(i=>(i.severity||'error')==='error').length;
          const warningCount=typeof parsed.warning_count==='number'?parsed.warning_count:issues.length-errorCount;
          completionHasError=!parsed.passed;
          completionMessage=parsed.passed
            ? (warningCount>0?`公開前チェックに合格しました（警告 ${warningCount}件）。`:'公開前チェックに合格しました。')
            : `公開前チェックでエラー ${errorCount}件${warningCount>0?`・警告 ${warningCount}件`:''}が見つかりました。`;
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
setupGfmSourceToolbar(element('panel-editor').querySelector<HTMLElement>('.formatting-toolbar')!,markdown=>{if(!documentState||busy)return;insertDocumentMarkdown(markdown);status('注釈を挿入しました。');});
setupControlIcons();
for (const [selector, name] of [["#undo-edit", "undo"], ["#redo-edit", "redo"], ["#insert-image", "image"], ['[data-format="link"]', "link"]] as const) {
  const button = document.querySelector<HTMLButtonElement>(selector);
  if (button) button.innerHTML = uiIcon(name) + (name === "image" ? " 画像" : name === "link" ? " リンク" : "");
}
document.querySelectorAll<HTMLElement>("[data-tab]").forEach((button) => button.addEventListener("click", () => {
  if(button.dataset.tab==='settings')selectSettingsCategory('text-ai');
  chooseTab(button.dataset.tab!);
}));

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
    const request=rpc;
    showWorkspaceHistory(history, projectRoot, root => work(() => openProject(root)), projectRoot ? [
      {label:'原稿・画像の保存先',run:()=>{void showWorkspacePaths({root:()=>projectRoot,request,
        prepare:async()=>{if(busy)throw new Error('処理が終わってから変更してください。');await savedBeforeOperation();return confirmAllDocumentTabs();},
        changed:async root=>{if(root===projectRoot)await work(()=>openProject(root,false));},
      }).catch(error=>status(String(error),true));}},
      {label:'撮影・挿入の処理時間',run:()=>{void showOperationTimings({root:()=>projectRoot,request}).catch(error=>status(String(error),true));}},
    ] : []);
  });
});
element("project-form").addEventListener("submit", (event) => { event.preventDefault(); void work(() => openProject(input("project-root").value.trim())); });
element("browse-project").addEventListener("click", () => { void work(async () => {
  if (!native) { status("ブラウザーでの開発表示では、プロジェクトのパスを入力して「開く」を押してください。"); input("project-root").focus(); return; }
  const path = await invoke<string | null>("choose_project", { initialDirectory: input("project-root").value.trim() || projectRoot });
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
document.addEventListener('keydown', event => {
  if (event.isComposing || document.querySelector('dialog:modal') || (event.target instanceof Element && event.target.closest('#panel-terminal'))) return;
  if (event.key === 'Escape' && !element('tree-filters').hidden && event.target instanceof Element && event.target.closest('#panel-tree')) {
    event.preventDefault();
    input('tree-search').value = '';
    element<HTMLSelectElement>('tree-filter').value = 'all';
    element('tree-filters').hidden = true;
    renderPages();
    element('page-list').tabIndex = -1;
    element('page-list').focus();
  }
});
input("tree-search").addEventListener("input", renderPages);
element("tree-filter").addEventListener("change", renderPages);
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
  const changed = element("panel-editor").dataset.editorView !== view;
  element("panel-editor").dataset.editorView = view;
  if (view === 'edit' && changed) previewScheduler.invalidate();
  else if (changed) void renderPreview();
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
new ResizeObserver(() => { if (element('markdown-preview').getClientRects().length) void renderPreview(); }).observe(element('markdown-preview'));
editor.addEventListener("editor-mode-change", () => {
  if (preferredEditorView === "preview") { preferredEditorView = "edit"; applyEditorView(); }
});
function updateEditorEmptyState(): void {
  const empty = !documentState && !activeImageTab;
  element('editor-empty-state').hidden = !empty;
  element('editor-empty-title').textContent = workspace ? '原稿を選ぶか、作成してください' : 'フォルダーを開いて始める';
  element('editor-empty-description').textContent = workspace ? '左のファイルツリーから原稿を選択できます。' : '原稿と画像を保存しているフォルダーを選択してください。';
  element('empty-open-folder').hidden = Boolean(workspace);
  element('empty-select-page').hidden = !workspace || !workspace.pages.length;
  element('empty-create-page').hidden = !workspace;
  element('panel-editor').classList.toggle('editor-is-empty', empty);
  setButtonDisabled(element<HTMLButtonElement>('editor-screenshot-ai'),!projectRoot||captureInsertionRunning);
  for (const id of ['reader-review','save-page']) setButtonDisabled(element<HTMLButtonElement>(id), !documentState || Boolean(activeImageTab));
  setButtonDisabled(element<HTMLButtonElement>('site-export-open'), !projectRoot);
}
element('empty-open-folder').addEventListener('click', () => element('open-existing-workspace').click());
element('empty-create-page').addEventListener('click', () => { contextCreateParent = null; element('new-page').click(); });
element('empty-select-page').addEventListener('click', () => { layoutManager?.focusPanel('file-tree'); element('page-list').tabIndex = -1; element('page-list').focus(); });
element('save-page').addEventListener('click', () => { void saveFromEditor(); });
element('save-retry').addEventListener('click', () => { void saveFromEditor(false); });
async function saveReviewedConflict(owner: Document, root: string, draft: string, stored: Document): Promise<void> {
  const current = () => root === projectRoot && owner === documentState && editor.value === draft && !activeImageTab;
  if (!current() || document.querySelector('#selection-diff-dialog[open]')) return;
  const review = await reviewSelection(owner.page, stored.content, draft, {accepted:[],feedback:''}, '', false, undefined, true);
  if (review.action !== 'adopt' || !review.accepted.length) return;
  if (!current()) { status('編集中の原稿が変わりました。保存する変更を選び直してください。', true); return; }
  await work(async () => {
    documentPersistence.state = { owner, state: 'saving' };
    updateSaveState();
    try {
      const saved = JSON.parse(await rpc('editor-save', {
        page: owner.page, json: { content: review.content, revision: stored.revision },
      }, root)) as Document;
      if (root !== projectRoot || owner !== documentState || activeImageTab) return;
      if (editor.value === draft) editor.value = saved.content;
      documentState = saved;
      documentPersistence.state = null;
      dirty = editor.value !== saved.content;
      retainDocumentTab();
      updateSaveState();
      await renderPreview();
      status(`${owner.page}を保存しました。`);
    } catch (error) {
      if (root === projectRoot && owner === documentState) {
        documentPersistence.state = { owner, state: 'error', message: String(error) };
        updateSaveState();
      }
      throw error;
    }
  });
}
element('save-conflict').addEventListener('click', () => { void work(async () => {
  if (!documentState) return;
  const owner = documentState, root = projectRoot, draft = editor.value;
  const stored = JSON.parse(await rpc('editor-read', { page: owner.page }, root)) as Document;
  if (root !== projectRoot || owner !== documentState || draft !== editor.value) return;
  const {dialog,body} = featureDialog('外部変更を確認'); dialog.id = 'save-conflict-dialog';
  const note = document.createElement('p'); note.textContent = '編集中の内容は保持しています。保存先と比べて、保存する変更を選べます。';
  const columns = document.createElement('div'); columns.className = 'selection-diff-columns';
  for (const [label,content] of [['編集中の内容',draft],['保存先の内容',stored.content]]) {
    const column = document.createElement('section'), heading = document.createElement('h3'), pre = document.createElement('pre'); heading.textContent = label; pre.textContent = content; column.append(heading,pre); columns.append(column);
  }
  const keep = document.createElement('button'); keep.textContent = '編集中の内容を保持して閉じる'; keep.onclick = () => dialog.close();
  const review = document.createElement('button'); review.textContent = '変更を選んで保存'; review.className = 'primary';
  review.onclick = () => {
    dialog.addEventListener('close', () => {
      void saveReviewedConflict(owner, root, draft, stored).catch(error => status(String(error), true));
    }, {once:true});
    dialog.close();
  };
  const reload = document.createElement('button'); reload.textContent = '保存先の内容を読み直す'; reload.onclick = () => { dialog.close(); if(documentState)void work(async()=>{if(!await confirmDiscard()||!documentState)return;await openPage(documentState.page,false);}); };
  const actions = document.createElement('div'); actions.className = 'actions'; actions.append(keep, reload, review);
  body.append(note,columns,actions);
}); });
element('workspace-name').addEventListener('keydown', event => { if (event.key === 'ArrowDown' && !document.getElementById('workspace-history-dialog')) { event.preventDefault(); element('workspace-name').click(); } });
for (const id of ['tree-create-menu']) {
  const menu = element<HTMLDetailsElement>(id);
  menu.addEventListener('click', event => { if ((event.target as HTMLElement).closest('button')) menu.open = false; });
  menu.addEventListener('keydown', event => { if (event.key === 'Escape') { menu.open = false; menu.querySelector<HTMLElement>('summary')?.focus(); } });
  document.addEventListener('click', event => { if (!menu.contains(event.target as Node)) menu.open = false; });
}
element("undo-edit").addEventListener("click", () => stepEditHistory(-1));
element("redo-edit").addEventListener("click", () => stepEditHistory(1));
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

  previewScheduler.schedule();
});
editor.addEventListener("scroll", () => syncScroll(editor, previewScrollElement()));
milkdown.host.addEventListener("scroll", event => { if (event.target === milkdown.scrollElement) syncScroll(milkdown.scrollElement, previewScrollElement()); }, true);
function initializePreview():void {
  const content=element<HTMLIFrameElement>('markdown-preview').contentDocument;
  if(content?.body){renderedPreviewDocument=content;rememberPreviewContent(content);}
  if (documentState && !previewRequestPending) previewNavigator.setStatus('ready');
  previewNavigator.setupIframeInterception(element<HTMLIFrameElement>("markdown-preview"));
  previewNavigator.updateToolbarState();
  const previewDocument = element<HTMLIFrameElement>("markdown-preview").contentDocument;
  previewDocument?.removeEventListener('keydown', handleDocumentShortcut);
  previewDocument?.addEventListener('keydown', handleDocumentShortcut);
  previewDocument?.querySelectorAll<HTMLElement>('code.language-mermaid, pre.mermaid, .highlight.language-mermaid pre').forEach(code => {
    const target = previewDocument.createElement("div");
    target.className = "mermaid-preview";
    target.style.cssText = "overflow:auto;background:#fff;padding:12px";
    const original=code.closest("pre")||code;rememberPreviewReplacement(original,target);original.replaceWith(target);
    void renderMermaid(target, code.textContent || "");
  });
  previewScrollWindow?.removeEventListener("scroll", onPreviewScroll);
  previewScrollWindow = element<HTMLIFrameElement>("markdown-preview").contentWindow;
  previewScrollWindow?.addEventListener("scroll", onPreviewScroll);
  syncScroll(editor.hidden ? milkdown.scrollElement : editor, previewScrollElement());
}
element<HTMLIFrameElement>("markdown-preview").addEventListener("load",initializePreview);
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
    const level = Number(element<HTMLSelectElement>("heading-level").value);
    if (level) applyAssist(changeHeadingLevel(editor.value, start, end, level));
    else {
      const from = editor.value.lastIndexOf('\n', start - 1) + 1;
      const newline = editor.value.indexOf('\n', end);
      const to = newline < 0 ? editor.value.length : newline;
      const text = editor.value.slice(from, to).replace(/^(\s*)#{1,6}\s+/gm, '$1');
      replaceMarkdown(from, to, text, 0, text.length);
    }
  } else if (format === "bullet" || format === "numbered" || format === "quote") {
    const lineStart = editor.value.lastIndexOf("\n", start - 1) + 1;
    const nextNewline = editor.value.indexOf("\n", end);
    const lineEnd = nextNewline < 0 ? editor.value.length : nextNewline;
    const lines = editor.value.slice(lineStart, lineEnd).split("\n");
    const replacement = lines.map((line, index) => `${format === "bullet" ? "- " : format === "quote" ? "> " : `${index + 1}. `}${line}`).join("\n");
    replaceMarkdown(lineStart, lineEnd, replacement, replacement.length, replacement.length);
  } else if (format === "mermaid") {
    replaceMarkdown(start, end, "\n\n```mermaid\ngraph TD\n    A[開始] --> B[完了]\n```\n", 0);
  } else if (format === "math") {
    replaceMarkdown(start, end, `\n\n\`\`\`LaTeX\n${selected || 'x = y'}\n\`\`\`\n`, 0);
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
editor.addEventListener('source-toolbar-action', event => {
  if (busy || !documentState || editor.readOnly || editor.disabled) return;
  const {format, level, markdown} = (event as CustomEvent<{format:string;level?:number;markdown?:string}>).detail;
  if (format === 'undo' || format === 'redo') {stepEditHistory(format === 'undo' ? -1 : 1); return;}
  if (format === 'image') {element('insert-image').click(); return;}
  if (format === 'alert' && markdown) {insertDocumentMarkdown(markdown); return;}
  if (format === 'heading' && level !== undefined) element<HTMLSelectElement>('heading-level').value = String(level);
  applyMarkdownFormat(format);
});
editor.addEventListener("keydown", (event) => {
  if (busy || !documentState) return;
  if (event.key === "Enter" && !event.isComposing && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && editor.selectionStart === editor.selectionEnd) {
    event.preventDefault(); applyAssist(continueMarkdownList(editor.value, editor.selectionStart)); return;
  }
});
function handleDocumentShortcut(event: KeyboardEvent): void {
  if(event.defaultPrevented||event.isComposing||document.querySelector('dialog:modal'))return;
  const stroke=keyStroke(event),bindings=currentBindings();
  const command=(['save','preview','refresh','settings'] as ShortcutCommand[]).find(command=>stroke&&bindings[command].includes(stroke));
  if(command){event.preventDefault();runKeyboardCommand(command,event);}
}
function runKeyboardCommand(command: ShortcutCommand, event: KeyboardEvent): void {
  if(command==='settings'){chooseTab('settings');return;}
  if(command==='treeSearch'){
    layoutManager?.focusPanel('file-tree');element('tree-filters').hidden=false;
    requestAnimationFrame(()=>{input('tree-search').focus();input('tree-search').select();});return;
  }
  if(command==='search'){element('manuscript-search-open').click();return;}
  if(command==='sendToTerminal'){void openEditorSendToTerminal();return;}
  if(busy||!documentState||activeImageTab)return;
  if(command==='insertAiNote'){void insertAiNoteAtCursor();return;}
  if(command==='save'){void saveFromEditor();return;}
  if(command==='preview'){
    const views:EditorView[]=['edit','split','preview'];
    const next=views[(views.indexOf(element('panel-editor').dataset.editorView as EditorView)+1)%views.length];
    document.querySelector<HTMLButtonElement>(`#panel-editor button[data-editor-view="${next}"]`)!.click();return;
  }
  if(command==='refresh'){void work(renderPreview);return;}
  if(milkdown.runShortcut(command))return;
  if(editor.readOnly||editor.disabled)return;
  if(command==='undo'||command==='redo'){stepEditHistory(command==='undo'?-1:1);return;}
  if(command==='bold'||command==='italic'||command==='link'){applyMarkdownFormat(command);return;}
  if(command==='indent'||command==='outdent'){
    if(command==='indent'&&event.key==='Tab'&&editor.selectionStart===editor.selectionEnd)replaceMarkdown(editor.selectionStart,editor.selectionEnd,'  ',2);
    else applyAssist(changeIndent(editor.value,editor.selectionStart,editor.selectionEnd,command==='indent'?'indent':'unindent'));
    return;
  }
  const expected=editor.value,start=editor.selectionStart,end=editor.selectionEnd,line=currentLine(expected,start);
  if(command==='duplicate'){replaceMarkdown(line.end,line.end,'\n'+line.text.slice(0,-1),1+start-line.start);return;}
  if(command==='deleteLine'){replaceMarkdown(line.deleteStart,line.deleteEnd,'',0);return;}
  if(command==='cut'){
    const selected=start!==end,text=selected?expected.slice(start,end):line.text;
    void copyTextToClipboard(text).then(()=>{
      if(editor.value!==expected||editor.selectionStart!==start||editor.selectionEnd!==end)return;
      replaceMarkdown(selected?start:line.deleteStart,selected?end:line.deleteEnd,'',0);
    }).catch(error=>status(`切り取りできませんでした: ${String(error)}`,true));
  }
}
installShortcutRouter(runKeyboardCommand,target=>target===editor||Boolean(target.closest('.ProseMirror,.cm-editor')));
function updateShortcutTitles():void {
  const bindings=currentBindings();
  const keys=(command:ShortcutCommand)=>bindings[command].map(bindingLabel).join(' / ')||'未割り当て';
  element('save-page').title=`原稿を保存 (${keys('save')})`;
  element('application-settings').title=`設定 (${keys('settings')})`;
  document.querySelectorAll<HTMLButtonElement>('#panel-editor button[data-editor-view]').forEach(button=>{button.title=`${button.getAttribute('aria-label')||button.textContent} (${keys('preview')})`;});
}
updateShortcutTitles();window.addEventListener('manual-studio-keybindings-change',updateShortcutTitles);
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
const moveTreeFile = setupFileMove({
  root:()=>projectRoot,busy:()=>busy,folders:()=>workspace?.project_entries.filter(e=>e.directory).map(e=>e.path)||[],request:rpc,work,report:status,
  prepare:async()=>{
    await savedBeforeOperation();retainDocumentTab();
    const active=documentState?.page;
    for(const [page,tab] of documentTabs)if(tab.content!==tab.document.content)throw new Error(`${page}に未保存の変更があります。先に保存してください。`);
    if(active&&documentState?.page!==active)await openPage(active);
  },
  changed:async(result:FileMoveResult)=>{
    const active=documentState?manuscriptPagePath(documentState.page):undefined;
    const tabs=[...documentTabs.values()].map(tab=>({tab,path:manuscriptPagePath(tab.document.page)}));
    const image=activeImageTab;
    for(const path of [...imageTabs])if(path===result.source){imageTabs.delete(path);imageTabs.add(result.destination);}
    documentState=null;documentPersistence.state=null;dirty=false;previewScheduler.invalidate();
    await refreshWorkspace(false,false);documentTabs.clear();
    const displayPath=(path:string)=>{
      const prefix=(workspace?.config.docs||'docs').replace(/\/$/,'')+'/';
      return path.startsWith(prefix)&&workspace?.pages.includes(path.slice(prefix.length))?path.slice(prefix.length):path;
    };
    for(const {tab,path} of tabs){
      const next=path===result.source?result.destination:path;
      const saved=result.documents.find(d=>d.page===next);
      const label=displayPath(next);
      if(saved){const history=new EditorHistory();history.reset({value:saved.content,start:0,end:0});documentTabs.set(label,{...tab,document:{...saved,page:label},content:saved.content,history,richState:null,start:0,end:0});}
      else documentTabs.set(label,{...tab,document:{...tab.document,page:label}});
    }
    expandedFolders.add(result.destination.split('/').slice(0,-1).join('/'));
    if(active)await openPage(active===result.source?result.destination:active);
    if(image)await openImageTab(image===result.source?result.destination:image);
    await markitsImages.refresh();renderPages();renderDocumentTabs();saveDocumentTabSession();
  },
});
let contextMoveSource:string|null=null;
const treeContextMenu = document.createElement('div'); treeContextMenu.id = 'tree-context-menu'; treeContextMenu.className = 'tree-context-menu'; treeContextMenu.role = 'menu'; treeContextMenu.hidden = true;
for (const [label, id] of [['Markdownを作成','new-page'],['フォルダーを作成','new-folder']]) {
  const button = document.createElement('button'); button.type = 'button'; button.role = 'menuitem'; button.textContent = label; button.onclick = () => { treeContextMenu.hidden = true; element<HTMLButtonElement>(id).click(); }; treeContextMenu.append(button);
}
const moveMenuItem=document.createElement('button');moveMenuItem.type='button';moveMenuItem.role='menuitem';moveMenuItem.textContent='移動してリンクを更新';moveMenuItem.hidden=true;
moveMenuItem.onclick=()=>{treeContextMenu.hidden=true;if(contextMoveSource)void moveTreeFile(contextMoveSource);};treeContextMenu.append(moveMenuItem);
const deleteMenuItem=document.createElement('button');deleteMenuItem.type='button';deleteMenuItem.role='menuitem';deleteMenuItem.textContent='削除';deleteMenuItem.hidden=true;
deleteMenuItem.onclick=()=>{
  treeContextMenu.hidden=true;
  const source=contextMoveSource,root=projectRoot;if(!source||!root||busy)return;
  void work(async()=>{
    await savedBeforeOperation();retainDocumentTab();
    for(const [page,tab] of documentTabs)if(tab.content!==tab.document.content)throw new Error(`${page}に未保存の変更があります。先に保存してください。`);
    const plan=JSON.parse(await rpc('project-delete-file',{json:{source}},root)) as {source:string;references:string[];token:string};
    if(root!==projectRoot)return;
    const {dialog,body}=featureDialog('ファイルを削除');dialog.id='file-delete-dialog';
    const description=document.createElement('p');description.textContent=`「${source}」を削除しますか？`;
    const warning=document.createElement('p');warning.role=plan.references.length?'alert':'status';
    warning.textContent=plan.references.length?'このファイルは次のファイルから参照されています。削除するとリンク切れになります。':'このファイルへの参照は見つかりませんでした。';
    const list=document.createElement('ul');for(const path of plan.references){const item=document.createElement('li');item.textContent=path;list.append(item);}
    const note=document.createElement('p');note.textContent='削除前のファイルを .munin/file-deletions/ にバックアップします。';
    const message=document.createElement('p');message.role='alert';
    const cancel=document.createElement('button');cancel.type='button';cancel.textContent='キャンセル';cancel.onclick=()=>dialog.close();
    const apply=document.createElement('button');apply.type='button';apply.textContent=plan.references.length?'参照を確認して削除':'削除する';
    let deleting=false;
    dialog.addEventListener('cancel',event=>{if(deleting)event.preventDefault();});
    apply.onclick=()=>{if(deleting||busy||root!==projectRoot||!dialog.open)return;deleting=true;apply.disabled=cancel.disabled=true;void work(async()=>{
      try{
        retainDocumentTab();
        for(const [page,tab] of documentTabs)if(tab.content!==tab.document.content)throw new Error(`${page}に未保存の変更があります。先に保存してください。`);
        await rpc('project-delete-file',{json:{source:plan.source,token:plan.token,apply:true}},root);
        dialog.close();
        const targets:FileTab[]=[...[...documentTabs.keys()].filter(page=>manuscriptPagePath(page)===source).map(path=>({kind:'document' as const,path})),...[...imageTabs].filter(path=>path===source).map(path=>({kind:'image' as const,path}))];
        await closeFileTabs(targets);await refreshWorkspace(false,false);await markitsImages.refresh();renderPages();renderDocumentTabs();
        status(`${source}を削除しました。`);
      }catch(error){message.textContent=String(error);}
      finally{deleting=false;apply.disabled=cancel.disabled=false;}
    });};
    const actions=document.createElement('div');actions.className='actions';actions.append(cancel,apply);body.append(description,warning,list,note,message,actions);cancel.focus();
  });
};treeContextMenu.append(deleteMenuItem);
document.body.append(treeContextMenu);
element('page-list').addEventListener('contextmenu', event => {
  if (!workspace || busy) return; event.preventDefault();
  const target = event.target as HTMLElement;
  const file = target.closest<HTMLElement>('[data-page],[data-image],[data-file]');
  contextMoveSource=file?(file.dataset.page||file.dataset.image||file.dataset.file||null):null;moveMenuItem.hidden=!contextMoveSource;
  deleteMenuItem.hidden=!contextMoveSource;
  contextCreateParent = file ? (file.dataset.page || file.dataset.image || file.dataset.file || '').split('/').slice(0,-1).join('/') : target.closest<HTMLElement>('[data-folder]')?.dataset.folder || workspace.config.docs;
  contextCreateParent = contextCreateParent.replace(/\\/g, '/').split('/').filter(part => part && part !== '.').join('/');
  treeContextMenu.hidden = false;
  const box = treeContextMenu.getBoundingClientRect(); treeContextMenu.style.left = `${Math.max(0,Math.min(event.clientX,innerWidth-box.width))}px`; treeContextMenu.style.top = `${Math.max(0,Math.min(event.clientY,innerHeight-box.height))}px`;
  treeContextMenu.querySelector<HTMLButtonElement>('button')!.focus();
});
document.addEventListener('pointerdown',event=>{ if (!treeContextMenu.contains(event.target as Node)) treeContextMenu.hidden = true; });
document.addEventListener('keydown',event=>{if(event.key==='Escape')treeContextMenu.hidden=true;});
let treeDragSource: HTMLElement | null = null;
let treeDropTarget: HTMLElement | null = null;
function setTreeDropTarget(folder: HTMLElement | null): void {
  if (treeDropTarget === folder) return;
  treeDropTarget?.classList.remove('tree-drop-target');
  treeDropTarget = folder;
  treeDropTarget?.classList.add('tree-drop-target');
}
function clearTreeDragIndicator(): void {
  setTreeDropTarget(null);
  treeDragSource?.classList.remove('tree-drag-source');
  treeDragSource = null;
}
document.addEventListener('dragend', clearTreeDragIndicator);
document.addEventListener('drop', clearTreeDragIndicator);
element('page-list').addEventListener('dragleave', event => {
  if (!(event.relatedTarget instanceof Node) || !element('page-list').contains(event.relatedTarget)) setTreeDropTarget(null);
});
element('page-list').addEventListener('dragstart', event => {
  const file=(event.target as HTMLElement).closest<HTMLElement>('[data-page],[data-image],[data-file]');
  if(!file||!event.dataTransfer||busy)return;
  event.stopPropagation();
  const path=file.dataset.page||file.dataset.image||file.dataset.file;
  event.dataTransfer.setData('application/x-munin-file',JSON.stringify({root:projectRoot,path}));
  event.dataTransfer.effectAllowed='copyMove';
  treeDragSource=file;file.classList.add('tree-drag-source');
  if(file.dataset.image)event.dataTransfer.setData('application/x-munin-image',JSON.stringify({root:projectRoot,path}));
});
element('page-list').addEventListener('dragover',event=>{
  const folder=(event.target as HTMLElement).closest<HTMLElement>('[data-folder]');
  if(busy||!folder||!event.dataTransfer?.types.includes('application/x-munin-file')){setTreeDropTarget(null);return;}
  event.preventDefault();event.dataTransfer.dropEffect='move';setTreeDropTarget(folder);
});
element('page-list').addEventListener('drop',event=>{
  const folder=(event.target as HTMLElement).closest<HTMLElement>('[data-folder]');
  clearTreeDragIndicator();
  if(busy||!folder||!event.dataTransfer?.types.includes('application/x-munin-file'))return;
  event.preventDefault();event.stopPropagation();
  try{const source=JSON.parse(event.dataTransfer.getData('application/x-munin-file')) as {root:string;path:string};if(source.root===projectRoot&&typeof source.path==='string')void moveTreeFile(source.path,folder.dataset.folder);}catch{status('移動するファイルを選び直してください。',true);}
});
function relativeProjectAsset(asset: string, page: string): string {
  const docs = workspace?.config.docs.replace(/\\/g,'/').replace(/\/$/,'') || 'docs';
  const projectPage = docs === '.' || workspace?.project_entries.some(entry=>entry.path===page) ? page : `${docs}/${page}`;
  const from = projectPage.split('/').slice(0,-1), to = asset.split('/');
  while (from.length && to.length && from[0]===to[0]) { from.shift(); to.shift(); }
  return '../'.repeat(from.length)+to.join('/');
}
for (const target of [editor,milkdown.host] as HTMLElement[]) {
  target.addEventListener('dragover',event=>{if(event.dataTransfer?.types.includes('application/x-munin-image')){event.preventDefault();event.dataTransfer.dropEffect='copy';}});
  target.addEventListener('drop',async event=>{
    const data = event.dataTransfer?.getData('application/x-munin-image'); if (!data) return;
    event.preventDefault();event.stopImmediatePropagation();
    if (!documentState || activeImageTab || busy) { status('画像を挿入する原稿を開いてください。',true);return; }
    let asset:{root:string;path:string;screenshot_id?:string;resource_id?:string};
    try{asset=JSON.parse(data);if(typeof asset.path!=='string'||!asset.path)throw new Error();}catch{status('画像のドラッグ情報を読み込めません。',true);return;}
    if (asset.root !== projectRoot) {status('同じプロジェクトの画像を選択してください。',true);return;}
    const page=documentState.page,root=projectRoot,start=editor.selectionStart,end=editor.selectionEnd,left=event.clientX,top=event.clientY;
    const expected=editor.value;const droppedImage=(event.target as Element).closest<HTMLImageElement>('img');
    const existing=target===milkdown.host?(droppedImage?milkdown.imageSourceRange(droppedImage):undefined):imageAtSelection(expected,start,end);
    const origin=captureInsertionContext(insertionState());
    const richDrop=target===milkdown.host&&!existing?milkdown.captureSelectionEdit(true,{left,top}):undefined;
    try{
      const action=asset.resource_id?'capture-resources-generate':'capture-resources-resolve';
      const json=asset.resource_id?{id:asset.resource_id}:{path:asset.path};
      asset.path=(JSON.parse(await rpc(action,{json},root)) as {path:string}).path;
      if(!isInsertionCurrent(origin,insertionState())||activeImageTab)throw Error('原稿が変更されました。挿入位置を選び直してください。');
    }catch(error){status(String(error),true);return;}
    if(existing){
      const next=replaceDocumentImage(expected,existing,relativeProjectAsset(asset.path,page),asset.screenshot_id);
      try{changeImageMarkdown(next,expected);void milkdown.refreshImages();status('画像の参照を置き換えました。説明と表示設定は保持しています。');}catch(error){status(String(error),true);}return;
    }
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
const editorNavigationSelector='#flexlayout-tabbutton-editor';
document.addEventListener('dragover',event=>{
  if(!(event.target instanceof Element)||!event.target.closest(editorNavigationSelector))return;
  if(!event.dataTransfer?.types.includes('application/x-munin-image'))return;
  event.preventDefault();event.dataTransfer.dropEffect='copy';
  resourceDragHover??=setTimeout(()=>{resourceDragHover=undefined;if(documentState&&!busy)chooseTab('editor');},400);
});
function clearResourceDragHover(){if(resourceDragHover)clearTimeout(resourceDragHover);resourceDragHover=undefined;}
document.addEventListener('dragleave',event=>{if(event.target instanceof Element&&event.target.closest(editorNavigationSelector)&&!(event.relatedTarget instanceof Element&&event.relatedTarget.closest(editorNavigationSelector)))clearResourceDragHover();},true);document.addEventListener('dragend',clearResourceDragHover);document.addEventListener('drop',clearResourceDragHover);
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
  if (busy) return;
  pendingImageSelection = null;
  toolbarImageInput.click();
});
function insertSourceImage(markdown: string, start: number, end: number): void {
  rememberCurrentSelection(start, end);
  editor.setRangeText(markdown, start, end, "end");
  dirty = true;
  updateSaveState();
  editor.dispatchEvent(new Event("input"));
  editor.focus();
}

function readImageForSaveDialog(file: File, origin: ReturnType<typeof captureInsertionContext<Document>>, selection: {start:number;end:number}, onError?: () => void): void {
  const reader = new FileReader();
  reader.onload = () => {
    if (!isInsertionCurrent(origin, insertionState())) {
      pendingImageSelection = null;
      status(STALE_INSERTION_MESSAGE, true);
      return;
    }
    if (typeof reader.result === 'string') {
      const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      pendingImageSelection = selection;
      openImageSaveDialog(reader.result, cleanName, cleanName.replace(/\.[^.]+$/, ''));
    }
  };
  if (onError) reader.onerror = onError;
  reader.readAsDataURL(file);
}

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
  readImageForSaveDialog(file, origin, selection, () => {pendingImageSelection = null; status("画像を読み込めませんでした。", true);});
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
  // Milkdown ignores an image node update while the editor is read-only.
  // A manuscript save may still be refreshing workspace metadata when the
  // asset finishes; let its editing lock clear before resolving the upload.
  while (busy && isInsertionCurrent(origin, insertionState())) {
    await new Promise<void>(resolve => setTimeout(resolve, 20));
  }
  if (!isInsertionCurrent(origin, insertionState())) throw new Error(STALE_INSERTION_MESSAGE);
  return computeRelativeMarkdownPath(current.page, path, workspace?.config.docs || "docs");
}

function computeRelativeMarkdownPath(pagePath: string, assetPath: string, docsFolder = "docs"): string {
  const pageRelative = docsFolder === "." || pagePath.startsWith(docsFolder + "/") ? pagePath : `${docsFolder}/${pagePath}`;
  const pageDir = pageRelative.split("/").slice(0, -1);
  const targetParts = assetPath.replace(/\\/g, "/").split("/").filter(part => part && part !== ".");
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
    if(!valid())throw new Error('原稿が変更されました。保存した画像は撮影一覧に残しています。');
    element<HTMLDialogElement>("image-save-dialog").close();
    pendingImageDataUrl = null;
    pendingImageOwner = null;
    const relPath = computeRelativeMarkdownPath(documentState!.page, fullAssetPath, workspace?.config.docs || "docs");
    const markdownCode = `![${alt}](${relPath})`;
    const start = selection.start;
    const end = selection.end;
    pendingImageSelection = null;
    insertSourceImage(markdownCode, start, end);
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
  if(paste.cancelled){status('画像の挿入はキャンセルされました。保存した画像は撮影一覧に残しています。');return false;}
  if(!isInsertionCurrent(paste.origin,insertionState()))throw new Error('原稿が変更されました。保存した画像は撮影一覧に残しています。');
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
    insertSourceImage(markdownCode, start, end);
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
      insertSourceImage(markdownCode, start, end);
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

function canPasteImageIntoEditor(): boolean {
  const active = document.activeElement;
  if (active && milkdown.host.contains(active)) return false;
  if (active && active !== editor && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return false;
  if (element('panel-editor').hidden) return false;
  if (!documentState) {
    status("先にMarkdown原稿を開いてください。", true);
    return false;
  }
  return true;
}
document.addEventListener("paste", (event: ClipboardEvent) => {
  if (event.target instanceof Node && milkdown.host.contains(event.target)) return;
  if (event.defaultPrevented || !canPasteImageIntoEditor()) return;
  if (handleImagePaste(event.clipboardData)) {
    event.preventDefault();
    lastImagePasteTime = Date.now();
    return;
  }
  if (native) void tryNativeImagePaste();
});

window.addEventListener("keydown", (event: KeyboardEvent) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
    if (!canPasteImageIntoEditor()) return;
    if (native) void tryNativeImagePaste();
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
        readImageForSaveDialog(file, origin, selection);
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
element("ai-connection-type").addEventListener("change", () => {
  if(element<HTMLSelectElement>('ai-connection-type').value==='cli')input('ai-model').value=cliAiSettings.get(element<HTMLSelectElement>('ai-agent').value);
  updateAiSettingsVisibility();
});
element("ai-agent").addEventListener("change", () => {
  input("ai-model").value = cliAiSettings.get(element<HTMLSelectElement>('ai-agent').value);
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
async function createFullDraft(templateMode=false):Promise<void>{
  if(busy)return;
  const options=templateMode?await askTemplateDestination(workspace?.config.docs||'docs',async()=>JSON.parse(await rpc('target-application',{},projectRoot)) as TargetApplication,()=>rpc('template-guide',{},projectRoot),showTargetApplication):null;
  if(templateMode&&!options)return;
  await savedBeforeOperation(true);retainDocumentTab();
  const root=projectRoot;
  const snapshots=Array.from(documentTabs,([page,tab])=>({page,content:tab.content,revision:tab.document.revision,dirty:tab.content!==tab.document.content}));
  const valid=()=>{retainDocumentTab();return root===projectRoot&&snapshots.every(item=>{const tab=documentTabs.get(item.page);return tab?.content===item.content&&tab.document.revision===item.revision;})&&!Array.from(documentTabs).some(([page,tab])=>tab.content!==tab.document.content&&!snapshots.some(item=>item.page===page));};
  const documents=snapshots.filter(item=>item.dirty);
  let candidate:DraftCandidate|undefined = templateMode||documents.length?undefined:loadDraftCandidate(root) || undefined;
  if (!candidate) {
    await work(async()=>{
      await ensureAiSettings();activeGenerationRoot=root;element('progress-cancel').hidden=false;element<HTMLButtonElement>('progress-cancel').disabled=false;await beginAiProgress('draft-propose',root);let success=false;
      try{candidate=JSON.parse(await rpc('draft-propose',{json:{...options,documents}},root)) as DraftCandidate;success=true;if(!templateMode&&!documents.length)saveDraftCandidate(root,candidate);}
      catch(error){logAiFailure(error);throw error;}
      finally{await stopAiProgress(success);}
    });
  }
  if(!candidate||root!==projectRoot)return;
  const pages=await reviewDraft(candidate,valid,path=>rpc('preview-asset',{page:`${candidate!.docs}/${candidate!.pages[0].path}`,asset:path},root));
  if(!pages){if(!templateMode)clearDraftCandidate(root);status('下書き候補を破棄しました。原稿は変更していません。');return;}
  await work(async()=>{
    if(!valid())throw new Error('原稿が変更されました。候補を作り直してください。');
    const outputPath=(path:string)=>candidate!.docs==='.'?path:`${candidate!.docs.replace(/\/$/,'')}/${path}`;
    const tabKey=(path:string)=>{const prefix=(workspace?.config.docs||'docs').replace(/\/$/,'')+'/';return path.startsWith(prefix)&&workspace?.pages.includes(path.slice(prefix.length))?path.slice(prefix.length):path;};
    const inEditor=pages.filter(page=>documents.some(item=>item.page===tabKey(outputPath(page.path))));
    const persisted=pages.filter(page=>!inEditor.includes(page));
    if(persisted.length)await rpc('draft-apply',{json:{docs:candidate!.docs,pages:persisted,template:templateMode}},root);
    if(!templateMode)clearDraftCandidate(root);
    for(const page of persisted){documentTabs.delete(tabKey(outputPath(page.path)));documentTabs.delete(outputPath(page.path));}
    for(const page of inEditor){await openPage(tabKey(outputPath(page.path)));replaceMarkdown(0,editor.value.length,page.content,0,0);retainDocumentTab();}
    await refreshWorkspace();
    const selectedPage=pages.find(page=>page.path==='index.md')||pages[0];
    if(selectedPage){await openPage(outputPath(selectedPage.path),inEditor.includes(selectedPage));chooseTab('editor');}
    status(`${pages.length}ページへ選んだ変更を反映しました。${inEditor.length?'編集中の原稿は未保存のまま保持しています。':'変更前の原稿はバックアップしました。'}`);
  });
}
element('create-ai-template').addEventListener('click',()=>{void createFullDraft(true).catch(error=>status(String(error),true));});
async function showTargetApplication(){
  const root=projectRoot;if(!root||busy)return false;
  return configureTargetApplication(async(action,settings)=>{
    if(root!==projectRoot)throw new Error('プロジェクトが切り替わりました。');
    return JSON.parse(await rpc('target-application',{json:{action,settings}},root)) as TargetApplication;
  });
}
element('target-application-open').addEventListener('click',()=>{void showTargetApplication().catch(error=>status(String(error),true));});
actionButton("quality-check", "quality-check", () => ({}), "publish-result");
element('site-export-open').addEventListener('click', () => {
  if (busy || !projectRoot || document.querySelector('#site-export-dialog[open]')) return;
  const {dialog, body} = featureDialog('HTML出力');
  dialog.id = 'site-export-dialog';
  const controls = element('site-export-controls');
  element<HTMLButtonElement>('browse-site-output').hidden = !native;
  element<HTMLButtonElement>('open-site-html').hidden = !native;
  input('site-output-path').value = workspace?.config.output ?? '';
  input('site-exclude-unused-assets').checked = Boolean(workspace?.config.mkdocs.exclude_unused_assets);
  element('site-build-result').textContent = '';
  body.append(controls);
  dialog.addEventListener('close', () => element('site-export-host').append(controls), {once: true});
});
function browseSiteOutput(dialogId: string, fieldId: string, resultId: string): void {
  const root = projectRoot;
  const dialog = document.querySelector<HTMLDialogElement>(`#${dialogId}[open]`);
  if (!native || !root || !dialog || busy) return;
  void work(async () => {
    const field = input(fieldId);
    try {
      const selected = await invoke<string|null>('choose_path', {
        initialPath: field.value.trim(), folder: true, projectRoot: root,
      });
      if (selected && dialog.open && root === projectRoot) {
        field.value = selected;
        element(resultId).textContent = '';
      }
    } catch (error) {
      if (dialog.open && root === projectRoot) element(resultId).textContent = String(error);
      throw error;
    }
  });
}
element('browse-site-output').addEventListener('click', () => browseSiteOutput('site-export-dialog', 'site-output-path', 'site-build-result'));
element('settings-site-browse').addEventListener('click', () => browseSiteOutput('panel-settings', 'settings-site-output', 'settings-site-result'));
async function saveSiteOutput(
  fieldId = 'site-output-path',
  resultId = 'site-build-result',
  siteName?: string,
  excludeUnused?: boolean,
): Promise<string> {
  const root = projectRoot;
  const path = input(fieldId);
  const value = path.value.trim();
  path.disabled = true;
  try {
    if (!value) throw new Error('出力先フォルダーを入力してください。');
    if (siteName !== undefined && !siteName) throw new Error('サイト名を入力してください。');
    const currentExclude = Boolean(workspace?.config.mkdocs.exclude_unused_assets);
    if (
      value === workspace?.config.output &&
      (siteName === undefined || siteName === workspace.config.mkdocs.site_name) &&
      (excludeUnused === undefined || excludeUnused === currentExclude)
    ) {
      path.value = value;
      return value;
    }
    const jsonPayload: Record<string, unknown> = {};
    if (siteName !== undefined) jsonPayload.site_name = siteName;
    if (excludeUnused !== undefined) jsonPayload.exclude_unused_assets = excludeUnused;
    const {output} = JSON.parse(
      await rpc(
        'save-html-output',
        { output: value, ...(Object.keys(jsonPayload).length ? { json: jsonPayload } : {}) },
        root,
      ),
    ) as {output: string};
    if (projectRoot !== root || !workspace) throw new Error('プロジェクトが切り替わりました。');
    workspace.config.output = output;
    if (siteName !== undefined) workspace.config.mkdocs.site_name = siteName;
    if (excludeUnused !== undefined) workspace.config.mkdocs.exclude_unused_assets = excludeUnused;
    path.value = output;
    return output;
  } catch (error) {
    element(resultId).textContent = String(error);
    throw error;
  } finally {
    path.disabled = false;
  }
}
element('settings-site-save').addEventListener('click', () => {
  if (!projectRoot) return;
  void work(async () => {
    const name = input('settings-site-name');
    const siteName = name.value.trim();
    const excludeUnused = input('settings-site-exclude-unused').checked;
    name.disabled = true;
    try {
      await saveSiteOutput('settings-site-output', 'settings-site-result', siteName, excludeUnused);
      name.value = siteName;
      element('settings-site-result').textContent = '保存しました。';
    } finally {
      name.disabled = false;
    }
  });
});
element('save-site-output').addEventListener('click', () => {
  void work(async () => {
    const output = await saveSiteOutput('site-output-path', 'site-build-result', undefined, input('site-exclude-unused-assets').checked);
    element('site-build-result').textContent = `出力先を保存しました · ${output}`;
  });
});
element('build-site').addEventListener('click', () => {
  const root = projectRoot;
  const selectedEngine = element<HTMLSelectElement>('site-engine').value;
  const action =
    selectedEngine === 'build-zensical'
      ? 'build-zensical'
      : selectedEngine === 'build-single-html'
        ? 'build-single-html'
        : 'build-mkdocs';
  void work(async () => {
    const output = await saveSiteOutput('site-output-path', 'site-build-result', undefined, input('site-exclude-unused-assets').checked);
    await runAction(action, {output}, 'site-build-result');
    if (!native || root !== projectRoot) return;
    const result = element('site-build-result');
    try {
      await invoke('open_output_html', {root, output});
      result.textContent += '\n出力済みのHTMLを開きました。';
    } catch (error) {
      const message = `HTMLを作成しましたが、自動で開けませんでした。\n${String(error)}`;
      result.textContent += `\n${message}`;
      status(message, true);
    }
  });
});
element('open-site-html').addEventListener('click', () => {
  if (!native || !projectRoot) return;
  const result = element('site-build-result');
  void work(async () => {
    try {
      await invoke('open_output_html', {root: projectRoot, output: input('site-output-path').value.trim()});
      result.textContent = '出力済みのHTMLを開きました。';
    } catch (error) {
      result.textContent = String(error);
      throw error;
    }
  }, {lockControls: false});
});
setBusy(false);
updateSaveState();
{
  const initialRoot = params.get("root") || localStorage.getItem("manual-studio-project");
  if (initialRoot) void work(() => openProject(initialRoot));
}

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
    if (typeof data.expected === 'string' && Array.isArray(data.report?.issues) && data.report.issues.every(issue => Object.hasOwn(issue, 'replacement'))) {
      installReaderReport(root, page, data.expected, data.report);
    }
  } catch { /* LocalStorage error */ }
}
let reopenReaderReview:(()=>boolean)|undefined;
function installReaderReport(root:string,page:string,expected:string,result:ReaderReport):void {
  const valid=()=>root===projectRoot&&documentState?.page===page&&editor.value===expected;
  const apply=(findings:ReaderReport['issues'])=>{
    if(busy)return;
    void work(async()=>{
      if(!valid())throw new Error('原稿が変更されました。レビューを実行し直してください。');
      let changes:ReturnType<typeof applyReviewCorrections>;
      try{changes=applyReviewCorrections(expected,result.issues,findings);}
      catch(error){const alert=document.querySelector('#reader-review-results [role=alert]');if(alert)alert.textContent=String(error);throw error;}
      if(!changes.applied)return;
      const previousFilter=document.querySelector<HTMLSelectElement>('#reader-review-results select')?.value||'all';
      if(preferredEditorView==='preview'){preferredEditorView='edit';applyEditorView();}
      milkdown.showSource();
      if(findings.length===1){const finding=findings[0];replaceMarkdown(finding.start,finding.end,finding.replacement!,0,finding.replacement!.length);}
      else replaceMarkdown(0,expected.length,changes.content,0,0);
      updateHistoryButtons();expected=editor.value;result.issues=changes.issues;
      saveReaderReviewSession(root,page,expected,result);
      document.querySelector<HTMLDialogElement>('#reader-review-results')?.close();reopenReaderReview?.();
      const filter=document.querySelector<HTMLSelectElement>('#reader-review-results select');
      if(filter){filter.value=previousFilter;filter.dispatchEvent(new Event('change'));}
      status(`レビューの修正案 ${changes.applied}件を適用しました。`);
    });
  };
  reopenReaderReview=()=>{
    if(!valid())return false;
    showReaderReport(result,valid,finding=>{
      if(preferredEditorView==='preview'){preferredEditorView='edit';applyEditorView();}
      milkdown.showSource();jumpToSource(editor,finding.start,finding.end);updateCursor();
    },finding=>{
      if(typeof finding.replacement!=='string'||finding.replacement===finding.quote)return;
      const before=expected;
      void(async()=>{
        const decision=await reviewSelection(page,finding.quote,finding.replacement!,undefined,'',false);
        if(decision.action!=='adopt'||decision.content===finding.quote)return;
        if(!valid()||expected!==before||before.slice(finding.start,finding.end)!==finding.quote){
          status('原稿が変更されました。レビューを実行し直してください。',true);return;
        }
        apply([{...finding,replacement:decision.content}]);
      })().catch(error=>status(String(error),true));
    },apply,setButtonDisabled);
    return true;
  };
}
element('reader-review').addEventListener('click',()=>{
  if(busy||!documentState||activeImageTab)return;
  const {dialog,body}=featureDialog('原稿チェック');
  const checks=element('manuscript-check');
  body.append(checks);
  const actionsRow=document.createElement('div');
  actionsRow.className='actions';
  const terminal=document.createElement('button');
  terminal.type='button';
  terminal.textContent='AIターミナルを開く';
  terminal.onclick=()=>{
    dialog.close();
    showTerminalPanel();
  };
  const notesBtn=document.createElement('button');
  notesBtn.type='button';
  const noteCount=extractAiNotes(editor.value).length;
  notesBtn.textContent=noteCount>0?`AIメモ一覧・依頼 (${noteCount})`:'AIメモを挿入';
  notesBtn.onclick=()=>{
    dialog.close();
    if(noteCount>0)openCurrentAiNotes();
    else void insertAiNoteAtCursor();
  };
  const glossaryBtn=document.createElement('button');
  glossaryBtn.type='button';
  glossaryBtn.textContent='用語集を設定';
  glossaryBtn.onclick=()=>{
    dialog.close();
    selectSettingsCategory('glossary');
    chooseTab('settings');
    void glossarySettings.reload();
  };
  const hubBtn=document.createElement('button');
  hubBtn.type='button';
  hubBtn.textContent='AI協業ツール';
  hubBtn.onclick=()=>{
    dialog.close();
    openAiCollabHub('dashboard');
  };
  actionsRow.append(terminal,notesBtn,glossaryBtn,hubBtn);
  body.append(actionsRow);
  if(reopenReaderReview){
    const previous=document.createElement('button');
    previous.type='button';
    previous.textContent='以前のレビュー結果を表示';
    previous.onclick=()=>{
      dialog.close();
      if(!reopenReaderReview?.())status('現在の原稿と一致するレビュー結果がありません。',true);
    };
    body.append(previous);
  }
  dialog.addEventListener('close',()=>element('manuscript-check-host').append(checks),{once:true});
});

element('insert-ai-note')?.addEventListener('click',()=>{void insertAiNoteAtCursor();});
element('manage-ai-notes')?.addEventListener('click',()=>{openCurrentAiNotes();});
element('send-to-terminal')?.addEventListener('click',()=>{void openEditorSendToTerminal();});
element('terminal-send-editor-btn')?.addEventListener('click',()=>{void openEditorSendToTerminal();});
element('open-ai-collab-hub')?.addEventListener('click',()=>{openAiCollabHub('dashboard');});
element('terminal-external-changes-btn')?.addEventListener('click',()=>{void openExternalChangeTray();});

let captureInsertionRunning=false;
async function insertScreenshotHere():Promise<void>{
  if(busy||captureInsertionRunning||!projectRoot)return;
  captureInsertionRunning=true;
  setButtonDisabled(element<HTMLButtonElement>('editor-screenshot-ai'),true);
  const root=projectRoot;
  const origin=captureInsertionContext(insertionState());
  const hadManuscript=Boolean(documentState&&!activeImageTab);
  const timing=new OperationTiming(rpc,root);
  let outcome:'success'|'cancelled'|'error'='cancelled';
  try {
    status('MarkItsで撮影しています。完了すると撮影リソースへ登録し、原稿に画像を挿入します。');
    timing.stage('capture');
    const resource=await markitsImages.captureResource();
    if(!resource||root!==projectRoot)return;
    captureDock.upsert(resource);
    timing.stage('generate');
    const {path}=JSON.parse(await rpc('capture-resources-generate',{json:{id:resource.id}},root)) as {path:string};
    if(root!==projectRoot)return;
    if(hadManuscript){
      if(!isInsertionCurrent(origin,insertionState())||activeImageTab)throw Error('原稿が変更されました。撮影リソース一覧から画像を挿入してください。');
    }else if(!await chooseImageDestination()||root!==projectRoot)return;
    if(!documentState)return;
    insertDocumentMarkdown(`![撮影画像](<${relativeProjectAsset(path,documentState.page)}>)`);
    await captureDock.refresh();outcome='success';
    status('撮影リソースを登録し、メタデータを除去した文書用画像を原稿に挿入しました。保存ボタンまたはCtrl/Cmd+Sで保存してください。');
  }catch(error){outcome='error';throw error;}
  finally{captureInsertionRunning=false;setButtonDisabled(element<HTMLButtonElement>('editor-screenshot-ai'),!projectRoot);await timing.finish(outcome).catch(error=>console.warn(error));}
}

element('editor-screenshot-ai').addEventListener('click',()=>{void insertScreenshotHere().catch(error=>status(String(error),true));});
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
        documentState={...saved,page:current.page};dirty=false;documentPersistence.state=null;updateSaveState();retainDocumentTab();
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
