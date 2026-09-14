// Scripted RunnerAdapter for tests (spec: "adapters/fake.ts"). Not
// registered in production -- the registry issue decides where this is
// wired up, and it is test-only there too.

import type { CanonicalEvent, DeltaFrame, EventSink, RunHandle, RunStart, RunnerAdapter, RunnerAvailability } from "../types.js";

// A step is either a canonical event/delta to emit, or a pause: the script
// blocks until the returned RunHandle's send()/answer() is called (whichever
// kind the step names), simulating a run genuinely waiting on input.
export type FakeScriptStep = CanonicalEvent | DeltaFrame | { wait: "message" | "answer" };

export interface FakeRunnerAdapterOptions {
  script: readonly FakeScriptStep[];
  agentSessionId?: string | null;
  availability?: Partial<RunnerAvailability>;
}

function isWaitStep(step: FakeScriptStep): step is { wait: "message" | "answer" } {
  return "wait" in step;
}

export class FakeRunnerAdapter implements RunnerAdapter {
  readonly id = "fake";
  private readonly script: readonly FakeScriptStep[];
  private readonly agentSessionIdValue: string | null;
  private readonly availability: RunnerAvailability;

  constructor(opts: FakeRunnerAdapterOptions) {
    this.script = opts.script;
    this.agentSessionIdValue = opts.agentSessionId ?? null;
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

    const emitEnded = (reason: "completed" | "interrupted") => {
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
      async interrupt(): Promise<void> {
        if (ended) return;
        stopAndResume();
        emitEnded("interrupted");
      },
      async close(): Promise<void> {
        if (ended) return;
        stopAndResume();
        emitEnded("completed");
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
