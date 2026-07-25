import React from "react";

interface MetricBarProps {
  label: string;
  /** 0–100 */
  value: number;
  /** Right-aligned text (defaults to `${value}%`) */
  valueLabel?: string;
  className?: string;
}

/**
 * Compact labelled progress bar used in the Console/Dashboard headers.
 * Colour shifts green → amber → red as the value climbs.
 */
export function MetricBar({ label, value, valueLabel, className = "" }: MetricBarProps) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  const color = pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className={className}>
      <div className="flex items-center justify-between text-xs text-text-300 mb-1">
        <span>{label}</span>
        <span className="font-mono text-text-200">{valueLabel ?? `${pct}%`}</span>
      </div>
      <div className="h-1.5 rounded-full bg-surface-700 overflow-hidden">
        <div className={`h-full ${color} transition-all duration-500`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
