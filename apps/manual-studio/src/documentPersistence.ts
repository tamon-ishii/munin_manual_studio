import type { Document } from './types';

export interface DocumentSaveContext {
  document: Document;
  root: string;
  content: string;
  version: number;
}
export interface DocumentSaveState {
  owner: Document;
  state: 'saving' | 'error';
  message?: string;
}
interface DocumentPersistenceOptions {
  context: () => DocumentSaveContext | null;
  write: (context: DocumentSaveContext) => Promise<Document>;
  stateChanged: () => void;
  apply: (saved: Document, context: DocumentSaveContext) => void;
  refresh: () => Promise<void>;
  saved: (page: string) => void;
}

/** Serializes writes and prevents responses for an old editor from changing the active document. */
export class DocumentPersistence {
  state: DocumentSaveState | null = null;
  private pending: Promise<void> | undefined;

  constructor(private readonly options: DocumentPersistenceOptions) {}

  async wait(): Promise<void> {
    while (this.pending) await this.pending;
  }

  async save(refresh = true): Promise<void> {
    while (this.pending) await this.pending;
    const pending = this.persist(refresh);
    this.pending = pending;
    try { await pending; }
    finally { if (this.pending === pending) this.pending = undefined; }
  }

  private isCurrent(context: DocumentSaveContext): boolean {
    const active = this.options.context();
    return active?.root === context.root && active.document === context.document && active.version === context.version;
  }

  private async persist(refresh: boolean): Promise<void> {
    const context = this.options.context();
    if (!context) throw new Error('保存する原稿を選択してください。');
    this.state = { owner: context.document, state: 'saving' };
    this.options.stateChanged();
    let saved: Document;
    try { saved = await this.options.write(context); }
    catch (error) {
      if (this.isCurrent(context)) {
        this.state = { owner: context.document, state: 'error', message: String(error) };
        this.options.stateChanged();
      }
      throw error;
    }
    if (!this.isCurrent(context)) return;
    this.state = null;
    this.options.apply(saved, context);
    this.options.stateChanged();
    if (refresh) await this.options.refresh();
    this.options.saved(context.document.page);
  }
}
