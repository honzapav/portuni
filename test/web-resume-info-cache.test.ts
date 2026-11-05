// Resume-info is fetched once per suspension (client traffic contract,
// rule 4): the Relace tab used to ask GET /sessions/:id/resume-info for
// every suspended row on every mount of the tab.

import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cachedResumeInfo,
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

  it("fetches once for the same session and suspension", async () => {
    const { fetcher, calls } = counting();
    const session = { id: "s1", state: "suspended", last_active_at: "2026-01-01 10:00:00" };
    assert.equal(await cachedResumeInfo(session, fetcher), info);
    assert.equal(await cachedResumeInfo(session, fetcher), info);
    assert.equal(calls(), 1);
  });

  it("fetches again for a new suspension of the same session", async () => {
    const { fetcher, calls } = counting();
    await cachedResumeInfo({ id: "s1", state: "suspended", last_active_at: "2026-01-01 10:00:00" }, fetcher);
    await cachedResumeInfo({ id: "s1", state: "suspended", last_active_at: "2026-01-01 11:00:00" }, fetcher);
    assert.equal(calls(), 2);
  });

  it("does not cache a failure", async () => {
    const failing = counting(true);
    const session = { id: "s1", state: "suspended", last_active_at: "2026-01-01 10:00:00" };
    await assert.rejects(cachedResumeInfo(session, failing.fetcher));
    const ok = counting();
    assert.equal(await cachedResumeInfo(session, ok.fetcher), info);
    assert.equal(ok.calls(), 1);
  });

  it("shares one in-flight fetch between two rows asking at once", async () => {
    const { fetcher, calls } = counting();
    const session = { id: "s1", state: "suspended", last_active_at: "2026-01-01 10:00:00" };
    await Promise.all([cachedResumeInfo(session, fetcher), cachedResumeInfo(session, fetcher)]);
    assert.equal(calls(), 1);
  });
});
