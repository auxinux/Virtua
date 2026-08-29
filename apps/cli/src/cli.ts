#!/usr/bin/env node
import { spawnSync } from "child_process";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import pc from "picocolors";
import Table from "cli-table3";
import ora from "ora";

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";
type ResourceKind = "vm" | "lxc" | "docker";

interface SessionFile {
  baseUrl: string;
  csrfToken: string;
  cookies: string;
  username?: string;
  savedAt: string;
}

interface RunnerResponse<T = unknown> {
  id: string;
  ok: boolean;
  result?: T;
  error?: string;
}

const DEFAULT_BASE_URL = process.env.VIRTUA_URL ?? "http://127.0.0.1:8441";
const SESSION_DIR = path.join(os.homedir(), ".config", "auxinuxvirtual");
const SESSION_PATH = path.join(SESSION_DIR, "virtua-session.json");
const RUNNER_SOCK_PATH = process.env.AUXINUX_RUNNER_SOCK ?? "/run/auxinuxvirtual.sock";
const RUNNER_TIMEOUT_MS = Number(process.env.VIRTUA_RUNNER_TIMEOUT_MS ?? 30 * 60 * 1000);

// Version: read from the adjacent package.json so release.sh is the single
// source of truth (it stamps all package.json files before archiving).
function readPkgVersion(): string {
  try {
    const pkgPath = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version?: string };
    if (pkg.version) return pkg.version;
  } catch { /* fall through */ }
  // Fallback: try the root workspace package.json two levels up from dist/
  try {
    const rootPkg = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(rootPkg, "utf-8")) as { version?: string };
    if (pkg.version) return pkg.version;
  } catch { /* fall through */ }
  return "0.7.64";
}
const VIRTUA_VERSION = readPkgVersion();

// ── Langue (EN par défaut · `virtua setlang FR|EN`) ─────────────────────────
type Lang = "en" | "fr";
const LANG_FILE_SYSTEM = "/etc/auxinuxvirtual/cli-lang";
const LANG_FILE_USER = path.join(SESSION_DIR, "lang");

function resolveLang(): Lang {
  const env = (process.env.VIRTUA_LANG ?? "").toLowerCase();
  if (env.startsWith("fr")) return "fr";
  if (env.startsWith("en")) return "en";
  for (const f of [LANG_FILE_SYSTEM, LANG_FILE_USER]) {
    try {
      const v = fs.readFileSync(f, "utf8").trim().toLowerCase();
      if (v === "fr" || v === "en") return v;
    } catch { /* not set */ }
  }
  return "en"; // default English
}
let LANG: Lang = resolveLang();

/** Inline bilingual string: returns the English or French variant per current LANG. */
function L(en: string, fr: string): string {
  return LANG === "fr" ? fr : en;
}

function setLang(code: string | undefined) {
  const c = (code ?? "").toLowerCase();
  const lang: Lang = c.startsWith("fr") ? "fr" : c.startsWith("en") ? "en" : (() => {
    throw new Error("Usage: virtua setlang EN | FR");
  })();
  try {
    fs.mkdirSync("/etc/auxinuxvirtual", { recursive: true });
    fs.writeFileSync(LANG_FILE_SYSTEM, `${lang}\n`);
  } catch {
    ensureSessionDir();
    fs.writeFileSync(LANG_FILE_USER, `${lang}\n`);
  }
  LANG = lang;
  console.log(lang === "fr" ? pc.green("Langue réglée sur Français.") : pc.green("Language set to English."));
}

// ── Pretty-print helpers ───────────────────

function colorState(state: string): string {
  const s = (state ?? "").toLowerCase();
  if (/(running|active|up|online|success|ok)/.test(s)) return pc.green(state);
  if (/(stopped|inactive|exited|dead|down|off|failed|crit)/.test(s)) return pc.red(state);
  if (/(paused|frozen|degraded|starting|stopping|warn)/.test(s)) return pc.yellow(state);
  return state;
}

function renderTable(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  if (!rows.length) return pc.dim(L("(none)", "(aucune)"));
  const cols = columns ?? [...rows.reduce((set, r) => { Object.keys(r).forEach((k) => set.add(k)); return set; }, new Set<string>())];

  const table = new Table({
    head: cols.map(c => pc.bold(pc.cyan(c.toUpperCase()))),
    style: { head: [], border: [] },
    chars: {
      'top': '─', 'top-mid': '┬', 'top-left': '┌', 'top-right': '┐',
      'bottom': '─', 'bottom-mid': '┴', 'bottom-left': '└', 'bottom-right': '┘',
      'left': '│', 'left-mid': '├', 'mid': '─', 'mid-mid': '┼',
      'right': '│', 'right-mid': '┤', 'middle': '│'
    }
  });

  const cell = (v: unknown, colName: string) => {
    const s = v === undefined || v === null ? "" : Array.isArray(v) ? v.join(", ") : String(v);
    const cn = colName.toLowerCase();
    if (cn === "state" || cn === "état" || cn === "status" || cn === "statut" || cn === "health" || cn === "santé") return colorState(s);
    return s;
  };

  rows.forEach(r => {
    table.push(cols.map(c => cell(r[c], c)));
  });

  return table.toString();
}

function kv(label: string, value: string) {
  console.log(`  ${pc.dim(label.padEnd(12))} ${value}`);
}

function fmtBytes(n?: number): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function fmtUptime(seconds?: number): string {
  if (seconds === undefined || seconds === null) return "";
  let s = Math.floor(seconds);
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60);
  return [d ? `${d}j` : "", h ? `${h}h` : "", `${m}m`].filter(Boolean).join(" ");
}

