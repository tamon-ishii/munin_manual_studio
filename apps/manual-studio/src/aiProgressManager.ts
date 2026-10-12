/** Centralized manager for AI task execution, progress monitoring, and cancellation. */
export interface AiProgressSnapshot {
  running: boolean;
  stage: string;
  startedAt: number;
  lastEventAt: number;
  connection: string;
  operation: string;
  failureMessage: string;
  displayLogs: string[];
  activeRoot: string | null;
  isCancelled: boolean;
}

export class AiProgressManager {
  private running = false;
  private stage = '処理を開始しています';
  private startedAt = 0;
  private lastEventAt = 0;
  private connection = 'AI';
  private operation = '';
  private failureMessage = '';
  private displayLogs: string[] = [];
  private activeRoot: string | null = null;
  private cancelRequest: Promise<void> | undefined;
  private agentTotal = 0;

  get isRunning(): boolean {
    return this.running;
  }

  get root(): string | null {
    return this.activeRoot;
  }

  get currentStage(): string {
    return this.stage;
  }

  get logs(): string[] {
    return [...this.displayLogs];
  }

  get failure(): string {
    return this.failureMessage;
  }

  get isCancelling(): boolean {
    return Boolean(this.cancelRequest);
  }

  get snapshot(): AiProgressSnapshot {
    return {
      running: this.running,
      stage: this.stage,
      startedAt: this.startedAt,
      lastEventAt: this.lastEventAt,
      connection: this.connection,
      operation: this.operation,
      failureMessage: this.failureMessage,
      displayLogs: [...this.displayLogs],
      activeRoot: this.activeRoot,
      isCancelled: Boolean(this.cancelRequest),
    };
  }

  start(params: {
    connection: string;
    operation: string;
    root: string;
    initialLogs?: string[];
  }): void {
    this.running = true;
    this.connection = params.connection;
    this.operation = params.operation;
    this.activeRoot = params.root;
    this.failureMessage = '';
    this.displayLogs = params.initialLogs ? [...params.initialLogs] : [];
    this.agentTotal = 0;
    this.startedAt = Date.now();
    this.stage = '処理を開始しています';
    this.lastEventAt = this.startedAt;
    this.cancelRequest = undefined;
  }

  log(message: string): void {
    this.displayLogs.push(`[${new Date().toLocaleTimeString('ja-JP', { hour12: false })}] ${message}`);
    this.lastEventAt = Date.now();
    this.stage = message;
  }

  recordFailure(error: unknown): string {
    this.failureMessage = String(error);
    this.log(`失敗: ${this.failureMessage}`);
    return this.failureMessage;
  }

  recordAgentLogs(entries: Array<{ time: string; message: string }>, total?: number): boolean {
    const reportTotal = total ?? entries.length;
    if (reportTotal > this.agentTotal) {
      const newItems = entries.slice(-(reportTotal - this.agentTotal));
      this.displayLogs.push(...newItems.map(e => `[${e.time}] ${e.message}`));
      this.agentTotal = reportTotal;
      this.lastEventAt = Date.now();
      if (this.running && entries.length) {
        this.stage = entries.at(-1)!.message;
      }
      return true;
    }
    return false;
  }

  requestCancel(cancelFn: (root: string) => Promise<void>): Promise<void> | undefined {
    if (!this.activeRoot || this.cancelRequest) return undefined;
    const root = this.activeRoot;
    this.log('中断を要求しました。実行中の処理を停止します。');
    this.cancelRequest = cancelFn(root).catch(err => {
      this.log(`中断要求の送信に失敗しました: ${String(err)}`);
    });
    return this.cancelRequest;
  }

  async stop(): Promise<{ cancelled: boolean; failure: string }> {
    const cancelled = Boolean(this.cancelRequest);
    if (this.cancelRequest) {
      await this.cancelRequest;
      this.cancelRequest = undefined;
    }
    this.running = false;
    this.activeRoot = null;
    return { cancelled, failure: this.failureMessage };
  }

  computeElapsed(): { seconds: number; formatted: string; isWaitingLong: boolean; waitingMessage: string } {
    const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    const isWaitingLong = this.running && Date.now() - this.lastEventAt >= 15_000;
    const waitingBase = this.stage.includes('応答を待っています')
      ? `${this.connection}の応答を待っています`
      : this.stage;
    const waitingMessage = isWaitingLong
      ? `${waitingBase}。経過 ${elapsed}秒（最終ログから${Math.floor((Date.now() - this.lastEventAt) / 1000)}秒）。中断できます。`
      : this.stage;
    return {
      seconds: elapsed,
      formatted: `${mm}:${ss}`,
      isWaitingLong,
      waitingMessage,
    };
  }
}
