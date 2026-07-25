import React from "react";

interface GaugeProps {
  value: number;       // 0-100
  size?: number;
  strokeWidth?: number;
  label?: string;
  sublabel?: string;
  color?: string;
}

export function Gauge({ value, size = 120, strokeWidth = 10, label, sublabel, color }: GaugeProps) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clampedValue = Math.min(100, Math.max(0, value));
  const dashOffset = circumference - (clampedValue / 100) * circumference;

  const getColor = () => {
    if (color) return color;
    if (clampedValue < 60) return "#40c057";
    if (clampedValue < 80) return "#fab005";
    return "#fa5252";
  };

  const cx = size / 2;
  const cy = size / 2;

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
          {/* Background track */}
          <circle
            cx={cx} cy={cy} r={radius}
            fill="none"
            stroke="#373a40"
            strokeWidth={strokeWidth}
          />
          {/* Value arc */}
          <circle
            cx={cx} cy={cy} r={radius}
            fill="none"
            stroke={getColor()}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            style={{ transition: "stroke-dashoffset 0.5s ease, stroke 0.3s ease" }}
          />
        </svg>
        {/* Center text */}
        <div className="absolute inset-0 flex flex-col items-center justify-center rotate-0">
          <span className="text-lg font-bold text-text-100 leading-none">{Math.round(clampedValue)}%</span>
        </div>
      </div>
      {label && <span className="text-xs font-medium text-text-300 text-center">{label}</span>}
      {sublabel && <span className="text-2xs text-text-500 text-center leading-tight">{sublabel}</span>}
    </div>
  );
}

interface MiniGaugeProps {
  value: number;
  label: string;
  detail?: string;
}

export function MiniGauge({ value, label, detail }: MiniGaugeProps) {
  const clampedValue = Math.min(100, Math.max(0, value));
  const getColor = () => {
    if (clampedValue < 60) return "bg-green-500";
    if (clampedValue < 80) return "bg-yellow-500";
    return "bg-red-500";
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between items-center">
        <span className="text-xs text-text-400">{label}</span>
        <span className="text-xs font-mono text-text-200">{Math.round(clampedValue)}%</span>
      </div>
      <div className="h-1.5 bg-surface-500 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${getColor()}`}
          style={{ width: `${clampedValue}%` }}
        />
      </div>
      {detail && <span className="text-2xs text-text-500">{detail}</span>}
    </div>
  );
}
