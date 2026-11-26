import { invoke } from "@tauri-apps/api/core";
import { featureDialog } from "./imageDialogs";
import { reviewSelection } from "./selectionAi";

const isNative = "__TAURI_INTERNALS__" in window;

export type DraftAssistTabId = "recording-draft" | "derivative" | "translation";
export type ManuscriptCheckTabId = "quality" | "fact-check" | "impact" | "structure";
export type SiteExportTabId = "build" | "nav" | "audience";

export interface AiCollabHubOptions {
  rpc: (action: string, options?: Record<string, unknown>, root?: string) => Promise<string>;
  getProjectRoot: () => string;
  getWorkingDirectory: () => string;
  getCurrentPage: () => string | null;
  getCurrentContent: () => string;
  getPages: () => string[];
  openPage: (page: string, line?: number) => Promise<void>;
  insertMarkdownWithDiff: (markdown: string, title: string) => Promise<void>;
  createPageWithContent: (relativePage: string, markdown: string, allowOverwrite?: boolean) => Promise<void>;
  sendToTerminal: (options: {
    title: string;
    page: string;
    lineStart?: number;
    excerpt?: string;
    defaultInstruction: string;
  }) => Promise<void>;
  reportStatus: (message: string, isError?: boolean) => void;
}

interface DashboardPage {
  page: string;
  title: string;
  audiences: string[];
  char_count: number;
  heading_count: number;
  image_count: number;
  incoming_count: number;
  error_count: number;
  warning_count: number;
  ai_note_count: number;
}

interface DashboardResponse {
  total_pages: number;
  total_errors: number;
  total_warnings: number;
  nav?: Array<{ page: string; title?: string; section?: string; hidden?: boolean }>;
  diagnostics: Array<{ kind: string; severity: string; pages: string[]; message: string }>;
  pages: DashboardPage[];
}

interface NavDraft {
  page: string;
  title: string;
  section: string;
  hidden: boolean;
}

const AUDIENCE_DEFS: Array<{ id: string; label: string; short: string }> = [
  { id: "user", label: "利用者向け (user)", short: "利用者向け" },
  { id: "developer", label: "開発者向け (developer)", short: "開発者向け" },
  { id: "maintainer", label: "保守者向け (maintainer)", short: "保守者向け" },
];

function createDialogTabs<T extends string>(
  idPrefix: string,
  ariaLabel: string,
  defs: Array<{ id: T; label: string }>,
  onSelect?: (id: T) => void,
): {
  tabsNav: HTMLElement;
  tabButtons: Map<T, HTMLButtonElement>;
  tabPanels: Map<T, HTMLElement>;
  selectTab: (id: T) => void;
} {
  const tabsNav = document.createElement("div");
  tabsNav.className = "settings-category-tabs ai-hub-tabs";
  tabsNav.setAttribute("role", "tablist");
  tabsNav.setAttribute("aria-label", ariaLabel);

  const tabButtons = new Map<T, HTMLButtonElement>();
  const tabPanels = new Map<T, HTMLElement>();

  for (const def of defs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = `${idPrefix}-tab-${def.id}`;
    btn.textContent = def.label;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-controls", `${idPrefix}-panel-${def.id}`);
    const panel = document.createElement("section");
    panel.id = `${idPrefix}-panel-${def.id}`;
    panel.className = "ai-hub-panel";
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", btn.id);
    tabButtons.set(def.id, btn);
    tabPanels.set(def.id, panel);
    tabsNav.append(btn);
  }

  const selectTab = (id: T) => {
    for (const def of defs) {
      const active = def.id === id;
      const btn = tabButtons.get(def.id)!;
      btn.setAttribute("aria-selected", String(active));
      btn.tabIndex = active ? 0 : -1;
      tabPanels.get(def.id)!.hidden = !active;
    }
    onSelect?.(id);
  };

  for (const def of defs) {
    const btn = tabButtons.get(def.id)!;
    btn.onclick = () => selectTab(def.id);
    btn.addEventListener("keydown", (event) => {
      const idx = defs.findIndex((item) => item.id === def.id);
      const next =
        event.key === "ArrowRight"
          ? (idx + 1) % defs.length
          : event.key === "ArrowLeft"
            ? (idx + defs.length - 1) % defs.length
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? defs.length - 1
                : -1;
      if (next < 0) return;
      event.preventDefault();
      selectTab(defs[next].id);
      tabButtons.get(defs[next].id)!.focus();
    });
  }

  return { tabsNav, tabButtons, tabPanels, selectTab };
}

function audienceSummaryLabel(audiences: string[]): string {
  if (!audiences.length) return "全員共通";
  const labels = audiences.map((id) => AUDIENCE_DEFS.find((d) => d.id === id)?.short || id);
  return `限定: ${labels.join("・")}`;
}

function sameAudienceSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((x) => setB.has(x));
}

