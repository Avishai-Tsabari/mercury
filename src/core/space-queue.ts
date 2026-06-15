type Work<T> = () => Promise<T>;

export class SpaceQueue {
  private readonly perSpacePending = new Map<string, Array<() => void>>();
  private readonly activeSpaces = new Set<string>();
  private activeGlobal = 0;

  constructor(private readonly maxConcurrency: number) {}

  enqueue<T>(spaceId: string, work: Work<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = async () => {
        this.activeGlobal += 1;
        this.activeSpaces.add(spaceId);
        try {
          resolve(await work());
        } catch (error) {
          reject(error);
        } finally {
          this.activeGlobal -= 1;
          this.activeSpaces.delete(spaceId);
          this.startNext(spaceId);
          this.drainOtherSpaces();
        }
      };

      const queue = this.perSpacePending.get(spaceId) ?? [];
      queue.push(run);
      this.perSpacePending.set(spaceId, queue);
      this.drainOtherSpaces();
    });
  }

  cancelAll(): number {
    let total = 0;
    for (const [_spaceId, queue] of this.perSpacePending) {
      total += queue.length;
    }
    this.perSpacePending.clear();
    return total;
  }

  get activeCount(): number {
    return this.activeGlobal;
  }

  get pendingCount(): number {
    let total = 0;
    for (const queue of this.perSpacePending.values()) {
      total += queue.length;
    }
    return total;
  }

  waitForActive(timeoutMs: number): Promise<boolean> {
    if (this.activeGlobal === 0) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const checkInterval = setInterval(() => {
        if (this.activeGlobal === 0) {
          clearInterval(checkInterval);
          resolve(true);
        }
      }, 100);
      setTimeout(() => {
        clearInterval(checkInterval);
        resolve(this.activeGlobal === 0);
      }, timeoutMs);
    });
  }

  cancelPending(spaceId: string): number {
    const queue = this.perSpacePending.get(spaceId);
    if (!queue || queue.length === 0) return 0;
    const count = queue.length;
    this.perSpacePending.delete(spaceId);
    return count;
  }

  isActive(spaceId: string): boolean {
    return this.activeSpaces.has(spaceId);
  }

  private canStart(spaceId: string): boolean {
    return (
      this.activeGlobal < this.maxConcurrency && !this.activeSpaces.has(spaceId)
    );
  }

  private startNext(spaceId: string): void {
    const queue = this.perSpacePending.get(spaceId);
    if (!queue || queue.length === 0 || !this.canStart(spaceId)) return;
    const next = queue.shift();
    if (queue.length === 0) this.perSpacePending.delete(spaceId);
    next?.();
  }

  private drainOtherSpaces(): void {
    for (const spaceId of this.perSpacePending.keys()) {
      if (this.activeGlobal >= this.maxConcurrency) return;
      this.startNext(spaceId);
    }
  }
}