function printHelp() {
  const brand = pc.bold(pc.cyan("Virtua CLI"));
  const version = pc.dim(`v${VIRTUA_VERSION}`);
  console.log(`\n  ${brand} ${version}\n`);

  const sections = LANG === "fr" ? [
    { title: "GÉNÉRAL", cmds: [
      ["virtua -h", "Afficher cette aide"],
      ["virtua status", "Vue d'ensemble de l'hôte (CPU/RAM/Disque)"],
      ["virtua list", "Toutes les machines (VM + LXC + Docker)"],
      ["virtua gui", "Interface graphique terminal (dialog)"],
      ["virtua setlang EN|FR", "Changer la langue"],
    ]},
    { title: "MACHINES (vm | lxc | docker)", cmds: [
      ["virtua <type> list", "Lister les machines"],
      ["virtua <type> info <id>", "Détails d'une machine"],
      ["virtua <type> start <id>", "Démarrer une machine"],
      ["virtua <type> stop <id>", "Arrêter une machine"],
      ["virtua <type> autostart <id> [on|off|status]", "Gérer le démarrage automatique"],
      ["virtua <type> console <id>", "Ouvrir la console (hôte seulement)"],
    ]},
    { title: "DOCKER (avancé)", cmds: [
      ["virtua docker edit <id> --json '{...}'", "Éditer un conteneur (ports, volumes, env, image, commande, réseau, CPU/RAM)"],
      ["virtua docker exec <id> <cmd...>", "Exécuter une commande dans un conteneur"],
      ["virtua docker compose list", "Lister les projets Compose persistants"],
      ["virtua docker compose create <nom> --yaml @fichier.yml", "Créer/éditer un fichier docker-compose.yml"],
      ["virtua docker compose up|down|ps|logs|config|restart <nom>", "Gérer un projet Compose"],
      ["virtua docker compose delete <nom>", "Supprimer un projet Compose"],
      ["virtua docker volumes list|create|delete", "Gérer les volumes Docker"],
      ["virtua docker prune [all|containers|images|volumes|networks]", "Nettoyer les ressources inutilisées"],
    ]},
  ] : [
    { title: "GENERAL", cmds: [
      ["virtua -h", "Show this help"],
      ["virtua status", "Host overview (CPU/RAM/Disk)"],
      ["virtua list", "All machines (VM + LXC + Docker)"],
      ["virtua gui", "Graphical terminal UI (dialog)"],
      ["virtua setlang EN|FR", "Change language"],
    ]},
    { title: "MACHINES (vm | lxc | docker)", cmds: [
      ["virtua <type> list", "List machines"],
      ["virtua <type> info <id>", "Details of one machine"],
      ["virtua <type> start <id>", "Start a machine"],
      ["virtua <type> stop <id>", "Stop a machine"],
      ["virtua <type> autostart <id> [on|off|status]", "Manage autostart"],
      ["virtua <type> console <id>", "Attach console (host only)"],
    ]},
    { title: "DOCKER (advanced)", cmds: [
      ["virtua docker edit <id> --json '{...}'", "Edit a container (ports, volumes, env, image, command, network, CPU/RAM)"],
      ["virtua docker exec <id> <cmd...>", "Run a command inside a container"],
      ["virtua docker compose list", "List persisted Compose projects"],
      ["virtua docker compose create <name> --yaml @file.yml", "Create/edit a docker-compose.yml"],
      ["virtua docker compose up|down|ps|logs|config|restart <name>", "Manage a Compose project"],
      ["virtua docker compose delete <name>", "Delete a Compose project"],
      ["virtua docker volumes list|create|delete", "Manage Docker volumes"],
      ["virtua docker prune [all|containers|images|volumes|networks]", "Prune unused resources"],
    ]},
  ];

  sections.forEach(s => {
    console.log(`  ${pc.bold(pc.yellow(s.title))}`);
    s.cmds.forEach(([c, d]) => {
      console.log(`    ${pc.cyan(c.padEnd(25))} ${pc.dim(d)}`);
    });
    console.log("");
  });
}

function getArgValue(args: string[], name: string) {
  const index = args.findIndex((arg) => arg === name);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasFlag(args: string[], name: string) {
  return args.includes(name);
}

function normalizeSubcommand(input?: string) {
  return (input ?? "").replace(/^-+/, "");
}

function isRootUser() {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

function shouldUseLocalRunner() {
  return process.env.VIRTUA_FORCE_API !== "1" && isRootUser() && fs.existsSync(RUNNER_SOCK_PATH);
}

function localRunnerUnavailableMessage() {
  if (!isRootUser()) return "Not logged in. Run `virtua login` first.";
  return `Not logged in and local runner socket is unavailable at ${RUNNER_SOCK_PATH}. Start auxinuxvirtual-runner or set VIRTUA_FORCE_API=1 and run virtua login.`;
}

function ensureSessionDir() {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

function saveSession(session: SessionFile) {
  ensureSessionDir();
  fs.writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2), { mode: 0o600 });
}

function loadSession(): SessionFile {
  if (!fs.existsSync(SESSION_PATH)) {
    throw new Error(localRunnerUnavailableMessage());
  }
  return JSON.parse(fs.readFileSync(SESSION_PATH, "utf8")) as SessionFile;
}

function clearSession() {
  if (fs.existsSync(SESSION_PATH)) fs.unlinkSync(SESSION_PATH);
}

async function prompt(question: string, hidden = false) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  if (!hidden) {
    return await new Promise<string>((resolve) => rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    }));
  }

  const mutableStdout = new (class {
    muted = false;
    write(chunk: string | Uint8Array) {
      if (!this.muted) {
        process.stdout.write(chunk);
      }
    }
  })();

  // @ts-expect-error custom output object for muted prompt
  const hiddenRl = readline.createInterface({ input: process.stdin, output: mutableStdout, terminal: true });
  mutableStdout.muted = false;
  return await new Promise<string>((resolve) => {
    hiddenRl.question(question, (answer) => {
      hiddenRl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
    mutableStdout.muted = true;
  });
}

async function callRunner<T = unknown>(action: string, params?: unknown, timeoutMs = RUNNER_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = randomUUID();
    const socket = net.createConnection(RUNNER_SOCK_PATH);
    let buffer = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new Error(`Runner timeout for action: ${action}`));
      }
    }, timeoutMs);

    socket.on("connect", () => {
      socket.write(JSON.stringify({ id, action, params: params ?? {} }) + "\n");
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const response = JSON.parse(line) as RunnerResponse<T>;
          if (response.id !== id) continue;
          clearTimeout(timeout);
          settled = true;
          socket.destroy();
          if (response.ok) {
            resolve(response.result as T);
          } else {
            reject(new Error(response.error ?? "Runner error"));
          }
        } catch {}
      }
    });

    socket.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Runner connection error: ${error.message}`));
      }
    });

    socket.on("close", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error("Runner connection closed unexpectedly"));
      }
    });
  });
}

async function request<T>(method: HttpMethod, requestPath: string, body?: unknown, session?: SessionFile): Promise<T> {
  const baseUrl = session?.baseUrl ?? DEFAULT_BASE_URL;
  const headers = new Headers();
  if (session?.cookies) headers.set("cookie", session.cookies);
  if (session?.csrfToken && method !== "GET") headers.set("x-csrf-token", session.csrfToken);
  if (body !== undefined) headers.set("content-type", "application/json");

  const response = await fetch(`${baseUrl}${requestPath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  const payload = text ? (() => {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  })() : undefined;

  if (!response.ok) {
    const message = typeof payload === "object" && payload && "error" in payload
      ? String((payload as { error: unknown }).error)
      : `${response.status} ${response.statusText}`;
    throw new Error(message);
  }

  return payload as T;
}

