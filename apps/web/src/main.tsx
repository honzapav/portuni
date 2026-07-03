import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import TursoSetupGate from "./components/TursoSetupGate";
import CentralLoginGate from "./components/CentralLoginGate";
import ErrorBoundary from "./components/ErrorBoundary";
import { installGlobalErrorOverlay } from "./lib/error-overlay";
import "./index.css";

// Surface uncaught errors on-screen — release builds have no devtools, so
// without this an uncaught throw just white-screens with no diagnostic.
installGlobalErrorOverlay();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <TursoSetupGate>
        <CentralLoginGate>
          <App />
        </CentralLoginGate>
      </TursoSetupGate>
    </ErrorBoundary>
  </React.StrictMode>,
);
