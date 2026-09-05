import { Info } from "lucide-react";

export function AboutPanel() {
  return (
    <div className="rounded border border-virtua-border bg-virtua-panel p-4">
      <div className="mb-3 flex items-center gap-2">
        <Info className="h-4 w-4 text-virtua-accent" />
        <p className="text-sm font-medium">A propos</p>
      </div>
      <div className="space-y-2 text-sm">
        <div className="flex justify-between gap-3"><span className="text-virtua-muted">Version</span><span>0.2.0</span></div>
        <div className="flex justify-between gap-3">
          <span className="text-virtua-muted">Application</span>
          <span className="text-right">AuxiNux Virtua Desktop Client</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-virtua-muted">Createur</span>
          <span className="text-right">André Porlier</span>
        </div>
      </div>
    </div>
  );
}