function splitSetCookieHeader(header: string) {
  const parts: string[] = [];
  let start = 0;
  let inExpires = false;
  for (let i = 0; i < header.length; i += 1) {
    const rest = header.slice(i).toLowerCase();
    if (rest.startsWith("expires=")) inExpires = true;
    if (inExpires && header[i] === ";") inExpires = false;
    if (!inExpires && header[i] === ",") {
      parts.push(header.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(header.slice(start).trim());
  return parts.filter(Boolean);
}

function getSetCookies(headers: Headers) {
  const extended = headers as Headers & {
    getSetCookie?: () => string[];
    raw?: () => Record<string, string[]>;
  };
  if (typeof extended.getSetCookie === "function") {
    return extended.getSetCookie();
  }
  const raw = typeof extended.raw === "function" ? extended.raw()["set-cookie"] : undefined;
  if (raw?.length) return raw;
  const single = headers.get("set-cookie");
  return single ? splitSetCookieHeader(single) : [];
}

function toCookieHeader(setCookies: string[]) {
  return setCookies.map((item) => item.split(";")[0]).filter(Boolean).join("; ");
}

async function getCsrfAndCookies(baseUrl: string) {
  const response = await fetch(`${baseUrl}/api/auth/csrf`);
  if (!response.ok) throw new Error(`Failed to get CSRF token: ${response.status}`);
  const data = await response.json() as { token: string };
  const cookies = toCookieHeader(getSetCookies(response.headers));
  return { csrfToken: data.token, cookies };
}

async function login(args: string[]) {
  const baseUrl = getArgValue(args, "--url") ?? DEFAULT_BASE_URL;
  const username = getArgValue(args, "--username") ?? process.env.VIRTUA_USERNAME ?? await prompt("Username: ");
  const password = getArgValue(args, "--password") ?? process.env.VIRTUA_PASSWORD ?? await prompt("Password: ", true);
  const { csrfToken, cookies } = await getCsrfAndCookies(baseUrl);

  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
      cookie: cookies,
    },
    body: JSON.stringify({ username, password }),
  });
  const payload = await response.json().catch(() => ({})) as { error?: string; user?: { username: string } };
  if (!response.ok) throw new Error(payload.error ?? "Login failed");

  const mergedCookies = [toCookieHeader(getSetCookies(response.headers)), cookies]
    .filter(Boolean)
    .join("; ");

  saveSession({
    baseUrl,
    csrfToken,
    cookies: mergedCookies,
    username: payload.user?.username ?? username,
    savedAt: new Date().toISOString(),
  });
  console.log(pc.green(`Logged in to ${baseUrl} as ${payload.user?.username ?? username}`));
}

async function ensureAuthenticated() {
  const session = loadSession();
  await request("GET", "/api/auth/me", undefined, session);
  return session;
}

function parseJsonInput(args: string[]) {
  const raw = getArgValue(args, "--json");
  if (!raw) throw new Error("Missing --json payload");
  if (raw.startsWith("@")) {
    return JSON.parse(fs.readFileSync(path.resolve(raw.slice(1)), "utf8"));
  }
  return JSON.parse(raw);
}

function printOutput(data: unknown) {
  if (Array.isArray(data)) {
    console.log(renderTable(data as Array<Record<string, unknown>>));
    return;
  }
  if (typeof data === "object" && data) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.log(String(data));
}

async function handleStatus(session: SessionFile, raw = false) {
  const [account, health, counts] = await Promise.all([
    request<Record<string, unknown>>("GET", "/api/auth/me", undefined, session),
    request<Record<string, unknown>>("GET", "/api/health", undefined, session),
    request<Record<string, unknown>>("GET", "/api/system/counts", undefined, session),
  ]);
  if (raw) { printOutput({ account, health, counts }); return; }
  console.log(`\n${pc.bold(pc.cyan("Virtua"))} ${pc.dim(`(mode API · ${session.baseUrl})`)}\n`);
  kv(L("Account","Compte"), String((account as { username?: string }).username ?? session.username ?? "?"));
  kv("API", colorState(String((health as { status?: string }).status ?? "ok")));
  const c = counts as { vms?: number; lxc?: number; docker?: number };
  kv("Machines", `VM ${pc.bold(c.vms ?? 0)} · LXC ${pc.bold(c.lxc ?? 0)} · Docker ${pc.bold(c.docker ?? 0)}`);
  console.log("");
}

function localIdentity() {
  return {
    username: process.env.SUDO_USER || process.env.USER || "root",
    role: "LOCAL_ROOT",
    mode: "local-runner",
    runnerSocket: RUNNER_SOCK_PATH,
  };
}

async function handleLocalStatus(raw = false) {
  const [ping, info, stats, services, vms, lxc, docker] = await Promise.all([
    callRunner<{ pong?: boolean }>("system_ping").catch(() => ({ pong: false })),
    callRunner<Record<string, unknown>>("system_info").catch(() => ({} as Record<string, unknown>)),
    callRunner<Record<string, unknown>>("system_stats").catch(() => ({} as Record<string, unknown>)),
    callRunner<Array<Record<string, unknown>>>("system_services").catch(() => []),
    callRunner<unknown[]>("qemu_vms").catch(() => []),
    callRunner<unknown[]>("lxc_containers").catch(() => []),
    callRunner<unknown[]>("docker_containers").catch(() => []),
  ]);
  if (raw) {
    printOutput({ account: localIdentity(), runner: ping, system: info, stats, services, counts: { vms: vms.length, lxc: lxc.length, docker: docker.length } });
    return;
  }
  const id = localIdentity();
  const sys = info as { hostname?: string; primaryIp?: string; publicIps?: string[]; os?: string; kernel?: string; arch?: string; uptime?: number };
  const st = stats as { loadavg?: number[]; cpuCount?: number; cpuUsage?: number; mem?: { total?: number; used?: number }; disk?: { total?: number; used?: number }; uptime?: number };
  const pong = (ping as { pong?: boolean }).pong;

  console.log(`\n${pc.bold(pc.cyan("Virtua"))} ${pc.bold(`— ${sys.hostname ?? "host"}`)}\n`);
  kv(L("Account","Compte"), `${id.username} ${pc.dim(`(${id.role} · ${id.mode})`)}`);
  kv("Runner", pong ? pc.green(`● ${L("online","en ligne")}`) : pc.red(`● ${L("unreachable","injoignable")}`));
  if (sys.os) kv("OS", `${sys.os}${sys.kernel ? ` ${pc.dim("·")} kernel ${sys.kernel}` : ""}`);
  if (sys.primaryIp) kv("IP", `${sys.primaryIp}${sys.publicIps?.length ? ` ${pc.dim(`(${L("public","publiques")}: ${sys.publicIps.join(", ")})`)}` : ""}`);
  kv("Uptime", `${fmtUptime(st.uptime ?? sys.uptime)}${st.loadavg ? `  ${pc.dim("·")} ${L("load","charge")} ${st.loadavg.map((n) => n.toFixed(2)).join(" ")}` : ""}`);
  if (st.cpuUsage !== undefined) kv("CPU", `${st.cpuUsage.toFixed(1)}% ${pc.dim(`(${st.cpuCount ?? "?"} ${L("cores","cœurs")})`)}`);
  if (st.mem?.total) kv(L("Memory","Mémoire"), `${fmtBytes(st.mem.used)} / ${fmtBytes(st.mem.total)}`);
  if (st.disk?.total) kv(L("Disk","Disque"), `${fmtBytes(st.disk.used)} / ${fmtBytes(st.disk.total)}`);
  kv("Machines", `VM ${pc.bold(vms.length)} ${pc.dim("·")} LXC ${pc.bold(lxc.length)} ${pc.dim("·")} Docker ${pc.bold(docker.length)}`);

  if (services.length) {
    console.log(`\n${pc.bold("Services")}`);
    const rows = services.map((s) => ({
      Service: String(s.name ?? "").replace(/\.service$/, ""),
      État: String(s.status ?? s.activeState ?? ""),
      Activé: String(s.unitFileState ?? ""),
    }));
    console.log(renderTable(rows, ["Service", "État", "Activé"]));
  }
  console.log("");
}

