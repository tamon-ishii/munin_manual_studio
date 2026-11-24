import { confirmAction, featureDialog } from './imageDialogs';
import { uiIcon } from './uiIcons';
import type { ResourceUsage } from './types';

export interface ProjectAssetItem {
  path: string;
  name?: string;
  kind?: 'screenshot' | 'generated' | 'imported' | string;
  bytes?: number;
  missing?: boolean;
  error?: string;
  usages: ResourceUsage[];
}

export interface AssetOrganizerOptions {
  root(): string;
  rpc(action: string, options: Record<string, unknown>, root: string): Promise<string>;
  hasUnsavedDocuments(): string[];
  openImage(path: string): Promise<void>;
  openUsage(usage: ResourceUsage): Promise<void>;
  onAssetsDeleted(paths: string[]): Promise<void>;
  status(message: string, error?: boolean): void;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function kindLabel(kind?: string): string {
  switch (kind) {
    case 'screenshot':
      return '撮影';
    case 'generated':
      return 'AI生成';
    default:
      return '画像';
  }
}

export function openAssetOrganizerDialog(options: AssetOrganizerOptions): HTMLDialogElement | null {
  const root = options.root();
  if (!root) {
    options.status('先にプロジェクトフォルダーを開いてください。', true);
    return null;
  }

  const existing = document.getElementById('asset-organizer-dialog') as HTMLDialogElement | null;
  if (existing?.open) {
    existing.focus();
    return existing;
  }

  const { dialog, body } = featureDialog('アセットの整理');
  dialog.id = 'asset-organizer-dialog';
  dialog.dataset.dialogInitialWidth = '560';
  dialog.dataset.dialogInitialHeight = '840';
  body.className = 'asset-organizer-body';

  const summary = document.createElement('p');
  summary.id = 'asset-organizer-summary';
  summary.className = 'asset-organizer-summary muted';
  summary.textContent = 'アセット一覧を読み込んでいます…';

  const toolbar = document.createElement('div');
  toolbar.className = 'asset-organizer-toolbar';

  const filterSelect = document.createElement('select');
  filterSelect.id = 'asset-organizer-filter';
  filterSelect.setAttribute('aria-label', 'アセットの使用状況');
  filterSelect.add(new Option('すべて', 'all'));
  filterSelect.add(new Option('未使用のみ', 'unused'));
  filterSelect.add(new Option('使用中のみ', 'used'));

  const searchInput = document.createElement('input');
  searchInput.id = 'asset-organizer-search';
  searchInput.type = 'search';
  searchInput.placeholder = 'ファイル名・パスで絞り込み';
  searchInput.setAttribute('aria-label', 'アセットを検索');

  const refreshButton = document.createElement('button');
  refreshButton.type = 'button';
  refreshButton.id = 'asset-organizer-refresh';
  refreshButton.innerHTML = `${uiIcon('refresh')}<span>再読込</span>`;

  const deleteUnusedButton = document.createElement('button');
  deleteUnusedButton.type = 'button';
  deleteUnusedButton.id = 'asset-organizer-delete-unused';
  deleteUnusedButton.className = 'primary asset-organizer-danger-btn';
  deleteUnusedButton.innerHTML = `${uiIcon('trash')}<span>未使用アセットを削除</span>`;
  deleteUnusedButton.disabled = true;

  toolbar.append(filterSelect, searchInput, refreshButton, deleteUnusedButton);

  const feedback = document.createElement('p');
  feedback.id = 'asset-organizer-feedback';
  feedback.className = 'asset-organizer-feedback';
  feedback.setAttribute('role', 'status');
  feedback.setAttribute('aria-live', 'polite');

  const list = document.createElement('div');
  list.id = 'asset-organizer-list';
  list.className = 'asset-organizer-list';

  body.append(summary, toolbar, feedback, list);

  let items: ProjectAssetItem[] = [];
  let loading = false;
  let version = 0;
  let renderGeneration = 0;
  const thumbnailCache = new Map<string, string>();

  async function loadThumbnails(queue: Array<{ img: HTMLImageElement; path: string }>, gen: number, currentVersion: number): Promise<void> {
    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length) {
        if (!dialog.open || gen !== renderGeneration || currentVersion !== version || options.root() !== root) return;
        const { img, path } = queue[cursor++];
        const cached = thumbnailCache.get(path);
        if (cached) {
          img.src = cached;
          img.hidden = false;
          continue;
        }
        try {
          const src = await options.rpc('resources-thumbnail', { asset: path }, root);
          if (!dialog.open || gen !== renderGeneration || currentVersion !== version || options.root() !== root) return;
          thumbnailCache.set(path, src);
          img.src = src;
          img.hidden = false;
        } catch {
          if (dialog.open && gen === renderGeneration && currentVersion === version) {
            img.hidden = true;
          }
        }
      }
    };
    const concurrency = Math.min(4, queue.length);
    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  const isDeletableUnused = (item: ProjectAssetItem): boolean =>
    !item.missing && item.usages.length === 0;

