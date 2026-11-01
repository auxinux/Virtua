import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "@/App";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { LanguageProvider } from "@/i18n";
import "@/index.css";
import { startTheme } from "@/theme";
import { installGlobalErrorLog } from "@/api/uiLog";

installGlobalErrorLog();
startTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <HashRouter>
        <LanguageProvider>
          <App />
        </LanguageProvider>
      </HashRouter>
    </ErrorBoundary>
  </React.StrictMode>,
);