function populateRecordingDraftPanel(
  recPanel: HTMLElement,
  dialog: HTMLDialogElement,
  options: AiCollabHubOptions,
  root: string,
): () => Promise<void> {
  recPanel.innerHTML = `
    <p class="hub-guide-banner">MarkItsの操作記録・操作スクリプト・注釈・画面UI情報（UIMap）が埋め込まれた画像から、操作手順の初稿Markdownを作成します。</p>
    <div class="ai-hub-form-row">
      <label>撮影リソースを選択
        <select id="hub-rec-resource"><option value="">（画像パスを直接指定）</option></select>
      </label>
      <label>またはプロジェクト内のPNGパス
        <div class="ai-hub-path-row">
          <input type="text" id="hub-rec-image-path" placeholder="docs/assets/step.png" />
          <button type="button" id="hub-rec-image-browse" hidden>参照…</button>
        </div>
      </label>
    </div>
    <div class="ai-hub-form-row">
      <label>手順の見出し（任意）
        <input type="text" id="hub-rec-title" placeholder="例: 設定を保存する手順" />
      </label>
      <label class="setting-checkbox">
        <input type="checkbox" id="hub-rec-use-ai" />
        接続済みAIで文章を仕上げる
      </label>
      <button type="button" class="primary" id="hub-rec-generate">手順書ドラフトを生成</button>
    </div>
    <p id="hub-rec-status" class="muted" role="status"></p>
    <pre id="hub-rec-preview" class="external-tray-preview" hidden></pre>
    <div class="actions" id="hub-rec-actions" hidden>
      <button type="button" class="primary" id="hub-rec-insert">差分確認して現在の原稿へ挿入</button>
      <button type="button" id="hub-rec-send-terminal">AIターミナルでさらに磨く</button>
    </div>
  `;
  let loaded = false;
  let generatedRecDraft = "";
  const recImageInput = recPanel.querySelector<HTMLInputElement>("#hub-rec-image-path")!;
  const recImageBrowseBtn = recPanel.querySelector<HTMLButtonElement>("#hub-rec-image-browse")!;
  if (isNative) {
    recImageBrowseBtn.hidden = false;
    recImageBrowseBtn.onclick = async () => {
      try {
        const picked = await invoke<string | null>("choose_path", {
          initialPath: recImageInput.value.trim(),
          folder: false,
          projectRoot: root,
          title: "PNG画像を選択",
        });
        if (picked) recImageInput.value = picked;
      } catch (error) {
        options.reportStatus(String(error), true);
      }
    };
  }

  async function loadSources(): Promise<void> {
    if (loaded) return;
    loaded = true;
    const select = recPanel.querySelector<HTMLSelectElement>("#hub-rec-resource")!;
    try {
      const res = JSON.parse(await options.rpc("operation-draft-sources", {}, root)) as {
        items: Array<{
          resource_id: string;
          name: string;
          has_script: boolean;
          has_operations: boolean;
          has_annotations: boolean;
          uimap_elements: number;
        }>;
      };
      select.length = 1;
      for (const item of res.items) {
        const tags = [
          item.has_script ? "スクリプト" : "",
          item.has_operations ? "操作記録" : "",
          item.has_annotations ? "注釈" : "",
          item.uimap_elements > 0 ? `UIMap:${item.uimap_elements}` : "",
        ].filter(Boolean);
        select.add(
          new Option(
            `${item.name}${tags.length ? ` [${tags.join("/")}]` : ""}`,
            item.resource_id,
          ),
        );
      }
    } catch {
      // Optional list
    }
  }

  recPanel.querySelector<HTMLButtonElement>("#hub-rec-generate")!.onclick = async () => {
    const resourceId = recPanel.querySelector<HTMLSelectElement>("#hub-rec-resource")!.value;
    const imagePath = recImageInput.value.trim();
    const title = recPanel.querySelector<HTMLInputElement>("#hub-rec-title")!.value.trim();
    const useAi = recPanel.querySelector<HTMLInputElement>("#hub-rec-use-ai")!.checked;
    const statusEl = recPanel.querySelector<HTMLElement>("#hub-rec-status")!;
    const previewEl = recPanel.querySelector<HTMLElement>("#hub-rec-preview")!;
    const actionsEl = recPanel.querySelector<HTMLElement>("#hub-rec-actions")!;
    statusEl.textContent = "操作手順ドラフトを生成しています…";
    try {
      const res = JSON.parse(
        await options.rpc(
          "operation-draft-generate",
          {
            resource_id: resourceId || undefined,
            image: imagePath || undefined,
            page: options.getCurrentPage() || undefined,
            title: title || undefined,
            use_ai: useAi,
          },
          root,
        ),
      ) as { markdown: string; source_kind: string; step_count: number; ai_refined: boolean };
      generatedRecDraft = res.markdown;
      previewEl.textContent = res.markdown;
      previewEl.hidden = false;
      actionsEl.hidden = false;
      statusEl.textContent = `生成完了（抽出元: ${res.source_kind} / ${res.step_count}手順${res.ai_refined ? " / AI整形済み" : ""}）`;
    } catch (error) {
      statusEl.textContent = `生成できませんでした: ${String(error)}`;
    }
  };

  recPanel.querySelector<HTMLButtonElement>("#hub-rec-insert")!.onclick = async () => {
    if (!generatedRecDraft) return;
    dialog.close();
    await options.insertMarkdownWithDiff(generatedRecDraft, "操作記録からの手順書ドラフト");
  };
  recPanel.querySelector<HTMLButtonElement>("#hub-rec-send-terminal")!.onclick = async () => {
    if (!generatedRecDraft) return;
    const page = options.getCurrentPage() || options.getPages()[0] || "index.md";
    dialog.close();
    await options.sendToTerminal({
      title: "操作記録ドラフトのブラッシュアップ",
      page,
      excerpt: generatedRecDraft,
      defaultInstruction:
        "この操作記録ベースのドラフトを読みやすい手順書に整え、preview-edit で原稿へ挿入してください。",
    });
  };

  return loadSources;
}

function populateDerivativePanel(
  derivPanel: HTMLElement,
  dialog: HTMLDialogElement,
  options: AiCollabHubOptions,
  root: string,
): void {
  derivPanel.innerHTML = `
    <p class="hub-guide-banner">既存の原稿をもとに、FAQ・リリースノート要点・初心者向けクイックガイドのたたき台を作成します。</p>
    <div class="ai-hub-form-row">
      <label>作成する文書の種類
        <select id="hub-deriv-kind">
          <option value="faq">FAQ・トラブルシューティング</option>
          <option value="release-notes">リリースノート要点</option>
          <option value="quickstart">初心者向けクイックガイド</option>
        </select>
      </label>
      <label class="setting-checkbox">
        <input type="checkbox" id="hub-deriv-use-ai" />
        接続済みAIで文章を仕上げる
      </label>
      <button type="button" class="primary" id="hub-deriv-run">ドラフトを生成</button>
    </div>
    <p class="muted">元にする原稿を選択:</p>
    <div id="hub-deriv-pages" class="glossary-uimap-list"></div>
    <p id="hub-deriv-status" class="muted" role="status"></p>
    <pre id="hub-deriv-preview" class="external-tray-preview" hidden></pre>
    <div class="actions" id="hub-deriv-actions" hidden>
      <label class="ai-hub-inline-filename">保存先ファイル名
        <input type="text" id="hub-deriv-filename" placeholder="faq.md" />
      </label>
      <button type="button" class="primary" id="hub-deriv-create">新規原稿として作成して開く</button>
      <button type="button" id="hub-deriv-insert">現在の原稿へ差分挿入</button>
    </div>
  `;

  const allPages = options.getPages();
  const derivPagesBox = derivPanel.querySelector<HTMLElement>("#hub-deriv-pages")!;
  const derivChecks: Array<{ page: string; input: HTMLInputElement }> = [];
  for (const p of allPages) {
    const lbl = document.createElement("label");
    lbl.className = "glossary-uimap-item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = p === options.getCurrentPage() || allPages.length <= 3;
    lbl.append(cb, document.createTextNode(p));
    derivPagesBox.append(lbl);
    derivChecks.push({ page: p, input: cb });
  }

  let derivResult: { suggested_page: string; markdown: string } | null = null;
  const derivFilenameInput = derivPanel.querySelector<HTMLInputElement>("#hub-deriv-filename")!;
  derivPanel.querySelector<HTMLButtonElement>("#hub-deriv-run")!.onclick = async () => {
    const pages = derivChecks.filter((c) => c.input.checked).map((c) => c.page);
    const kind = derivPanel.querySelector<HTMLSelectElement>("#hub-deriv-kind")!.value;
    const useAi = derivPanel.querySelector<HTMLInputElement>("#hub-deriv-use-ai")!.checked;
    const statusEl = derivPanel.querySelector<HTMLElement>("#hub-deriv-status")!;
    const previewEl = derivPanel.querySelector<HTMLElement>("#hub-deriv-preview")!;
    const actionsEl = derivPanel.querySelector<HTMLElement>("#hub-deriv-actions")!;
    statusEl.textContent = "派生ドラフトを生成しています…";
    try {
      const res = JSON.parse(
        await options.rpc("derivative-generate", { kind, pages, use_ai: useAi }, root),
      ) as { suggested_page: string; markdown: string; ai_refined: boolean };
      derivResult = res;
      derivFilenameInput.value = res.suggested_page;
      previewEl.textContent = res.markdown;
      previewEl.hidden = false;
      actionsEl.hidden = false;
      statusEl.textContent = `生成完了（推奨ファイル名: ${res.suggested_page}${res.ai_refined ? " / AI整形済み" : ""}）`;
    } catch (error) {
      statusEl.textContent = `生成できませんでした: ${String(error)}`;
    }
  };
  derivPanel.querySelector<HTMLButtonElement>("#hub-deriv-create")!.onclick = async () => {
    if (!derivResult) return;
    const statusEl = derivPanel.querySelector<HTMLElement>("#hub-deriv-status")!;
    const target = derivFilenameInput.value.trim() || derivResult.suggested_page;
    try {
      await options.createPageWithContent(target, derivResult.markdown, false);
      dialog.close();
    } catch (error) {
      statusEl.textContent = `原稿を作成できませんでした（別名を指定してください）: ${String(error)}`;
    }
  };
  derivPanel.querySelector<HTMLButtonElement>("#hub-deriv-insert")!.onclick = async () => {
    if (!derivResult) return;
    dialog.close();
    await options.insertMarkdownWithDiff(derivResult.markdown, "派生コンテンツドラフト");
  };
}

