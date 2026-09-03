import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import WorkspaceMigrationGate from "./components/WorkspaceMigrationGate";
import TursoSetupGate from "./components/TursoSetupGate";
import CentralLoginGate from "./components/CentralLoginGate";
import ErrorBoundary from "./components/ErrorBoundary";
import { installGlobalErrorOverlay } from "./lib/error-overlay";
import { migrateUnscopedStorageForCurrentWindow } from "./lib/workspace-storage";
import "./index.css";

// Surface uncaught errors on-screen — release builds have no devtools, so
// without this an uncaught throw just white-screens with no diagnostic.
installGlobalErrorOverlay();

// One-time localStorage migration (#228): must run before anything below
// reads a workspace-scoped key (CentralLoginGate's first-steps-pending
// check fires from a mount effect before <App/> even exists).
migrateUnscopedStorageForCurrentWindow();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <WorkspaceMigrationGate>
        <TursoSetupGate>
          <CentralLoginGate>
            <App />
          </CentralLoginGate>
        </TursoSetupGate>
      </WorkspaceMigrationGate>
    </ErrorBoundary>
  </React.StrictMode>,
);
