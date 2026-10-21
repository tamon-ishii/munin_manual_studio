/** Bounded cache shared by list refreshes; obsolete in-flight results cannot repopulate it. */
export class ThumbnailCache {
  private values = new Map<string, string>();
  private pending = new Map<string, Promise<string>>();
  private active = new Set<string>();
  constructor(private readonly limit = 128) {}
  retain(keys: string[]): void {
    this.active = new Set(keys);
    for (const key of this.values.keys()) if (!this.active.has(key)) this.values.delete(key);
  }
  async load(key: string, request: () => Promise<string>): Promise<string> {
    const cached = this.values.get(key);
    if (cached !== undefined) { this.values.delete(key); this.values.set(key, cached); return cached; }
    const pending = this.pending.get(key);
    if (pending) return pending;
    const operation = request().then(value => {
      if (this.active.has(key)) {
        this.values.set(key, value);
        while (this.values.size > this.limit) this.values.delete(this.values.keys().next().value!);
      }
      return value;
    });
    this.pending.set(key, operation);
    try { return await operation; }
    finally { if (this.pending.get(key) === operation) this.pending.delete(key); }
  }
}