function populateTranslationPanel(
  transPanel: HTMLElement,
  dialog: HTMLDialogElement,
  options: AiCollabHubOptions,
  root: string,
): void {
  transPanel.innerHTML = `
    <p class="hub-guide-banner">基準言語ページのGit差分だけを抽出し、翻訳先ページの該当箇所だけを同期します（全文再翻訳で既存訳を壊しません）。</p>
    <div class="ai-hub-form-row">
      <label>基準言語ページ
        <select id="hub-trans-source"></select>
      </label>
      <label>翻訳先ページ
        <select id="hub-trans-target"></select>
      </label>
    </div>
    <div class="ai-hub-form-row">
      <label>比較元のコミット（既定: 1つ前の変更 HEAD~1）
        <input type="text" id="hub-trans-base" value="HEAD~1" />
      </label>
      <label>翻訳先言語
        <input type="text" id="hub-trans-lang" value="English" />
      </label>
      <label class="setting-checkbox">
        <input type="checkbox" id="hub-trans-use-ai" />
        接続済みAIで差分翻訳案を作る
      </label>
      <button type="button" class="primary" id="hub-trans-run">翻訳差分を抽出</button>
    </div>
    <p id="hub-trans-status" class="muted" role="status"></p>
    <pre id="hub-trans-diff" class="external-tray-preview" hidden></pre>
    <div class="actions" id="hub-trans-actions" hidden>
      <button type="button" class="primary" id="hub-trans-send-terminal">最小差分プロンプトをAIターミナルへ送る</button>
      <button type="button" id="hub-trans-apply-diff" hidden>AI翻訳案をDiff確認して反映</button>
    </div>
  `;

  const allPages = options.getPages();
  const transSrcSelect = transPanel.querySelector<HTMLSelectElement>("#hub-trans-source")!;
  const transDstSelect = transPanel.querySelector<HTMLSelectElement>("#hub-trans-target")!;
  for (const p of allPages) {
    transSrcSelect.add(new Option(p, p));
    transDstSelect.add(new Option(p, p));
  }
  if (allPages.length >= 2) {
    transDstSelect.selectedIndex = 1;
  }

  const transRunBtn = transPanel.querySelector<HTMLButtonElement>("#hub-trans-run")!;
  const transStatusEl = transPanel.querySelector<HTMLElement>("#hub-trans-status")!;
  const syncTransButtonState = () => {
    if (allPages.length < 2) {
      transRunBtn.disabled = true;
      transStatusEl.textContent = "差分翻訳同期には基準言語と翻訳先の2ページ以上が必要です。";
    } else if (transSrcSelect.value === transDstSelect.value) {
      transRunBtn.disabled = true;
      transStatusEl.textContent = "基準言語ページと翻訳先ページには異なるページを選択してください。";
    } else {
      transRunBtn.disabled = false;
      if (/2ページ以上|異なるページ/.test(transStatusEl.textContent || "")) {
        transStatusEl.textContent = "";
      }
    }
  };
  transSrcSelect.onchange = syncTransButtonState;
  transDstSelect.onchange = syncTransButtonState;
  syncTransButtonState();

  let lastTransPlan: {
    source_page: string;
    target_page: string;
    git_diff: string;
    handoff_prompt: string;
    target_before: string;
    proposed_after: string | null;
  } | null = null;

  transRunBtn.onclick = async () => {
    const diffEl = transPanel.querySelector<HTMLElement>("#hub-trans-diff")!;
    const actionsEl = transPanel.querySelector<HTMLElement>("#hub-trans-actions")!;
    const applyDiffBtn = transPanel.querySelector<HTMLButtonElement>("#hub-trans-apply-diff")!;
    transStatusEl.textContent = "基準言語のGit差分を抽出しています…";
    try {
      const res = JSON.parse(
        await options.rpc(
          "translation-diff-plan",
          {
            source_page: transSrcSelect.value,
            target_page: transDstSelect.value,
            base_ref: transPanel.querySelector<HTMLInputElement>("#hub-trans-base")!.value.trim() || "HEAD~1",
            target_language: transPanel.querySelector<HTMLInputElement>("#hub-trans-lang")!.value.trim() || "English",
            use_ai: transPanel.querySelector<HTMLInputElement>("#hub-trans-use-ai")!.checked,
          },
          root,
        ),
      );
      lastTransPlan = res;
      diffEl.textContent = res.git_diff || "（指定範囲のGit差分はありません。セクション構成を比較して同期できます）";
      diffEl.hidden = false;
      actionsEl.hidden = false;
      applyDiffBtn.hidden = !res.proposed_after;
      transStatusEl.textContent = res.has_git_diff
        ? `変更見出し: ${(res.changed_headings || []).join(", ") || "あり"}`
        : "Git差分は検出されませんでした（セクション比較プロンプトを作成しました）。";
    } catch (error) {
      transStatusEl.textContent = `抽出に失敗しました: ${String(error)}`;
    }
  };

  transPanel.querySelector<HTMLButtonElement>("#hub-trans-send-terminal")!.onclick = async () => {
    if (!lastTransPlan) return;
    dialog.close();
    await options.sendToTerminal({
      title: `多言語差分同期（${lastTransPlan.target_page}）`,
      page: lastTransPlan.target_page,
      defaultInstruction: lastTransPlan.handoff_prompt,
    });
  };
  transPanel.querySelector<HTMLButtonElement>("#hub-trans-apply-diff")!.onclick = async () => {
    if (!lastTransPlan?.proposed_after) return;
    const plan = lastTransPlan;
    const decision = await reviewSelection(
      plan.target_page,
      plan.target_before,
      plan.proposed_after!,
      undefined,
      "",
      false,
    );
    if (decision.action !== "adopt" || decision.content === plan.target_before) return;
    dialog.close();
    await options.createPageWithContent(plan.target_page, decision.content, true);
  };
}

