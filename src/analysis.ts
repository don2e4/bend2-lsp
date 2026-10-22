import { Worker } from "node:worker_threads";
import type { AnalysisRequest, AnalysisResult } from "./protocol.js";

type Input = Omit<AnalysisRequest, "id">;
type Pending = { input: Input; resolve: (result: AnalysisResult) => void; reject: (error: Error) => void };

// Checking may evaluate an @unsafe def that never returns, so a worker that
// answers nothing for `timeoutMs` is replaced. Its oldest request is the one
// it is stuck on: that one gets a diagnostic, and the rest are sent again.
export class Analyzer {
  private worker!: Worker;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private stopping = false;
  private watchdog: NodeJS.Timeout | undefined;
  private readonly timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.spawn();
  }

  private spawn(): void {
    const worker = new Worker(new URL("./analysis-worker.js", import.meta.url));
    this.worker = worker;
    worker.on("message", (result: AnalysisResult) => {
      if (worker !== this.worker) return;
      const pending = this.pending.get(result.id);
      if (!pending) return;
      this.pending.delete(result.id);
      pending.resolve(result);
      this.arm(true);
    });
    const fail = (cause: unknown) => {
      if (this.stopping || worker !== this.worker) return;
      const error = cause instanceof Error ? cause : new Error(`analysis worker exited (${String(cause)})`);
      const pending = [...this.pending.values()];
      this.pending.clear();
      this.arm(true);
      // One replacement serves every retry; an idle worker respawns on demand.
      if (pending.length > 0) this.spawn();
      for (const request of pending) request.reject(error);
    };
    worker.on("error", fail);
    worker.on("exit", (code) => { if (code !== 0) fail(code); });
  }

  private arm(restart: boolean): void {
    if (this.watchdog && !restart) return;
    clearTimeout(this.watchdog);
    this.watchdog = this.pending.size > 0 ? setTimeout(() => this.stuck(), this.timeoutMs) : undefined;
  }

  private stuck(): void {
    this.watchdog = undefined;
    if (this.pending.size === 0) return;
    const [[id, oldest], ...rest] = [...this.pending];
    this.pending.clear();
    void this.worker.terminate();
    this.spawn();
    for (const [restId, request] of rest) {
      this.pending.set(restId, request);
      this.worker.postMessage({ ...request.input, id: restId });
    }
    this.arm(true);
    const seconds = Math.round(this.timeoutMs / 1000);
    oldest.resolve({
      id, uri: oldest.input.uri, version: oldest.input.version, versions: { [oldest.input.uri]: oldest.input.version },
      diagnostics: [{
        uri: oldest.input.uri, range: { start: 0, end: 0 }, code: "checking",
        message: `Checking stopped after ${seconds} s without an answer. It may be evaluating a def that never returns, such as an @unsafe one.`,
      }],
      hovers: {}, definitions: {}, completions: [],
    });
  }

  private request(input: Input): Promise<AnalysisResult> {
    if (this.worker.threadId === -1) this.spawn();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { input, resolve, reject });
      this.worker.postMessage({ ...input, id });
      this.arm(false);
    });
  }

  async analyze(input: Input): Promise<AnalysisResult> {
    try {
      return await this.request(input);
    } catch {
      return this.request(input);
    }
  }

  async close(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.watchdog);
    await this.worker.terminate();
  }
}
