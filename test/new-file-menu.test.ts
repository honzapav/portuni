import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NO_MIRROR_REASON, newFileMenu } from "../apps/web/src/lib/new-file-menu.js";

// The split exists only where „Nová prezentace" could ever do something:
// integration on and Showtime.app found. Without a mirror it is there,
// disabled, and says why.
describe("newFileMenu", () => {
  it("is the plain button without the integration or without Showtime", () => {
    assert.deepEqual(
      newFileMenu({ showtimeEnabled: false, showtimeInstalled: true, hasMirror: true }),
      { kind: "plain" },
    );
    assert.deepEqual(
      newFileMenu({ showtimeEnabled: true, showtimeInstalled: false, hasMirror: true }),
      { kind: "plain" },
    );
  });

  it("splits with the presentation enabled when the node has a mirror", () => {
    assert.deepEqual(
      newFileMenu({ showtimeEnabled: true, showtimeInstalled: true, hasMirror: true }),
      { kind: "split", presentation: { enabled: true } },
    );
  });

  it("splits with the presentation disabled, and the reason, without a mirror", () => {
    assert.deepEqual(
      newFileMenu({ showtimeEnabled: true, showtimeInstalled: true, hasMirror: false }),
      { kind: "split", presentation: { enabled: false, reason: NO_MIRROR_REASON } },
    );
  });
});
