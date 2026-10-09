import { editorViewCtx } from '@milkdown/kit/core';
import { $command, insert } from '@milkdown/kit/utils';

export type AiTaskKind = 'text' | 'screenshot' | 'diagram';
export const aiTagItems: { kind: AiTaskKind; label: string; icon: string }[] = [
  { kind: 'text', label: '文章の指示', icon: '<span>AI文</span>' },
  { kind: 'diagram', label: '図の指示', icon: '<span>AI図</span>' },
];

/** Commands shared by Crepe's toolbar, slash menu and the capture dialog. */
export function createAiTagsPlugin(requestTask?: (kind: AiTaskKind) => void) {
  const requestAiTag = $command('RequestManualAiTag', () => (kind?: AiTaskKind) => (_state, dispatch, view) => {
    if (!kind || !aiTagItems.some(item => item.kind === kind) || !view?.editable || !requestTask) return false;
    if (dispatch) requestTask(kind);
    return true;
  });
  const insertAiTag = $command('InsertManualAiTag', ctx => (markdown?: string) => (_state, dispatch, view) => {
    if (!markdown || !/^<!--\s*ai:task\b/.test(markdown.trim()) || !view?.editable) return false;
    if (dispatch) {
      insert(markdown)(ctx);
      ctx.get(editorViewCtx).focus();
    }
    return true;
  });
  return { plugins: [requestAiTag, insertAiTag], requestAiTag, insertAiTag };
}