function normalizeMachineRows(vms: Array<Record<string, unknown>>, lxc: Array<Record<string, unknown>>, docker: Array<Record<string, unknown>>) {
  const rows: Array<Record<string, unknown>> = [];
  const kType="Type", kName=L("Name","Nom"), kState=L("State","État"), kVcpu="vCPU", kRam="RAM", kIp="IP", kDetail=L("Detail","Détail");
  for (const v of vms) rows.push({
    [kType]: "VM", [kName]: v.name, [kState]: String(v.state ?? ""),
    [kVcpu]: v.vcpus ?? "", [kRam]: v.maxMemoryKiB ? `${Math.round(Number(v.maxMemoryKiB) / 1024)} MiB` : "",
    [kIp]: Array.isArray(v.ipAddresses) ? (v.ipAddresses as string[]).join(",") : (v.ipAddress ?? ""),
    [kDetail]: v.autostart ? "autostart" : "",
  });
  for (const c of lxc) rows.push({
    [kType]: "LXC", [kName]: c.name, [kState]: String(c.state ?? ""),
    [kVcpu]: c.cpus ?? "", [kRam]: c.memoryMiB ? `${c.memoryMiB} MiB` : "",
    [kIp]: c.ipAddress ?? "", [kDetail]: c.autostart ? "autostart" : "",
  });
  for (const d of docker) rows.push({
    [kType]: "Docker", [kName]: d.name, [kState]: String(d.state ?? d.status ?? ""),
    [kVcpu]: "", [kRam]: "", [kIp]: "", [kDetail]: d.image ?? "",
  });
  return rows;
}

async function handleLocalList(raw = false) {
  const [vms, lxc, docker] = await Promise.all([
    callRunner<Array<Record<string, unknown>>>("qemu_vms").catch(() => []),
    callRunner<Array<Record<string, unknown>>>("lxc_containers").catch(() => []),
    callRunner<Array<Record<string, unknown>>>("docker_containers").catch(() => []),
  ]);
  if (raw) { printOutput({ vms, lxc, docker }); return; }
  console.log(`\n${pc.bold("Machines")}`);
  console.log(renderTable(normalizeMachineRows(vms, lxc, docker)));
  console.log("");
}

async function handleApiList(session: SessionFile, raw = false) {
  const [vms, lxc, docker] = await Promise.all([
    request<Array<Record<string, unknown>>>("GET", "/api/vms", undefined, session).catch(() => []),
    request<Array<Record<string, unknown>>>("GET", "/api/lxc", undefined, session).catch(() => []),
    request<Array<Record<string, unknown>>>("GET", "/api/docker/containers", undefined, session).catch(() => []),
  ]);
  if (raw) { printOutput({ vms, lxc, docker }); return; }
  console.log(`\n${pc.bold("Machines")}`);
  console.log(renderTable(normalizeMachineRows(vms, lxc, docker)));
  console.log("");
}

function attachConsole(kind: ResourceKind, identifier: string) {
  if (!identifier) throw new Error(`Missing ${kind} identifier`);
  const run = (cmd: string, cmdArgs: string[]) => {
    const r = spawnSync(cmd, cmdArgs, { stdio: "inherit" });
    if (r.error) throw new Error(`Cannot launch ${cmd}: ${(r.error as Error).message}. Is it installed and are you root?`);
    return r.status ?? 0;
  };
  if (kind === "vm") {
    console.error(pc.dim(`${L("Serial console of VM","Console série de la VM")} '${identifier}' — ${L("exit with Ctrl+]","quitter avec Ctrl+]")}`));
    process.exitCode = run("virsh", ["console", identifier, "--force"]);
  } else if (kind === "lxc") {
    console.error(pc.dim(`${L("Shell in LXC container","Shell dans le conteneur LXC")} '${identifier}' — ${L("exit with 'exit'","quitter avec 'exit'")}`));
    process.exitCode = run("lxc-attach", ["-n", identifier]);
  } else {
    console.error(pc.dim(`${L("Shell in Docker container","Shell dans le conteneur Docker")} '${identifier}' — ${L("exit with 'exit'","quitter avec 'exit'")}`));
    let status = run("docker", ["exec", "-it", identifier, "bash"]);
    if (status === 126 || status === 127) status = run("docker", ["exec", "-it", identifier, "sh"]);
    process.exitCode = status;
  }
}

function normalizeBooleanToggle(input?: string): boolean | "status" {
  const value = (input ?? "status").toLowerCase();
  if (["on", "enable", "enabled", "true", "1", "yes"].includes(value)) return true;
  if (["off", "disable", "disabled", "false", "0", "no"].includes(value)) return false;
  if (["status", "state", "show", "get"].includes(value)) return "status";
  throw new Error(L("Expected on, off, or status", "Attendu: on, off ou status"));
}

function autostartStateLine(identifier: string, enabled: boolean, detail?: string) {
  return `${identifier} autostart: ${enabled ? "enabled" : "disabled"}${detail ? ` (${detail})` : ""}`;
}

