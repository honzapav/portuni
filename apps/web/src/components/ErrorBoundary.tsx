// React error boundary. Catches render/commit/lifecycle throws in the
// subtree and shows a readable fallback instead of unmounting the whole
// app to a white screen. Async throws (event listeners, rAF, promises)
// do NOT reach here — those are surfaced by installGlobalErrorOverlay().
//
// Before this existed, a single bad render anywhere blanked the entire
// desktop app with no diagnostic (release builds have no devtools).

import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportError } from "../lib/error-overlay";
import { i18n } from "../i18n";
import { Button } from "@/components/ui/button";

type Props = { children: ReactNode };
type State = { error: Error | null; componentStack: string | null };

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ componentStack: info.componentStack ?? null });
    reportError("react-render", error, info.componentStack ?? undefined);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 2147483646,
            background: "#0a0b0f",
            color: "#ffb4b4",
            font: "12.5px/1.5 ui-monospace, Menlo, monospace",
            padding: "24px",
            overflow: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          <div style={{ color: "#ffe08a", fontWeight: 600, marginBottom: 12 }}>
            {i18n.t(($) => $.error_boundary.title, { ns: "common" })}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => this.setState({ error: null, componentStack: null })}
            className="mb-4 border-[#555] bg-transparent text-[#ddd] hover:bg-[#333] hover:text-white"
          >
            {i18n.t(($) => $.error_boundary.retry, { ns: "common" })}
          </Button>
          <div>
            {this.state.error.name}: {this.state.error.message}
            {"\n"}
            {this.state.error.stack}
            {this.state.componentStack ? `\n\n${this.state.componentStack}` : ""}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