function populateFactCheckPanel(
  factPanel: HTMLElement,
  dialog: HTMLDialogElement,
  options: AiCollabHubOptions,
  root: string,
): void {
  factPanel.innerHTML = `
    <p class="hub-guide-banner">開いている原稿内のコマンド・フラグ・パス・UI表記（「」）を、対象アプリのソースコードと撮影画像のUI要素情報（UIMap）に照合して裏取りします。</p>
    <div class="ai-hub-form-row">
      <label>照合元ソースフォルダー
        <div class="ai-hub-path-row">
          <input type="text" id="hub-fact-source-dir" />
          <button type="button" id="hub-fact-source-browse" hidden>参照…</button>
        </div>
      </label>
      <button type="button" class="primary" id="hub-fact-run">現在の原稿を裏取り</button>
    </div>
    <div class="actions">
      <select id="hub-fact-filter" aria-label="裏取り結果の絞り込み">
        <option value="all">すべて</option>
        <option value="unverified">根拠未確認のみ</option>
        <option value="supported">根拠ありのみ</option>
      </select>
      <span id="hub-fact-status" class="muted" role="status"></span>
    </div>
    <div id="hub-fact-list" class="ai-hub-list"></div>
  `;
  const factDirInput = factPanel.querySelector<HTMLInputElement>("#hub-fact-source-dir")!;
  factDirInput.value = options.getWorkingDirectory() || root;
  const factBrowseBtn = factPanel.querySelector<HTMLButtonElement>("#hub-fact-source-browse")!;
  if (isNative) {
    factBrowseBtn.hidden = false;
    factBrowseBtn.onclick = async () => {
      try {
        const picked = await invoke<string | null>("choose_path", {
          initialPath: factDirInput.value.trim() || root,
          folder: true,
          baseDirectory: root,
          title: "照合元ソースフォルダーを選択",
        });
        if (picked) factDirInput.value = picked;
      } catch (error) {
        options.reportStatus(String(error), true);
      }
    };
  }
  const factFilter = factPanel.querySelector<HTMLSelectElement>("#hub-fact-filter")!;
  let lastFactResult: {
    page: string;
    findings: Array<{
      kind: string;
      claim: string;
      verdict: "supported" | "unverified";
      line: number;
      evidence: { source_type: string; location: string; excerpt: string } | null;
    }>;
  } | null = null;

  const renderFactFindings = () => {
    const listEl = factPanel.querySelector<HTMLElement>("#hub-fact-list")!;
    listEl.replaceChildren();
    if (!lastFactResult) return;
    const filter = factFilter.value;
    const items = lastFactResult.findings.filter((f) => filter === "all" || f.verdict === filter);
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "条件に一致する項目はありません。";
      listEl.append(empty);
      return;
    }
    for (const f of items) {
      const card = document.createElement("div");
      card.className = `ai-hub-card ai-hub-verdict-${f.verdict}`;
      const head = document.createElement("div");
      head.className = "ai-hub-card-header";
      const badge = document.createElement("span");
      badge.className =
        f.verdict === "supported" ? "quality-badge quality-badge-success" : "quality-badge quality-badge-error";
      badge.textContent = f.verdict === "supported" ? "根拠あり" : "根拠未確認";
      const title = document.createElement("strong");
      title.textContent = `行 ${f.line}: ${f.claim}`;
      head.append(badge, title);

      const ev = document.createElement("p");
      ev.className = "muted";
      ev.textContent = f.evidence
        ? `${f.evidence.source_type}: ${f.evidence.location} — ${f.evidence.excerpt}`
        : "ソースコードおよびUIMapに一致する根拠が見つかりませんでした。表記ズレまたは古い仕様の可能性があります。";

      const actions = document.createElement("div");
      actions.className = "actions";
      const jumpBtn = document.createElement("button");
      jumpBtn.type = "button";
      jumpBtn.textContent = "該当行を開く";
      jumpBtn.onclick = () => {
        dialog.close();
        void options.openPage(lastFactResult!.page, f.line);
      };
      actions.append(jumpBtn);

      if (f.verdict === "unverified") {
        const askBtn = document.createElement("button");
        askBtn.type = "button";
        askBtn.textContent = "AIターミナルで調査";
        askBtn.onclick = () => {
          dialog.close();
          void options.sendToTerminal({
            title: "未確認の記述をソースから裏取り",
            page: lastFactResult!.page,
            lineStart: f.line,
            excerpt: f.claim,
            defaultInstruction: `原稿内の記述「${f.claim}」（行 ${f.line}）がソースコードに存在するか確認し、誤りや表記変更があれば preview-edit で修正案を提示してください。`,
          });
        };
        actions.append(askBtn);
      }

      card.append(head, ev, actions);
      listEl.append(card);
    }
  };
  factFilter.onchange = renderFactFindings;

  factPanel.querySelector<HTMLButtonElement>("#hub-fact-run")!.onclick = async () => {
    const page = options.getCurrentPage();
    const statusEl = factPanel.querySelector<HTMLElement>("#hub-fact-status")!;
    if (!page) {
      statusEl.textContent = "先に裏取り対象の原稿を開いてください。";
      return;
    }
    statusEl.textContent = "ソースコードとUIMapを照合しています…";
    try {
      const res = JSON.parse(
        await options.rpc(
          "manuscript-fact-check",
          { page, source_dir: factDirInput.value.trim() || undefined },
          root,
        ),
      );
      lastFactResult = res;
      const hintSuffix = res.indexed_source_files === 0 && res.hint ? ` — ${res.hint}` : "";
      statusEl.textContent = `根拠あり ${res.supported}件 / 未確認 ${res.unverified}件（ソース ${res.indexed_source_files}件・UIMap ${res.indexed_uimap_labels}語を照合）${hintSuffix}`;
      renderFactFindings();
    } catch (error) {
      statusEl.textContent = `裏取りに失敗しました: ${String(error)}`;
    }
  };
}

