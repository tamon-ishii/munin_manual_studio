import {gfmAlerts,configureGfmAlerts,alertKinds,alertMarkdown} from './gfmEditor';
import type {ShortcutCommand} from './keyboardShortcuts';
import {currentLine} from './editorLineCommands';
import {sinkListItem,liftListItem} from '@milkdown/kit/prose/schema-list';
import {lift} from '@milkdown/kit/prose/commands';
import {documentImages,parseFigure,renderFigure,type DocumentImage,type ImagePresentation} from './imagePresentation';
import { Slice } from '@milkdown/kit/prose/model';
import { TextSelection } from '@milkdown/kit/prose/state';
import { uploadConfig, uploadPlugin } from '@milkdown/kit/plugin/upload';
import type { EditorState } from '@milkdown/kit/prose/state';
import { uiIcon } from './uiIcons';
import { LanguageDescription, LanguageSupport, StreamLanguage } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import type { Ctx } from '@milkdown/kit/ctx';
import { Crepe } from '@milkdown/crepe';
import { imageBlockSchema } from '@milkdown/kit/component/image-block';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';
import { type Editor, editorViewCtx, editorViewOptionsCtx, serializerCtx, parserCtx } from '@milkdown/kit/core';
import { imageSchema, clearTextInCurrentBlockCommand } from '@milkdown/kit/preset/commonmark';
import { undo, redo, closeHistory } from '@milkdown/kit/prose/history';
import { Plugin } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import { $prose, $remark, replaceAll, callCommand, insert } from '@milkdown/kit/utils';
type ImageAstNode={type:string;value?:string;children?:ImageAstNode[];muninPresentation?:ImagePresentation};
const imagePresentationPlugin=$remark('munin-image-presentation',()=>()=>function transform(node:ImageAstNode){
  if(node.type==='html'){const figure=parseFigure(node.value||'');if(figure){Object.assign(node,{type:'image-block',url:figure.src,alt:figure.alt,title:figure.caption,muninPresentation:figure});return;}}
  node.children?.forEach(transform);
  if(node.type==='paragraph'&&node.children?.length===1&&node.children[0].muninPresentation){const image=node.children[0];delete node.children;Object.assign(node,image);}
});
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

