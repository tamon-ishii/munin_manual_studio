import type { Node as MarkdownNode } from '@milkdown/kit/transformer';
import { $node, $remark, $view } from '@milkdown/kit/utils';
import { closeHistory, redo, undo } from '@milkdown/kit/prose/history';

const attributes = /(?:^|\s)([a-zA-Z][a-zA-Z0-9_-]*)=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
function attribute(header: string, name: string): string | undefined {
  for (const match of header.matchAll(attributes)) {
    if (match[1] === name) return match[2] ?? match[3] ?? match[4];
  }
}
function decode(value: string): string {
  return value.replaceAll('&#10;', '\n').replaceAll('&#13;', '\r').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}
function encode(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\r', '&#13;').replaceAll('\n', '&#10;');
}
function setPrompt(header: string, prompt: string): string {
  return header.replace(attributes, (token, name: string) => name === 'prompt' ? ` prompt="${encode(prompt)}"` : token);
}
function toggleApproval(header: string): string {
  const isApproved = attribute(header, 'approved-at') !== undefined;
  if (isApproved) {
    return header.replace(/(?:^|\s)approved-at=(?:"[^"]*"|'[^']*'|[^\s>]+)/g, '');
  }
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return header.replace(/\s*-->$/, ` approved-at="${now}" -->`);
}
function decodeB64(str: string): string {
  try {
    const binary = atob(str);
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}
type Ast = MarkdownNode & { [key: string]: unknown; children?: Ast[]; value?: string; header?: string };
function comment(node: Ast): string | undefined {
  if (node.type === 'html') return node.value;
  if (node.type === 'paragraph' && node.children?.length === 1 && node.children[0].type === 'html') return node.children[0].value;
}
/** Group comment markers and their Markdown children into one editable container. */
function groupTasks(tree: Ast): void {
  if (!tree.children) return;
  const grouped: Ast[] = [];
  for (let index = 0; index < tree.children.length; index++) {
    const node = tree.children[index];
    const header = comment(node);

    // 1. Unified format: <!-- ai:task ... prompt="..." --> ... <!-- /ai:task -->
    if (header && /^<!--\s*ai:task\b/.test(header) && attribute(header, 'prompt') !== undefined) {
      let end = index + 1;
      while (end < tree.children.length && !/^<!--\s*\/ai:task\s*-->$/.test(comment(tree.children[end])?.trim() || '')) end++;
      if (end < tree.children.length) {
        grouped.push({ type: 'manualAiTask', header: header.trim(), children: tree.children.slice(index + 1, end) });
        index = end;
        continue;
      }
    }

    // 2. Legacy format: <!-- ai:task id=... kind=...\nprompt\n-->
    if (header && /^<!--\s*ai:task\b/.test(header)) {
      const legacyMatch = header.match(/^<!--\s*ai:task\b(?<attrs>[^\r\n>]*)\r?\n(?<prompt>[\s\S]*?)\r?\n-->$/);
      if (legacyMatch) {
        const attrs = legacyMatch.groups?.attrs || '';
        const prompt = legacyMatch.groups?.prompt?.trim() || '';
        const id = attribute(attrs, 'id') || '';
        const kind = attribute(attrs, 'kind') || 'text';

        // Check if followed by <!-- ai:generated id=id ... --> ... <!-- /ai:generated -->
        let genStart = index + 1;
        if (genStart < tree.children.length) {
          const genHeader = comment(tree.children[genStart]);
          if (genHeader && /^<!--\s*ai:generated\b/.test(genHeader) && attribute(genHeader, 'id') === id) {
            let end = genStart + 1;
            while (end < tree.children.length && !/^<!--\s*\/ai:generated\s*-->$/.test(comment(tree.children[end])?.trim() || '')) end++;
            if (end < tree.children.length) {
              const genAttrs = genHeader.replace(/^<!--\s*ai:generated\b/, '').replace(/\s*-->$/, '');
              const unifiedHeader = `<!-- ai:task id="${id}" kind="${kind}" prompt="${encode(prompt)}"${genAttrs.replace(/(?:^|\s)(?:id|kind|prompt-b64)=(?:"[^"]*"|'[^']*'|[^\s>]+)/g, '')} -->`;
              grouped.push({ type: 'manualAiTask', header: unifiedHeader.trim(), children: tree.children.slice(genStart + 1, end) });
              index = end;
              continue;
            }
          }
        }
        // If not followed by ai:generated, it is an empty legacy task
        const unifiedHeader = `<!-- ai:task id="${id}" kind="${kind}" prompt="${encode(prompt)}" -->`;
        grouped.push({ type: 'manualAiTask', header: unifiedHeader.trim(), children: [] });
        continue;
      }
    }

    // 3. Standalone legacy <!-- ai:generated ... --> ... <!-- /ai:generated -->
    if (header && /^<!--\s*ai:generated\b/.test(header)) {
      let end = index + 1;
      while (end < tree.children.length && !/^<!--\s*\/ai:generated\s*-->$/.test(comment(tree.children[end])?.trim() || '')) end++;
      if (end < tree.children.length) {
        const id = attribute(header, 'id') || '';
        const kind = attribute(header, 'kind') || 'text';
        const promptB64 = attribute(header, 'prompt-b64');
        const prompt = promptB64 ? decodeB64(promptB64) : '';
        const genAttrs = header.replace(/^<!--\s*ai:generated\b/, '').replace(/\s*-->$/, '').replace(/(?:^|\s)(?:id|kind|prompt-b64)=(?:"[^"]*"|'[^']*'|[^\s>]+)/g, '');
        const unifiedHeader = `<!-- ai:task id="${id}" kind="${kind}" prompt="${encode(prompt)}"${genAttrs} -->`;
        grouped.push({ type: 'manualAiTask', header: unifiedHeader.trim(), children: tree.children.slice(index + 1, end) });
        index = end;
        continue;
      }
    }

    groupTasks(node);
    grouped.push(node);
  }
  tree.children = grouped;
}
const remarkAiTask = $remark('manualAiTask', () => () => (tree: MarkdownNode) => groupTasks(tree as Ast));
const aiTaskNode = $node('manual_ai_task', () => ({
  group: 'block', content: 'block+', defining: true, isolating: true,
  attrs: { header: { default: '', validate: 'string' } },
  parseDOM: [{ tag: 'section[data-ai-task-header]', contentElement: '.milkdown-ai-task-body', getAttrs: dom => ({ header: (dom as HTMLElement).dataset.aiTaskHeader || '' }) }],
  toDOM: node => ['section', { 'data-ai-task-header': node.attrs.header, class: 'milkdown-ai-task' }, ['div', { class: 'milkdown-ai-task-body' }, 0]],
  parseMarkdown: {
    match: node => node.type === 'manualAiTask',
    runner: (state, node, type) => {
      const task = node as Ast;
      state.openNode(type, { header: task.header });
      state.next(task.children?.length ? task.children : [{ type: 'paragraph', children: [] }]);
      state.closeNode();
    },
  },
  toMarkdown: {
    match: node => node.type.name === 'manual_ai_task',
    runner: (state, node) => {
      state.addNode('html', undefined, node.attrs.header);
      if (!(node.childCount === 1 && node.firstChild?.type.name === 'paragraph' && !node.firstChild.content.size)) state.next(node.content);
      state.addNode('html', undefined, '<!-- /ai:task -->');
    },
  },
}));
const aiTaskView = $view(aiTaskNode, () => (initialNode, view, getPos) => {
  let node = initialNode;
  const dom = document.createElement('section'); dom.className = 'milkdown-ai-task';
  const header = document.createElement('div'); header.className = 'milkdown-ai-task-header'; header.contentEditable = 'false';
  const summary = document.createElement('div'); summary.className = 'milkdown-ai-task-summary';
  const name = document.createElement('strong');
  const id = document.createElement('code');
  const regenerateBtn = document.createElement('button'); regenerateBtn.type = 'button'; regenerateBtn.className = 'milkdown-ai-task-regenerate';
  const confirmBtn = document.createElement('button'); confirmBtn.type = 'button'; confirmBtn.className = 'milkdown-ai-task-confirm';
  const deleteBtn = document.createElement('button'); deleteBtn.type = 'button'; deleteBtn.className = 'milkdown-ai-task-delete';
  const status = document.createElement('span'); status.className = 'milkdown-ai-task-status';
  summary.append(name, id, regenerateBtn, confirmBtn, deleteBtn, status);
  const label = document.createElement('label'); label.className = 'milkdown-ai-task-prompt-label'; label.append('AIへの指示');
  const prompt = document.createElement('textarea'); prompt.className = 'milkdown-ai-task-prompt'; prompt.rows = 2; prompt.placeholder = '生成する内容を指示してください';
  label.append(prompt); header.append(summary, label);
  const bodyLabel = document.createElement('div'); bodyLabel.className = 'milkdown-ai-task-body-label'; bodyLabel.contentEditable = 'false'; bodyLabel.textContent = '本文';
  const contentDOM = document.createElement('div'); contentDOM.className = 'milkdown-ai-task-body';
  dom.append(header, bodyLabel, contentDOM);
  const resize = () => { prompt.style.height = 'auto'; prompt.style.height = `${Math.max(58, prompt.scrollHeight)}px`; };
  const refresh = () => {
    const rawHeader = String(node.attrs.header);
    dom.dataset.aiTaskHeader = rawHeader;
    const kind = attribute(rawHeader, 'kind') || 'text';
    name.textContent = kind === 'screenshot' ? 'AI撮影' : kind === 'diagram' ? 'AI図' : 'AI文章';
    id.textContent = attribute(rawHeader, 'id') || '';
    prompt.setAttribute('aria-label', `AIへの指示 ${id.textContent}`);
    const nextPrompt = decode(attribute(rawHeader, 'prompt') || '');
    if (prompt.value !== nextPrompt) prompt.value = nextPrompt;
    prompt.readOnly = !view.editable;
    const approved = attribute(rawHeader, 'approved-at') !== undefined;
    const empty = node.childCount === 1 && node.firstChild?.type.name === 'paragraph' && !node.firstChild.content.size;
    status.textContent = approved ? '確定済み' : empty ? '未生成' : '生成済み';
    confirmBtn.textContent = approved ? '確定解除' : '確定';
    confirmBtn.className = `milkdown-ai-task-confirm${approved ? ' button-approved is-approved' : ''}`;
    confirmBtn.disabled = !view.editable || Boolean(empty && !approved);
    confirmBtn.title = approved ? '確定を解除します' : empty ? '生成結果がある場合に確定できます' : '生成結果を確定します';

    regenerateBtn.textContent = empty ? '生成' : '再生成';
    regenerateBtn.disabled = !view.editable || approved;
    regenerateBtn.title = approved ? '確定を解除すると再生成できます' : empty ? 'AIで生成します' : 'AIで再生成します';

    deleteBtn.textContent = '削除';
    deleteBtn.disabled = !view.editable;
    deleteBtn.title = 'このAIタグを削除します（Undoで戻せます）';

    dom.classList.toggle('is-approved', approved); dom.classList.toggle('is-empty', Boolean(empty));
    resize();
  };
  const editPrompt = () => {
    if (!view.editable) return;
    const position = getPos();
    if (position === undefined) return;
    const nextHeader = setPrompt(String(node.attrs.header), prompt.value);
    if (nextHeader !== node.attrs.header) view.dispatch(view.state.tr.setNodeMarkup(position, undefined, { ...node.attrs, header: nextHeader }));
    resize();
  };
  regenerateBtn.addEventListener('click', event => {
    event.preventDefault();
    if (!view.editable) return;
    const rawHeader = String(node.attrs.header);
    const approved = attribute(rawHeader, 'approved-at') !== undefined;
    if (approved) return;
    const taskId = attribute(rawHeader, 'id') || '';
    const taskKind = attribute(rawHeader, 'kind') || 'text';
    if (!taskId) return;
    window.dispatchEvent(new CustomEvent('manual-studio-regenerate-task', {
      detail: { id: taskId, kind: taskKind }
    }));
  });
  confirmBtn.addEventListener('click', event => {
    event.preventDefault();
    if (!view.editable) return;
    const position = getPos();
    if (position === undefined) return;
    const rawHeader = String(node.attrs.header);
    const approved = attribute(rawHeader, 'approved-at') !== undefined;
    const empty = node.childCount === 1 && node.firstChild?.type.name === 'paragraph' && !node.firstChild.content.size;
    if (empty && !approved) return;
    const nextHeader = toggleApproval(rawHeader);
    if (nextHeader !== node.attrs.header) {
      view.dispatch(closeHistory(view.state.tr).setNodeMarkup(position, undefined, { ...node.attrs, header: nextHeader }));
    }
  });
  deleteBtn.addEventListener('click', event => {
    event.preventDefault();
    if (!view.editable) return;
    const position = getPos();
    if (position === undefined) return;
    const rawHeader = String(node.attrs.header);
    const taskId = attribute(rawHeader, 'id') || 'AIタグ';
    view.dispatch(closeHistory(view.state.tr).delete(position, position + node.nodeSize));
    window.dispatchEvent(new CustomEvent('manual-studio-status', {
      detail: { message: `AIタグ「${taskId}」を削除しました。Undo で戻せます。` }
    }));
  });
  prompt.addEventListener('input', event => { if (!(event as InputEvent).isComposing) editPrompt(); });
  prompt.addEventListener('compositionend', editPrompt);
  prompt.addEventListener('focus', () => { if (view.editable) view.dispatch(closeHistory(view.state.tr)); });
  prompt.addEventListener('blur', () => { if (view.editable) view.dispatch(closeHistory(view.state.tr)); });
  prompt.addEventListener('keydown', event => {
    if (!view.editable || event.isComposing || !(event.ctrlKey || event.metaKey) || !['z', 'y'].includes(event.key.toLowerCase())) return;
    event.preventDefault();
    (event.key.toLowerCase() === 'y' || event.shiftKey ? redo : undo)(view.state, view.dispatch);
  });
  window.addEventListener('manual-studio-editor-font-size-change', resize);
  refresh();
  const observer = new MutationObserver(refresh);
  observer.observe(view.dom, { attributes: true, attributeFilter: ['contenteditable'] });
  return {
    dom, contentDOM,
    update(next) { if (next.type !== node.type) return false; node = next; refresh(); return true; },
    stopEvent: event => header.contains(event.target as globalThis.Node),
    ignoreMutation: mutation => mutation.type !== 'selection' && (mutation.target === dom || header.contains(mutation.target) || bodyLabel.contains(mutation.target)),
    destroy: () => { observer.disconnect(); window.removeEventListener('manual-studio-editor-font-size-change', resize); },
  };
});
export const aiTaskBlockPlugins = [...remarkAiTask, aiTaskNode, aiTaskView];
