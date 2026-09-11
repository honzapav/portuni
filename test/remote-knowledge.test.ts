import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  REMOTE_ABSENT,
  REMOTE_UNKNOWN,
  hashOf,
  knowledgeFromCachedHash,
  knowledgeFromRecordAndObservation,
  knowledgeFromStat,
  remotePresent,
  treatAsExisting,
} from "../apps/server/domain/sync/remote-knowledge.js";

describe("remote knowledge", () => {
  it("a cached hash proves presence; its absence proves nothing", () => {
    assert.deepEqual(knowledgeFromCachedHash("abc"), remotePresent("abc"));
    // The whole point: NULL is not "absent".
    assert.deepEqual(knowledgeFromCachedHash(null), REMOTE_UNKNOWN);
    assert.notDeepEqual(knowledgeFromCachedHash(null), REMOTE_ABSENT);
  });

  it("central's record wins, a device observation only fills a hole", () => {
    assert.deepEqual(knowledgeFromRecordAndObservation("central", "device"), remotePresent("central"));
    assert.deepEqual(knowledgeFromRecordAndObservation(null, "device"), remotePresent("device"));
    assert.deepEqual(knowledgeFromRecordAndObservation(null, null), REMOTE_UNKNOWN);
  });

  it("only a live stat can prove absence, and a failed stat proves nothing", () => {
    assert.deepEqual(knowledgeFromStat({ hash: "h", exists: true }), remotePresent("h"));
    // A backend that reports no hash on listing still proves presence.
    assert.deepEqual(knowledgeFromStat({ hash: null, exists: true }), remotePresent(null));
    assert.deepEqual(knowledgeFromStat({ hash: null, exists: false }), REMOTE_ABSENT);
    assert.equal(knowledgeFromStat(null), null);
  });

  it("only a proven-present remote counts as existing", () => {
    assert.equal(treatAsExisting(remotePresent("h")), true);
    assert.equal(treatAsExisting(remotePresent(null)), true);
    assert.equal(treatAsExisting(REMOTE_ABSENT), false);
    assert.equal(treatAsExisting(REMOTE_UNKNOWN), false);
  });

  it("hashOf yields a hash only for a present remote", () => {
    assert.equal(hashOf(remotePresent("h")), "h");
    assert.equal(hashOf(remotePresent(null)), null);
    assert.equal(hashOf(REMOTE_ABSENT), null);
    assert.equal(hashOf(REMOTE_UNKNOWN), null);
  });
});