function populateImpactPanel(
  impactPanel: HTMLElement,
  dialog: HTMLDialogElement,
  options: AiCollabHubOptions,
  root: string,
): void {
  impactPanel.innerHTML = `
    <p class="hub-guide-banner">対象アプリリポジトリのGit差分から、変更されたUI文言・識別子と影響を受けるマニュアルページ・再撮影候補を抽出します。</p>
    <div class="ai-hub-form-row">
      <label>対象アプリのリポジトリパス
        <div class="ai-hub-path-row">
          <input type="text" id="hub-impact-repo" />
          <button type="button" id="hub-impact-repo-browse" hidden>参照…</button>
        </div>
      </label>
      <label>比較元のコミット（既定: 1つ前の変更 HEAD~1）
        <input type="text" id="hub-impact-base" value="HEAD~1" />
      </label>
      <button type="button" class="primary" id="hub-impact-run">影響箇所を抽出</button>
    </div>
    <p id="hub-impact-status" class="muted" role="status"></p>
    <div id="hub-impact-list" class="ai-hub-list"></div>
  `;
  const impactRepoInput = impactPanel.querySelector<HTMLInputElement>("#hub-impact-repo")!;
  impactRepoInput.value = options.getWorkingDirectory() || root;
  const impactBrowseBtn = impactPanel.querySelector<HTMLButtonElement>("#hub-impact-repo-browse")!;
  if (isNative) {
    impactBrowseBtn.hidden = false;
    impactBrowseBtn.onclick = async () => {
      try {
        const picked = await invoke<string | null>("choose_path", {
          initialPath: impactRepoInput.value.trim() || root,
          folder: true,
          baseDirectory: root,
          title: "対象アプリのリポジトリを選択",
        });
        if (picked) impactRepoInput.value = picked;
      } catch (error) {
        options.reportStatus(String(error), true);
      }
    };
  }
  const impactBaseInput = impactPanel.querySelector<HTMLInputElement>("#hub-impact-base")!;

  impactPanel.querySelector<HTMLButtonElement>("#hub-impact-run")!.onclick = async () => {
    const statusEl = impactPanel.querySelector<HTMLElement>("#hub-impact-status")!;
    const listEl = impactPanel.querySelector<HTMLElement>("#hub-impact-list")!;
    statusEl.textContent = "Git差分とマニュアルを照合しています…";
    listEl.replaceChildren();
    try {
      const res = JSON.parse(
        await options.rpc(
          "app-impact-analyze",
          {
            repo_path: impactRepoInput.value.trim() || undefined,
            base_ref: impactBaseInput.value.trim() || "HEAD~1",
          },
          root,
        ),
      ) as {
        changed_files: string[];
        impacted_pages: Array<{
          page: string;
          score: number;
          reasons: string[];
          matched_lines: Array<{ line: number; token: string }>;
        }>;
        impacted_screenshots: Array<{
          resource_id: string;
          name: string;
          matched_ui_elements: string[];
        }>;
      };
      statusEl.textContent = `変更ファイル ${res.changed_files.length}件 → 影響ページ ${res.impacted_pages.length}件 / 関連撮影画像 ${res.impacted_screenshots.length}件`;
      if (!res.impacted_pages.length && !res.impacted_screenshots.length) {
        const empty = document.createElement("p");
        empty.className = "muted";
        empty.textContent = "指定した差分から影響を受けるマニュアルページは検出されませんでした。";
        listEl.append(empty);
        return;
      }
      for (const item of res.impacted_pages) {
        const card = document.createElement("div");
        card.className = "ai-hub-card";
        const title = document.createElement("strong");
        title.textContent = `${item.page}（影響スコア: ${item.score}）`;
        const ul = document.createElement("ul");
        for (const r of item.reasons) {
          const li = document.createElement("li");
          li.textContent = r;
          ul.append(li);
        }
        const actions = document.createElement("div");
        actions.className = "actions";
        const openBtn = document.createElement("button");
        openBtn.type = "button";
        openBtn.textContent = "ページを開く";
        openBtn.onclick = () => {
          dialog.close();
          void options.openPage(item.page, item.matched_lines[0]?.line || 1);
        };
        const askBtn = document.createElement("button");
        askBtn.type = "button";
        askBtn.className = "primary";
        askBtn.textContent = "AIターミナルで更新依頼";
        askBtn.onclick = () => {
          dialog.close();
          void options.sendToTerminal({
            title: `アプリ変更に伴う ${item.page} の更新`,
            page: item.page,
            lineStart: item.matched_lines[0]?.line || 1,
            defaultInstruction: `アプリの最新変更（base_ref: ${impactBaseInput.value.trim() || "HEAD~1"}）に合わせて、このページの該当箇所を更新案として preview-edit で提示してください。\n検出理由:\n- ${item.reasons.join("\n- ")}`,
          });
        };
        actions.append(openBtn, askBtn);
        card.append(title, ul, actions);
        listEl.append(card);
      }
      for (const shot of res.impacted_screenshots) {
        const card = document.createElement("div");
        card.className = "ai-hub-card";
        card.textContent = `関連撮影画像: ${shot.name}（一致UI要素: ${shot.matched_ui_elements.join(", ")}）— 画面変更があれば再撮影を検討してください。`;
        listEl.append(card);
      }
    } catch (error) {
      statusEl.textContent = `影響抽出に失敗しました: ${String(error)}`;
    }
  };
}

function populateStructurePanel(
  panel: HTMLElement,
  dialog: HTMLDialogElement,
  options: AiCollabHubOptions,
  root: string,
): () => Promise<void> {
  panel.innerHTML = `
    <p class="hub-guide-banner">プロジェクト全体のページ構成を集計し、どこからもリンクされていない孤立ページやエラー・未解決AIメモの件数を確認します。</p>
    <div class="actions">
      <button type="button" class="primary" id="hub-dashboard-refresh">構成・整合性を再集計</button>
      <span id="hub-dashboard-status" class="muted" role="status"></span>
    </div>
    <div id="hub-dashboard-diagnostics" class="ai-hub-list"></div>
    <div id="hub-dashboard-pages" class="ai-hub-list"></div>
  `;
  let loaded = false;

  async function load(force = false): Promise<void> {
    if (loaded && !force) return;
    loaded = true;
    const statusEl = panel.querySelector<HTMLElement>("#hub-dashboard-status")!;
    const diagEl = panel.querySelector<HTMLElement>("#hub-dashboard-diagnostics")!;
    const pagesEl = panel.querySelector<HTMLElement>("#hub-dashboard-pages")!;
    statusEl.textContent = "プロジェクト全体の構成を集計しています…";
    try {
      const data = JSON.parse(await options.rpc("project-dashboard", {}, root)) as DashboardResponse;
      statusEl.textContent = `全 ${data.total_pages} ページ / エラー ${data.total_errors}件・警告 ${data.total_warnings}件・横断診断 ${data.diagnostics.length}件`;

      diagEl.replaceChildren();
      for (const diag of data.diagnostics) {
        const card = document.createElement("div");
        card.className = `ai-hub-card ai-hub-severity-${diag.severity}`;
        const msg = document.createElement("span");
        msg.textContent = diag.message;
        const actions = document.createElement("div");
        actions.className = "actions";
        if (diag.pages[0]) {
          const openBtn = document.createElement("button");
          openBtn.type = "button";
          openBtn.textContent = `${diag.pages[0]} を開く`;
          openBtn.onclick = () => {
            dialog.close();
            void options.openPage(diag.pages[0]);
          };
          actions.append(openBtn);
        }
        card.append(msg, actions);
        diagEl.append(card);
      }

      pagesEl.replaceChildren();
      for (const item of data.pages) {
        const row = document.createElement("div");
        row.className = "ai-hub-card ai-hub-page-row";
        row.dataset.page = item.page;

        const info = document.createElement("div");
        info.className = "ai-hub-page-info";
        const titleRow = document.createElement("div");
        titleRow.className = "ai-hub-page-title-row";
        const title = document.createElement("strong");
        title.textContent = `${item.title} (${item.page})`;
        const audBadge = document.createElement("span");
        audBadge.className = `audience-scope-badge${item.audiences.length ? " is-restricted" : ""}`;
        audBadge.textContent = audienceSummaryLabel(item.audiences);
        titleRow.append(title, audBadge);

        const meta = document.createElement("div");
        meta.className = "muted";
        meta.textContent = `文字数: ${item.char_count} / 見出し: ${item.heading_count} / 画像: ${item.image_count} / 被リンク: ${item.incoming_count} / エラー: ${item.error_count} / 警告: ${item.warning_count} / AIメモ: ${item.ai_note_count}`;
        info.append(titleRow, meta);

        const actions = document.createElement("div");
        actions.className = "actions";
        const openBtn = document.createElement("button");
        openBtn.type = "button";
        openBtn.textContent = "開く";
        openBtn.onclick = () => {
          dialog.close();
          void options.openPage(item.page);
        };
        actions.append(openBtn);
        row.append(info, actions);
        pagesEl.append(row);
      }
    } catch (error) {
      statusEl.textContent = `集計できませんでした: ${String(error)}`;
    }
  }

  panel.querySelector<HTMLButtonElement>("#hub-dashboard-refresh")!.onclick = () => void load(true);
  return () => load(false);
}

