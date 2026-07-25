import React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { apiGet, apiPost } from "../../api/client";
import { MiniGauge } from "../ui/Gauge";
import { formatBytes, formatUptime } from "../../utils/formatBytes";
import type { SystemStats, SystemInfo } from "@auxinux/shared";
import i18n, { changeAppLanguage, getAvailableLanguages, type UiLanguage } from "../../i18n";
import auxinuxLogo from "../../assets/logo-AuxiNux.png";
import { applyTheme, getStoredTheme, type AppTheme } from "../../utils/theme";
import { useAuth } from "../../utils/useAuth";
import { useSimpleMode } from "../../utils/useSimpleMode";
import {
  Sun, Moon, Globe, LogOut, Plus, ShieldCheck,
  Settings2, LayoutDashboard, Monitor, Network
} from "lucide-react";

export function TopBar() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [theme, setTheme] = React.useState<AppTheme>(() => getStoredTheme());
  const { user, capabilities } = useAuth();
  const { isSimpleMode, toggleSimpleMode } = useSimpleMode();

  React.useEffect(() => {
    const onThemeChange = (event: Event) => {
      const nextTheme = (event as CustomEvent<AppTheme>).detail;
      setTheme(nextTheme);
    };
    window.addEventListener("auxinux-theme-change", onThemeChange as EventListener);
    return () => window.removeEventListener("auxinux-theme-change", onThemeChange as EventListener);
  }, []);

  const { data: stats } = useQuery<SystemStats>({
    queryKey: ["system", "stats"],
    queryFn: () => apiGet<SystemStats>("/api/system/stats"),
    refetchInterval: 5_000,
    enabled: !!capabilities?.sections.dashboard,
  });

  const { data: info } = useQuery<SystemInfo>({
    queryKey: ["system", "info"],
    queryFn: () => apiGet<SystemInfo>("/api/system/info"),
    staleTime: 60_000,
    enabled: !!capabilities?.sections.dashboard,
  });

  const { data: languages = [] } = useQuery<UiLanguage[]>({
    queryKey: ["ui", "languages"],
    queryFn: () => getAvailableLanguages(),
    staleTime: 5 * 60_000,
  });

  const logout = useMutation({
    mutationFn: () => apiPost("/api/auth/logout"),
    onSuccess: () => {
      sessionStorage.removeItem("tasksSince");
      qc.clear();
      navigate("/login");
    },
  });

  const toggleTheme = () => {
    const nextTheme: AppTheme = theme === "dark" ? "light" : "dark";
    applyTheme(nextTheme);
    setTheme(nextTheme);
  };

  return (
    <header className="h-14 bg-surface-900 border-b border-surface-600 flex items-center px-4 gap-4 flex-shrink-0">
      <div className="flex items-center gap-3 pr-4 border-r border-surface-700 min-w-[168px]">
        <img src={auxinuxLogo} alt="AuxiNux" className="h-11 w-auto object-contain flex-shrink-0" />
        <div className="flex flex-col leading-none">
          <span className="text-[13px] font-semibold uppercase tracking-[0.28em] text-text-300">
            Virtua
          </span>
        </div>
      </div>

      {capabilities?.sections.dashboard && !isSimpleMode && (
        <div className="flex items-center gap-2 text-xs text-text-400">
          <Monitor className="w-3.5 h-3.5" />
          <span className="font-medium text-text-300">{info?.hostname ?? "..."}</span>
          {info && <span className="text-text-500">{info.primaryIp ?? info.publicIps?.[0] ?? info.allIps[0]}</span>}
        </div>
      )}

      {/* Mini stats - Hidden in Simple Mode */}
      {capabilities?.sections.dashboard && stats && !isSimpleMode && (
        <div className="flex items-center gap-6 flex-1 justify-center">
          <div className="w-28">
            <MiniGauge
              value={stats.cpuUsage}
              label={`CPU (${stats.cpuCount} cores)`}
              detail={`${stats.loadavg[0].toFixed(2)} load`}
            />
          </div>
          <div className="w-28">
            <MiniGauge
              value={stats.mem.total > 0 ? (stats.mem.used / stats.mem.total) * 100 : 0}
              label={t("res.memory")}
              detail={`${formatBytes(stats.mem.used)} / ${formatBytes(stats.mem.total)}`}
            />
          </div>
          <div className="w-28">
            <MiniGauge
              value={stats.disk.total > 0 ? (stats.disk.used / stats.disk.total) * 100 : 0}
              label={t("res.rootDisk")}
              detail={`${formatBytes(stats.disk.used)} / ${formatBytes(stats.disk.total)}`}
            />
          </div>
          <div className="text-xs text-text-500">
            <span className="text-text-400">↑</span> {formatBytes(stats.network.txBytes)}
            <span className="mx-1 text-text-600">/</span>
            <span className="text-text-400">↓</span> {formatBytes(stats.network.rxBytes)}
          </div>
          {stats.uptime > 0 && (
            <div className="text-2xs text-text-500">
              {t("dashboard.upShort")} {formatUptime(stats.uptime)}
            </div>
          )}
        </div>
      )}

      {isSimpleMode && (
        <div className="flex-1 flex items-center justify-center">
          <div className="flex items-center gap-2 text-green-400 bg-green-400/10 px-3 py-1 rounded-full border border-green-400/20 animate-pulse">
            <ShieldCheck className="w-4 h-4" />
            <span className="text-xs font-semibold">{t("status.systemHealthy", "Système en bonne santé")}</span>
          </div>
        </div>
      )}

      {/* Right side */}
      <div className="flex items-center gap-2 ml-auto">
        {/* Simple Mode Toggle */}
        <button
          onClick={toggleSimpleMode}
          className={`btn btn-sm flex items-center gap-2 px-3 ${isSimpleMode ? "bg-accent-blue/20 text-accent-blue-light border-accent-blue/30" : "bg-surface-700 text-text-400 border-surface-500"}`}
          title={isSimpleMode ? "Passer en mode Expert" : "Passer en mode Simple"}
        >
          {isSimpleMode ? <LayoutDashboard className="w-4 h-4" /> : <Settings2 className="w-4 h-4" />}
          <span className="hidden sm:inline">{isSimpleMode ? "Mode Simple" : "Mode Expert"}</span>
        </button>

        {capabilities?.sections.createWizard && (
          <button onClick={() => navigate("/create")} className="btn-primary btn-sm flex items-center gap-1.5">
            <Plus className="w-4 h-4" />
            <span>{t("wizard.new")}</span>
          </button>
        )}

        <button
          onClick={toggleTheme}
          className="btn btn-sm"
          title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        >
          {theme === "dark" ? <Sun className="w-4 h-4 text-yellow-400" /> : <Moon className="w-4 h-4 text-blue-400" />}
        </button>

        {/* Language toggle */}
        <div className="relative group">
          <Globe className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-500 pointer-events-none" />
          <select
            value={i18n.language.toUpperCase()}
            onChange={(e) => { void changeAppLanguage(e.target.value); }}
            className="bg-surface-700 border border-surface-500 rounded pl-7 pr-2 py-1 text-2xs text-text-300 appearance-none focus:outline-none focus:border-accent-blue transition-colors cursor-pointer"
            aria-label={t("auth.language")}
          >
            {languages.map((language) => (
              <option key={language.code} value={language.code}>
                {language.code}
              </option>
            ))}
          </select>
        </div>

        {/* User menu */}
        <div className="flex items-center gap-2 ml-2 pl-2 border-l border-surface-700">
          <div className="hidden sm:block text-right">
            <div className="text-xs font-medium text-text-200 leading-tight">{user?.username ?? "..."}</div>
            <div className="text-[10px] text-text-500 uppercase tracking-wider">{user?.role}</div>
          </div>
          <div className="w-8 h-8 rounded-full bg-accent-blue/30 border border-accent-blue/20 flex items-center justify-center text-accent-blue-light text-xs font-bold shadow-sm">
            {(user?.username ?? "?")[0].toUpperCase()}
          </div>
          <button
            onClick={() => logout.mutate()}
            className="text-text-500 hover:text-state-stopped transition-colors p-1.5 rounded hover:bg-surface-600"
            title={t("auth.logout")}
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </header>
  );
}
