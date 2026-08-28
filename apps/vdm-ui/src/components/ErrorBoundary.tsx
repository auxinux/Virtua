import { Component, type ReactNode } from "react";

interface Props { children: ReactNode; }
interface State { error: Error | null; }

// Catches any render-time crash so a bug shows a readable error + a way back,
// instead of a blank page that traps the user.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="p-6 max-w-xl mx-auto mt-10">
          <div className="vdm-card p-5 space-y-3 border-vdm-danger/40">
            <h2 className="text-base font-semibold text-vdm-danger">Something went wrong</h2>
            <p className="text-sm text-vdm-textMuted">An unexpected error occurred while rendering this page.</p>
            <pre className="text-xs font-mono text-vdm-text bg-vdm-bg rounded p-3 overflow-auto max-h-40 whitespace-pre-wrap">{this.state.error.message}</pre>
            <div className="flex gap-2">
              <button className="vdm-btn-primary" onClick={() => { this.setState({ error: null }); }}>Try again</button>
              <button className="vdm-btn-ghost" onClick={() => { window.location.href = "/dashboard"; }}>Go to Dashboard</button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}