function populateExportNavPanel(
  navPanel: HTMLElement,
  dialog: HTMLDialogElement,
  options: AiCollabHubOptions,
  root: string,
): () => Promise<void> {
  navPanel.innerHTML = `
    <p class="hub-guide-banner">HTML出力時のサイドバー目次順・セクション分け・表示名・非表示を設定します。</p>
    <div class="actions">
      <button type="button" id="hub-nav-refresh">一覧を再読み込み</button>
      <button type="button" class="primary" id="hub-nav-save-btn">目次順・公開設定を保存</button>
      <span id="hub-nav-status" class="muted" role="status"></span>
    </div>
    <div id="hub-nav-pages" class="ai-hub-list"></div>
  `;

  let loaded = false;
  let orderedPages: DashboardPage[] = [];
  let navDraftMap = new Map<string, NavDraft>();

  const renderRows = () => {
    const pagesEl = navPanel.querySelector<HTMLElement>("#hub-nav-pages")!;
    pagesEl.replaceChildren();
    orderedPages.forEach((item, idx) => {
      const draft = navDraftMap.get(item.page) || { page: item.page, title: "", section: "", hidden: false };
      navDraftMap.set(item.page, draft);

      const row = document.createElement("div");
      row.className = "ai-hub-card ai-hub-page-row";
      row.dataset.page = item.page;

      const info = document.createElement("div");
      info.className = "ai-hub-page-info";
      const title = document.createElement("strong");
      title.textContent = `${item.title} (${item.page})`;

      const navRow = document.createElement("div");
      navRow.className = "ai-hub-nav-controls";
      const upBtn = document.createElement("button");
      upBtn.type = "button";
      upBtn.textContent = "↑";
      upBtn.title = "目次順を上へ移動";
      upBtn.setAttribute("aria-label", `${item.page} を上へ移動`);
      upBtn.disabled = idx === 0;
      upBtn.onclick = () => {
        if (idx === 0) return;
        [orderedPages[idx - 1], orderedPages[idx]] = [orderedPages[idx], orderedPages[idx - 1]];
        renderRows();
      };
      const downBtn = document.createElement("button");
      downBtn.type = "button";
      downBtn.textContent = "↓";
      downBtn.title = "目次順を下へ移動";
      downBtn.setAttribute("aria-label", `${item.page} を下へ移動`);
      downBtn.disabled = idx === orderedPages.length - 1;
      downBtn.onclick = () => {
        if (idx >= orderedPages.length - 1) return;
        [orderedPages[idx], orderedPages[idx + 1]] = [orderedPages[idx + 1], orderedPages[idx]];
        renderRows();
      };

      const sectionInput = document.createElement("input");
      sectionInput.type = "text";
      sectionInput.className = "ai-hub-nav-input";
      sectionInput.placeholder = "セクション名（任意）";
      sectionInput.setAttribute("aria-label", `${item.page} のセクション名`);
      sectionInput.value = draft.section;
      sectionInput.oninput = () => {
        draft.section = sectionInput.value;
      };

      const titleInput = document.createElement("input");
      titleInput.type = "text";
      titleInput.className = "ai-hub-nav-input";
      titleInput.placeholder = `表示名（既定: ${item.title}）`;
      titleInput.setAttribute("aria-label", `${item.page} の目次表示名`);
      titleInput.value = draft.title;
      titleInput.oninput = () => {
        draft.title = titleInput.value;
      };

      const hideLbl = document.createElement("label");
      hideLbl.className = "ai-hub-aud-check";
      const hideCb = document.createElement("input");
      hideCb.type = "checkbox";
      hideCb.checked = draft.hidden;
      hideCb.onchange = () => {
        draft.hidden = hideCb.checked;
      };
      hideLbl.append(hideCb, document.createTextNode("目次から隠す"));

      navRow.append(upBtn, downBtn, sectionInput, titleInput, hideLbl);
      info.append(title, navRow);

      const actions = document.createElement("div");
      actions.className = "actions";
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.textContent = "開く";
      openBtn.onclick = () => {
        dialog.close();
        void options.openPage(item.page);
      };
      actions.append(openBtn);

      row.append(info, actions);
      pagesEl.append(row);
    });
  };

  async function load(force = false): Promise<void> {
    if (loaded && !force) return;
    loaded = true;
    const statusEl = navPanel.querySelector<HTMLElement>("#hub-nav-status")!;
    statusEl.textContent = "ページ一覧を読み込んでいます…";
    try {
      const data = JSON.parse(await options.rpc("project-dashboard", {}, root)) as DashboardResponse;
      const savedNav = data.nav || [];
      navDraftMap = new Map();
      for (const entry of savedNav) {
        navDraftMap.set(entry.page, {
          page: entry.page,
          title: entry.title || "",
          section: entry.section || "",
          hidden: Boolean(entry.hidden),
        });
      }
      const rankOf = (page: string) => {
        const i = savedNav.findIndex((e) => e.page === page || page.endsWith(`/${e.page}`));
        if (i >= 0) return i;
        if (page === "index.md" || page.endsWith("/index.md")) return savedNav.length;
        return savedNav.length + 1;
      };
      orderedPages = [...data.pages].sort(
        (a, b) => rankOf(a.page) - rankOf(b.page) || a.page.localeCompare(b.page),
      );
      statusEl.textContent = `全 ${orderedPages.length} ページ`;
      renderRows();
    } catch (error) {
      statusEl.textContent = `読み込めませんでした: ${String(error)}`;
    }
  }

  navPanel.querySelector<HTMLButtonElement>("#hub-nav-refresh")!.onclick = () => void load(true);
  navPanel.querySelector<HTMLButtonElement>("#hub-nav-save-btn")!.onclick = async () => {
    const statusEl = navPanel.querySelector<HTMLElement>("#hub-nav-status")!;
    const saveNavBtn = navPanel.querySelector<HTMLButtonElement>("#hub-nav-save-btn")!;
    saveNavBtn.disabled = true;
    try {
      const nav = orderedPages.map((item) => {
        const d = navDraftMap.get(item.page) || { page: item.page, title: "", section: "", hidden: false };
        return {
          page: item.page,
          title: d.title.trim(),
          section: d.section.trim(),
          hidden: d.hidden,
        };
      });
      await options.rpc("publication-nav-save", { nav }, root);
      statusEl.textContent = `目次順・公開設定（${nav.length}ページ）を保存しました。HTML出力時に反映されます。`;
      options.reportStatus("HTML出力の目次順・公開設定を保存しました。");
    } catch (error) {
      statusEl.textContent = `目次設定の保存に失敗しました: ${String(error)}`;
    } finally {
      saveNavBtn.disabled = false;
    }
  };

  return () => load(false);
}