  function setBusy(busy: boolean): void {
    loading = busy;
    refreshButton.disabled = busy;
    const unusedCount = items.filter(isDeletableUnused).length;
    deleteUnusedButton.disabled = busy || unusedCount === 0;
  }

  function render(): void {
    const gen = ++renderGeneration;
    const currentVersion = version;
    list.replaceChildren();
    const pendingThumbnails: Array<{ img: HTMLImageElement; path: string }> = [];

    const filter = filterSelect.value;
    const query = searchInput.value.trim().toLowerCase();

    const usedItems = items.filter(item => item.usages.length > 0);
    const unusedItems = items.filter(isDeletableUnused);
    const totalBytes = items.reduce((acc, item) => acc + (item.bytes || 0), 0);
    const unusedBytes = unusedItems.reduce((acc, item) => acc + (item.bytes || 0), 0);

    summary.textContent =
      `全 ${items.length}件（使用中 ${usedItems.length}件・未使用 ${unusedItems.length}件 / 合計 ${formatBytes(totalBytes)}` +
      `${unusedItems.length > 0 ? `・未使用 ${formatBytes(unusedBytes)}` : ''}）`;

    const deleteLabel = deleteUnusedButton.querySelector('span');
    if (deleteLabel) {
      deleteLabel.textContent =
        unusedItems.length > 0 ? `未使用アセットを削除 (${unusedItems.length}件)` : '未使用アセットを削除';
    }
    deleteUnusedButton.disabled = loading || unusedItems.length === 0;

    const filtered = items.filter(item => {
      if (filter === 'unused' && item.usages.length > 0) return false;
      if (filter === 'used' && item.usages.length === 0) return false;
      if (query) {
        const haystack = `${item.path} ${item.name || ''}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });

    if (!filtered.length) {
      const empty = document.createElement('p');
      empty.className = 'asset-organizer-empty muted';
      empty.textContent =
        items.length === 0
          ? 'このプロジェクトに画像アセットはありません。'
          : '条件に一致するアセットがありません。';
      list.append(empty);
      return;
    }

    for (const item of filtered) {
      const row = document.createElement('article');
      row.className = 'asset-organizer-item';
      row.dataset.assetPath = item.path;
      row.dataset.assetState = item.missing ? 'missing' : item.usages.length === 0 ? 'unused' : 'used';

      const thumbWrap = document.createElement('div');
      thumbWrap.className = 'asset-organizer-thumb';
      if (!item.missing) {
        const img = document.createElement('img');
        img.alt = item.name || item.path;
        img.dataset.assetPath = item.path;
        img.width = 72;
        img.height = 48;
        const cached = thumbnailCache.get(item.path);
        if (cached) {
          img.src = cached;
        } else {
          img.hidden = true;
          pendingThumbnails.push({ img, path: item.path });
        }
        thumbWrap.append(img);
      } else {
        const missingBadge = document.createElement('span');
        missingBadge.className = 'muted';
        missingBadge.textContent = '欠落';
        thumbWrap.append(missingBadge);
      }

      const info = document.createElement('div');
      info.className = 'asset-organizer-info';

      const pathLine = document.createElement('div');
      pathLine.className = 'asset-organizer-path-line';

      const pathCode = document.createElement('code');
      pathCode.className = 'asset-organizer-path';
      pathCode.textContent = item.path;
      pathCode.title = item.path;

      const statusBadge = document.createElement('span');
      statusBadge.className = `asset-organizer-badge is-${item.missing ? 'missing' : item.usages.length === 0 ? 'unused' : 'used'}`;
      statusBadge.textContent = item.missing
        ? 'ファイル欠落'
        : item.usages.length === 0
          ? '未使用'
          : `使用中 (${item.usages.length}箇所)`;

      pathLine.append(pathCode, statusBadge);

      const meta = document.createElement('div');
      meta.className = 'asset-organizer-meta muted';
      meta.textContent = `${kindLabel(item.kind)}${!item.missing ? ` · ${formatBytes(item.bytes || 0)}` : ''}`;

      info.append(pathLine, meta);

      if (item.usages.length > 0) {
        const usagesWrap = document.createElement('div');
        usagesWrap.className = 'asset-organizer-usages';
        for (const usage of item.usages) {
          const jump = document.createElement('button');
          jump.type = 'button';
          jump.className = 'asset-organizer-usage-link';
          jump.textContent = `${usage.page}:${usage.line}`;
          jump.title = `${usage.page} の ${usage.line} 行目を開く`;
          jump.onclick = () => {
            dialog.close();
            void options.openUsage(usage);
          };
          usagesWrap.append(jump);
        }
        info.append(usagesWrap);
      }

      const actions = document.createElement('div');
      actions.className = 'asset-organizer-item-actions';

      if (!item.missing) {
        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.textContent = '表示';
        openBtn.title = `${item.path} を画像タブで開く`;
        openBtn.onclick = () => {
          dialog.close();
          void options.openImage(item.path);
        };
        actions.append(openBtn);
      }

      if (isDeletableUnused(item)) {
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'asset-organizer-delete-one';
        delBtn.dataset.deleteAsset = item.path;
        delBtn.textContent = '削除';
        delBtn.title = `未使用アセット ${item.path} を削除`;
        delBtn.disabled = loading;
        delBtn.onclick = () => {
          void handleDelete([item]);
        };
        actions.append(delBtn);
      }

      row.append(thumbWrap, info, actions);
      list.append(row);
    }

    if (pendingThumbnails.length) {
      void loadThumbnails(pendingThumbnails, gen, currentVersion);
    }
  }

  async function load(clearThumbnails = false): Promise<void> {
    const currentVersion = ++version;
    if (clearThumbnails) thumbnailCache.clear();
    setBusy(true);
    feedback.textContent = '';
    feedback.classList.remove('is-error');
    try {
      const result = JSON.parse(await options.rpc('resources-list', {}, root)) as {
        items?: ProjectAssetItem[];
      };
      if (!dialog.open || currentVersion !== version || options.root() !== root) return;
      items = (result.items || []).sort((a, b) => {
        const aUnused = isDeletableUnused(a) ? 0 : 1;
        const bUnused = isDeletableUnused(b) ? 0 : 1;
        if (aUnused !== bUnused) return aUnused - bUnused;
        return a.path.localeCompare(b.path);
      });
    } catch (error) {
      if (!dialog.open || currentVersion !== version) return;
      feedback.textContent = `アセット一覧を読み込めませんでした: ${String(error)}`;
      feedback.classList.add('is-error');
    } finally {
      if (dialog.open && currentVersion === version) {
        setBusy(false);
        render();
      }
    }
  }

  async function handleDelete(targets: ProjectAssetItem[]): Promise<void> {
    if (loading || !targets.length) return;
    const dirtyPages = options.hasUnsavedDocuments();
    if (dirtyPages.length > 0) {
      feedback.textContent = `未保存の原稿（${dirtyPages.join(', ')}）があるため削除できません。先に保存してください。`;
      feedback.classList.add('is-error');
      return;
    }

    const totalSize = targets.reduce((acc, item) => acc + (item.bytes || 0), 0);
    const confirmMessage =
      targets.length === 1
        ? `未使用アセット「${targets[0].path}」（${formatBytes(totalSize)}）を削除しますか？\n削除前のファイルは .munin/file-deletions/ にバックアップされます。`
        : `未使用アセット ${targets.length}件（合計 ${formatBytes(totalSize)}）を削除しますか？\n原稿から参照されている画像は対象外です。\n削除前のファイルは .munin/file-deletions/ にバックアップされます。`;

    const confirmed = await confirmAction(confirmMessage, '削除する');
    if (!confirmed || !dialog.open || options.root() !== root) return;

    setBusy(true);
    feedback.textContent = '未使用アセットを削除しています…';
    feedback.classList.remove('is-error');
    try {
      const payload = targets.length === items.filter(isDeletableUnused).length
        ? {}
        : { paths: targets.map(item => item.path) };
      const report = JSON.parse(
        await options.rpc('resources-delete-unused', { json: payload }, root),
      ) as {
        deleted?: string[];
        skipped?: Array<{ path: string; reason: string }>;
        freed_bytes?: number;
        backup?: string | null;
      };
      if (options.root() !== root) return;
      const deleted = report.deleted || [];
      const skipped = report.skipped || [];
      if (deleted.length > 0) {
        await options.onAssetsDeleted(deleted);
      }
      await load();
      if (!dialog.open || options.root() !== root) return;
      if (deleted.length > 0) {
        const message =
          `未使用アセット ${deleted.length}件を削除しました（${formatBytes(report.freed_bytes || 0)}削減` +
          `${skipped.length ? `・対象外 ${skipped.length}件` : ''}）。`;
        feedback.textContent = report.backup ? `${message} バックアップ: ${report.backup}` : message;
        options.status(message);
      } else {
        feedback.textContent = '削除できる未使用アセットはありませんでした。';
      }
    } catch (error) {
      if (!dialog.open) return;
      feedback.textContent = `削除に失敗しました: ${String(error)}`;
      feedback.classList.add('is-error');
      options.status(`アセット削除エラー: ${String(error)}`, true);
    } finally {
      if (dialog.open) setBusy(false);
    }
  }

  filterSelect.onchange = render;
  searchInput.oninput = render;
  refreshButton.onclick = () => { void load(true); };
  deleteUnusedButton.onclick = () => {
    void handleDelete(items.filter(isDeletableUnused));
  };

  void load();
  return dialog;
}
