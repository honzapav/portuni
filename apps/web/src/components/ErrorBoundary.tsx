// React error boundary. Catches render/commit/lifecycle throws in the
// subtree and shows a readable fallback instead of unmounting the whole
// app to a white screen. Async throws (event listeners, rAF, promises)
// do NOT reach here — those are surfaced by installGlobalErrorOverlay().
//
// Before this existed, a single bad render anywhere blanked the entire
// desktop app with no diagnostic (release builds have no devtools).

import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportError } from "../lib/error-overlay";

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
            Portuni narazil na chybu při vykreslení. Zkopíruj text níže a
            přepni se zpět na fungujícího agenta.
          </div>
          <button
            type="button"
            onClick={() => this.setState({ error: null, componentStack: null })}
            style={{
              marginBottom: 16,
              padding: "4px 12px",
              border: "1px solid #555",
              borderRadius: 4,
              background: "transparent",
              color: "#ddd",
              cursor: "pointer",
            }}
          >
            Zkusit znovu vykreslit
          </button>
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
