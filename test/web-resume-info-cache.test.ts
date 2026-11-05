// Resume-info is fetched once per suspension (client traffic contract,
// rule 4): the Relace tab used to ask GET /sessions/:id/resume-info for
// every suspended row on every mount of the tab. A frame that moves the
// thread out of `suspended` forgets the answer (the next suspension has a
// new reason), and an answer older than the TTL is asked again (the
// handoff file on disk may have changed).

import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  RESUME_INFO_TTL_MS,
  cachedResumeInfo,
  invalidateResumeInfo,
  resetResumeInfoCacheForTesting,
} from "../apps/web/src/lib/resume-info-cache.js";
import type { SessionResumeInfo } from "../apps/web/src/types.js";

const info = { resumable: true } as unknown as SessionResumeInfo;

function counting(fail = false) {
  let calls = 0;
  const fetcher = (_id: string): Promise<SessionResumeInfo> => {
    calls += 1;
    return fail ? Promise.reject(new Error("down")) : Promise.resolve(info);
  };
  return { fetcher, calls: () => calls };
}

describe("cachedResumeInfo", () => {
  beforeEach(() => resetResumeInfoCacheForTesting());

  it("fetches once for the same session within the TTL", async () => {
    const { fetcher, calls } = counting();
    assert.equal(await cachedResumeInfo("s1", fetcher, 1_000), info);
    assert.equal(await cachedResumeInfo("s1", fetcher, 1_000 + RESUME_INFO_TTL_MS - 1), info);
    assert.equal(calls(), 1);
  });

  it("fetches again once the answer is older than the TTL", async () => {
    const { fetcher, calls } = counting();
    await cachedResumeInfo("s1", fetcher, 1_000);
    await cachedResumeInfo("s1", fetcher, 1_000 + RESUME_INFO_TTL_MS);
    assert.equal(calls(), 2);
  });

  it("fetches again after the session was invalidated (it ran again and suspended anew)", async () => {
    const { fetcher, calls } = counting();
    await cachedResumeInfo("s1", fetcher, 1_000);
    invalidateResumeInfo("s1");
    await cachedResumeInfo("s1", fetcher, 1_001);
    assert.equal(calls(), 2);
  });

  it("does not cache a failure", async () => {
    const failing = counting(true);
    await assert.rejects(cachedResumeInfo("s1", failing.fetcher, 1_000));
    const ok = counting();
    assert.equal(await cachedResumeInfo("s1", ok.fetcher, 1_000), info);
    assert.equal(ok.calls(), 1);
  });

  it("shares one in-flight fetch between two rows asking at once", async () => {
    const { fetcher, calls } = counting();
    await Promise.all([cachedResumeInfo("s1", fetcher, 1_000), cachedResumeInfo("s1", fetcher, 1_000)]);
    assert.equal(calls(), 1);
  });
});
