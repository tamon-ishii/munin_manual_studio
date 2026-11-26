import { confirmAction } from "./imageDialogs";

export interface GlossaryTerm {
  id: string;
  preferred: string;
  avoid: string[];
  category: "ui" | "term" | "style";
  case_sensitive: boolean;
  note: string;
  source: "manual" | "uimap";
}

export interface GlossaryFile {
  version: number;
  terms: GlossaryTerm[];
}

interface UimapCandidate {
  name: string;
  roles: string[];
  sources: string[];
  count: number;
  registered: boolean;
}

export interface GlossarySettingsOptions {
  rpc: (action: string, options?: Record<string, unknown>, root?: string) => Promise<string>;
  getProjectRoot: () => string;
  reportStatus: (message: string, isError?: boolean) => void;
}

export interface GlossarySettingsController {
  element: HTMLElement;
  reload: (root?: string) => Promise<void>;
}

const CATEGORY_LABELS: Record<GlossaryTerm["category"], string> = {
  ui: "UI表記",
  term: "専門用語",
  style: "文体・表記",
};

function parseAvoidList(raw: string): string[] {
  return raw
    .split(/[\n,、]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function setupGlossarySettings(options: GlossarySettingsOptions): GlossarySettingsController {
  const section = document.createElement("section");
  section.id = "glossary-settings";
  section.className = "card glossary-settings-card";
  section.innerHTML = `
    <h2>用語集・表記ルール</h2>
    <p class="muted">プロジェクト全体で統一するUI名称や用語・NG表記を登録します。原稿チェックやAIによる編集・推敲時に自動で参照されます。</p>
    <form class="glossary-form" id="glossary-entry-form">
      <div class="glossary-form-grid">
        <label>正式表記（必須）
          <input type="text" id="glossary-preferred" placeholder="例: 撮影するアプリを登録" required />
        </label>
        <label>カテゴリ
          <select id="glossary-category">
            <option value="ui">UI表記</option>
            <option value="term">専門用語</option>
            <option value="style">文体・表記</option>
          </select>
        </label>
        <label class="glossary-span-2">NG表記・ゆれ候補（カンマまたは改行区切り）
          <textarea id="glossary-avoid" rows="2" placeholder="例: アプリ登録, 対象アプリ登録"></textarea>
        </label>
        <label class="glossary-span-2">補足メモ（任意）
          <input type="text" id="glossary-note" placeholder="例: 上部ナビゲーションのボタン表記に合わせ、「」で囲む。" />
        </label>
        <label class="setting-checkbox glossary-span-2">
          <input type="checkbox" id="glossary-case-sensitive" />
          大文字・小文字を区別する
        </label>
      </div>
      <div class="actions">
        <button type="submit" class="primary" id="glossary-submit-btn">用語を追加</button>
        <button type="button" id="glossary-cancel-edit" hidden>編集をキャンセル</button>
        <button type="button" id="glossary-import-uimap">撮影画像のUI要素から候補を取り込む</button>
      </div>
    </form>
    <div id="glossary-uimap-panel" class="glossary-uimap-panel" hidden></div>
    <div class="glossary-filter-bar">
      <input type="search" id="glossary-search" placeholder="用語を検索…" aria-label="用語を検索" />
      <select id="glossary-filter-category" aria-label="カテゴリ絞り込み">
        <option value="all">すべてのカテゴリ</option>
        <option value="ui">UI表記</option>
        <option value="term">専門用語</option>
        <option value="style">文体・表記</option>
      </select>
      <span id="glossary-count" class="muted">0件</span>
    </div>
    <div id="glossary-list" class="glossary-list" aria-live="polite"></div>
    <div class="actions">
      <span id="glossary-save-status" role="status" aria-live="polite" class="muted"></span>
      <button type="button" id="glossary-retry-save" hidden>保存を再試行</button>
    </div>
  `;

  const form = section.querySelector<HTMLFormElement>("#glossary-entry-form")!;
  const preferredInput = section.querySelector<HTMLInputElement>("#glossary-preferred")!;
  const categorySelect = section.querySelector<HTMLSelectElement>("#glossary-category")!;
  const avoidInput = section.querySelector<HTMLTextAreaElement>("#glossary-avoid")!;
  const noteInput = section.querySelector<HTMLInputElement>("#glossary-note")!;
  const caseCheck = section.querySelector<HTMLInputElement>("#glossary-case-sensitive")!;
  const submitBtn = section.querySelector<HTMLButtonElement>("#glossary-submit-btn")!;
  const cancelEditBtn = section.querySelector<HTMLButtonElement>("#glossary-cancel-edit")!;
  const importUimapBtn = section.querySelector<HTMLButtonElement>("#glossary-import-uimap")!;
  const uimapPanel = section.querySelector<HTMLElement>("#glossary-uimap-panel")!;
  const searchInput = section.querySelector<HTMLInputElement>("#glossary-search")!;
  const filterCategory = section.querySelector<HTMLSelectElement>("#glossary-filter-category")!;
  const countEl = section.querySelector<HTMLElement>("#glossary-count")!;
  const listEl = section.querySelector<HTMLElement>("#glossary-list")!;
  const saveStatusEl = section.querySelector<HTMLElement>("#glossary-save-status")!;
  const retrySaveBtn = section.querySelector<HTMLButtonElement>("#glossary-retry-save")!;

  let glossary: GlossaryFile = { version: 1, terms: [] };
  let editingId: string | null = null;
  let pendingSave: GlossaryFile | null = null;
  let loadedRoot = "";

  function resetForm(): void {
    editingId = null;
    preferredInput.value = "";
    avoidInput.value = "";
    noteInput.value = "";
    categorySelect.value = "ui";
    caseCheck.checked = false;
    submitBtn.textContent = "用語を追加";
    cancelEditBtn.hidden = true;
  }

  function setSaveStatus(message: string, failed = false): void {
    saveStatusEl.textContent = message;
    retrySaveBtn.hidden = !failed;
  }

  async function persist(next: GlossaryFile): Promise<boolean> {
    const root = options.getProjectRoot();
    if (!root) {
      setSaveStatus("プロジェクトを開いてから保存してください。", true);
      return false;
    }
    pendingSave = next;
    setSaveStatus("保存中…");
    try {
      const saved = JSON.parse(
        await options.rpc("glossary-save", { json: next }, root),
      ) as GlossaryFile;
      if (root !== options.getProjectRoot()) return false;
      glossary = saved;
      pendingSave = null;
      setSaveStatus("保存済み（.munin/glossary.json）");
      renderList();
      return true;
    } catch (error) {
      setSaveStatus(`保存できませんでした: ${String(error)}`, true);
      options.reportStatus(`用語集の保存に失敗しました: ${String(error)}`, true);
      return false;
    }
  }

  function renderList(): void {
    const query = searchInput.value.trim().toLowerCase();
    const category = filterCategory.value;
    const filtered = glossary.terms.filter((term) => {
      if (category !== "all" && term.category !== category) return false;
      if (!query) return true;
      return (
        term.preferred.toLowerCase().includes(query) ||
        term.note.toLowerCase().includes(query) ||
        term.avoid.some((item) => item.toLowerCase().includes(query))
      );
    });
    countEl.textContent = `${filtered.length} / ${glossary.terms.length}件`;
    listEl.replaceChildren();
    if (!filtered.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = glossary.terms.length
        ? "条件に一致する用語がありません。"
        : "まだ用語は登録されていません。";
      listEl.append(empty);
      return;
    }

    for (const term of filtered) {
      const row = document.createElement("div");
      row.className = "glossary-row";
      row.dataset.glossaryTermId = term.id;

      const main = document.createElement("div");
      main.className = "glossary-row-main";
      const header = document.createElement("div");
      header.className = "glossary-row-header";
      const badge = document.createElement("span");
      badge.className = `glossary-category-badge glossary-category-${term.category}`;
      badge.textContent = CATEGORY_LABELS[term.category] || term.category;
      const title = document.createElement("strong");
      title.textContent = term.preferred;
      header.append(badge, title);
      if (term.source === "uimap") {
        const src = document.createElement("span");
        src.className = "glossary-source-tag";
        src.textContent = "UIMap";
        header.append(src);
      }
      main.append(header);

      if (term.avoid.length) {
        const avoidLine = document.createElement("div");
        avoidLine.className = "glossary-avoid-line";
        avoidLine.textContent = `NG表記: ${term.avoid.join(" / ")}`;
        main.append(avoidLine);
      }
      if (term.note) {
        const noteLine = document.createElement("div");
        noteLine.className = "muted glossary-note-line";
        noteLine.textContent = term.note;
        main.append(noteLine);
      }

      const actions = document.createElement("div");
      actions.className = "actions glossary-row-actions";
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.textContent = "編集";
      editBtn.onclick = () => {
        editingId = term.id;
        preferredInput.value = term.preferred;
        categorySelect.value = term.category;
        avoidInput.value = term.avoid.join(", ");
        noteInput.value = term.note;
        caseCheck.checked = term.case_sensitive;
        submitBtn.textContent = "変更を保存";
        cancelEditBtn.hidden = false;
        preferredInput.focus();
      };
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.textContent = "削除";
      delBtn.onclick = async () => {
        if (!(await confirmAction(`「${term.preferred}」を用語集から削除しますか？`, "削除する"))) {
          return;
        }
        const next: GlossaryFile = {
          version: 1,
          terms: glossary.terms.filter((item) => item.id !== term.id),
        };
        if (editingId === term.id) resetForm();
        await persist(next);
      };
      actions.append(editBtn, delBtn);

      row.append(main, actions);
      listEl.append(row);
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const preferred = preferredInput.value.trim();
    if (!preferred) return;
    const entry: GlossaryTerm = {
      id: editingId || "",
      preferred,
      avoid: parseAvoidList(avoidInput.value),
      category: categorySelect.value as GlossaryTerm["category"],
      case_sensitive: caseCheck.checked,
      note: noteInput.value.trim(),
      source: editingId
        ? glossary.terms.find((t) => t.id === editingId)?.source || "manual"
        : "manual",
    };
    const nextTerms = editingId
      ? glossary.terms.map((item) => (item.id === editingId ? entry : item))
      : [...glossary.terms, entry];
    const ok = await persist({ version: 1, terms: nextTerms });
    if (ok) resetForm();
  });

  cancelEditBtn.addEventListener("click", () => resetForm());
  retrySaveBtn.addEventListener("click", () => {
    if (pendingSave) void persist(pendingSave);
  });
  searchInput.addEventListener("input", renderList);
  filterCategory.addEventListener("change", renderList);

  importUimapBtn.addEventListener("click", async () => {
    const root = options.getProjectRoot();
    if (!root) {
      setSaveStatus("プロジェクトを開いてから実行してください。", true);
      return;
    }
    importUimapBtn.disabled = true;
    uimapPanel.hidden = false;
    uimapPanel.textContent = "撮影画像のUIMapを解析しています…";
    try {
      const result = JSON.parse(
        await options.rpc("glossary-uimap-candidates", {}, root),
      ) as { scanned_images: number; candidates: UimapCandidate[] };
      if (root !== options.getProjectRoot()) return;
      const unregistered = result.candidates.filter((c) => !c.registered);
      uimapPanel.replaceChildren();
      const head = document.createElement("div");
      head.className = "glossary-uimap-header";
      const summary = document.createElement("strong");
      summary.textContent = `UIMap候補（${result.scanned_images}枚の画像から未登録 ${unregistered.length}件）`;
      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.textContent = "パネルを隠す";
      closeBtn.onclick = () => {
        uimapPanel.hidden = true;
      };
      head.append(summary, closeBtn);
      uimapPanel.append(head);

      if (!unregistered.length) {
        const msg = document.createElement("p");
        msg.className = "muted";
        msg.textContent = result.scanned_images
          ? "未登録のUI要素候補はありません。"
          : "UIMapが埋め込まれたPNG画像がプロジェクト内に見つかりませんでした。";
        uimapPanel.append(msg);
        return;
      }

      const list = document.createElement("div");
      list.className = "glossary-uimap-list";
      const checkboxes: Array<{ candidate: UimapCandidate; input: HTMLInputElement }> = [];
      for (const candidate of unregistered.slice(0, 60)) {
        const label = document.createElement("label");
        label.className = "glossary-uimap-item";
        const check = document.createElement("input");
        check.type = "checkbox";
        check.checked = false;
        const text = document.createElement("span");
        const roleText = candidate.roles.length ? ` [${candidate.roles.join("/")}]` : "";
        text.textContent = `${candidate.name}${roleText}（${candidate.count}回）`;
        label.append(check, text);
        list.append(label);
        checkboxes.push({ candidate, input: check });
      }
      const footer = document.createElement("div");
      footer.className = "actions";
      const addSelected = document.createElement("button");
      addSelected.type = "button";
      addSelected.className = "primary";
      addSelected.textContent = "選んだ候補をUI表記として登録";
      addSelected.onclick = async () => {
        const picked = checkboxes.filter((item) => item.input.checked).map((item) => item.candidate);
        if (!picked.length) {
          setSaveStatus("登録する候補をチェックしてください。");
          return;
        }
        const addedTerms: GlossaryTerm[] = picked.map((item) => ({
          id: "",
          preferred: item.name,
          avoid: [],
          category: "ui",
          case_sensitive: false,
          note: item.roles.length ? `画面要素（${item.roles.join("/")}）` : "画面要素",
          source: "uimap",
        }));
        const ok = await persist({
          version: 1,
          terms: [...glossary.terms, ...addedTerms],
        });
        if (ok) {
          uimapPanel.hidden = true;
          options.reportStatus(`UIMapから${addedTerms.length}件を用語集に登録しました。`);
        }
      };
      footer.append(addSelected);
      uimapPanel.append(list, footer);
    } catch (error) {
      uimapPanel.textContent = `UIMap候補の取得に失敗しました: ${String(error)}`;
    } finally {
      importUimapBtn.disabled = false;
    }
  });

  async function reload(root = options.getProjectRoot()): Promise<void> {
    if (!root) {
      glossary = { version: 1, terms: [] };
      loadedRoot = "";
      uimapPanel.hidden = true;
      resetForm();
      setSaveStatus("");
      renderList();
      return;
    }
    if (root !== loadedRoot) {
      uimapPanel.hidden = true;
      resetForm();
    }
    loadedRoot = root;
    try {
      const loaded = JSON.parse(await options.rpc("glossary-read", {}, root)) as GlossaryFile;
      if (root !== options.getProjectRoot()) return;
      glossary = loaded;
      pendingSave = null;
      setSaveStatus(glossary.terms.length ? "読み込み済み" : "");
      renderList();
    } catch (error) {
      setSaveStatus(`用語集の読み込みに失敗しました: ${String(error)}`, false);
    }
  }

  return { element: section, reload };
}