function printAutostartState(identifier: string, enabled: boolean, detail?: string) {
  const state = enabled ? pc.green("enabled") : pc.yellow("disabled");
  console.log(`${identifier} autostart: ${state}${detail ? pc.dim(` (${detail})`) : ""}`);
}

function handleVersion(raw = false) {
  const osPretty = () => { try { return fs.readFileSync("/etc/os-release", "utf8").match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1] ?? os.type(); } catch { return os.type(); } };
  const data = { virtua: VIRTUA_VERSION, os: osPretty(), kernel: os.release() };
  if (raw) { printOutput(data); return; }
  console.log(`\n${pc.bold(pc.cyan("Virtua"))} ${pc.bold(`v${data.virtua}`)}\n`);
  kv("OS", data.os);
  kv("Kernel", data.kernel);
  console.log("");
}

function handleKernel(raw = false) {
  const release = os.release();
  if (raw) { printOutput({ release }); return; }
  console.log(`\n${pc.bold("Kernel")}\n`);
  kv(L("Current", "Actuel"), release);
  console.log("");
}

async function handleLocalHealth() {
  const spinner = ora(L("Checking health...", "Vérification de la santé...")).start();
  try {
    const [ping, stats, services, vms, lxc, docker] = await Promise.all([
      callRunner<{ pong?: boolean }>("system_ping").catch(() => ({ pong: false })),
      callRunner<Record<string, unknown>>("system_stats").catch(() => ({})),
      callRunner<Array<Record<string, unknown>>>("system_services").catch(() => []),
      callRunner<unknown[]>("qemu_vms").catch(() => []),
      callRunner<unknown[]>("lxc_containers").catch(() => []),
      callRunner<unknown[]>("docker_containers").catch(() => []),
    ]);
    spinner.stop();
    console.log(`\n${pc.bold(L("Host health","Santé de l'hôte"))}\n`);
    const line = (l: string, ok: boolean, d: string) => console.log(`  ${ok ? pc.green("● OK") : pc.red("● ERR")}  ${l.padEnd(12)} ${pc.dim(d)}`);
    line("Runner", !!ping.pong, ping.pong ? "online" : "offline");
    line("Services", services.every(s => s.activeState !== "failed"), "checks failed services");
    line("Machines", true, `VM:${vms.length} LXC:${lxc.length} Docker:${docker.length}`);
    console.log("");
  } catch (e) {
    spinner.fail(String(e));
  }
}

async function handleApiHealth(session: SessionFile) {
  const health = await request<Record<string, unknown>>("GET", "/api/health", undefined, session).catch(() => ({ status: "unknown" }));
  console.log(`\n${pc.bold(L("Health (API)","Santé (API)"))}\n`);
  kv("API", colorState(String((health as { status?: string }).status ?? "ok")));
  console.log("");
}

async function getLocalAutostartState(kind: ResourceKind, identifier: string) {
  if (kind === "vm") {
    const info = await callRunner<{ autostart?: boolean }>("qemu_info", { name: identifier });
    return { enabled: Boolean(info.autostart) };
  }
  if (kind === "lxc") {
    const info = await callRunner<{ autostart?: boolean }>("lxc_info", { name: identifier });
    return { enabled: Boolean(info.autostart) };
  }
  const info = await callRunner<{ restartPolicy?: string }>("docker_inspect", { id: identifier });
  const restartPolicy = info.restartPolicy ?? "no";
  return { enabled: restartPolicy !== "no", detail: `restartPolicy=${restartPolicy}` };
}

async function setLocalAutostart(kind: ResourceKind, identifier: string, enabled: boolean) {
  if (kind === "vm") {
    await callRunner("qemu_update_config", { name: identifier, autostart: enabled });
    return { enabled };
  }
  if (kind === "lxc") {
    await callRunner("lxc_update_config", { name: identifier, autostart: enabled });
    return { enabled };
  }
  const restartPolicy = enabled ? "unless-stopped" : "no";
  await callRunner("docker_update_config", { id: identifier, restartPolicy });
  return { enabled, detail: `restartPolicy=${restartPolicy}` };
}

async function handleLocalAutostart(kind: ResourceKind, identifier: string | undefined, modeInput?: string, silent = false) {
  if (!identifier) throw new Error("Usage: virtua <type> autostart <id> [on|off|status]");
  const mode = normalizeBooleanToggle(modeInput);
  const result = mode === "status"
    ? await getLocalAutostartState(kind, identifier)
    : await setLocalAutostart(kind, identifier, mode);
  if (!silent) printAutostartState(identifier, result.enabled, result.detail);
  return autostartStateLine(identifier, result.enabled, result.detail);
}

async function getApiAutostartState(session: SessionFile, kind: ResourceKind, identifier: string) {
  if (kind === "vm") {
    const info = await request<{ autostart?: boolean }>("GET", `/api/vms/${encodeURIComponent(identifier)}`, undefined, session);
    return { enabled: Boolean(info.autostart) };
  }
  if (kind === "lxc") {
    const info = await request<{ autostart?: boolean }>("GET", `/api/lxc/${encodeURIComponent(identifier)}`, undefined, session);
    return { enabled: Boolean(info.autostart) };
  }
  const info = await request<{ restartPolicy?: string }>("GET", `/api/docker/containers/${encodeURIComponent(identifier)}`, undefined, session);
  const restartPolicy = info.restartPolicy ?? "no";
  return { enabled: restartPolicy !== "no", detail: `restartPolicy=${restartPolicy}` };
}

async function setApiAutostart(session: SessionFile, kind: ResourceKind, identifier: string, enabled: boolean) {
  if (kind === "vm") {
    await request("PUT", `/api/vms/${encodeURIComponent(identifier)}/config`, { autostart: enabled }, session);
    return { enabled };
  }
  if (kind === "lxc") {
    await request("PUT", `/api/lxc/${encodeURIComponent(identifier)}/config`, { autostart: enabled }, session);
    return { enabled };
  }
  const restartPolicy = enabled ? "unless-stopped" : "no";
  await request("PUT", `/api/docker/containers/${encodeURIComponent(identifier)}/config`, { restartPolicy }, session);
  return { enabled, detail: `restartPolicy=${restartPolicy}` };
}

async function handleApiAutostart(session: SessionFile, kind: ResourceKind, identifier: string | undefined, modeInput?: string) {
  if (!identifier) throw new Error("Usage: virtua <type> autostart <id> [on|off|status]");
  const mode = normalizeBooleanToggle(modeInput);
  const result = mode === "status"
    ? await getApiAutostartState(session, kind, identifier)
    : await setApiAutostart(session, kind, identifier, mode);
  printAutostartState(identifier, result.enabled, result.detail);
}

