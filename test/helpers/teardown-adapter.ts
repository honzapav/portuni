// #489: an adapter whose run end is driven by the test. Between
// beginTeardown() and endRun() the handle refuses every send with
// RunEndedError -- exactly the window a real run has between a provider
// failure (or the idle sweep's close) and the run_ended that follows it.
// The fake adapter cannot open that window: its script plays out to the
// run_ended without a step in between.

import { RunEndedError } from "../../apps/server/domain/runner/types.js";
import type {
  CanonicalEvent,
  EventSink,
  RunEndReason,
  RunHandle,
  RunStart,
  RunnerAdapter,
  RunnerAvailability,
  RunnerModel,
} from "../../apps/server/domain/runner/types.js";

export class TeardownRun {
  // Every message the handle actually took.
  readonly delivered: string[] = [];
  // Every message it refused because the run was already ending.
  readonly refusedTexts: string[] = [];
  closeCount = 0;
  private ending = false;
  private ended = false;

  // Resolves the first time a send is refused -- the signal a test waits
  // on instead of a timer.
  readonly refused: Promise<void>;
  private markRefused!: () => void;
  // Resolves when close() is entered, i.e. once the teardown window is open.
  readonly closing: Promise<void>;
  private markClosing!: () => void;
  private readonly closeGate: Promise<void> | null;
  private openCloseGate: () => void = () => undefined;

  constructor(
    readonly start: RunStart,
    private readonly sink: EventSink,
    holdClose: boolean,
  ) {
    this.refused = new Promise<void>((resolve) => {
      this.markRefused = resolve;
    });
    this.closing = new Promise<void>((resolve) => {
      this.markClosing = resolve;
    });
    this.closeGate = holdClose
      ? new Promise<void>((resolve) => {
          this.openCloseGate = resolve;
        })
      : null;
  }

  emit(event: CanonicalEvent): void {
    this.sink(event);
  }

  // The run is on its way out (a provider failure's teardown, a close):
  // nothing it is handed from here can reach the agent any more.
  beginTeardown(): void {
    this.ending = true;
  }

  endRun(reason: RunEndReason = "completed"): void {
    if (this.ended) return;
    this.ended = true;
    this.ending = true;
    this.sink({ kind: "run_ended", payload: { run_id: this.start.runId, reason, usage: null } });
  }

  // Lets a close() that was asked to hold finish and emit its run_ended.
  releaseClose(): void {
    this.openCloseGate();
  }

  get handle(): RunHandle {
    return {
      send: async (text: string): Promise<void> => {
        if (this.ending || this.ended) {
          this.refusedTexts.push(text);
          this.markRefused();
          throw new RunEndedError("send: the run is ending");
        }
        this.delivered.push(text);
      },
      answer: async (): Promise<void> => undefined,
      interrupt: async (): Promise<void> => undefined,
      close: async (): Promise<void> => {
        this.closeCount += 1;
        this.beginTeardown();
        this.markClosing();
        if (this.closeGate) await this.closeGate;
        this.endRun("completed");
      },
      setModel: async (): Promise<void> => undefined,
      agentSessionId: (): string | null => null,
      pid: (): number | null => null,
    };
  }
}

export class TeardownAdapter implements RunnerAdapter {
  readonly id = "fake";
  readonly runs: TeardownRun[] = [];

  constructor(private readonly opts: { holdClose?: boolean } = {}) {}

  get last(): TeardownRun {
    return this.runs[this.runs.length - 1];
  }

  async detect(): Promise<RunnerAvailability> {
    return { installed: true, version: "teardown-1.0.0", logged_in: true, instances_supported: false };
  }

  async models(): Promise<RunnerModel[]> {
    return [];
  }

  async start(run: RunStart, sink: EventSink): Promise<RunHandle> {
    const created = new TeardownRun(run, sink, this.opts.holdClose === true);
    this.runs.push(created);
    return created.handle;
  }
}
