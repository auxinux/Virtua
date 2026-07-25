import React from "react";

export function ScopeNotice({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warning";
  title: string;
  children: React.ReactNode;
}) {
  const palette = tone === "warning"
    ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
    : "border-accent-blue/30 bg-accent-blue/10 text-text-200";

  return (
    <div className={`rounded-lg border px-4 py-3 ${palette}`}>
      <div className="text-sm font-semibold">{title}</div>
      <div className="mt-1 text-xs text-text-400">
        {children}
      </div>
    </div>
  );
}
