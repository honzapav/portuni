// The caller's own identity, as GET /me answers it: id and whether the
// global scope allows the manage tier. One hook for every surface that
// gates session actions on ownership or manage scope (DetailPane's Relace
// tab, OverviewView's inbox ordering, SessionChat's header actions) --
// each used to run its own fetchMe(). Defaults to "nobody, no manage"
// until the fetch resolves or if it fails, so nothing is ever offered
// optimistically.
import { useEffect, useState } from "react";
import { fetchMe } from "../api";

export interface Me {
  meId: string | null;
  canManage: boolean;
}

let cached: Me | null = null;
let inflight: Promise<Me> | null = null;

function loadMe(): Promise<Me> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = fetchMe()
      .then((me) => {
        cached = { meId: me.id, canManage: me.global_scope === "manage" || me.global_scope === "admin" };
        return cached;
      })
      .catch(() => {
        inflight = null;
        return { meId: null, canManage: false };
      });
  }
  return inflight;
}

// Test-only: forget the cached answer between tests.
export function resetMeForTesting(): void {
  cached = null;
  inflight = null;
}

export function useMe(): Me {
  const [me, setMe] = useState<Me>(() => cached ?? { meId: null, canManage: false });
  useEffect(() => {
    let cancelled = false;
    void loadMe().then((m) => {
      if (!cancelled) setMe(m);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return me;
}
