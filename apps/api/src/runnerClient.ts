import * as net from "net";
import { randomUUID } from "crypto";

/**
 * Client IPC de l'API vers le runner privilégié.
 *
 * Le protocole est volontairement simple : un objet JSON par ligne sur un
 * socket Unix. Toutes les réponses portent l'identifiant de la requête afin
 * d'ignorer proprement les messages qui ne lui appartiennent pas. Une requête
 * peut recevoir plusieurs événements de progression avant sa réponse finale.
 */
const SOCK_PATH = process.env.AUXINUX_RUNNER_SOCK ?? "/run/auxinuxvirtual.sock";
const DEFAULT_TIMEOUT = 120_000;

export interface RunnerProgress {
  percent?: number;
  bytesCurrent?: number;
  bytesTotal?: number;
  message?: string;
}

/**
 * Exécute une action privilégiée et ferme toujours le socket à la fin.
 *
 * @param action Nom d'action enregistré par le runner.
 * @param params Données sérialisables transmises au gestionnaire.
 * @param timeoutMs Durée maximale, opérations longues incluses.
 * @param onProgress Récepteur optionnel des événements intermédiaires.
 */
export async function callRunner<T = unknown>(
  action: string,
  params?: unknown,
  timeoutMs = DEFAULT_TIMEOUT,
  onProgress?: (p: RunnerProgress) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = randomUUID();
    const socket = net.createConnection(SOCK_PATH);
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
      const request = JSON.stringify({ id, action, params: params ?? {} }) + "\n";
      socket.write(request);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const resp = JSON.parse(line) as {
            id: string;
            ok?: boolean;
            result?: T;
            error?: string;
            progress?: RunnerProgress;
          };
          if (resp.id !== id) continue;
          // Non-final progress update: forward and keep the socket open.
          if (resp.progress && resp.ok === undefined) {
            if (!settled) onProgress?.(resp.progress);
            continue;
          }
          clearTimeout(timeout);
          settled = true;
          socket.destroy();
          if (resp.ok) {
            resolve(resp.result as T);
          } else {
            reject(new Error(resp.error ?? "Runner error"));
          }
        } catch {
          // Une ligne incomplète ou non JSON ne doit pas interrompre la
          // requête : le tampon conserve déjà les fragments sans saut de ligne.
        }
      }
    });

    socket.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Runner connection error: ${err.message}`));
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
