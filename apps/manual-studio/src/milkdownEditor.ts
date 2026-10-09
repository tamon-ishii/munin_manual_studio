import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorState } from '@milkdown/kit/prose/state';
import { uiIcon } from './uiIcons';
import { aiTaskBlockPlugins } from './milkdownAiTaskBlock';
import { aiTagItems, createAiTagsPlugin, type AiTaskKind } from './milkdownAiTags';
import { LanguageDescription, LanguageSupport, StreamLanguage } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import type { Ctx } from '@milkdown/kit/ctx';
import { Crepe } from '@milkdown/crepe';
import { imageBlockSchema } from '@milkdown/kit/component/image-block';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';
import { type Editor, editorViewCtx, editorViewOptionsCtx, serializerCtx } from '@milkdown/kit/core';
import { imageSchema, clearTextInCurrentBlockCommand } from '@milkdown/kit/preset/commonmark';
import { undo, redo } from '@milkdown/kit/prose/history';
import { Plugin } from '@milkdown/kit/prose/state';
import { $prose, replaceAll, callCommand, insert } from '@milkdown/kit/utils';
let mermaidModule: Promise<typeof import('mermaid')['default']> | undefined;
function loadMermaid() {
  return mermaidModule ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true });
    return mermaid;
  });
}
let diagramId = 0;
export async function renderMermaid(target: HTMLElement, code: string): Promise<void> {
  const version = String(++diagramId);
  target.dataset.renderVersion = version;
  try {
    const mermaid = await loadMermaid();
    const { svg } = await mermaid.render(`manual-mermaid-${version}`, code);
    if (target.dataset.renderVersion === version) { target.innerHTML = svg; target.classList.remove('diagram-error'); }
  } catch (error) {
    if (target.dataset.renderVersion === version) { target.textContent = `Mermaid: ${String(error)}`; target.classList.add('diagram-error'); }
  }
}

