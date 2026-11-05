// Resume-info is fetched once per suspension and once per tab, not once
// per row (client traffic contract, rules 4 and 6): the Relace tab asks
// POST /sessions/resume-info for every suspended row it does not have a
// fresh answer for, primes this window-wide cache, and the rows read it.
// A frame that moves the thread out of `suspended` forgets the answer
// (the next suspension has a new reason), and an answer older than the TTL
// is asked again (the handoff file on disk may have changed).

import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  RESUME_INFO_TTL_MS,
  invalidateResumeInfo,
  peekResumeInfo,
  primeResumeInfo,
  resetResumeInfoCacheForTesting,
  resumeInfoIdsToAsk,
} from "../apps/web/src/lib/resume-info-cache.js";
import type { SessionResumeInfo } from "../apps/web/src/types.js";

const info = (id: string) => ({ session_id: id, conversation_resumable: true }) as unknown as SessionResumeInfo;

describe("resume-info cache", () => {
  beforeEach(() => resetResumeInfoCacheForTesting());

  it("a primed answer is read back within the TTL and forgotten after it", () => {
    primeResumeInfo([info("s1")], 1_000);
    assert.deepEqual(peekResumeInfo("s1", 1_000 + RESUME_INFO_TTL_MS - 1), info("s1"));
    assert.equal(peekResumeInfo("s1", 1_000 + RESUME_INFO_TTL_MS), null);
  });

  it("invalidate forgets one session (it ran again and suspended anew)", () => {
    primeResumeInfo([info("s1"), info("s2")], 1_000);
    invalidateResumeInfo("s1");
    assert.equal(peekResumeInfo("s1", 1_001), null);
    assert.deepEqual(peekResumeInfo("s2", 1_001), info("s2"));
  });

  it("asks only for the suspended rows without a fresh answer", () => {
    primeResumeInfo([info("s1")], 1_000);
    const rows = [
      { id: "s1", state: "suspended" },
      { id: "s2", state: "suspended" },
      { id: "s3", state: "running" },
    ];
    assert.deepEqual(resumeInfoIdsToAsk(rows, 1_001), ["s2"]);
    assert.deepEqual(resumeInfoIdsToAsk(rows, 1_000 + RESUME_INFO_TTL_MS), ["s1", "s2"]);
  });
});
