// The load cycle the settings lists share (runner instances, workspaces,
// users, access requests): a loading/error/ok state loaded on mount,
// `load()` to reload, a mounted guard for async work that resolves after
// the panel unmounted, the set of row ids with an action in flight, and a
// create form's busy/error submit.

import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { displayError } from "../errors";

type ListLoadState<T extends object> =
  | { kind: "loading" }
  | { kind: "error"; reason: string }
  | ({ kind: "ok" } & T);

// React 18 StrictMode double-invokes effects in dev (setup -> cleanup ->
// setup again) synchronously, before any fetch can possibly resolve --
// resetting to true on setup (not just false on cleanup) is what keeps a
// real async response after that dance from being silently dropped for the
// rest of the mount's lifetime.
function useMountedRef(): MutableRefObject<boolean> {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  return mountedRef;
}

// `fetchList` must be stable (a module-level function): `load` and the
// mount effect depend on it.
export function useListLoad<T extends object>(fetchList: () => Promise<T>) {
  const mountedRef = useMountedRef();
  const [state, setState] = useState<ListLoadState<T>>({ kind: "loading" });

  const load = useCallback(async () => {
    if (!mountedRef.current) return;
    setState({ kind: "loading" });
    try {
      const data = await fetchList();
      if (mountedRef.current) setState({ kind: "ok", ...data });
    } catch (e) {
      if (mountedRef.current) {
        setState({ kind: "error", reason: displayError(e) });
      }
    }
  }, [mountedRef, fetchList]);

  useEffect(() => {
    void load();
  }, [load]);

  return { state, setState, load, mountedRef };
}

// Row ids with an action in flight; `withPending(id, fn)` marks `id` while
// `fn` runs.
export function usePendingIds(mountedRef: MutableRefObject<boolean>) {
  const [pending, setPending] = useState<Set<string>>(() => new Set());

  function withPending<T>(id: string, fn: () => Promise<T>): Promise<T> {
    setPending((prev) => new Set([...prev, id]));
    return fn().finally(() => {
      if (!mountedRef.current) return;
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    });
  }

  return { pending, withPending };
}

// A create form's submit: `run(fn)` raises `busy` and clears `error` while
// `fn` runs, and shows a failure as `error`.
export function useFormAction() {
  const mountedRef = useMountedRef();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      if (mountedRef.current) setError(displayError(e));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  return { busy, error, setError, run, mountedRef };
}
