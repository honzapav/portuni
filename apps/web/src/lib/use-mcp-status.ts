// Polls /mcp/info on a self-adjusting cadence so the footer indicator
// reflects whether the bundled MCP server is reachable. Polls fast
// (every 2s) while the server is down so recovery shows up promptly,
// and slows to 5s once it's running again to avoid generating
// background traffic on idle desktops.

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "./backend-url";

export type McpStatus =
  | { state: "loading" }
  | { state: "running"; url: string; port: number }
  | { state: "down"; reason: string };

const POLL_RUNNING_MS = 5000;
const POLL_DOWN_MS = 2000;

export function useMcpStatus(): McpStatus {
  const [status, setStatus] = useState<McpStatus>({ state: "loading" });
  const stateRef = useRef<McpStatus>(status);
  stateRef.current = status;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Skip identical updates: a fresh object every 5s re-renders the
    // footer forever even when nothing changed.
    function apply(next: McpStatus) {
      const prev = stateRef.current;
      const same =
        prev.state === next.state &&
        (next.state !== "running" ||
          (prev.state === "running" && prev.url === next.url && prev.port === next.port)) &&
        (next.state !== "down" ||
          (prev.state === "down" && prev.reason === next.reason));
      if (!same) setStatus(next);
    }

    async function tick() {
      // No polling while the tab/window is hidden -- the indicator is not
      // visible and the requests just churn the backend.
      if (document.hidden) {
        timer = setTimeout(() => void tick(), POLL_RUNNING_MS);
        return;
      }
      try {
        const res = await apiFetch("/mcp/info");
        if (cancelled) return;
        if (!res.ok) {
          apply({ state: "down", reason: `HTTP ${res.status}` });
        } else {
          const body = (await res.json()) as { url: string; port: number };
          apply({ state: "running", url: body.url, port: body.port });
        }
      } catch (e) {
        if (cancelled) return;
        apply({
          state: "down",
          reason: e instanceof Error ? e.message : String(e),
        });
      }
      if (!cancelled) {
        const delay =
          stateRef.current.state === "running" ? POLL_RUNNING_MS : POLL_DOWN_MS;
        timer = setTimeout(() => void tick(), delay);
      }
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return status;
}