function ensureDialogAvailable() {
  const found = spawnSync("sh", ["-lc", "command -v dialog"], { encoding: "utf8" });
  if (found.status !== 0) {
    throw new Error(L(
      "dialog is not installed. Install it or use the non-interactive commands.",
      "dialog n'est pas installé. Installe-le ou utilise les commandes non interactives.",
    ));
  }
}

function runDialog(args: string[]) {
  const result = spawnSync("dialog", args, { encoding: "utf8", stdio: ["inherit", "inherit", "pipe"] });
  return { status: result.status ?? 0, output: (result.stderr ?? "").trim() };
}

function showDialogMessage(title: string, message: string) {
  runDialog(["--clear", "--title", title, "--msgbox", message, "18", "76"]);
}

async function loadMachinesForGui() {
  const [vms, lxc, docker] = await Promise.all([
    callRunner<Array<Record<string, unknown>>>("qemu_vms").catch(() => []),
    callRunner<Array<Record<string, unknown>>>("lxc_containers").catch(() => []),
    callRunner<Array<Record<string, unknown>>>("docker_containers").catch(() => []),
  ]);
  return [
    ...vms.map((item) => ({ kind: "vm" as const, id: String(item.name ?? ""), state: String(item.state ?? "") })),
    ...lxc.map((item) => ({ kind: "lxc" as const, id: String(item.name ?? ""), state: String(item.state ?? "") })),
    ...docker.map((item) => ({ kind: "docker" as const, id: String(item.id ?? item.name ?? ""), label: String(item.name ?? item.id ?? ""), state: String(item.state ?? item.status ?? "") })),
  ].filter((item) => item.id);
}

async function handleGui() {
  if (!shouldUseLocalRunner()) {
    throw new Error(L(
      "virtua gui currently requires root on the Virtua host so it can use the local runner socket.",
      "virtua gui exige actuellement root sur l'hôte Virtua pour utiliser le socket local du runner.",
    ));
  }
  ensureDialogAvailable();

  while (true) {
    const machines = await loadMachinesForGui();
    const menuArgs = [
      "--clear",
      "--title", "Virtua",
      "--menu", L("Select a resource", "Sélectionne une ressource"),
      "22", "82", "14",
      "status", L("Host status", "État de l'hôte"),
      "list", L("List all machines", "Lister toutes les machines"),
      ...machines.flatMap((item) => {
        const label = item.kind === "docker" && "label" in item ? item.label : item.id;
        return [`${item.kind}:${item.id}`, `${label}  [${item.kind.toUpperCase()} · ${item.state}]`];
      }),
      "quit", L("Quit", "Quitter"),
    ];
    const choice = runDialog(menuArgs);
    if (choice.status !== 0 || choice.output === "quit") break;
    if (choice.output === "status") {
      const [ping, info, stats, services, vms, lxc, docker] = await Promise.all([
        callRunner<{ pong?: boolean }>("system_ping").catch(() => ({ pong: false })),
        callRunner<Record<string, unknown>>("system_info").catch(() => ({} as Record<string, unknown>)),
        callRunner<Record<string, unknown>>("system_stats").catch(() => ({} as Record<string, unknown>)),
        callRunner<Array<Record<string, unknown>>>("system_services").catch(() => []),
        callRunner<unknown[]>("qemu_vms").catch(() => []),
        callRunner<unknown[]>("lxc_containers").catch(() => []),
        callRunner<unknown[]>("docker_containers").catch(() => []),
      ]);
      const sys = info as { hostname?: string; os?: string; primaryIp?: string };
      const st = stats as { cpuUsage?: number; mem?: { total?: number; used?: number }; disk?: { total?: number; used?: number } };
      showDialogMessage("Virtua status", [
        `Host: ${sys.hostname ?? "host"}`,
        `Runner: ${ping.pong ? "online" : "offline"}`,
        sys.os ? `OS: ${sys.os}` : "",
        sys.primaryIp ? `IP: ${sys.primaryIp}` : "",
        st.cpuUsage !== undefined ? `CPU: ${st.cpuUsage.toFixed(1)}%` : "",
        st.mem?.total ? `Memory: ${fmtBytes(st.mem.used)} / ${fmtBytes(st.mem.total)}` : "",
        st.disk?.total ? `Disk: ${fmtBytes(st.disk.used)} / ${fmtBytes(st.disk.total)}` : "",
        `Machines: VM ${vms.length} · LXC ${lxc.length} · Docker ${docker.length}`,
        "",
        "Services:",
        ...services.map((service) => `- ${String(service.name ?? "").replace(/\.service$/, "")}: ${String(service.status ?? service.activeState ?? "")}`),
      ].filter(Boolean).join("\n"));
      continue;
    }
    if (choice.output === "list") {
      showDialogMessage("Virtua machines", machines.length
        ? machines.map((item) => `${item.kind.toUpperCase()}  ${"label" in item ? item.label : item.id}  ${item.state}`).join("\n")
        : L("(none)", "(aucune)"));
      continue;
    }

    const [kindRaw, ...idParts] = choice.output.split(":");
    const kind = kindRaw as ResourceKind;
    const identifier = idParts.join(":");
    const action = runDialog([
      "--clear",
      "--title", `${kind.toUpperCase()} ${identifier}`,
      "--menu", L("Choose an action", "Choisis une action"),
      "16", "72", "8",
      "info", L("Show details", "Afficher les détails"),
      "start", L("Start", "Démarrer"),
      "stop", L("Stop", "Arrêter"),
      "restart", L("Restart", "Redémarrer"),
      "autostart-on", "Autostart ON",
      "autostart-off", "Autostart OFF",
      "autostart-status", "Autostart status",
      "console", L("Open console", "Ouvrir la console"),
      "back", L("Back", "Retour"),
    ]);
    if (action.status !== 0 || action.output === "back") continue;
    try {
      let message = "";
      if (action.output === "autostart-on") message = await handleLocalAutostart(kind, identifier, "on", true);
      else if (action.output === "autostart-off") message = await handleLocalAutostart(kind, identifier, "off", true);
      else if (action.output === "autostart-status") message = await handleLocalAutostart(kind, identifier, "status", true);
      else if (["start", "stop", "restart"].includes(action.output)) {
        const res = {
          vm: { action: "qemu_action", key: "name" },
          lxc: { action: "lxc_action", key: "name" },
          docker: { action: "docker_action", key: "id" },
        }[kind];
        await callRunner(res.action, { [res.key]: identifier, action: action.output });
        message = `${action.output} ${identifier}: ok`;
      } else if (action.output === "info") {
        const res = {
          vm: { info: "qemu_info", key: "name" },
          lxc: { info: "lxc_info", key: "name" },
          docker: { info: "docker_inspect", key: "id" },
        }[kind];
        const info = await callRunner(res.info, { [res.key]: identifier });
        message = JSON.stringify(info, null, 2);
      } else {
        await handleLocalResource(kind, [action.output, identifier]);
      }
      if (action.output !== "console") showDialogMessage(`${kind.toUpperCase()} ${identifier}`, message);
    } catch (error) {
      showDialogMessage("Virtua error", error instanceof Error ? error.message : String(error));
    }
  }
}