export function setupMilkdownEditor(source: HTMLTextAreaElement, report: (message: string) => void, resolveImage: (source: string) => Promise<string> = async source => source, uploadImage?: (file: File) => Promise<string>, requestAiTask?: (kind: AiTaskKind) => void) {
  const host = document.createElement('div');
  host.id = 'milkdown-editor';
  source.before(host);
  const toggle = document.createElement('button');
  toggle.type = 'button'; toggle.textContent = 'Markdownソース';
  source.parentElement!.querySelector('.column-label')!.append(toggle);
  let instance: Editor | undefined;
  let crepe: Crepe | undefined;
  const sourceToolbar = source.closest('#panel-editor')?.querySelector<HTMLElement>('.formatting-toolbar');
  if (sourceToolbar) sourceToolbar.hidden = true;
  const sourceAiToolbar = source.closest('#panel-editor')?.querySelector<HTMLElement>('.instruction-toolbar');
  if (sourceAiToolbar) sourceAiToolbar.hidden = true;
  let syncing = false;
  let sourceMode = false;
  let ready = false;
  let imageRefreshVersion = 0;
  let readonly = source.disabled || source.readOnly;
  const valueProperty = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!;
  const sourceValue = () => valueProperty.get!.call(source) as string;
  function refresh() {
    ++imageRefreshVersion;
    if (!ready || !instance || syncing) return;
    syncing = true;
    try { instance.action(replaceAll(sourceValue(), true)); } finally { syncing = false; }
  }
  Object.defineProperty(source, 'value', {
    get: sourceValue,
    set(value: string) { valueProperty.set!.call(source, value); refresh(); },
  });
  async function refreshImages(): Promise<void> {
    if (!ready || !instance) return;
    const version = ++imageRefreshVersion;
    const images = instance.action(ctx => {
      const view = ctx.get(editorViewCtx);
      const images: Array<{ image: HTMLImageElement; source: string }> = [];
      view.state.doc.descendants((node, position) => {
        if (!['image', 'image-block'].includes(node.type.name) || !node.attrs.src) return;
        const dom = view.nodeDOM(position);
        const image = dom instanceof HTMLImageElement ? dom : dom instanceof HTMLElement ? dom.querySelector<HTMLImageElement>('img') : null;
        if (image) images.push({ image, source: String(node.attrs.src) });
      });
      return images;
    });
    await Promise.all(images.map(async ({ image, source: imageSource }) => {
      try {
        const resolved = await resolveImage(imageSource);
        if (version !== imageRefreshVersion || !image.isConnected) return;
        image.src = resolved;
      } catch (error) { if (version === imageRefreshVersion) report(`画像の更新に失敗しました: ${String(error)}`); }
    }));
  }
  function showSource() {
    sourceMode = true; host.hidden = true; source.hidden = false;
    if (sourceToolbar) sourceToolbar.hidden = false;
    if (sourceAiToolbar) sourceAiToolbar.hidden = false;
    toggle.textContent = 'Milkdown編集'; toggle.setAttribute('aria-pressed', 'true');
    source.dispatchEvent(new Event('editor-mode-change'));
  }
  toggle.addEventListener('click', () => {
    if (!sourceMode) { showSource(); source.focus(); }
    else { refresh(); if (sourceToolbar) sourceToolbar.hidden = true; if (sourceAiToolbar) sourceAiToolbar.hidden = true; sourceMode = false; host.hidden = false; source.hidden = true; toggle.textContent = 'Markdownソース'; toggle.setAttribute('aria-pressed', 'false'); instance?.action(ctx => ctx.get(editorViewCtx).focus()); source.dispatchEvent(new Event('editor-mode-change')); }
  });
  source.addEventListener('input', () => { if (!syncing) refresh(); });
  function updateReadonly() {
    if (!ready || !crepe || !instance) return;
    const next = source.disabled || source.readOnly;
    crepe.setReadonly(next);
    if (readonly && !next) {
      // Crepe's top bar drops its reactive state subscription while readonly.
      // Recreate plugin views when editing resumes; plugin history state is retained.
      instance.action(ctx => { const view = ctx.get(editorViewCtx); view.updateState(view.state.reconfigure({ plugins: [...view.state.plugins] })); });
    }
    readonly = next;
  }
  const observer = new MutationObserver(updateReadonly);
  observer.observe(source, { attributes: true, attributeFilter: ['disabled', 'readonly'] });
  const bridge = $prose(ctx => new Plugin({
    view: () => ({ update(view, previous) {
      if (syncing) return;
      const changed = !view.state.doc.eq(previous.doc);
      if (changed) {
        const doc = view.state.doc;
        const last = doc.lastChild;
        const serializable = doc.childCount > 1 && last?.type.name === 'paragraph' && !last.content.size
          ? doc.copy(doc.content.cut(0, doc.content.size - last.nodeSize)) : doc;
        valueProperty.set!.call(source, ctx.get(serializerCtx)(serializable));
      }
      if (changed || !view.state.selection.eq(previous.selection)) {
        let offset = 0;
        let start = 0;
        let end = 0;
        const markdown = sourceValue();
        view.state.doc.descendants((node, position) => {
          const text = node.isText ? node.text! : node.type.name === 'html' ? String(node.attrs.value) : '';
          if (!text) return;
          const found = markdown.indexOf(text, offset);
          if (found < 0) return;
          const selection = view.state.selection;
          if (selection.from >= position && selection.from <= position + node.nodeSize) start = found + Math.min(selection.from - position, text.length);
          if (selection.to >= position && selection.to <= position + node.nodeSize) end = found + Math.min(selection.to - position, text.length);
          offset = found + text.length;
        });
        source.setSelectionRange(start, Math.max(start, end));
      }
      if (!changed) return;
      syncing = true;
      try {
        source.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      } finally { syncing = false; }
    } }),
  }));
  const aiTags = createAiTagsPlugin(requestAiTask);
  const icon = (label: string) => `<span>${label}</span>`;
  const mermaidSource = '```mermaid\ngraph TD\n    A[開始] --> B[完了]\n```';
  const topBarLabels: string[] = [];
  const labels: Record<string, string> = { bold: '太字', italic: '斜体', strikethrough: '取り消し線', code: 'インラインコード', link: 'リンク', image: '画像', table: '表', 'code-block': 'コードブロック', math: '数式', quote: '引用', hr: '区切り線', 'bullet-list': '箇条書き', 'ordered-list': '番号付きリスト', 'task-list': 'タスクリスト', undo: '元に戻す', redo: 'やり直す', mermaid: 'Mermaidの図を挿入' };
  const toolbarObserver = new MutationObserver(() => {
    host.querySelectorAll<HTMLButtonElement>('.milkdown-top-bar .top-bar-item').forEach((button, index) => {
      const label = topBarLabels[index];
      if (label) { button.setAttribute('aria-label', label); button.title = label; }
    });
  });
  toolbarObserver.observe(host, { childList: true, subtree: true });
  crepe = new Crepe({
    root: host,
    defaultValue: sourceValue(),
    features: { [Crepe.Feature.TopBar]: true },
    featureConfigs: {
      [Crepe.Feature.TopBar]: {
        headingOptions: [{ label: '本文', level: null }, ...Array.from({ length: 6 }, (_, index) => ({ label: `見出し${index + 1}`, level: index + 1 }))],
        buildTopBar: builder => {
          builder.addGroup('history', '履歴')
            .addItem('undo', { icon: uiIcon('undo'), active: () => false, onRun: (ctx: Ctx) => { const view = ctx.get(editorViewCtx); undo(view.state, view.dispatch); } })
            .addItem('redo', { icon: uiIcon('redo'), active: () => false, onRun: (ctx: Ctx) => { const view = ctx.get(editorViewCtx); redo(view.state, view.dispatch); } });
          builder.getGroup('block').addItem('mermaid', { icon: icon('Mermaid'), active: () => false, onRun: (ctx: Ctx) => insert(mermaidSource)(ctx) });
          if (requestAiTask) builder.addGroup('ai-tags', 'AIタグ').addItem('ai-tags', {
            icon: '', active: () => false,
            selector: { activeLabel: () => 'AIタグを追加', options: aiTagItems.map(item => ({ label: item.label, onSelect: ctx => { callCommand(aiTags.requestAiTag.key, item.kind)(ctx); } })) },
          });
          const advancedKeys = new Set(['strikethrough', 'code', 'code-block', 'math', 'quote', 'hr', 'task-list', 'mermaid']);
          const advanced = builder.build().flatMap(group => group.items).filter(item => advancedKeys.has(item.key) && item.onRun);
          for (const group of builder.build()) group.items = group.items.filter(item => !advancedKeys.has(item.key));
          builder.addGroup('insert', '挿入').addItem('insert', {
            icon: '', active: () => false,
            selector: { activeLabel: () => '挿入・その他', options: advanced.map(item => ({ label: labels[item.key] || item.key, onSelect: ctx => item.onRun!(ctx) })) },
          });
          const groups = builder.build();
          for (let index = groups.length - 1; index >= 0; index--) {
            if (!groups[index].items.length) groups.splice(index, 1);
          }
          topBarLabels.splice(0, topBarLabels.length, ...builder.build().flatMap(group => group.items.filter(item => item.onRun).map(item => labels[item.key] || item.key)));
        },
      },
      [Crepe.Feature.Toolbar]: { boldLabel: '太字', italicLabel: '斜体', codeLabel: 'インラインコード', linkLabel: 'リンク', strikethroughLabel: '取り消し線', latexLabel: '数式' },
      [Crepe.Feature.Placeholder]: { text: 'ここにマニュアルを書きます。' },
      [Crepe.Feature.ImageBlock]: { proxyDomURL: resolveImage, onUpload: uploadImage, inlineUploadButton: '画像を選ぶ', blockUploadButton: '画像を選ぶ', blockConfirmButton: '挿入', blockCaptionPlaceholderText: '画像の説明', inlineUploadPlaceholderText: '画像のURL', blockUploadPlaceholderText: '画像のURL' },
      [Crepe.Feature.CodeMirror]: {
        languages: [...languages, LanguageDescription.of({ name: 'mermaid', alias: ['mermaid'], load: async () => new LanguageSupport(StreamLanguage.define({ token(stream) { if (stream.match(/^%%.*/)) return 'comment'; if (stream.match(/^(?:graph|flowchart|sequenceDiagram|classDiagram|subgraph|end)\b/)) return 'keyword'; stream.next(); return null; } })) })],
        searchPlaceholder: 'コードの言語を検索', noResultText: '該当する言語がありません', copyText: 'コピー', previewLabel: '図のプレビュー', previewLoading: '描画中…', previewOnlyByDefault: false,
        renderPreview: (language, content, applyPreview) => {
          if (language !== 'mermaid') { applyPreview(null); return null; }
          const preview = document.createElement('div'); preview.className = 'mermaid-preview';
          void renderMermaid(preview, content).then(() => applyPreview(preview));
        },
      },
      [Crepe.Feature.BlockEdit]: {
        textGroup: { label: '文章', text: { label: '本文' }, h1: { label: '見出し1' }, h2: { label: '見出し2' }, h3: { label: '見出し3' }, h4: { label: '見出し4' }, h5: { label: '見出し5' }, h6: { label: '見出し6' }, quote: { label: '引用' }, divider: { label: '区切り線' } },
        listGroup: { label: 'リスト', bulletList: { label: '箇条書き' }, orderedList: { label: '番号付きリスト' }, taskList: { label: 'タスクリスト' } },
        advancedGroup: { label: '挿入', image: { label: '画像' }, codeBlock: { label: 'コードブロック' }, table: { label: '表' }, math: { label: '数式' } },
        buildMenu: builder => {
          builder.addGroup('diagrams', '図').addItem('mermaid', { label: 'Mermaid', icon: icon('◇'), onRun: (ctx: Ctx) => { callCommand(clearTextInCurrentBlockCommand.key)(ctx); insert(mermaidSource)(ctx); } });
          if (requestAiTask) {
            const group = builder.addGroup('ai-tags', 'AIタグ');
            for (const item of aiTagItems) group.addItem(`ai-${item.kind}`, { label: item.label, icon: item.icon, onRun: (ctx: Ctx) => {
              callCommand(clearTextInCurrentBlockCommand.key)(ctx);
              callCommand(aiTags.requestAiTag.key, item.kind)(ctx);
            } });
          }
        },
      },
    },
  });
  crepe.editor.config(ctx => {
    // Remark uses null for absent image titles; the preset's string validator rejects it.
    ctx.update(imageSchema.key, previous => ctx => {
      const schema = previous(ctx);
      return { ...schema, parseMarkdown: { ...schema.parseMarkdown, runner: (state, node, type) => {
        state.addNode(type, { src: String(node.url ?? ''), alt: String(node.alt ?? ''), title: String(node.title ?? '') });
      } } };
    });
    ctx.update(editorViewOptionsCtx, previous => ({ ...previous, editable: () => !source.disabled && !source.readOnly, attributes: { role: 'textbox', 'aria-label': 'Markdown原稿', 'aria-multiline': 'true' } }));
    ctx.update(imageBlockSchema.key, previous => ctx => {
      const schema = previous(ctx);
      return { ...schema, attrs: { ...schema.attrs, alt: { default: '', validate: 'string' } },
        parseMarkdown: { ...schema.parseMarkdown, runner: (state, node, type) => {
          state.addNode(type, { src: String(node.url ?? ''), caption: String(node.title ?? ''), alt: String(node.alt ?? ''), ratio: 1 });
        } },
        toMarkdown: { ...schema.toMarkdown, runner: (state, node) => {
          state.openNode('paragraph');
          state.addNode('image', undefined, undefined, { url: node.attrs.src, alt: node.attrs.alt, title: node.attrs.caption });
          state.closeNode();
        } },
      };
    });
  }).use(aiTaskBlockPlugins).use(bridge).use(aiTags.plugins);
  void crepe.create().then(editor => {
    instance = editor; ready = true; refresh(); updateReadonly();
    if (!sourceMode) source.hidden = true;
    source.dispatchEvent(new Event('editor-mode-change'));
  }).catch(error => { showSource(); toggle.disabled = true; report(`Milkdownの起動に失敗しました: ${String(error)}`); });
  function stepHistory(direction: number): boolean {
    if (sourceMode || !instance || !ready) return false;
    instance.action(ctx => { const view = ctx.get(editorViewCtx); (direction < 0 ? undo : redo)(view.state, view.dispatch); view.focus(); });
    return true;
  }
  return { showSource, refresh, refreshImages, host, stepHistory,
    focus: () => { if (sourceMode) source.focus(); else instance?.action(ctx=>ctx.get(editorViewCtx).focus()); },
    captureState: () => ready && instance ? instance.action(ctx => ctx.get(editorViewCtx).state) : null,
    restoreState: (state: EditorState) => { if (ready && instance && state) instance.action(ctx => ctx.get(editorViewCtx).updateState(state)); },
    get isRichEditing() { return ready && !sourceMode; },
    captureAiTagInsertion: (): ((markdown: string) => boolean) | undefined => {
      if (sourceMode || !ready || !instance) return undefined;
      const editor = instance;
      const { bookmark, document } = editor.action(ctx => {
        const state = ctx.get(editorViewCtx).state;
        return { bookmark: state.selection.getBookmark(), document: state.doc };
      });
      return markdown => editor.action(ctx => {
        const view = ctx.get(editorViewCtx);
        if (!view.state.doc.eq(document)) throw new Error('撮影中に原稿が変更されました。撮影タグを追加する位置を選び直してください。');
        view.dispatch(view.state.tr.setSelection(bookmark.resolve(view.state.doc)));
        // Programmatic capture completion also runs while the UI is readonly.
        insert(markdown)(ctx);
        view.focus();
        return true;
      });
    },
    selectInsertionHeading: (index: number|null): void => {
      if (!ready || !instance || sourceMode) return;
      instance.action(ctx=>{ const view=ctx.get(editorViewCtx);let found=-1,count=0;view.state.doc.descendants((node,pos)=>{if(node.type.name==='heading' && count++===index)found=pos+node.nodeSize;});const selection=found>=0?TextSelection.near(view.state.doc.resolve(found)):TextSelection.atEnd(view.state.doc);view.dispatch(view.state.tr.setSelection(selection)); });
    },
    insertMarkdownAt: (markdown: string, left: number, top: number): void => {
      if (!ready || !instance) return;
      instance.action(ctx => { const view=ctx.get(editorViewCtx); const point=view.posAtCoords({left,top}); if(point) view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(point.pos)))); insert(markdown)(ctx); view.focus(); });
    },
    insertMarkdown: (markdown: string): boolean => {
      if (sourceMode || !ready || !instance) return false;
      instance.action(ctx => { insert(markdown)(ctx); ctx.get(editorViewCtx).focus(); });
      return true;
    },
    insertAiTag: (markdown: string): boolean => {
      if (sourceMode || !ready || !instance) return false;
      return instance.action(callCommand(aiTags.insertAiTag.key, markdown));
    },
    historyState: () => sourceMode || !instance || !ready ? null : instance.action(ctx => {
      const state = ctx.get(editorViewCtx).state;
      return { canUndo: undo(state), canRedo: redo(state) };
    }),
  };
}
