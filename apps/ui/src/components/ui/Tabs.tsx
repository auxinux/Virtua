import React from "react";

export interface Tab {
  /** Tab identifier — use either `id` or `key` */
  id?: string;
  key?: string;
  label: string;
  icon?: React.ReactNode;
}

interface TabsProps {
  tabs: Tab[];
  active: string;
  onChange: (id: string) => void;
  className?: string;
}

export function Tabs({ tabs, active, onChange, className = "" }: TabsProps) {
  return (
    <div className={`flex border-b border-surface-500 ${className}`}>
      {tabs.map((tab) => {
        const tabId = tab.id ?? tab.key ?? tab.label;
        return (
          <button
            key={tabId}
            onClick={() => onChange(tabId)}
            className={`px-4 py-2 text-sm font-medium transition-colors flex items-center gap-1.5 ${
              active === tabId ? "tab-active" : "tab-inactive"
            }`}
          >
            {tab.icon && <span className="w-4 h-4">{tab.icon}</span>}
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
