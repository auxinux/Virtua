import React from "react";

export function Sparkline({
  values,
  color = "#228be6",
  height = 64,
}: {
  values: number[];
  color?: string;
  height?: number;
}) {
  if (!values.length) {
    return <div className="h-16 rounded bg-surface-700/40" />;
  }

  const width = 240;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = Math.max(max - min, 1);
  const points = values.map((value, index) => {
    const x = (index / Math.max(values.length - 1, 1)) * width;
    const y = height - ((value - min) / range) * height;
    return `${x},${y}`;
  }).join(" ");

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-16 w-full">
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  );
}
