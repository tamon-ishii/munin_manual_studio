import { invoke } from "@tauri-apps/api/core";
import { featureDialog } from "./imageDialogs";
import { reviewSelection } from "./selectionAi";

const isNative = "__TAURI_INTERNALS__" in window;

export type HubTabId = "dashboard" | "fact-check" | "impact" | "recording-draft" | "derivative";

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

export function openAiCollabHubDialog(
  options: AiCollabHubOptions,
  initialTab: HubTabId = "dashboard",
): void {
  const root = options.getProjectRoot();
  if (!root) {
    options.reportStatus("先にプロジェクトを開いてください。", true);
    return;
  }

  const { dialog, body } = featureDialog("AI協業ツール");
  dialog.id = "ai-collab-hub-dialog";
  dialog.dataset.dialogInitialWidth = "1040";
  dialog.dataset.dialogInitialHeight = "760";

  const tabsNav = document.createElement("div");
  tabsNav.className = "settings-category-tabs ai-hub-tabs";
  tabsNav.setAttribute("role", "tablist");
  tabsNav.setAttribute("aria-label", "AI協業機能の種類");

  const tabDefs: Array<{ id: HubTabId; label: string }> = [
    { id: "dashboard", label: "構成・読者" },
    { id: "fact-check", label: "事実裏取り" },
    { id: "impact", label: "アプリ変更影響" },
    { id: "recording-draft", label: "操作記録→手順書" },
    { id: "derivative", label: "派生生成・多言語同期" },
  ];

  const tabButtons = new Map<HubTabId, HTMLButtonElement>();
  const tabPanels = new Map<HubTabId, HTMLElement>();

  for (const def of tabDefs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = `ai-hub-tab-${def.id}`;
    btn.textContent = def.label;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-controls", `ai-hub-panel-${def.id}`);
    const panel = document.createElement("section");
    panel.id = `ai-hub-panel-${def.id}`;
    panel.className = "ai-hub-panel";
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", btn.id);
    tabButtons.set(def.id, btn);
    tabPanels.set(def.id, panel);
    tabsNav.append(btn);
  }

  const selectTab = (id: HubTabId) => {
    for (const def of tabDefs) {
      const active = def.id === id;
      const btn = tabButtons.get(def.id)!;
      btn.setAttribute("aria-selected", String(active));
      btn.tabIndex = active ? 0 : -1;
      tabPanels.get(def.id)!.hidden = !active;
    }
    if (id === "dashboard" && !dashboardLoaded) void loadDashboard();
    if (id === "recording-draft" && !recordingLoaded) void loadRecordingSources();
  };

  for (const def of tabDefs) {
    const btn = tabButtons.get(def.id)!;
    btn.onclick = () => selectTab(def.id);
    btn.addEventListener("keydown", (event) => {
      const idx = tabDefs.findIndex((item) => item.id === def.id);
      const next =
        event.key === "ArrowRight"
          ? (idx + 1) % tabDefs.length
          : event.key === "ArrowLeft"
            ? (idx + tabDefs.length - 1) % tabDefs.length
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? tabDefs.length - 1
                : -1;
      if (next < 0) return;
      event.preventDefault();
      selectTab(tabDefs[next].id);
      tabButtons.get(tabDefs[next].id)!.focus();
    });
  }

  body.append(tabsNav, ...tabDefs.map((d) => tabPanels.get(d.id)!));

  // ---------- Tab 1: Dashboard & Audience ----------
  const dashPanel = tabPanels.get("dashboard")!;
  dashPanel.innerHTML = `
    <div class="ai-hub-toolbar-groups">
      <div class="actions ai-hub-toolbar-group" role="group" aria-label="構成と目次">
        <button type="button" class="primary" id="hub-dashboard-refresh">構成・整合性を再集計</button>
        <button type="button" id="hub-nav-save-btn">目次順・公開設定を保存</button>
      </div>
      <div class="actions ai-hub-toolbar-group" role="group" aria-label="読者別HTML出力">
        <label class="ai-hub-inline-label">読者別HTML出力:
          <select id="hub-audience-build-target" aria-label="出力する読者">
            <option value="user">user（利用者）</option>
            <option value="developer">developer（開発者）</option>
            <option value="maintainer">maintainer（保守者）</option>
          </select>
        </label>
        <select id="hub-audience-build-engine" aria-label="読者別HTML出力ツール">
          <option value="mkdocs">MkDocs</option>
          <option value="zensical">Zensical</option>
          <option value="single-html">単一HTML（Python不要）</option>
        </select>
        <button type="button" id="hub-audience-build-btn">読者別HTMLを作成</button>
      </div>
    </div>
    <p id="hub-dashboard-status" class="muted" role="status"></p>
    <div id="hub-dashboard-diagnostics" class="ai-hub-list"></div>
    <div id="hub-dashboard-pages" class="ai-hub-list"></div>
  `;
  let dashboardLoaded = false;
  type DashboardPage = {
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
  };
  type NavDraft = { page: string; title: string; section: string; hidden: boolean };
  let orderedPages: DashboardPage[] = [];
  let navDraftMap = new Map<string, NavDraft>();

  const renderDashboardPages = () => {
    const statusEl = dashPanel.querySelector<HTMLElement>("#hub-dashboard-status")!;
    const pagesEl = dashPanel.querySelector<HTMLElement>("#hub-dashboard-pages")!;
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
      const meta = document.createElement("div");
      meta.className = "muted";
      meta.textContent = `文字数: ${item.char_count} / 見出し: ${item.heading_count} / 画像: ${item.image_count} / 被リンク: ${item.incoming_count} / エラー: ${item.error_count} / 警告: ${item.warning_count} / AIメモ: ${item.ai_note_count}`;

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
        renderDashboardPages();
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
        renderDashboardPages();
      };

      const sectionInput = document.createElement("input");
      sectionInput.type = "text";
      sectionInput.className = "ai-hub-nav-input";
      sectionInput.placeholder = "セクション名（任意）";
      sectionInput.setAttribute("aria-label", `${item.page} のセクション名`);
      sectionInput.value = draft.section;
      sectionInput.oninput = () => { draft.section = sectionInput.value; };

      const titleInput = document.createElement("input");
      titleInput.type = "text";
      titleInput.className = "ai-hub-nav-input";
      titleInput.placeholder = `表示名（既定: ${item.title}）`;
      titleInput.setAttribute("aria-label", `${item.page} の目次表示名`);
      titleInput.value = draft.title;
      titleInput.oninput = () => { draft.title = titleInput.value; };

      const hideLbl = document.createElement("label");
      hideLbl.className = "ai-hub-aud-check";
      const hideCb = document.createElement("input");
      hideCb.type = "checkbox";
      hideCb.checked = draft.hidden;
      hideCb.onchange = () => { draft.hidden = hideCb.checked; };
      hideLbl.append(hideCb, document.createTextNode("目次から隠す"));

      navRow.append(upBtn, downBtn, sectionInput, titleInput, hideLbl);
      info.append(title, meta, navRow);

      const controls = document.createElement("div");
      controls.className = "actions ai-hub-audience-controls";
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.textContent = "開く";
      openBtn.onclick = () => {
        dialog.close();
        void options.openPage(item.page);
      };
      controls.append(openBtn);

      const checks: Array<{ aud: string; input: HTMLInputElement }> = [];
      for (const aud of ["user", "developer", "maintainer"]) {
        const lbl = document.createElement("label");
        lbl.className = "ai-hub-aud-check";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = item.audiences.includes(aud);
        lbl.append(cb, document.createTextNode(aud));
        controls.append(lbl);
        checks.push({ aud, input: cb });
      }
      const saveAudBtn = document.createElement("button");
      saveAudBtn.type = "button";
      saveAudBtn.textContent = "読者保存";
      saveAudBtn.onclick = async () => {
        saveAudBtn.disabled = true;
        try {
          const selected = checks.filter((c) => c.input.checked).map((c) => c.aud);
          await options.rpc("page-audience-save", { page: item.page, audiences: selected }, root);
          item.audiences = selected;
          statusEl.textContent = `${item.page} の対象読者設定を保存しました。`;
          options.reportStatus(`${item.page} の対象読者設定を保存しました。`);
        } catch (error) {
          statusEl.textContent = `保存失敗: ${String(error)}`;
        } finally {
          saveAudBtn.disabled = false;
        }
      };
      controls.append(saveAudBtn);
      row.append(info, controls);
      pagesEl.append(row);
    });
  };

  async function loadDashboard(): Promise<void> {
    dashboardLoaded = true;
    const statusEl = dashPanel.querySelector<HTMLElement>("#hub-dashboard-status")!;
    const diagEl = dashPanel.querySelector<HTMLElement>("#hub-dashboard-diagnostics")!;
    statusEl.textContent = "プロジェクト全体の構成を集計しています…";
    try {
      const data = JSON.parse(await options.rpc("project-dashboard", {}, root)) as {
        total_pages: number;
        total_errors: number;
        total_warnings: number;
        nav?: Array<{ page: string; title?: string; section?: string; hidden?: boolean }>;
        diagnostics: Array<{ kind: string; severity: string; pages: string[]; message: string }>;
        pages: DashboardPage[];
      };
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
      renderDashboardPages();
    } catch (error) {
      statusEl.textContent = `集計できませんでした: ${String(error)}`;
    }
  }

  dashPanel.querySelector<HTMLButtonElement>("#hub-nav-save-btn")!.onclick = async () => {
    const statusEl = dashPanel.querySelector<HTMLElement>("#hub-dashboard-status")!;
    const saveNavBtn = dashPanel.querySelector<HTMLButtonElement>("#hub-nav-save-btn")!;
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

  const audienceEngineSelect = dashPanel.querySelector<HTMLSelectElement>("#hub-audience-build-engine")!;
  try {
    const savedEngine = localStorage.getItem("manual-studio-site-engine");
    if (savedEngine === "build-zensical") audienceEngineSelect.value = "zensical";
    else if (savedEngine === "build-single-html") audienceEngineSelect.value = "single-html";
    else if (savedEngine === "build-mkdocs") audienceEngineSelect.value = "mkdocs";
  } catch { /* Optional persistence. */ }

  dashPanel.querySelector<HTMLButtonElement>("#hub-dashboard-refresh")!.onclick = () =>
    void loadDashboard();
  dashPanel.querySelector<HTMLButtonElement>("#hub-audience-build-btn")!.onclick = async () => {
    const statusEl = dashPanel.querySelector<HTMLElement>("#hub-dashboard-status")!;
    const audience = dashPanel.querySelector<HTMLSelectElement>("#hub-audience-build-target")!.value;
    const engine = audienceEngineSelect.value;
    statusEl.textContent = `${audience} 向け HTML を作成しています…`;
    try {
      const res = JSON.parse(
        await options.rpc("build-audience", { audience, engine, draft: true }, root),
      ) as { output: string; summary: string };
      statusEl.textContent = `${audience} 向け HTML を作成しました（出力先: ${res.output}）。`;
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
      options.reportStatus(`${audience} 向け HTML を作成しました。`);
    } catch (error) {
      const message = String(error);
      const hint = engine !== "single-html" && /見つかりません|MkDocs|Zensical|Python|\.venv/i.test(message)
        ? " （ツールを「単一HTML（Python不要）」へ切り替えるか、HTML出力設定でワーキングフォルダを指定できます）"
        : "";
      statusEl.textContent = `読者別出力に失敗しました: ${message}${hint}`;
    }
  };

  // ---------- Tab 2: Source Fact-Check ----------
  const factPanel = tabPanels.get("fact-check")!;
  factPanel.innerHTML = `
    <p class="muted">現在の原稿内のコマンド・フラグ・パス・UI表記（「」）を、対象アプリのソースコードと撮影画像のUIMapに照合して裏取りします。</p>
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
      badge.className = f.verdict === "supported" ? "quality-badge quality-badge-success" : "quality-badge quality-badge-error";
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

  // ---------- Tab 3: App Diff Impact Analyzer ----------
  const impactPanel = tabPanels.get("impact")!;
  impactPanel.innerHTML = `
    <p class="muted">対象アプリリポジトリのGit差分から、変更されたUI文言・識別子・関連撮影画像と影響を受けるマニュアルページを抽出します。</p>
    <div class="ai-hub-form-row">
      <label>対象アプリのリポジトリパス
        <div class="ai-hub-path-row">
          <input type="text" id="hub-impact-repo" />
          <button type="button" id="hub-impact-repo-browse" hidden>参照…</button>
        </div>
      </label>
      <label>比較基準（base_ref）
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

  // ---------- Tab 4: Recording -> Procedural Draft ----------
  const recPanel = tabPanels.get("recording-draft")!;
  recPanel.innerHTML = `
    <p class="muted">MarkItsの操作記録・操作スクリプト・注釈・UIMapが埋め込まれた画像から、操作手順の初稿Markdownを生成し、差分確認のうえ現在の原稿へ挿入します。</p>
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
  let recordingLoaded = false;
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

  async function loadRecordingSources(): Promise<void> {
    recordingLoaded = true;
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
    const imagePath = recPanel.querySelector<HTMLInputElement>("#hub-rec-image-path")!.value.trim();
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

  // ---------- Tab 5: Derivative & Differential Translation Sync ----------
  const derivPanel = tabPanels.get("derivative")!;
  derivPanel.innerHTML = `
    <div class="card">
      <h3>既存原稿から派生コンテンツを生成</h3>
      <div class="ai-hub-form-row">
        <label>派生種別
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
        <button type="button" class="primary" id="hub-deriv-run">派生ドラフトを生成</button>
      </div>
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
    </div>
    <div class="card">
      <h3>多言語マニュアルの差分翻訳同期</h3>
      <p class="muted">基準言語ページのGit差分だけを抽出し、翻訳先ページの該当箇所のみを同期します（全文再翻訳で既存訳を壊しません）。</p>
      <div class="ai-hub-form-row">
        <label>基準言語ページ
          <select id="hub-trans-source"></select>
        </label>
        <label>翻訳先ページ
          <select id="hub-trans-target"></select>
        </label>
      </div>
      <div class="ai-hub-form-row">
        <label>比較基準（base_ref）
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
    </div>
  `;

  const allPages = options.getPages();
  const derivPagesBox = derivPanel.querySelector<HTMLElement>("#hub-deriv-pages")!;
  const derivChecks: Array<{ page: string; input: HTMLInputElement }> = [];
  const transSrcSelect = derivPanel.querySelector<HTMLSelectElement>("#hub-trans-source")!;
  const transDstSelect = derivPanel.querySelector<HTMLSelectElement>("#hub-trans-target")!;
  for (const p of allPages) {
    const lbl = document.createElement("label");
    lbl.className = "glossary-uimap-item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = p === options.getCurrentPage() || allPages.length <= 3;
    lbl.append(cb, document.createTextNode(p));
    derivPagesBox.append(lbl);
    derivChecks.push({ page: p, input: cb });

    transSrcSelect.add(new Option(p, p));
    transDstSelect.add(new Option(p, p));
  }
  if (allPages.length >= 2) {
    transDstSelect.selectedIndex = 1;
  }

  const transRunBtn = derivPanel.querySelector<HTMLButtonElement>("#hub-trans-run")!;
  const transStatusEl = derivPanel.querySelector<HTMLElement>("#hub-trans-status")!;
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
      await options.createPageWithContent(target, derivResult.markdown);
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

  let lastTransPlan: {
    source_page: string;
    target_page: string;
    git_diff: string;
    handoff_prompt: string;
    target_before: string;
    proposed_after: string | null;
  } | null = null;

  derivPanel.querySelector<HTMLButtonElement>("#hub-trans-run")!.onclick = async () => {
    const statusEl = derivPanel.querySelector<HTMLElement>("#hub-trans-status")!;
    const diffEl = derivPanel.querySelector<HTMLElement>("#hub-trans-diff")!;
    const actionsEl = derivPanel.querySelector<HTMLElement>("#hub-trans-actions")!;
    const applyDiffBtn = derivPanel.querySelector<HTMLButtonElement>("#hub-trans-apply-diff")!;
    statusEl.textContent = "基準言語のGit差分を抽出しています…";
    try {
      const res = JSON.parse(
        await options.rpc(
          "translation-diff-plan",
          {
            source_page: transSrcSelect.value,
            target_page: transDstSelect.value,
            base_ref: derivPanel.querySelector<HTMLInputElement>("#hub-trans-base")!.value.trim() || "HEAD~1",
            target_language: derivPanel.querySelector<HTMLInputElement>("#hub-trans-lang")!.value.trim() || "English",
            use_ai: derivPanel.querySelector<HTMLInputElement>("#hub-trans-use-ai")!.checked,
          },
          root,
        ),
      );
      lastTransPlan = res;
      diffEl.textContent = res.git_diff || "（指定範囲のGit差分はありません。セクション構成を比較して同期できます）";
      diffEl.hidden = false;
      actionsEl.hidden = false;
      applyDiffBtn.hidden = !res.proposed_after;
      statusEl.textContent = res.has_git_diff
        ? `変更見出し: ${(res.changed_headings || []).join(", ") || "あり"}`
        : "Git差分は検出されませんでした（セクション比較プロンプトを作成しました）。";
    } catch (error) {
      statusEl.textContent = `抽出に失敗しました: ${String(error)}`;
    }
  };

  derivPanel.querySelector<HTMLButtonElement>("#hub-trans-send-terminal")!.onclick = async () => {
    if (!lastTransPlan) return;
    dialog.close();
    await options.sendToTerminal({
      title: `多言語差分同期（${lastTransPlan.target_page}）`,
      page: lastTransPlan.target_page,
      defaultInstruction: lastTransPlan.handoff_prompt,
    });
  };
  derivPanel.querySelector<HTMLButtonElement>("#hub-trans-apply-diff")!.onclick = async () => {
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

  selectTab(initialTab);
}
