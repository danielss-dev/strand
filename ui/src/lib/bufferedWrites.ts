/** Coalesce live state before serialization, keeping writes ordered per key. */
export class BufferedWrites {
  private entries = new Map<string, {
    pending?: { value: unknown };
    timer?: ReturnType<typeof setTimeout>;
    writing?: Promise<void>;
  }>();

  constructor(private write: (key: string, value: unknown) => Promise<void>, private delay = 500) {}

  schedule(key: string, value: unknown): void {
    const entry = this.entries.get(key) ?? {};
    this.entries.set(key, entry);
    entry.pending = { value };
    if (!entry.timer) entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.flush(key).catch((error) => console.warn('state save failed', error));
    }, this.delay);
  }

  async flush(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    if (entry.writing) {
      await entry.writing;
      return this.flush(key);
    }
    const pending = entry.pending;
    if (!pending) {
      this.entries.delete(key);
      return;
    }
    entry.pending = undefined;
    entry.writing = this.write(key, pending.value);
    try {
      await entry.writing;
    } catch (error) {
      entry.pending ??= pending;
      throw error;
    } finally {
      entry.writing = undefined;
    }
    if (entry.pending) return this.flush(key);
    clearTimeout(entry.timer);
    this.entries.delete(key);
  }
}
