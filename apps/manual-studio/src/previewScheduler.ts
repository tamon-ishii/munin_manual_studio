interface Options<T> {
  snapshot(): T | null;
  key(snapshot: T): string;
  visible(): boolean;
  generate(snapshot: T): Promise<string>;
  loading(): void;
  apply(html: string): void;
  error(error: unknown): void;
}
/** One request at a time. Typing replaces pending work; hidden previews stay dirty. */
export class PreviewScheduler<T> {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private generation = 0;
  private dirty = false;
  private force = false;
  private activeKey: string | undefined;
  private renderedKey: string | undefined;
  constructor(private readonly options: Options<T>, private readonly delay = 250) {}
  invalidate(): void {
    this.generation++;
    this.dirty = true;
    clearTimeout(this.timer);
  }
  schedule(): void {
    this.invalidate();
    if (this.options.visible()) this.timer = setTimeout(() => { void this.flush(); }, this.delay);
  }
  request(force = false): Promise<void> {
    if (force) this.invalidate();
    const snapshot = this.options.snapshot();
    if (snapshot && this.options.key(snapshot) !== this.renderedKey && this.options.key(snapshot) !== this.activeKey) this.dirty = true;
    this.force ||= force;
    return this.flush();
  }
  private flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.running) return this.running;
    const operation = Promise.resolve().then(async () => {
      while (this.dirty && (this.force || this.options.visible())) {
        const snapshot = this.options.snapshot();
        if (!snapshot) { this.dirty = false; this.force = false; break; }
        const generation = this.generation, key = this.options.key(snapshot), forced = this.force;
        this.dirty = false; this.force = false;
        this.activeKey = key;
        this.options.loading();
        try {
          const html = await this.options.generate(snapshot);
          const current = this.options.snapshot();
          if (generation !== this.generation || !current || key !== this.options.key(current)) continue;
          if (!forced && !this.options.visible()) { this.dirty = true; break; }
          this.renderedKey = key;
          this.options.apply(html);
        } catch (error) {
          if (generation === this.generation) this.options.error(error);
        } finally { this.activeKey = undefined; }
      }
    });
    this.running = operation;
    const clear = () => { if (this.running === operation) this.running = undefined; };
    void operation.then(clear, clear);
    return operation;
  }
}