function populateExportAudiencePanel(
  audPanel: HTMLElement,
  dialog: HTMLDialogElement,
  options: AiCollabHubOptions,
  root: string,
): () => Promise<void> {
  audPanel.innerHTML = `
    <div class="hub-guide-banner">
      <strong>読者別出力のしくみ</strong>
      <ul class="audience-guide-list">
        <li>既定は<strong>「全員共通」</strong>です（どの読者向けHTMLにも含まれます）。</li>
        <li>特定の読者だけに載せたいページだけ<strong>「特定の読者に限定」</strong>へ切り替えて対象を選んでください（原稿先頭に <code>&lt;!-- ai:audience ... --&gt;</code> が保存されます）。</li>
        <li>通常の「出力・テーマ」では常に全ページが出力されます。読者別に絞り込むには下の「読者別HTMLを作成」を使います。</li>
      </ul>
    </div>
    <div class="card audience-build-card">
      <div class="actions ai-hub-toolbar-group" role="group" aria-label="読者別HTML出力">
        <label class="ai-hub-inline-label">出力する読者
          <select id="hub-audience-build-target" aria-label="出力する読者">
            <option value="user">利用者向け (user)</option>
            <option value="developer">開発者向け (developer)</option>
            <option value="maintainer">保守者向け (maintainer)</option>
          </select>
        </label>
        <label class="ai-hub-inline-label">出力ツール
          <select id="hub-audience-build-engine" aria-label="読者別HTML出力ツール">
            <option value="mkdocs">MkDocs</option>
            <option value="zensical">Zensical</option>
            <option value="single-html">単一HTML（Python不要）</option>
          </select>
        </label>
        <button type="button" class="primary" id="hub-audience-build-btn">読者別HTMLを作成</button>
      </div>
      <p id="hub-audience-status" class="muted" role="status"></p>
    </div>
    <div class="actions audience-pages-toolbar">
      <strong>ページごとの公開対象</strong>
      <button type="button" id="hub-audience-save-all" class="primary" disabled>変更した読者設定を保存</button>
      <span id="hub-audience-dirty-note" class="muted" role="status"></span>
    </div>
    <div id="hub-audience-pages" class="ai-hub-list"></div>
  `;

  const engineSelect = audPanel.querySelector<HTMLSelectElement>("#hub-audience-build-engine")!;
  try {
    const savedEngine = localStorage.getItem("manual-studio-site-engine");
    if (savedEngine === "build-zensical") engineSelect.value = "zensical";
    else if (savedEngine === "build-single-html") engineSelect.value = "single-html";
    else if (savedEngine === "build-mkdocs") engineSelect.value = "mkdocs";
  } catch { /* Optional persistence */ }

  let loaded = false;
  let pages: DashboardPage[] = [];
  const draftState = new Map<string, { restricted: boolean; audiences: string[] }>();

  const saveAllBtn = audPanel.querySelector<HTMLButtonElement>("#hub-audience-save-all")!;
  const dirtyNoteEl = audPanel.querySelector<HTMLElement>("#hub-audience-dirty-note")!;
  const statusEl = audPanel.querySelector<HTMLElement>("#hub-audience-status")!;

  const getDirtyPages = (): Array<{ page: string; audiences: string[]; invalidEmpty: boolean }> => {
    const dirty: Array<{ page: string; audiences: string[]; invalidEmpty: boolean }> = [];
    for (const item of pages) {
      const draft = draftState.get(item.page);
      if (!draft) continue;
      const effective = draft.restricted ? draft.audiences : [];
      const invalidEmpty = draft.restricted && draft.audiences.length === 0;
      if (invalidEmpty || !sameAudienceSet(item.audiences, effective)) {
        dirty.push({ page: item.page, audiences: effective, invalidEmpty });
      }
    }
    return dirty;
  };

  const syncDirtyState = () => {
    const dirty = getDirtyPages();
    const invalidCount = dirty.filter((d) => d.invalidEmpty).length;
    saveAllBtn.disabled = dirty.length === 0 || invalidCount > 0;
    if (invalidCount > 0) {
      dirtyNoteEl.textContent = "「特定の読者に限定」を選んだページは1つ以上の読者を選択してください。";
    } else if (dirty.length > 0) {
      dirtyNoteEl.textContent = `未保存の変更 ${dirty.length}件`;
    } else {
      dirtyNoteEl.textContent = "";
    }
  };

  const renderRows = () => {
    const pagesEl = audPanel.querySelector<HTMLElement>("#hub-audience-pages")!;
    pagesEl.replaceChildren();
    for (const item of pages) {
      const draft = draftState.get(item.page) || {
        restricted: item.audiences.length > 0,
        audiences: [...item.audiences],
      };
      draftState.set(item.page, draft);

      const row = document.createElement("div");
      row.className = "ai-hub-card ai-hub-page-row audience-page-row";
      row.dataset.page = item.page;

      const info = document.createElement("div");
      info.className = "ai-hub-page-info";
      const titleRow = document.createElement("div");
      titleRow.className = "ai-hub-page-title-row";
      const title = document.createElement("strong");
      title.textContent = `${item.title} (${item.page})`;
      const badge = document.createElement("span");
      const updateBadge = () => {
        const eff = draft.restricted ? draft.audiences : [];
        badge.className = `audience-scope-badge${draft.restricted ? " is-restricted" : ""}`;
        badge.textContent = draft.restricted
          ? eff.length
            ? audienceSummaryLabel(eff)
            : "限定（対象未選択）"
          : "全員共通";
      };
      updateBadge();
      titleRow.append(title, badge);
      info.append(titleRow);

      const controls = document.createElement("div");
      controls.className = "audience-row-controls";

      const scopeSelect = document.createElement("select");
      scopeSelect.className = "audience-scope-select";
      scopeSelect.setAttribute("aria-label", `${item.page} の公開対象`);
      scopeSelect.add(new Option("全員共通（全読者に含める）", "all"));
      scopeSelect.add(new Option("特定の読者に限定する", "restricted"));
      scopeSelect.value = draft.restricted ? "restricted" : "all";

      const checksBox = document.createElement("div");
      checksBox.className = "audience-checks";
      checksBox.hidden = !draft.restricted;

      for (const def of AUDIENCE_DEFS) {
        const lbl = document.createElement("label");
        lbl.className = "ai-hub-aud-check";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = def.id;
        cb.checked = draft.audiences.includes(def.id);
        cb.onchange = () => {
          const next = new Set(draft.audiences);
          if (cb.checked) next.add(def.id);
          else next.delete(def.id);
          draft.audiences = AUDIENCE_DEFS.map((d) => d.id).filter((id) => next.has(id));
          updateBadge();
          syncDirtyState();
        };
        lbl.append(cb, document.createTextNode(def.label));
        checksBox.append(lbl);
      }

      scopeSelect.onchange = () => {
        draft.restricted = scopeSelect.value === "restricted";
        checksBox.hidden = !draft.restricted;
        updateBadge();
        syncDirtyState();
      };

      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.textContent = "開く";
      openBtn.onclick = () => {
        dialog.close();
        void options.openPage(item.page);
      };

      controls.append(scopeSelect, checksBox, openBtn);
      row.append(info, controls);
      pagesEl.append(row);
    }
    syncDirtyState();
  };

  async function load(force = false): Promise<void> {
    if (loaded && !force) return;
    loaded = true;
    statusEl.textContent = "ページの読者設定を読み込んでいます…";
    try {
      const data = JSON.parse(await options.rpc("project-dashboard", {}, root)) as DashboardResponse;
      pages = data.pages;
      draftState.clear();
      for (const item of pages) {
        draftState.set(item.page, {
          restricted: item.audiences.length > 0,
          audiences: [...item.audiences],
        });
      }
      const restrictedCount = pages.filter((p) => p.audiences.length > 0).length;
      statusEl.textContent = `全 ${pages.length} ページ（全員共通 ${pages.length - restrictedCount}件 / 読者限定 ${restrictedCount}件）`;
      renderRows();
    } catch (error) {
      statusEl.textContent = `読み込めませんでした: ${String(error)}`;
    }
  }

  saveAllBtn.onclick = async () => {
    const dirty = getDirtyPages();
    if (!dirty.length) return;
    if (dirty.some((d) => d.invalidEmpty)) {
      dirtyNoteEl.textContent = "「特定の読者に限定」を選んだページは1つ以上の読者を選択してください。";
      return;
    }
    saveAllBtn.disabled = true;
    dirtyNoteEl.textContent = "読者設定を保存しています…";
    try {
      for (const entry of dirty) {
        await options.rpc("page-audience-save", { page: entry.page, audiences: entry.audiences }, root);
        const target = pages.find((p) => p.page === entry.page);
        if (target) target.audiences = [...entry.audiences];
      }
      const restrictedCount = pages.filter((p) => p.audiences.length > 0).length;
      statusEl.textContent = `読者設定を保存しました（${dirty.length}ページ更新 · 全員共通 ${pages.length - restrictedCount}件 / 読者限定 ${restrictedCount}件）。`;
      options.reportStatus(`${dirty.length}ページの読者設定を保存しました。`);
      syncDirtyState();
    } catch (error) {
      dirtyNoteEl.textContent = `保存失敗: ${String(error)}`;
      saveAllBtn.disabled = false;
    }
  };

  audPanel.querySelector<HTMLButtonElement>("#hub-audience-build-btn")!.onclick = async () => {
    const audience = audPanel.querySelector<HTMLSelectElement>("#hub-audience-build-target")!.value;
    const engine = engineSelect.value;
    const audienceLabel = AUDIENCE_DEFS.find((d) => d.id === audience)?.label || audience;
    if (getDirtyPages().length > 0) {
      statusEl.textContent = "先に「変更した読者設定を保存」を押してから出力してください。";
      return;
    }
    statusEl.textContent = `${audienceLabel} の HTML を作成しています…`;
    try {
      const res = JSON.parse(
        await options.rpc("build-audience", { audience, engine, draft: true }, root),
      ) as { output: string; summary: string };
      statusEl.textContent = `${audienceLabel} の HTML を作成しました（出力先: ${res.output}）。`;
      if (isNative) {
        const openHtmlBtn = document.createElement("button");
        openHtmlBtn.type = "button";
        openHtmlBtn.textContent = "出力HTMLを開く";
        openHtmlBtn.style.marginLeft = "8px";
        openHtmlBtn.onclick = () => {
          void invoke("open_output_html", { root, output: res.output }).catch((err) => {
            options.reportStatus(`出力HTMLを開けませんでした: ${String(err)}`, true);
          });
        };
        statusEl.append(openHtmlBtn);
      }
      options.reportStatus(`${audienceLabel} の HTML を作成しました。`);
    } catch (error) {
      const message = String(error);
      const hint =
        engine !== "single-html" && /見つかりません|MkDocs|Zensical|Python|\.venv/i.test(message)
          ? " （出力ツールを「単一HTML（Python不要）」へ切り替えるか、「出力・テーマ」タブでワーキングフォルダを指定してください）"
          : "";
      statusEl.textContent = `読者別出力に失敗しました: ${message}${hint}`;
    }
  };

  return () => load(false);
}

