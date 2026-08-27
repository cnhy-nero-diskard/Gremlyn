export type VerificationResult = { ok: true } | { ok: false; reason: string };

export interface QueuedWork<T> {
  jobId: number;
  repoId: number;
  prNumber: number;
  verify: () => Promise<VerificationResult>;
  run: (signal: AbortSignal) => Promise<T>;
  onRejected?: (reason: string) => void | Promise<void>;
  onCancelled?: (state: "queued" | "running") => void | Promise<void>;
}

export type QueueResult<T> =
  | { kind: "completed"; value: T }
  | { kind: "rejected"; reason: string }
  | { kind: "cancelled"; state: "queued" | "running" };

interface Pending<T> {
  work: QueuedWork<T>;
  key: string;
  resolve: (result: QueueResult<T>) => void;
  reject: (error: unknown) => void;
}

interface Running<T> {
  item: Pending<T>;
  controller: AbortController;
}

/** In-memory global semaphore plus per-repository/PR execution locks (design D8). */
export class JobQueue<T> {
  private readonly pending: Pending<T>[] = [];
  private readonly running = new Map<number, Running<T>>();
  private readonly activeKeys = new Set<string>();
  private activeCount = 0;

  constructor(private readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error("concurrency must be a positive integer");
    }
  }

  enqueue(work: QueuedWork<T>): Promise<QueueResult<T>> {
    if (
      this.running.has(work.jobId) ||
      this.pending.some((item) => item.work.jobId === work.jobId)
    ) {
      throw new Error(`job ${work.jobId} is already queued`);
    }
    const promise = new Promise<QueueResult<T>>((resolve, reject) => {
      this.pending.push({
        work,
        key: `${work.repoId}:${work.prNumber}`,
        resolve,
        reject,
      });
    });
    this.pump();
    return promise;
  }

  cancel(jobId: number): boolean {
    const queuedIndex = this.pending.findIndex((item) => item.work.jobId === jobId);
    if (queuedIndex >= 0) {
      const [item] = this.pending.splice(queuedIndex, 1);
      if (!item) return false;
      void this.completeQueuedCancellation(item);
      return true;
    }
    const active = this.running.get(jobId);
    if (!active) return false;
    active.controller.abort();
    return true;
  }

  get queuedCount(): number {
    return this.pending.length;
  }

  get runningCount(): number {
    return this.activeCount;
  }

  private pump(): void {
    while (this.activeCount < this.concurrency) {
      const index = this.pending.findIndex((item) => !this.activeKeys.has(item.key));
      if (index < 0) return;
      const [item] = this.pending.splice(index, 1);
      if (!item) return;
      this.start(item);
    }
  }

  private start(item: Pending<T>): void {
    const controller = new AbortController();
    this.activeCount += 1;
    this.activeKeys.add(item.key);
    this.running.set(item.work.jobId, { item, controller });
    void this.execute(item, controller);
  }

  private async execute(item: Pending<T>, controller: AbortController): Promise<void> {
    try {
      const verification = await item.work.verify();
      if (!verification.ok) {
        await item.work.onRejected?.(verification.reason);
        item.resolve({ kind: "rejected", reason: verification.reason });
        return;
      }
      if (controller.signal.aborted) {
        await item.work.onCancelled?.("running");
        item.resolve({ kind: "cancelled", state: "running" });
        return;
      }
      const value = await item.work.run(controller.signal);
      if (controller.signal.aborted) {
        await item.work.onCancelled?.("running");
        item.resolve({ kind: "cancelled", state: "running" });
      } else {
        item.resolve({ kind: "completed", value });
      }
    } catch (err) {
      if (controller.signal.aborted) {
        try {
          await item.work.onCancelled?.("running");
          item.resolve({ kind: "cancelled", state: "running" });
        } catch (cancelErr) {
          item.reject(cancelErr);
        }
      } else {
        item.reject(err);
      }
    } finally {
      this.running.delete(item.work.jobId);
      this.activeKeys.delete(item.key);
      this.activeCount -= 1;
      this.pump();
    }
  }

  private async completeQueuedCancellation(item: Pending<T>): Promise<void> {
    try {
      await item.work.onCancelled?.("queued");
      item.resolve({ kind: "cancelled", state: "queued" });
    } catch (err) {
      item.reject(err);
    } finally {
      this.pump();
    }
  }
}
