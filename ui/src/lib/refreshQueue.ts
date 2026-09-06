/** One running read and one replaceable trailing read per resource. */
export class RefreshQueue {
  private entries = new Map<string, {
    revision: number;
    work: (current: () => boolean) => Promise<void>;
    done: Promise<void>;
  }>();

  run(key: string, work: (current: () => boolean) => Promise<void>): Promise<void> {
    const existing = this.entries.get(key);
    if (existing) {
      existing.revision++;
      existing.work = work;
      return existing.done;
    }
    const entry = { revision: 0, work, done: Promise.resolve() };
    this.entries.set(key, entry);
    entry.done = Promise.resolve().then(async () => {
      try {
        for (;;) {
          const revision = entry.revision;
          const current = () => revision === entry.revision;
          try {
            await entry.work(current);
          } catch (error) {
            if (current()) throw error;
          }
          if (current()) return;
        }
      } finally {
        this.entries.delete(key);
      }
    });
    return entry.done;
  }
}
