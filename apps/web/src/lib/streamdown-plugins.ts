// Streamdown's cjk/code/math/mermaid plugins are individually heavy (mermaid
// especially -- a full diagram-rendering engine) and only a small fraction
// of chat messages ever use them. Lazy-load them the way TerminalTabs.tsx
// lazy-loads xterm, instead of bundling all four onto the startup path.
// Streamdown itself renders plain markdown fine with `plugins` undefined,
// so the transcript is never blocked on this -- it just upgrades in place
// (CJK line-breaking, syntax highlighting, math, diagrams) once the chunk
// arrives.

import { useEffect, useState } from "react";
import type { StreamdownProps } from "streamdown";

export type StreamdownPlugins = NonNullable<StreamdownProps["plugins"]>;

let cached: Promise<StreamdownPlugins> | null = null;

export function loadStreamdownPlugins(): Promise<StreamdownPlugins> {
  if (!cached) {
    cached = Promise.all([
      import("@streamdown/cjk"),
      import("@streamdown/code"),
      import("@streamdown/math"),
      import("@streamdown/mermaid"),
    ]).then(([cjkMod, codeMod, mathMod, mermaidMod]) => ({
      cjk: cjkMod.cjk,
      code: codeMod.code,
      math: mathMod.math,
      mermaid: mermaidMod.mermaid,
    }));
  }
  return cached;
}

export function useStreamdownPlugins(): StreamdownPlugins | undefined {
  const [plugins, setPlugins] = useState<StreamdownPlugins | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void loadStreamdownPlugins().then((loaded) => {
      if (!cancelled) setPlugins(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return plugins;
}
