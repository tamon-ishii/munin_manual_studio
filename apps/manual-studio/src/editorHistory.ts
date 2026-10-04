/** A textarea edit history with no dependency on the DOM or application state. */
export interface EditorSnapshot {
  value: string;
  start: number;
  end: number;
}

export interface EditInput {
  inputType: string;
  isTrusted: boolean;
}

const GROUPABLE_INPUT_TYPES = new Set([
  "insertText",
  "deleteContentBackward",
  "deleteContentForward",
]);

const MAX_SNAPSHOTS = 201;
const INPUT_GROUP_WINDOW_MS = 800;

function copySnapshot(snapshot: EditorSnapshot): EditorSnapshot {
  const value = String(snapshot.value);
  const start = clampPosition(snapshot.start, value.length);
  const end = clampPosition(snapshot.end, value.length);
  return { value, start: Math.min(start, end), end: Math.max(start, end) };
}

function clampPosition(position: number, length: number): number {
  if (!Number.isFinite(position)) return 0;
  return Math.max(0, Math.min(length, Math.trunc(position)));
}

/**
 * Records text and selection snapshots. Consecutive trusted typing/deletion
 * events of the same kind are grouped while they arrive within 800ms.
 */
export class EditorHistory {
  private snapshots: EditorSnapshot[] = [];
  private index = -1;
  private lastInputType = "";
  private lastInputAt = 0;

  get length(): number {
    return this.snapshots.length;
  }

  get currentIndex(): number {
    return this.index;
  }

  get canUndo(): boolean {
    return this.index > 0;
  }

  get canRedo(): boolean {
    return this.index >= 0 && this.index < this.snapshots.length - 1;
  }

  get current(): EditorSnapshot | null {
    return this.index < 0 ? null : { ...this.snapshots[this.index] };
  }

  reset(snapshot: EditorSnapshot): void {
    this.snapshots = [copySnapshot(snapshot)];
    this.index = 0;
    this.closeInputGroup();
  }

  /** Update the current selection without creating an undo step. */
  rememberSelection(start: number, end: number): void {
    if (this.index < 0) return;
    const current = this.snapshots[this.index];
    const selection = copySnapshot({ value: current.value, start, end });
    if (current.start !== selection.start || current.end !== selection.end) {
      this.snapshots[this.index] = selection;
      this.closeInputGroup();
    }
  }

  /**
   * Record a post-input snapshot. Returns true if the stored history changed.
   * `now` is injectable so grouping behavior can be tested deterministically.
   */
  record(snapshot: EditorSnapshot, input: EditInput, now = Date.now()): boolean {
    const next = copySnapshot(snapshot);
    if (this.index < 0) {
      this.reset(next);
      return true;
    }

    const current = this.snapshots[this.index];
    if (current.value === next.value) {
      this.rememberSelection(next.start, next.end);
      return false;
    }

    const inputType = input.isTrusted ? input.inputType : "";
    const groupable = GROUPABLE_INPUT_TYPES.has(inputType);
    const elapsed = now - this.lastInputAt;
    const canGroup = groupable
      && inputType === this.lastInputType
      && elapsed >= 0
      && elapsed < INPUT_GROUP_WINDOW_MS
      && this.index === this.snapshots.length - 1
      && this.index > 0;

    if (canGroup) {
      this.snapshots[this.index] = next;
    } else {
      // Editing after undo discards the abandoned future before appending.
      this.snapshots.splice(this.index + 1);
      this.snapshots.push(next);
      if (this.snapshots.length > MAX_SNAPSHOTS) this.snapshots.shift();
      this.index = this.snapshots.length - 1;
    }

    this.lastInputType = groupable ? inputType : "";
    this.lastInputAt = now;
    return true;
  }

  step(direction: -1 | 1): EditorSnapshot | null {
    const nextIndex = this.index + direction;
    if (nextIndex < 0 || nextIndex >= this.snapshots.length) return null;
    this.index = nextIndex;
    this.closeInputGroup();
    return { ...this.snapshots[this.index] };
  }

  private closeInputGroup(): void {
    this.lastInputType = "";
    this.lastInputAt = 0;
  }
}
