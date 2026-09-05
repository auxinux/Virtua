const colorByValue = (value: number) => {
  if (value >= 85) return "bg-virtua-red";
  if (value >= 70) return "bg-virtua-yellow";
  return "bg-virtua-accent";
};

export function MetricBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs text-virtua-muted">
        <span>{label}</span>
        <span>{value}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded bg-black/25">
        <div className={`h-full rounded ${colorByValue(value)}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </div>
    </div>
  );
}