export function setupMilkdownEditor(
  source: HTMLTextAreaElement,
  report: (message: string) => void,
  resolveImage: (source: string) => Promise<string> = async source => source,
  uploadImage?: (file: File) => Promise<string>,
  _requestAiTask?: undefined,
  onEditImage?: (source: string, img: HTMLImageElement) => void,
  onImageSettings?: (img: HTMLImageElement) => void,
  onRecaptureImage?: (source: string, img: HTMLImageElement) => void
) {
  const host = document.createElement('div');
  host.id = 'milkdown-editor';
  host.style.position = 'relative';
  source.before(host);
  const toggle = document.createElement('button');
  toggle.type = 'button'; toggle.textContent = 'Markdownソース';
  toggle.id = 'editor-mode-toggle';
  const modeControls = source.closest('#panel-editor')?.querySelector('.editor-mode-controls') || source.parentElement!;
  modeControls.append(toggle);
  const pendingUploads: Array<{ cancelled: boolean }> = [];
  function cancelLatestUpload(): boolean {
    const pending = [...pendingUploads].reverse().find(upload => !upload.cancelled);
    if (!pending) return false;
    pending.cancelled = true;
    return true;
  }
  function undoOrCancel(ctx: Ctx): boolean {
    const view = ctx.get(editorViewCtx);
    if (pendingUploads.length === 1 && !/!\[\]\(\)/.test(sourceValue()) && cancelLatestUpload()) return true;
    if (undo(view.state)) return undo(view.state, view.dispatch);
    return cancelLatestUpload();
  }
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

  const overlay = document.createElement('div');
  overlay.className = 'milkdown-image-action-overlay';
  overlay.style.display = 'none';
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'milkdown-image-edit-btn';
  editBtn.textContent = '🎨 画像の編集';
  editBtn.title = 'MarkItsで画像に注釈やトリミングを加えて編集します';
  overlay.appendChild(editBtn);
  if(onRecaptureImage){
    const recaptureBtn=document.createElement('button');recaptureBtn.type='button';recaptureBtn.className='milkdown-image-recapture-btn';recaptureBtn.textContent='再撮影';recaptureBtn.title='保存済みの撮影手順でこの画像を再撮影します';
    recaptureBtn.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();if(activeImg&&activeSource)onRecaptureImage(activeSource,activeImg);});overlay.append(recaptureBtn);
  }
  const settingsBtn=document.createElement('button');settingsBtn.type='button';settingsBtn.textContent='画像の表示設定';settingsBtn.onclick=()=>{if(activeImg)onImageSettings?.(activeImg);};if(onImageSettings)overlay.append(settingsBtn);
  host.appendChild(overlay);

  let activeImg: HTMLImageElement | null = null;
  let activeSource = '';
  let hideTimer: number | null = null;

  function hideOverlay() {
    overlay.style.display = 'none';
    activeImg = null;
    activeSource = '';
  }

  function cancelHide() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function scheduleHide() {
    cancelHide();
    hideTimer = window.setTimeout(() => {
      hideOverlay();
    }, 250);
  }

  function getOriginalSrc(img: HTMLImageElement): string | null {
    let foundSrc: string | null = null;
    if (instance) {
      instance.action(ctx => {
        const view = ctx.get(editorViewCtx);
        view.state.doc.descendants((node, position) => {
          if (foundSrc) return;
          if (!['image', 'image-block'].includes(node.type.name) || !node.attrs.src) return;
          const dom = view.nodeDOM(position);
          if (dom === img || (dom instanceof HTMLElement && dom.contains(img))) {
            foundSrc = String(node.attrs.src);
          }
        });
      });
    }
    if (foundSrc) {
      img.dataset.originalSrc = foundSrc;
      return foundSrc;
    }
    if(img.dataset.originalSrc)return img.dataset.originalSrc;
    const rawSrc = img.getAttribute('src');
    if (rawSrc && !rawSrc.startsWith('data:')) {
      img.dataset.originalSrc = rawSrc;
      return rawSrc;
    }
    return null;
  }

  function updateOverlayPosition() {
    if (!activeImg || !activeImg.isConnected) {
      hideOverlay();
      return;
    }
    const imgRect = activeImg.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const viewport = host.querySelector<HTMLElement>('.ProseMirror')?.getBoundingClientRect() || hostRect;
    if (imgRect.bottom <= viewport.top || imgRect.top >= viewport.bottom) {
      hideOverlay();
      return;
    }
    const top = imgRect.top - hostRect.top + host.scrollTop + 8;
    const right = hostRect.right - imgRect.right - host.scrollLeft + 8;
    overlay.style.top = `${Math.max(0, top)}px`;
    overlay.style.right = `${Math.max(0, right)}px`;
    overlay.style.left = 'auto';
    overlay.style.display = 'flex';
  }

  function handleImageHover(img: HTMLImageElement) {
    if ((!onEditImage&&!onImageSettings&&!onRecaptureImage) || readonly) return;
    cancelHide();
    activeImg = img;
    activeSource = getOriginalSrc(img) || '';
    if (!activeSource || activeSource.startsWith('data:')) return;
    updateOverlayPosition();
  }

  overlay.addEventListener('mouseenter', cancelHide);
  overlay.addEventListener('mouseleave', scheduleHide);
  editBtn.addEventListener('click', e => {
    e.stopPropagation();
    e.preventDefault();
    if (activeImg && activeSource && onEditImage) {
      onEditImage(activeSource, activeImg);
    }
  });

  host.addEventListener('mouseover', e => {
    const target = e.target;
    if (target instanceof HTMLImageElement) {
      handleImageHover(target);
    }
  });

  host.addEventListener('mouseout', e => {
    const target = e.target;
    if (target instanceof HTMLImageElement) {
      const related = e.relatedTarget as Node | null;
      if (related && (overlay.contains(related) || target.contains(related))) {
        return;
      }
      scheduleHide();
    }
  });

  host.addEventListener('scroll', () => {
    if (activeImg) updateOverlayPosition();
  }, { passive: true, capture: true });
  window.addEventListener('resize', () => {
    if (activeImg) updateOverlayPosition();
  }, { passive: true });

  let richOwner: string | null = null;
  let richSource: string | null = null;
  function refresh(force = false) {
    hideOverlay();
    ++imageRefreshVersion;
    if (!ready || !instance || syncing || (sourceMode && !force)) return;
    syncing = true;
    try { instance.action(ctx=>{
      const owner=source.dataset.owner||'';
      if(owner===richOwner&&sourceValue()===richSource)return;
      const view=ctx.get(editorViewCtx),parsed=ctx.get(parserCtx)(sourceValue());
      const trimEnd=(doc:typeof view.state.doc)=>{while(doc.childCount>1&&doc.lastChild?.type.name==='paragraph'&&!doc.lastChild.content.size)doc=doc.copy(doc.content.cut(0,doc.content.size-doc.lastChild.nodeSize));return doc;};
      if(owner===richOwner&&parsed&&trimEnd(view.state.doc).eq(trimEnd(parsed)))return;
      view.dispatch(closeHistory(view.state.tr));
      replaceAll(sourceValue(),owner!==richOwner)(ctx);
      view.dispatch(closeHistory(view.state.tr));
      richOwner=owner;richSource=sourceValue();
    }); } finally { syncing = false; }
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
        if (image) {
          image.dataset.originalSrc = String(node.attrs.src);
          if(dom instanceof HTMLElement&&node.type.name==='image-block'){
            const configured=Boolean(node.attrs.presentation);dom.style.width=configured?(node.attrs.displayWidth===null?'fit-content':`${node.attrs.displayWidth}%`):'';
            dom.style.marginLeft=configured&&node.attrs.alignment!=='left'?'auto':'';dom.style.marginRight=configured&&node.attrs.alignment!=='right'?'auto':'';
            if(configured){image.style.width=node.attrs.displayWidth===null?'auto':'100%';image.style.maxWidth='100%';image.style.height='auto';image.addEventListener('load',()=>{image.style.height='auto';},{once:true});}
          }
          images.push({ image, source: String(node.attrs.src) });
        }
      });
      return images;
    });
    await Promise.all(images.map(async ({ image, source: imageSource }) => {
      try {
        const resolved = await resolveImage(imageSource);
        if (version !== imageRefreshVersion || !image.isConnected) return;
        if (image.src === resolved) {
          image.src = '';
        }
        image.src = resolved;
      } catch (error) { if (version === imageRefreshVersion) report(`画像の更新に失敗しました: ${String(error)}`); }
    }));
  }
  function showSource() {
    hideOverlay();
    sourceMode = true; host.hidden = false; host.dataset.sourceMode = 'true'; source.hidden = false;
    toggle.textContent = 'Milkdown編集'; toggle.setAttribute('aria-pressed', 'true');
    source.dispatchEvent(new Event('editor-mode-change'));
  }
  toggle.addEventListener('click', () => {
    if (!sourceMode) { showSource(); source.focus(); }
    else { refresh(true); sourceMode = false; delete host.dataset.sourceMode; host.hidden = false; source.hidden = true; toggle.textContent = 'Markdownソース'; toggle.setAttribute('aria-pressed', 'false'); instance?.action(ctx => ctx.get(editorViewCtx).focus()); source.dispatchEvent(new Event('editor-mode-change')); }
  });
  source.addEventListener('input', () => { if (!syncing) refresh(); });
  // Notify the existing top bar when source selection changes, without parsing
  // partially written Markdown or adding an entry to the rich editor history.
  const refreshSourceToolbar = () => {
    if (sourceMode && ready && instance) instance.action(ctx => {
      const view = ctx.get(editorViewCtx); view.dispatch(view.state.tr.setMeta('addToHistory', false));
    });
  };
  for (const event of ['input', 'select', 'click', 'keyup', 'editor-mode-change']) source.addEventListener(event, refreshSourceToolbar);
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
    props: { decorations(state) {
      const hidden:Decoration[]=[];
      const isReference=(node:typeof state.doc)=>node.type.name==='html'&&/^\s*<!--\s*(?:screenshot:ref\s+id=[a-z0-9-]+|\/screenshot:ref)\s*-->\s*$/.test(String(node.attrs.value));
      state.doc.descendants((node,pos)=>{
        if(node.type.name==='paragraph'&&node.childCount>0){
          let referencesOnly=true;node.forEach(child=>{if(!isReference(child))referencesOnly=false;});
          if(referencesOnly){hidden.push(Decoration.node(pos,pos+node.nodeSize,{class:'screenshot-reference-hidden'}));return false;}
        }
        if(isReference(node))hidden.push(Decoration.node(pos,pos+node.nodeSize,{class:'screenshot-reference-hidden'}));
      });
      return DecorationSet.create(state.doc,hidden);
    } },
    view: () => ({ update(view, previous) {
      // Async rich-editor transactions must not overwrite newer source edits.
      if (syncing || sourceMode) return;
      const changed = !view.state.doc.eq(previous.doc);
      if (changed) {
        const doc = view.state.doc;
        const last = doc.lastChild;
        const serializable = doc.childCount > 1 && last?.type.name === 'paragraph' && !last.content.size
          ? doc.copy(doc.content.cut(0, doc.content.size - last.nodeSize)) : doc;
        valueProperty.set!.call(source, ctx.get(serializerCtx)(serializable));
        richSource=sourceValue();
      }
      if (!sourceMode && (changed || !view.state.selection.eq(previous.selection))) {
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
        // Notify after ProseMirror has committed its selection; the native DOM
        // selectionchange event may arrive before that transaction.
        source.dispatchEvent(new Event("editor-selection-change"));
      }
      if (!changed) return;
      requestAnimationFrame(applyImageStyles);
      syncing = true;
      try {
        source.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      } finally { syncing = false; }
    } }),
  }));
  const icon = (label: string) => `<span>${label}</span>`;
  const mermaidSource = '```mermaid\ngraph TD\n    A[開始] --> B[完了]\n```';
  const topBarControls:Array<{key:string;label:string}>=[];
  const labels: Record<string, string> = { bold: '太字', italic: '斜体', strikethrough: '取り消し線', code: 'インラインコード', link: 'リンク', image: '画像', table: '表', 'code-block': 'コードブロック', math: '数式', quote: '引用', hr: '区切り線', 'bullet-list': '箇条書き', 'ordered-list': '番号付きリスト', 'task-list': 'タスクリスト', undo: '元に戻す', redo: 'やり直す', mermaid: 'Mermaidの図を挿入' };
  function applyImageStyles(){if(!ready||!instance)return;instance.action(ctx=>{const view=ctx.get(editorViewCtx);view.state.doc.descendants((node,pos)=>{
    if(node.type.name!=='image-block')return;const dom=view.nodeDOM(pos);if(!(dom instanceof HTMLElement))return;
    const image=dom.querySelector('img');if(image)image.alt=String(node.attrs.alt||'');
    const configured=Boolean(node.attrs.presentation);dom.dataset.imagePresentation=String(configured);dom.style.width=configured?(node.attrs.displayWidth===null?'fit-content':`${node.attrs.displayWidth}%`):'';
    dom.style.marginLeft=configured&&node.attrs.alignment!=='left'?'auto':'';dom.style.marginRight=configured&&node.attrs.alignment!=='right'?'auto':'';dom.style.textAlign=configured?node.attrs.alignment:'';
  });});}
  function fitToolbarMenus() {
    const bounds = (sourceMode ? source.parentElement! : host).getBoundingClientRect();
    host.querySelectorAll<HTMLElement>('.top-bar-heading-dropdown').forEach(menu => {
      const selector = menu.parentElement!.getBoundingClientRect();
      const below = Math.max(0, bounds.bottom - selector.bottom - 4);
      const above = Math.max(0, selector.top - bounds.top - 4);
      // The editor clips its scrolling contents. Keep even wrapped toolbar
      // menus inside it, and let long menus scroll independently.
      const openAbove = above > below;
      menu.style.top = openAbove ? 'auto' : '100%';
      menu.style.bottom = openAbove ? '100%' : 'auto';
      menu.style.maxHeight = `${openAbove ? above : below}px`;
      menu.style.maxWidth = `${bounds.width}px`;
      menu.style.left = `${Math.min(0, bounds.right - selector.left - menu.offsetWidth)}px`;
    });
  }
  const menuResizeObserver = new ResizeObserver(fitToolbarMenus);
  menuResizeObserver.observe(host);
  host.addEventListener('scroll', fitToolbarMenus, true);
  const toolbarObserver = new MutationObserver(() => {
    fitToolbarMenus();
    applyImageStyles();
    host.querySelectorAll<HTMLButtonElement>('.top-bar-heading-button').forEach(button=>{
      const label=button.querySelector<HTMLElement>('.top-bar-heading-label');
      if(label?.textContent==='注釈'){
        button.setAttribute('aria-label','注釈');button.title='注釈';label.innerHTML=uiIcon('annotation');
      }
    });
    host.querySelectorAll<HTMLElement>('.milkdown-top-bar .top-bar-inner').forEach(bar=>{
      Array.from(bar.children).forEach((node,index)=>{if(node instanceof HTMLElement&&node.dataset.toolbarPosition===undefined)node.dataset.toolbarPosition=String(index);});
      bar.querySelectorAll<HTMLElement>(':scope > .top-bar-item,:scope > .top-bar-heading-selector').forEach((element,index)=>{
        const control=element.dataset.toolbarKey?topBarControls.find(item=>item.key===element.dataset.toolbarKey):topBarControls[index];
        if(!control)return;
        if(element.dataset.toolbarKey!==control.key)element.dataset.toolbarKey=control.key;
        if(element.dataset.toolbarLabel!==control.label)element.dataset.toolbarLabel=control.label;
        if(element.matches('button')){element.setAttribute('aria-label',control.label);element.title=control.label;}
      });
    });
  });
  toolbarObserver.observe(host, { childList: true, subtree: true });
  crepe = new Crepe({
    root: host,
    defaultValue: sourceValue(),
    features: { [Crepe.Feature.TopBar]: true },
    featureConfigs: {
      // A native caret remains visible across focus, readonly and layout
      // transitions without depending on a separately positioned DOM widget.
      [Crepe.Feature.Cursor]: {virtual:false},
      [Crepe.Feature.TopBar]: {
        headingOptions: [{ label: '本文', level: null }, ...Array.from({ length: 6 }, (_, index) => ({ label: `見出し${index + 1}`, level: index + 1 }))],
        buildTopBar: builder => {
          builder.addGroup('history', '履歴')
            .addItem('undo', { icon: uiIcon('undo'), active: () => false, onRun: (ctx: Ctx) => { undoOrCancel(ctx); } })
            .addItem('redo', { icon: uiIcon('redo'), active: () => false, onRun: (ctx: Ctx) => { const view = ctx.get(editorViewCtx); redo(view.state, view.dispatch); } });
          builder.getGroup('block').addItem('mermaid', { icon: uiIcon('diagram'), active: () => false, onRun: (ctx: Ctx) => insert(mermaidSource)(ctx) });
          const advancedKeys = new Set(['strikethrough', 'code', 'code-block', 'math', 'quote', 'hr', 'task-list']);
          const advanced = builder.build().flatMap(group => group.items).filter(item => advancedKeys.has(item.key) && item.onRun);
          for (const group of builder.build()) group.items = group.items.filter(item => !advancedKeys.has(item.key));
          builder.addGroup('extras', 'その他').addItem('insert', {
            icon: '', active: () => false,
            selector: { activeLabel: () => '挿入・その他', options: advanced.map(item => ({ label: labels[item.key] || item.key, onSelect: ctx => item.onRun!(ctx) })) },
          });
          builder.addGroup('gfm-alerts','注釈').addItem('gfm-alert',{icon:'',active:()=>false,selector:{activeLabel:()=> '注釈',options:alertKinds.map(([kind,label])=>({label:`${label} (${kind})`,onSelect:(ctx:Ctx)=>insert(alertMarkdown(kind))(ctx)}))}});
          const groups = builder.build();
          for (let index = groups.length - 1; index >= 0; index--) {
            if (!groups[index].items.length) groups.splice(index, 1);
          }
          // Keep Milkdown's original UI in both modes; route only the operation
          // to the Markdown source when it is being edited.
          const sourceAction = (format: string, extra: Record<string, unknown> = {}) => {
            source.dispatchEvent(new CustomEvent('source-toolbar-action', {detail: {format, ...extra}}));
          };
          const formats: Record<string, string> = {strikethrough:'strike', code:'inline-code', 'bullet-list':'bullet', 'ordered-list':'numbered', hr:'rule'};
          for (const group of builder.build()) for (const item of group.items) {
            const run = item.onRun;
            if (run) item.onRun = ctx => sourceMode ? sourceAction(formats[item.key] || item.key) : run(ctx);
            const active = item.active;
            item.active = ctx => sourceMode ? false : active(ctx);
            if (!item.selector) continue;
            const selector = item.selector;
            if (item.key === 'heading-selector') {
              const label = selector.activeLabel;
              selector.activeLabel = ctx => {
                if (!sourceMode) return label(ctx);
                const start = sourceValue().lastIndexOf('\n', source.selectionStart - 1) + 1;
                const heading = /^(#{1,6})\s/.exec(sourceValue().slice(start));
                return heading ? `見出し${heading[1].length}` : '本文';
              };
            }
            selector.options = selector.options.map((option, index) => {
              const select = option.onSelect;
              return {...option, onSelect: ctx => {
                if (!sourceMode) {select(ctx); return;}
                if (item.key === 'heading-selector') sourceAction('heading', {level:index});
                else if (item.key === 'gfm-alert') sourceAction('alert', {markdown:alertMarkdown(alertKinds[index][0])});
                else if (item.key === 'insert') sourceAction(formats[advanced[index].key] || advanced[index].key);
              }};
            });
          }
          builder.addGroup('ai-actions','AI操作').addItem('ai-insert',{
            icon:uiIcon('aiInsert'),active:()=>false,
            onRun:()=>{window.dispatchEvent(new Event('manual-studio-selection-ai'));},
          });
          const orderedGroups=builder.build();
          const otherIndex=orderedGroups.findIndex(group=>group.items.some(item=>item.key==='insert'));
          if(otherIndex>=0)orderedGroups.push(...orderedGroups.splice(otherIndex,1));
          const selectorLabels:Record<string,string>={'heading-selector':'見出し','gfm-alert':'注釈',insert:'挿入・その他','ai-insert':'AI操作'};
          topBarControls.splice(0,topBarControls.length,...builder.build().flatMap(group=>group.items.filter(item=>item.onRun||item.selector).map(item=>({key:item.key,label:selectorLabels[item.key]||labels[item.key]||item.key}))));
        },
      },
      [Crepe.Feature.Toolbar]: {
        boldLabel: '太字', italicLabel: '斜体', codeLabel: 'インラインコード', linkLabel: 'リンク', strikethroughLabel: '取り消し線', latexLabel: '数式',
        buildToolbar: builder => {
          builder.addGroup('selection-ai', 'AI操作').addItem('selection-ai', {
            icon: uiIcon('aiInsert'), label: 'AI操作', active: () => false,
            onRun: () => { window.dispatchEvent(new Event('manual-studio-selection-ai')); },
          });
        },
      },
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
        },
      },
    },
  });
  crepe.editor.config(ctx => {
    configureGfmAlerts(ctx);
    // The upload plugin leaves its placeholder behind when its uploader rejects.
    // The upload callback already reports the error; an empty result lets the
    // plugin remove the placeholder without inserting an image.
    ctx.update(uploadConfig.key, previous => ({ ...previous, uploader: async (...args) => {
      const pending = { cancelled: false };
      pendingUploads.push(pending);
      try { const result = await previous.uploader(...args); return pending.cancelled ? [] : result; }
      catch { return []; }
      finally { pendingUploads.splice(pendingUploads.indexOf(pending), 1); }
    } }));
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
      return { ...schema, attrs: { ...schema.attrs, alt: { default: '', validate: 'string' }, displayWidth:{default:null},alignment:{default:'center'},presentation:{default:false} },
        parseMarkdown: { ...schema.parseMarkdown, match:node=>schema.parseMarkdown.match(node), runner: (state, node, type) => {
          const figure=(node.muninPresentation as ImagePresentation|undefined)||(node.type==='html'?parseFigure(String(node.value||'')):undefined);
          state.addNode(type, figure?{src:figure.src,caption:figure.caption,alt:figure.alt,ratio:1,displayWidth:figure.width,alignment:figure.align,presentation:true}:{ src: String(node.url ?? ''), caption: String(node.title ?? ''), alt: String(node.alt ?? ''), ratio: 1 });
        } },
        toMarkdown: { ...schema.toMarkdown, runner: (state, node) => {
          if(node.attrs.presentation){state.addNode('html',undefined,renderFigure({src:node.attrs.src,alt:node.attrs.alt,caption:node.attrs.caption,width:node.attrs.displayWidth,align:node.attrs.alignment,configured:true}));return;}
          state.openNode('paragraph');
          state.addNode('image', undefined, undefined, { url: node.attrs.src, alt: node.attrs.alt, title: node.attrs.caption });
          state.closeNode();
        } },
      };
    });
  }).use(imagePresentationPlugin).use(gfmAlerts).use(bridge);
  void crepe.create().then(editor => {
    instance = editor; ready = true; refresh(); updateReadonly();
    if (!sourceMode) source.hidden = true;
    source.dispatchEvent(new Event('editor-mode-change'));
  }).catch(error => {
    showSource();
    // Retain the standalone source controls if Milkdown cannot create its UI.
    if (sourceToolbar) sourceToolbar.hidden = false;
    if (sourceAiToolbar) sourceAiToolbar.hidden = false;
    toggle.disabled = true;
    report(`Milkdownの起動に失敗しました: ${String(error)}`);
  });
  function stepHistory(direction: number): boolean {
    if (sourceMode || !instance || !ready) return false;
    instance.action(ctx => { const view = ctx.get(editorViewCtx); if (direction < 0) undoOrCancel(ctx); else redo(view.state, view.dispatch); view.focus(); });
    return true;
  }
  function imageSourceRange(image:HTMLImageElement):DocumentImage|undefined{
    if(!ready||!instance)return;const src=getOriginalSrc(image);let ordinal=-1,index=0;
    instance.action(ctx=>{const view=ctx.get(editorViewCtx);view.state.doc.descendants((node,pos)=>{if(!['image','image-block'].includes(node.type.name)||node.attrs.src!==src)return;const dom=view.nodeDOM(pos);if(dom===image||dom instanceof HTMLElement&&dom.contains(image))ordinal=index;index++;});});
    const images=documentImages(sourceValue()).filter(item=>item.src===src);return ordinal>=0?images[ordinal]:images.length===1?images[0]:undefined;
  }
  function runShortcut(command: ShortcutCommand): boolean {
    if (!ready || !instance || sourceMode) return false;
    return instance.action(ctx => {
      const view = ctx.get(editorViewCtx), state = view.state;
      if (!view.editable) return true;
      if (command === 'undo' || command === 'redo') { stepHistory(command === 'undo' ? -1 : 1); return true; }
      if (command === 'bold' || command === 'italic' || command === 'link') {
        const key = command === 'bold' ? 'b' : command === 'italic' ? 'i' : 'k';
        const mac=/Mac|iPhone|iPad/.test(navigator.platform);
        view.someProp('handleKeyDown', handler => handler(view, new KeyboardEvent('keydown',{key,ctrlKey:!mac,metaKey:mac,bubbles:true})));
        return true;
      }
      const {$from,empty} = state.selection;
      if (!$from.parent.isTextblock) return true;
      if (command === 'indent' || command === 'outdent') {
        const listItem = state.schema.nodes.list_item;
        if (listItem && (command === 'indent' ? sinkListItem(listItem) : liftListItem(listItem))(state, view.dispatch)) return true;
        if (command === 'outdent' && lift(state, view.dispatch)) return true;
        let tr = state.tr;
        state.doc.nodesBetween(state.selection.from,state.selection.to,(node,pos)=>{
          if (!node.isTextblock) return;
          if (command === 'indent') tr.insertText('  ',tr.mapping.map(pos+1));
          else {const prefix=/^(?:\t| {1,2})/.exec(node.textContent)?.[0];if(prefix)tr.delete(tr.mapping.map(pos+1),tr.mapping.map(pos+1+prefix.length));}
          return false;
        });
        if(tr.docChanged)view.dispatch(tr.scrollIntoView());
        return true;
      }
      if (!['cut','deleteLine','duplicate'].includes(command)) return false;
      const blockStart = $from.start(), line = currentLine($from.parent.textBetween(0,$from.parent.content.size,'','\uFFFC'),$from.parentOffset);
      let tr = state.tr;
      if (command === 'duplicate') {
        tr.insertText('\n'+line.text.slice(0,-1),blockStart+line.end);
      } else if (command === 'cut' && !empty) {
        const text=state.doc.textBetween(state.selection.from,state.selection.to,'\n');
        void navigator.clipboard.writeText(text).then(()=>{if(view.state===state)view.dispatch(state.tr.deleteSelection().scrollIntoView());}).catch(error=>report(`切り取りできませんでした: ${String(error)}`));
        return true;
      } else {
        const from=blockStart+line.deleteStart,to=blockStart+line.deleteEnd;
        if (line.start===0 && line.end===$from.parent.content.size && $from.depth>0) tr.delete($from.before(),$from.after());
        else tr.delete(from,to);
        if(command==='cut') {
          void navigator.clipboard.writeText(line.text).then(()=>{if(view.state===state)view.dispatch(tr.scrollIntoView());}).catch(error=>report(`切り取りできませんでした: ${String(error)}`));
          return true;
        }
      }
      view.dispatch(tr.scrollIntoView());return true;
    });
  }
  return { showSource, refresh, refreshImages, host, stepHistory,imageSourceRange,runShortcut,
    get scrollElement(): HTMLElement { return host.querySelector<HTMLElement>('.ProseMirror') || host; },
    selectedImageSourceRange:()=>{if(!ready||!instance||sourceMode)return;let image:HTMLImageElement|undefined;instance.action(ctx=>{const view=ctx.get(editorViewCtx);const dom=view.nodeDOM(view.state.selection.from);image=dom instanceof HTMLImageElement?dom:dom instanceof HTMLElement?dom.querySelector<HTMLImageElement>('img')||undefined:undefined;});return image?imageSourceRange(image):undefined;},
    replaceMarkdownDocument:(markdown:string,expected:string)=>{if(sourceValue()!==expected)throw new Error('原稿が変更されました。画像を選び直してください。');if(!ready||!instance||sourceMode)return false;instance.action(ctx=>{const view=ctx.get(editorViewCtx);view.dispatch(closeHistory(view.state.tr));replaceAll(markdown,false)(ctx);view.dispatch(closeHistory(view.state.tr));});return true;},
    focus: () => { if (sourceMode) source.focus(); else instance?.action(ctx=>ctx.get(editorViewCtx).focus()); },
    captureState: () => ready && instance && !sourceMode ? instance.action(ctx => {
      let state = ctx.get(editorViewCtx).state;
      const key = uploadPlugin.key();
      const decorations = key?.getState(state);
      // Pending upload widgets are transient UI, not document tab state. Drop
      // them from the cached snapshot so a failed or stale upload cannot return.
      for (const decoration of decorations?.find() || []) {
        const id = decoration.spec.id;
        if (id !== undefined && key) state = state.apply(state.tr.setMeta(key, { remove: { id } }));
      }
      return state;
    }) : null,
    restoreState: (state: EditorState) => { if (ready && instance && state) instance.action(ctx => ctx.get(editorViewCtx).updateState(state)); },
    get isRichEditing() { return ready && !sourceMode; },
    captureSelectionEdit: (insertionOnly=false, coordinates?:{left:number;top:number}) => {
      if(sourceMode||!ready||!instance)return;
      const editor=instance;
      return editor.action(ctx=>{
        const view=ctx.get(editorViewCtx);
        if(coordinates){
          const point=view.posAtCoords(coordinates);
          if(point)view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(point.pos))));
        }
        const state=view.state;
        const from=state.selection.from,to=insertionOnly?from:state.selection.to;
        const text=insertionOnly||state.selection.empty?"":ctx.get(serializerCtx)(state.doc.cut(from,to));
        return {text,apply:(markdown:string,blockInsertion=false)=>editor.action(ctx=>{
          const current=ctx.get(editorViewCtx);
          if(!current.state.doc.eq(state.doc))throw new Error('原稿が変更されました。範囲を選び直してください。');
          const parsed=ctx.get(parserCtx)(markdown);
          if(!parsed)throw new Error('AIの本文を読み取れませんでした。');
          const selected = TextSelection.create(current.state.doc,from,to);
          const point=current.state.doc.resolve(from);
          let transaction=current.state.tr.setSelection(selected);
          if(blockInsertion&&selected.empty&&point.parentOffset===0&&point.parent.isTextblock){
            const insertAt=point.before();
            transaction=current.state.tr.insert(insertAt,parsed.content);
            transaction.setSelection(TextSelection.near(transaction.doc.resolve(insertAt+parsed.content.size),1));
          }else transaction=transaction.replaceSelection(blockInsertion?new Slice(parsed.content,0,0):Slice.maxOpen(parsed.content));
          current.dispatch(transaction.scrollIntoView());
          current.focus();
        })};
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
    historyState: () => sourceMode || !instance || !ready ? null : instance.action(ctx => {
      const state = ctx.get(editorViewCtx).state;
      return { canUndo: undo(state), canRedo: redo(state) };
    }),
  };
}