// ── Docker advanced subcommands (local runner) ───────────────────────────────
async function handleLocalCompose(args: string[]) {
  const sub = normalizeSubcommand(args[0]);
  const name = args[1];
  switch (sub) {
    case "list": case "ls":
      printOutput(await callRunner("docker_compose_list"));
      break;
    case "create": case "save": {
      if (!name) throw new Error("Usage: virtua docker compose create <name> --yaml <file-or-string>");
      const yaml = getArgValue(args, "--yaml") ?? getArgValue(args, "--file");
      if (!yaml) throw new Error("Missing --yaml (a path prefixed with @, or an inline YAML string)");
      const composeYaml = yaml.startsWith("@") ? fs.readFileSync(path.resolve(yaml.slice(1)), "utf8") : yaml;
      printOutput(await callRunner("docker_compose_save", { name, composeYaml }));
      break;
    }
    case "up":
      if (!name) throw new Error("Usage: virtua docker compose up <name>");
      printOutput(await callRunner("docker_compose_up", { name }));
      break;
    case "down":
      if (!name) throw new Error("Usage: virtua docker compose down <name>");
      printOutput(await callRunner("docker_compose_down", { name, removeVolumes: hasFlag(args, "--volumes") }));
      break;
    case "ps":
      if (!name) throw new Error("Usage: virtua docker compose ps <name>");
      printOutput(await callRunner("docker_compose_ps", { name }));
      break;
    case "logs":
      if (!name) throw new Error("Usage: virtua docker compose logs <name>");
      printOutput(await callRunner("docker_compose_logs", { name, tail: Number(getArgValue(args, "--tail") ?? 100) }));
      break;
    case "config":
      if (!name) throw new Error("Usage: virtua docker compose config <name>");
      printOutput(await callRunner("docker_compose_config", { name }));
      break;
    case "restart":
      if (!name) throw new Error("Usage: virtua docker compose restart <name>");
      printOutput(await callRunner("docker_compose_restart", { name }));
      break;
    case "delete": case "rm":
      if (!name) throw new Error("Usage: virtua docker compose delete <name>");
      printOutput(await callRunner("docker_compose_delete", { name }));
      break;
    default:
      throw new Error(`Unknown compose command: ${sub}`);
  }
}

async function handleLocalVolumes(args: string[]) {
  const sub = normalizeSubcommand(args[0]);
  switch (sub) {
    case "list": case "ls": case "":
      printOutput(await callRunner("docker_volumes"));
      break;
    case "create": {
      const name = args[1];
      if (!name) throw new Error("Usage: virtua docker volumes create <name> [--driver local]");
      printOutput(await callRunner("docker_volume_create", { name, driver: getArgValue(args, "--driver") }));
      break;
    }
    case "delete": case "rm": {
      const name = args[1];
      if (!name) throw new Error("Usage: virtua docker volumes delete <name>");
      printOutput(await callRunner("docker_volume_delete", { id: name }));
      break;
    }
    default:
      throw new Error(`Unknown volumes command: ${sub}`);
  }
}

// ── Docker advanced subcommands (API) ────────────────────────────────────────
async function handleApiCompose(session: SessionFile, args: string[]) {
  const sub = normalizeSubcommand(args[0]);
  const name = args[1];
  switch (sub) {
    case "list": case "ls":
      printOutput(await request("GET", "/api/docker/compose", undefined, session));
      break;
    case "create": case "save": {
      if (!name) throw new Error("Usage: virtua docker compose create <name> --yaml <file-or-string>");
      const yaml = getArgValue(args, "--yaml") ?? getArgValue(args, "--file");
      if (!yaml) throw new Error("Missing --yaml (a path prefixed with @, or an inline YAML string)");
      const composeYaml = yaml.startsWith("@") ? fs.readFileSync(path.resolve(yaml.slice(1)), "utf8") : yaml;
      printOutput(await request("POST", "/api/docker/compose", { name, composeYaml }, session));
      break;
    }
    case "up":
      if (!name) throw new Error("Usage: virtua docker compose up <name>");
      printOutput(await request("POST", `/api/docker/compose/${encodeURIComponent(name)}/up`, {}, session));
      break;
    case "down":
      if (!name) throw new Error("Usage: virtua docker compose down <name>");
      printOutput(await request("POST", `/api/docker/compose/${encodeURIComponent(name)}/down`, { removeVolumes: hasFlag(args, "--volumes") }, session));
      break;
    case "ps":
      if (!name) throw new Error("Usage: virtua docker compose ps <name>");
      printOutput(await request("GET", `/api/docker/compose/${encodeURIComponent(name)}/ps`, undefined, session));
      break;
    case "logs":
      if (!name) throw new Error("Usage: virtua docker compose logs <name>");
      printOutput(await request("GET", `/api/docker/compose/${encodeURIComponent(name)}/logs?tail=${Number(getArgValue(args, "--tail") ?? 100)}`, undefined, session));
      break;
    case "config":
      if (!name) throw new Error("Usage: virtua docker compose config <name>");
      printOutput(await request("GET", `/api/docker/compose/${encodeURIComponent(name)}`, undefined, session));
      break;
    case "restart":
      if (!name) throw new Error("Usage: virtua docker compose restart <name>");
      printOutput(await request("POST", `/api/docker/compose/${encodeURIComponent(name)}/restart`, {}, session));
      break;
    case "delete": case "rm":
      if (!name) throw new Error("Usage: virtua docker compose delete <name>");
      printOutput(await request("DELETE", `/api/docker/compose/${encodeURIComponent(name)}`, undefined, session));
      break;
    default:
      throw new Error(`Unknown compose command: ${sub}`);
  }
}

