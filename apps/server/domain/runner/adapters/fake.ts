// Scripted RunnerAdapter for tests (spec: "adapters/fake.ts"). Not
// registered in production -- the registry issue decides where this is
// wired up, and it is test-only there too.

import type {
  CanonicalEvent,
  DeltaFrame,
  EventSink,
  RunHandle,
  RunStart,
  RunnerAdapter,
  RunnerAvailability,
  RunnerModel,
  RunEndReason,
} from "../types.js";

// A step is either a canonical event/delta to emit, a pause (the script
// blocks until the returned RunHandle's send()/answer() is called, whichever
// kind the step names, simulating a run genuinely waiting on input), or an
// explicit end: the run stops there with that reason, the way a real
// adapter reports a provider limit/error (#411) instead of the "completed"
// a script running to its end reports.
export type FakeScriptStep =
  | CanonicalEvent
  | DeltaFrame
  | { wait: "message" | "answer" }
  | { end: RunEndReason };

export interface FakeRunnerAdapterOptions {
  script: readonly FakeScriptStep[];
  agentSessionId?: string | null;
  availability?: Partial<RunnerAvailability>;
  // #376: models() just returns this fixed list -- the fake has no live
  // query to fill a cache from, and no test needs it to.
  models?: readonly RunnerModel[];
}

function isWaitStep(step: FakeScriptStep): step is { wait: "message" | "answer" } {
  return "wait" in step;
}

function isEndStep(step: FakeScriptStep): step is { end: RunEndReason } {
  return "end" in step;
}

export class FakeRunnerAdapter implements RunnerAdapter {
  readonly id = "fake";
  private readonly script: readonly FakeScriptStep[];
  private readonly agentSessionIdValue: string | null;
  private readonly availability: RunnerAvailability;
  private readonly modelsList: readonly RunnerModel[];
  // Test-only visibility for RunHandle.setModel (#375) -- the last model
  // any live run's handle was asked to switch to, or null if never called.
  private lastSetModel: string | null = null;

  getLastSetModel(): string | null {
    return this.lastSetModel;
  }

  async models(): Promise<RunnerModel[]> {
    return [...this.modelsList];
  }

  constructor(opts: FakeRunnerAdapterOptions) {
    this.script = opts.script;
    this.agentSessionIdValue = opts.agentSessionId ?? null;
    this.modelsList = opts.models ?? [];
    this.availability = {
      installed: true,
      version: "fake-1.0.0",
      logged_in: true,
      instances_supported: false,
      ...opts.availability,
    };
  }

  async detect(): Promise<RunnerAvailability> {
    return this.availability;
  }

  async start(run: RunStart, sink: EventSink): Promise<RunHandle> {
    const agentSessionIdValue = this.agentSessionIdValue;
    let ended = false;
    let stopped = false;
    let waitingFor: "message" | "answer" | null = null;
    let resumeWaiting: (() => void) | null = null;

    const emitEnded = (reason: RunEndReason) => {
      if (ended) return;
      ended = true;
      sink({ kind: "run_ended", payload: { run_id: run.runId, reason, usage: null } });
    };

    // Runs synchronously up to the first `wait` step (or the end of the
    // script) since nothing here awaits a real timer -- a wait-free script
    // has fully played out, including the trailing run_ended, by the time
    // start()'s caller observes the returned handle.
    const playScript = async () => {
      for (const step of this.script) {
        if (stopped) return;
        if (isEndStep(step)) {
          emitEnded(step.end);
          return;
        }
        if (isWaitStep(step)) {
          waitingFor = step.wait;
          await new Promise<void>((resolve) => {
            resumeWaiting = resolve;
          });
          waitingFor = null;
          if (stopped) return;
          continue;
        }
        sink(step);
      }
      emitEnded("completed");
    };

    void playScript();

    const resolveWait = (kind: "message" | "answer") => {
      if (waitingFor === kind && resumeWaiting) {
        const resolve = resumeWaiting;
        resumeWaiting = null;
        resolve();
      }
    };

    const stopAndResume = () => {
      stopped = true;
      if (resumeWaiting) {
        const resolve = resumeWaiting;
        resumeWaiting = null;
        resolve();
      }
    };

    return {
      async send(): Promise<void> {
        resolveWait("message");
      },
      async answer(): Promise<void> {
        resolveWait("answer");
      },
      // #378: mirrors the real Claude adapter -- interrupt() only cancels
      // whatever turn is in flight, it never ends the run. The script (if
      // paused at a wait step) stays paused; ending the run is close()'s
      // job alone.
      async interrupt(): Promise<void> {
        // no-op
      },
      async close(): Promise<void> {
        if (ended) return;
        stopAndResume();
        emitEnded("completed");
      },
      setModel: async (model: string | null): Promise<void> => {
        this.lastSetModel = model;
      },
      agentSessionId(): string | null {
        return agentSessionIdValue;
      },
      pid(): number | null {
        return null;
      },
    };
  }
}
