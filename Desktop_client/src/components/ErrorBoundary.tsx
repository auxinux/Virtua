import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  error: Error | null;
  details: string | null;
}

/**
 * A render error used to unmount the whole tree and leave a black window —
 * indistinguishable from a crash. Keep the app usable and show what happened.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, details: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Console output ends up in the WebView devtools and in the Tauri log.
    console.error("Virtua Desktop: erreur d'affichage", error, info.componentStack);
    this.setState({ details: info.componentStack ?? null });
  }

  private reset = () => this.setState({ error: null, details: null });

  private restart = () => {
    this.reset();
    window.location.reload();
  };

  render() {
    const { error, details } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="grid min-h-screen place-items-center bg-virtua-bg p-8 text-virtua-text">
        <div className="w-full max-w-2xl space-y-4 rounded border border-virtua-red/50 bg-virtua-panel p-6">
          <h1 className="text-xl font-semibold text-virtua-red">Une page de Virtua Desktop a cesse de repondre</h1>
          <p className="text-sm text-virtua-muted">
            Le reste de l'application continue de fonctionner. Vous pouvez revenir en arriere ou
            recharger la fenetre.
          </p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-3 text-xs">
            {error.message}
            {details ? `\n${details}` : ""}
          </pre>
          <div className="flex flex-wrap gap-2">
            <button className="virtua-button-primary" onClick={this.restart}>Recharger</button>
            <button className="virtua-button" onClick={this.reset}>Reessayer</button>
          </div>
        </div>
      </div>
    );
  }
}
