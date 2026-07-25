import * as net from "net";
import * as fs from "fs";
import { handleDocker } from "./handlers/docker";
import { handleLxc } from "./handlers/lxc";
import { handleQemu } from "./handlers/qemu";
import { handleStorage } from "./handlers/storage";
import { handleNetwork } from "./handlers/network";
import { handleSystem } from "./handlers/system";

const SOCK_PATH = process.env.AUXINUX_RUNNER_SOCK ?? "/run/auxinuxvirtual.sock";

interface RunnerRequest {
  id: string;
  action: string;
  params?: unknown;
}

interface RunnerResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** A live progress update streamed before the final response (same request id). */
export interface ProgressUpdate {
  percent?: number;
  bytesCurrent?: number;
  bytesTotal?: number;
  message?: string;
}
export type ProgressEmitter = (update: ProgressUpdate) => void;

async function dispatch(action: string, params: unknown, emit: ProgressEmitter): Promise<unknown> {
  if (action.startsWith("docker_")) return handleDocker(action, params);
  if (action.startsWith("lxc_")) return handleLxc(action, params, emit);
  if (action.startsWith("qemu_")) return handleQemu(action, params, emit);
  if (action.startsWith("storage_")) return handleStorage(action, params);
  if (action.startsWith("network_")) return handleNetwork(action, params);
  if (action.startsWith("system_")) return handleSystem(action, params);
  throw new Error(`Unknown action: ${action}`);
}

function startServer() {
  if (fs.existsSync(SOCK_PATH)) fs.unlinkSync(SOCK_PATH);

  const server = net.createServer((socket) => {
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        let req: RunnerRequest;
        try {
          req = JSON.parse(line) as RunnerRequest;
        } catch {
          continue;
        }

        // Stream progress updates on the same socket with the same id; the API
        // client treats lines carrying `progress` as non-final updates.
        const emit: ProgressEmitter = (update) => {
          if (socket.writable) {
            socket.write(JSON.stringify({ id: req.id, progress: update }) + "\n");
          }
        };
        dispatch(req.action, req.params ?? {}, emit)
          .then((result) => {
            const resp: RunnerResponse = { id: req.id, ok: true, result };
            socket.write(JSON.stringify(resp) + "\n");
          })
          .catch((err) => {
            const resp: RunnerResponse = {
              id: req.id,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            };
            socket.write(JSON.stringify(resp) + "\n");
          });
      }
    });

    socket.on("error", (err) => {
      console.error("[runner] Socket error:", err.message);
    });
  });

  server.listen(SOCK_PATH, () => {
    fs.chmodSync(SOCK_PATH, 0o600);
    console.log(`[runner] Listening on ${SOCK_PATH}`);
  });

  server.on("error", (err) => {
    console.error("[runner] Server error:", err);
    process.exit(1);
  });
}

startServer();
