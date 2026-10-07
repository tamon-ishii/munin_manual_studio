import { uiIcon } from './uiIcons';
export interface FileTreeEntry {
  path: string;
  directory: boolean;
}

interface TreeNode {
  name: string;
  path: string;
  folders: Map<string, TreeNode>;
  files: string[];
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]!);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter((part) => part && part !== ".").join("/");
}

/** Build the source tree markup and preserve the supplied expanded-folder set. */
export function renderFileTree(
  entries: FileTreeEntry[],
  pages: string[],
  currentPage: string | undefined,
  docsFolder: string,
  expandedFolders: Set<string>,
  options: { query?: string; markdownOnly?: boolean } = {},
): string {
  if (!entries.length) return '<p class="muted">フォルダーにファイルがありません。</p>';

  const normalizedEntries = entries.map((entry) => ({ ...entry, path: normalizePath(entry.path) }))
    .filter((entry) => entry.path.length > 0);
  const files = new Set(normalizedEntries.filter((entry) => !entry.directory).map((entry) => entry.path));
  const pagePaths = new Set(pages.map(normalizePath));
  const normalizedPage = currentPage ? normalizePath(currentPage) : undefined;
  const normalizedDocsFolder = normalizePath(docsFolder) || "docs";
  const docsRelativePage = normalizedPage
    ? normalizePath(`${normalizedDocsFolder}/${normalizedPage}`)
    : undefined;
  const activePath = normalizedPage && files.has(normalizedPage)
    ? normalizedPage
    : docsRelativePage && (files.has(docsRelativePage) || pagePaths.has(normalizedPage!))
      ? docsRelativePage
      : undefined;

  const query = (options.query || "").trim().toLocaleLowerCase();
  const filtering = Boolean(query || options.markdownOnly);
  const visibleEntries = filtering ? normalizedEntries.filter(entry => !entry.directory
    && (!options.markdownOnly || pagePaths.has(entry.path) || /\.md$/i.test(entry.path))
    && entry.path.toLocaleLowerCase().includes(query)) : normalizedEntries;
  if (!visibleEntries.length) return '<p class="muted" role="status">条件に一致するファイルがありません。</p>';

  const root: TreeNode = { name: "", path: "", folders: new Map(), files: [] };
  for (const entry of visibleEntries) {
    const parts = entry.path.split("/");
    let node = root;
    const folderParts = entry.directory ? parts : parts.slice(0, -1);
    for (const name of folderParts) {
      const folderPath = node.path ? `${node.path}/${name}` : name;
      let child = node.folders.get(name);
      if (!child) {
        child = { name, path: folderPath, folders: new Map(), files: [] };
        node.folders.set(name, child);
      }
      node = child;
    }
    if (!entry.directory) node.files.push(entry.path);
  }

  if (activePath) {
    const parts = activePath.split("/");
    for (let index = 1; index < parts.length; index++) {
      expandedFolders.add(parts.slice(0, index).join("/"));
    }
  }

  const renderNode = (node: TreeNode): string => {
    const folders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name, "ja"));
    const folderHtml = folders.map((folder) => `<details class="tree-folder" data-folder="${escapeHtml(folder.path)}" ${filtering || expandedFolders.has(folder.path) ? "open" : ""}><summary role="treeitem" aria-label="${escapeHtml(folder.name)} フォルダー"><span class="tree-chevron">▸</span><span class="tree-icon">${uiIcon("folder")}</span><span class="tree-name">${escapeHtml(folder.name)}</span></summary><div role="group">${renderNode(folder)}</div></details>`).join("");
    const fileHtml = node.files.sort((a, b) => a.localeCompare(b, "ja")).map((path) => {
      const name = path.split("/").at(-1)!;
      const isPage = pagePaths.has(path) || /\.md$/i.test(name);
      return isPage
        ? `<div class="tree-file-row"><button type="button" role="treeitem" data-page="${escapeHtml(path)}" class="tree-file ${activePath === path ? "selected" : ""}" title="${escapeHtml(path)}" ${activePath === path ? 'aria-current="page"' : ""}><span class="tree-icon">${uiIcon("file")}</span><span class="tree-name">${escapeHtml(name)}</span></button><button type="button" class="tree-generate" data-generate-page="${escapeHtml(path)}" title="${escapeHtml(name)}のAI文章・図・撮影指示を実行" aria-label="${escapeHtml(name)}をAI更新">AI</button></div>`
        : `<div role="treeitem" class="tree-file tree-static" title="${escapeHtml(path)}"><span class="tree-icon">${/\.(png|jpe?g|gif|webp|svg)$/i.test(name) ? uiIcon("image") : uiIcon("file")}</span><span class="tree-name">${escapeHtml(name)}</span></div>`;
    }).join("");
    return folderHtml + fileHtml;
  };

  return renderNode(root);
}
