import { useEffect, useState } from "react";

// A 1s clock for activity-indicator dots. Lives in the component that
// renders the dots -- a tick in App would re-render the whole tree every
// second forever (it used to). Pauses while the tab is hidden.
export function useNowTick(intervalMs = 1000): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
