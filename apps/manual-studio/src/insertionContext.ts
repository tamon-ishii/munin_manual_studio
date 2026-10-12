/** What an asynchronous image insertion was started against. */
export interface InsertionState<Document> {
  document: Document | null;
  root: string;
  content: string;
  /** Changes when a document is opened, but not when autosave refreshes its metadata. */
  documentSession?: number;
}
export interface InsertionContext<Document> extends InsertionState<Document> {
  /** Source-mode entries also require unchanged text; rich-editor upload edits the text while it waits. */
  checksContent: boolean;
}

export const STALE_INSERTION_MESSAGE = "編集中の原稿が切り替わりました。画像を挿入し直してください。";

export function captureInsertionContext<Document>(state: InsertionState<Document>, options: { checksContent?: boolean } = {}): InsertionContext<Document> {
  return { ...state, checksContent: options.checksContent ?? true };
}

/** Keep the opening session across saves, rejecting navigation and (when required) text edits. */
export function isInsertionCurrent<Document>(context: InsertionContext<Document>, now: InsertionState<Document>): boolean {
  if (!context.document || !now.document || now.root !== context.root) return false;
  if (context.documentSession !== undefined) {
    if (now.documentSession !== context.documentSession) return false;
  } else if (now.document !== context.document) return false;
  return !context.checksContent || now.content === context.content;
}