/**
 * 「原稿作成支援」ダイアログ（書く・生成するに特化した3タブ）
 */
export function openDraftAssistDialog(
  options: AiCollabHubOptions,
  initialTab: DraftAssistTabId = "recording-draft",
): void {
  const root = options.getProjectRoot();
  if (!root) {
    options.reportStatus("先にプロジェクトを開いてください。", true);
    return;
  }

  const { dialog, body } = featureDialog("原稿作成支援");
  dialog.id = "ai-collab-hub-dialog";
  dialog.dataset.dialogInitialWidth = "960";
  dialog.dataset.dialogInitialHeight = "740";

  let loadRecording: (() => Promise<void>) | null = null;
  const tabDefs: Array<{ id: DraftAssistTabId; label: string }> = [
    { id: "recording-draft", label: "操作記録から手順書" },
    { id: "derivative", label: "FAQ・要約を作成" },
    { id: "translation", label: "多言語の差分翻訳" },
  ];
  const { tabsNav, tabPanels, selectTab } = createDialogTabs(
    "ai-hub",
    "原稿作成支援の種類",
    tabDefs,
    (id) => {
      if (id === "recording-draft") void loadRecording?.();
    },
  );

  body.append(tabsNav, ...tabDefs.map((d) => tabPanels.get(d.id)!));

  loadRecording = populateRecordingDraftPanel(tabPanels.get("recording-draft")!, dialog, options, root);
  populateDerivativePanel(tabPanels.get("derivative")!, dialog, options, root);
  populateTranslationPanel(tabPanels.get("translation")!, dialog, options, root);

  selectTab(initialTab);
}

/**
 * 「原稿チェック」ダイアログ（チェック・裏取り・変更影響・構成診断の4タブ）
 */
export function mountManuscriptCheckTabs(
  dialog: HTMLDialogElement,
  body: HTMLElement,
  qualityElements: HTMLElement[],
  options: AiCollabHubOptions,
  initialTab: ManuscriptCheckTabId = "quality",
): void {
  const root = options.getProjectRoot();
  dialog.id = "manuscript-check-dialog";
  dialog.dataset.dialogInitialWidth = "960";
  dialog.dataset.dialogInitialHeight = "740";

  let loadStructure: (() => Promise<void>) | null = null;
  const tabDefs: Array<{ id: ManuscriptCheckTabId; label: string }> = [
    { id: "quality", label: "品質チェック" },
    { id: "fact-check", label: "ソースとの裏取り" },
    { id: "impact", label: "アプリ変更の影響" },
    { id: "structure", label: "ページ構成・孤立診断" },
  ];
  const { tabsNav, tabPanels, selectTab } = createDialogTabs(
    "check",
    "原稿チェックの種類",
    tabDefs,
    (id) => {
      if (id === "structure") void loadStructure?.();
    },
  );

  body.append(tabsNav, ...tabDefs.map((d) => tabPanels.get(d.id)!));

  tabPanels.get("quality")!.append(...qualityElements);
  populateFactCheckPanel(tabPanels.get("fact-check")!, dialog, options, root);
  populateImpactPanel(tabPanels.get("impact")!, dialog, options, root);
  loadStructure = populateStructurePanel(tabPanels.get("structure")!, dialog, options, root);

  selectTab(initialTab);
}

/**
 * 「HTML出力」ダイアログ（出力・テーマ／目次順・非表示／読者別出力の3タブ）
 */
export function mountSiteExportTabs(
  dialog: HTMLDialogElement,
  body: HTMLElement,
  buildControls: HTMLElement,
  options: AiCollabHubOptions,
  initialTab: SiteExportTabId = "build",
): void {
  const root = options.getProjectRoot();
  dialog.dataset.dialogInitialWidth = "920";
  dialog.dataset.dialogInitialHeight = "760";

  let loadNav: (() => Promise<void>) | null = null;
  let loadAudience: (() => Promise<void>) | null = null;
  const tabDefs: Array<{ id: SiteExportTabId; label: string }> = [
    { id: "build", label: "出力・テーマ" },
    { id: "nav", label: "目次順・非表示" },
    { id: "audience", label: "読者別出力" },
  ];
  const { tabsNav, tabPanels, selectTab } = createDialogTabs(
    "export",
    "HTML出力の設定",
    tabDefs,
    (id) => {
      if (id === "nav") void loadNav?.();
      if (id === "audience") void loadAudience?.();
    },
  );

  body.append(tabsNav, ...tabDefs.map((d) => tabPanels.get(d.id)!));

  tabPanels.get("build")!.append(buildControls);
  loadNav = populateExportNavPanel(tabPanels.get("nav")!, dialog, options, root);
  loadAudience = populateExportAudiencePanel(tabPanels.get("audience")!, dialog, options, root);

  selectTab(initialTab);
}