async function handleApiVolumes(session: SessionFile, args: string[]) {
  const sub = normalizeSubcommand(args[0]);
  switch (sub) {
    case "list": case "ls": case "":
      printOutput(await request("GET", "/api/docker/volumes", undefined, session));
      break;
    case "create": {
      const name = args[1];
      if (!name) throw new Error("Usage: virtua docker volumes create <name> [--driver local]");
      printOutput(await request("POST", "/api/docker/volumes", { name, driver: getArgValue(args, "--driver") }, session));
      break;
    }
    case "delete": case "rm": {
      const name = args[1];
      if (!name) throw new Error("Usage: virtua docker volumes delete <name>");
      printOutput(await request("DELETE", `/api/docker/volumes/${encodeURIComponent(name)}`, undefined, session));
      break;
    }
    default:
      throw new Error(`Unknown volumes command: ${sub}`);
  }
}

async function handleLocalResource(kind: ResourceKind, args: string[]) {
  const subcommand = normalizeSubcommand(args[0]);
  const identifier = args[1];
  const spinner = ora();

  // Docker advanced subcommands (compose / volumes / exec / prune / edit).
  if (kind === "docker" && subcommand === "compose") {
    return handleLocalCompose(args.slice(1));
  }
  if (kind === "docker" && subcommand === "volumes") {
    return handleLocalVolumes(args.slice(1));
  }
  if (kind === "docker" && subcommand === "exec") {
    if (!identifier) throw new Error("Usage: virtua docker exec <id> <command...>");
    const command = args.slice(2).join(" ");
    if (!command) throw new Error("Usage: virtua docker exec <id> <command...>");
    printOutput(await callRunner("docker_exec", { id: identifier, command }));
    return;
  }
  if (kind === "docker" && subcommand === "prune") {
    printOutput(await callRunner("docker_prune", { target: args[1] ?? "all" }));
    return;
  }
  if (kind === "docker" && subcommand === "edit") {
    if (!identifier) throw new Error("Usage: virtua docker edit <id> --json <payload>");
    const payload = parseJsonInput(args);
    printOutput(await callRunner("docker_recreate", { id: identifier, ...(payload as Record<string, unknown>) }));
    return;
  }

  if (["start", "stop", "restart"].includes(subcommand)) {
    spinner.text = `${subcommand} ${identifier}...`;
    spinner.start();
  }

  try {
    const res = {
      vm: { list: "qemu_vms", info: "qemu_info", action: "qemu_action" },
      lxc: { list: "lxc_containers", info: "lxc_info", action: "lxc_action" },
      docker: { list: "docker_containers", info: "docker_inspect", action: "docker_action" },
    }[kind];

    switch (subcommand) {
      case "list":
      case "ls":
        printOutput(await callRunner(res.list));
        break;
      case "info":
        printOutput(await callRunner(res.info, { [kind === "docker" ? "id" : "name"]: identifier }));
        break;
      case "start":
      case "stop":
      case "restart":
        await callRunner(res.action, { [kind === "docker" ? "id" : "name"]: identifier, action: subcommand });
        spinner.succeed(pc.green(`${subcommand} ${identifier} done`));
        break;
      case "autostart":
        await handleLocalAutostart(kind, identifier, args[2]);
        break;
      case "console":
        attachConsole(kind, identifier);
        break;
      default:
        throw new Error(`Unknown command: ${subcommand}`);
    }
  } catch (e) {
    spinner.fail(pc.red(String(e)));
  }
}

async function handleResource(session: SessionFile, kind: ResourceKind, args: string[]) {
  const subcommand = normalizeSubcommand(args[0]);
  const identifier = args[1];

  // Docker advanced subcommands (compose / volumes / exec / prune / edit).
  if (kind === "docker" && subcommand === "compose") {
    return handleApiCompose(session, args.slice(1));
  }
  if (kind === "docker" && subcommand === "volumes") {
    return handleApiVolumes(session, args.slice(1));
  }
  if (kind === "docker" && subcommand === "exec") {
    if (!identifier) throw new Error("Usage: virtua docker exec <id> <command...>");
    const command = args.slice(2).join(" ");
    if (!command) throw new Error("Usage: virtua docker exec <id> <command...>");
    printOutput(await request("POST", `/api/docker/containers/${encodeURIComponent(identifier)}/exec`, { command }, session));
    return;
  }
  if (kind === "docker" && subcommand === "prune") {
    printOutput(await request("POST", "/api/docker/prune", { target: args[1] ?? "all" }, session));
    return;
  }
  if (kind === "docker" && subcommand === "edit") {
    if (!identifier) throw new Error("Usage: virtua docker edit <id> --json <payload>");
    const payload = parseJsonInput(args);
    printOutput(await request("PUT", `/api/docker/containers/${encodeURIComponent(identifier)}/recreate`, payload, session));
    return;
  }

  const config = {
    vm: { list: "/api/vms", info: (id: string) => `/api/vms/${id}`, action: (id: string, a: string) => `/api/vms/${id}/${a}` },
    lxc: { list: "/api/lxc", info: (id: string) => `/api/lxc/${id}`, action: (id: string, a: string) => `/api/lxc/${id}/${a}` },
    docker: { list: "/api/docker/containers", info: (id: string) => `/api/docker/containers/${id}`, action: (id: string, a: string) => `/api/docker/containers/${id}/${a}` },
  }[kind];

  switch (subcommand) {
    case "list":
    case "ls":
      printOutput(await request("GET", config.list, undefined, session));
      break;
    case "info":
      printOutput(await request("GET", config.info(identifier), undefined, session));
      break;
    case "start":
    case "stop":
    case "restart":
      await request("POST", config.action(identifier, subcommand), undefined, session);
      console.log(pc.green(`${subcommand} ${identifier} requested`));
      break;
    case "autostart":
      await handleApiAutostart(session, kind, identifier, args[2]);
      break;
    default:
      throw new Error(`Unknown command: ${subcommand}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = normalizeSubcommand(args[0]);

  try {
    switch (command) {
      case "": case "h": case "help": case "--help":
        printHelp();
        return;
      case "setlang": case "lang":
        setLang(args[1]);
        return;
      case "login":
        await login(args.slice(1));
        return;
      case "logout":
        clearSession();
        console.log(pc.yellow("Logged out"));
        return;
      case "status":
        if (shouldUseLocalRunner()) { await handleLocalStatus(); return; }
        await handleStatus(await ensureAuthenticated());
        return;
      case "list": case "ls":
        if (shouldUseLocalRunner()) { await handleLocalList(); return; }
        await handleApiList(await ensureAuthenticated());
        return;
      case "gui":
        await handleGui();
        return;
      case "version": case "-v":
        handleVersion();
        return;
      case "vm": case "lxc": case "docker":
        if (shouldUseLocalRunner()) { await handleLocalResource(command, args.slice(1)); return; }
        await handleResource(await ensureAuthenticated(), command, args.slice(1));
        return;
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } catch (error) {
    console.error(pc.red(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}

void main();
