export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}

export function formatBytesRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatPercent(value: number, max: number): string {
  if (max === 0) return "0%";
  return `${Math.round((value / max) * 100)}%`;
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (parts.length === 0) parts.push(`${Math.floor(seconds)}s`);
  return parts.join(" ");
}

export function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleString();
}
