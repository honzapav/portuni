// #488: a RunnerAdapter whose start() blocks until the test opens its gate.
// The window between "a run row exists and the session says running" and
// "the adapter handed back a live handle" is where a second message, an
// Uzavřít or a Předat used to race the start; this makes that window as
// wide as the test needs.

import type { FakeRunnerAdapter } from "../../apps/server/domain/runner/adapters/fake.js";
import type { EventSink, RunHandle, RunStart, RunnerAdapter } from "../../apps/server/domain/runner/types.js";

export class GatedAdapter implements RunnerAdapter {
  readonly id = "fake";
  // How many runs this adapter was asked to start -- one per process, so a
  // second start is a second process on the same thread.
  startCount = 0;
  // How many of the handles it handed back were closed.
  closeCount = 0;
  // Resolves the first time start() is entered, i.e. once the start window
  // is genuinely open.
  readonly entered: Promise<void>;
  private markEntered!: () => void;
  private openGate!: () => void;
  private readonly gate: Promise<void>;

  constructor(private readonly inner: FakeRunnerAdapter) {
    this.entered = new Promise<void>((resolve) => {
      this.markEntered = resolve;
    });
    this.gate = new Promise<void>((resolve) => {
      this.openGate = resolve;
    });
  }

  open(): void {
    this.openGate();
  }

  detect() {
    return this.inner.detect();
  }

  models() {
    return this.inner.models();
  }

  async start(run: RunStart, sink: EventSink): Promise<RunHandle> {
    this.startCount += 1;
    this.markEntered();
    await this.gate;
    const handle = await this.inner.start(run, sink);
    return {
      ...handle,
      close: async () => {
        this.closeCount += 1;
        await handle.close();
      },
    };
  }
}
