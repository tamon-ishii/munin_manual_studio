export interface CaptureSession {
  readonly generation: number;
  readonly root: string;
  readonly page: string;
  readonly id: string;
  readonly selection: Readonly<{ start: number; end: number }>;
}

/** Tracks the document that owns a capture until it is completed or cancelled. */
export class CaptureSessionStore {
  private generation = 0;
  private currentSession: CaptureSession | null = null;

  get active(): CaptureSession | null {
    return this.currentSession;
  }

  begin(input: Omit<CaptureSession, "generation">): CaptureSession {
    if (this.currentSession) throw new Error("撮影AIタグの作成中は、新しい撮影を開始できません。");
    if (!input.root.trim() || !input.page.trim() || !input.id.trim()) throw new Error("撮影対象のプロジェクト・文書・IDを指定してください。");
    const session = Object.freeze({
      ...input,
      selection: Object.freeze({ ...input.selection }),
      generation: ++this.generation,
    });
    this.currentSession = session;
    return session;
  }

  isCurrent(generation: number): boolean {
    return this.currentSession?.generation === generation;
  }

  matchesTarget(generation: number, root: string, page: string): boolean {
    return this.currentSession?.generation === generation
      && this.currentSession.root === root
      && this.currentSession.page === page;
  }

  invalidate(generation?: number): boolean {
    if (!this.currentSession || (generation !== undefined && this.currentSession.generation !== generation)) return false;
    this.currentSession = null;
    this.generation++;
    return true;
  }

  assertInactive(): void {
    if (this.currentSession) {
      throw new Error("撮影AIタグの作成中は、完了またはキャンセルしてからプロジェクト・文書を切り替えてください。");
    }
  }
}
