import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useVdmAuth } from "@/hooks/useVdmAuth";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { VdmTask } from "@/types/vdm";

function Icon({ path, className = "w-4 h-4" }: { path: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d={path} />
    </svg>
  );
}

export function TopBar() {
  const { user, logout } = useVdmAuth();
  const navigate = useNavigate();
  const [showUserMenu, setShowUserMenu] = useState(false);

  const tasksQuery = useQuery<VdmTask[]>({
    queryKey: ["vdm-tasks-running"],
    queryFn: () => api.get("/api/vdm/tasks?status=running&limit=10"),
    refetchInterval: 4000,
  });

  const runningTasks = tasksQuery.data ?? [];

  return (
    <header className="flex items-center h-12 px-4 border-b border-vdm-border bg-vdm-surface/50 gap-3 flex-shrink-0">
      {/* Active tasks indicator */}
      <button
        onClick={() => navigate("/tasks")}
        className="flex items-center gap-2 px-2.5 py-1.5 rounded hover:bg-vdm-surfaceHover transition-colors"
      >
        <Icon
          path="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25ZM6.75 12h.008v.008H6.75V12Zm0 3h.008v.008H6.75V15Zm0 3h.008v.008H6.75V18Z"
          className="w-4 h-4 text-vdm-textMuted"
        />
        <span className="text-sm text-vdm-textMuted">Tasks</span>
        {runningTasks.length > 0 && (
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-vdm-accent animate-pulse" />
            <span className="text-xs text-vdm-accentHover font-medium">{runningTasks.length} running</span>
          </span>
        )}
      </button>

      {/* Running task progress strip */}
      {runningTasks.length > 0 && (
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {runningTasks.slice(0, 2).map((task) => (
            <div key={task.id} className="flex items-center gap-2 px-2 py-1 bg-vdm-surface rounded border border-vdm-border text-xs min-w-0">
              <div className="w-1.5 h-1.5 rounded-full bg-vdm-accent animate-pulse flex-shrink-0" />
              <span className="truncate text-vdm-textMuted max-w-32">{task.label}</span>
              <span className="text-vdm-accent font-medium flex-shrink-0">{task.progress}%</span>
            </div>
          ))}
          {runningTasks.length > 2 && (
            <span className="text-xs text-vdm-textMuted">+{runningTasks.length - 2} more</span>
          )}
        </div>
      )}

      <div className="flex-1" />

      {/* User menu */}
      <div className="relative">
        <button
          onClick={() => setShowUserMenu((v) => !v)}
          className="flex items-center gap-2 px-2.5 py-1.5 rounded hover:bg-vdm-surfaceHover transition-colors"
        >
          <div className="w-6 h-6 rounded-full bg-vdm-accent/20 flex items-center justify-center flex-shrink-0">
            <span className="text-xs font-semibold text-vdm-accent">{(user?.displayName ?? user?.username ?? "?")[0].toUpperCase()}</span>
          </div>
          <span className="text-sm text-vdm-text">{user?.displayName ?? user?.username}</span>
          <span className="text-xs text-vdm-textMuted capitalize">{user?.role}</span>
          <Icon path="m19.5 8.25-7.5 7.5-7.5-7.5" className="w-3 h-3 text-vdm-textMuted" />
        </button>

        {showUserMenu && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setShowUserMenu(false)} />
            <div className="absolute right-0 top-full mt-1 w-48 bg-vdm-surface border border-vdm-border rounded-lg shadow-xl z-20 overflow-hidden">
              <div className="px-3 py-2 border-b border-vdm-border">
                <p className="text-sm font-medium text-vdm-text">{user?.displayName ?? user?.username}</p>
                <p className="text-xs text-vdm-textMuted capitalize">{user?.role}</p>
              </div>
              <button
                onClick={() => { navigate("/settings"); setShowUserMenu(false); }}
                className="w-full text-left px-3 py-2 text-sm text-vdm-textMuted hover:text-vdm-text hover:bg-vdm-surfaceHover transition-colors"
              >
                Account Settings
              </button>
              <button
                onClick={() => logout()}
                className="w-full text-left px-3 py-2 text-sm text-vdm-danger hover:bg-vdm-danger/10 transition-colors"
              >
                Sign Out
              </button>
            </div>
          </>
        )}
      </div>
    </header>
  );
}
