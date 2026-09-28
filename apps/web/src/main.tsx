import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import WorkspaceMigrationGate from "./components/WorkspaceMigrationGate";
import TursoSetupGate from "./components/TursoSetupGate";
import CentralLoginGate from "./components/CentralLoginGate";
import ErrorBoundary from "./components/ErrorBoundary";
import { installGlobalErrorOverlay } from "./lib/error-overlay";
import { migrateUnscopedStorageForCurrentWindow } from "./lib/workspace-storage";
import { bootI18n } from "./i18n";
import "./index.css";

// Surface uncaught errors on-screen — release builds have no devtools, so
// without this an uncaught throw just white-screens with no diagnostic.
installGlobalErrorOverlay();

// One-time localStorage migration (#228): must run before anything below
// reads a workspace-scoped key (CentralLoginGate's first-steps-pending
// check fires from a mount effect before <App/> even exists).
migrateUnscopedStorageForCurrentWindow();

function render() {
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
}

// Nothing renders before the boot language's `common` and `errors` are
// loaded and <html lang> is set, so no frame shows another language. A
// failed catalog load still renders: i18next falls back to the bundled
// English `common`.
bootI18n()
  .catch((err) => console.error("[i18n] boot failed", err))
  .then(render);
