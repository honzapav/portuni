import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import TursoSetupGate from "./components/TursoSetupGate";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <TursoSetupGate>
      <App />
    </TursoSetupGate>
  </React.StrictMode>,
);
