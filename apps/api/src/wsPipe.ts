/** Minimal surface of a WebSocket we write to (ws.WebSocket in production). */
export interface BinarySink {
  readyState: number;
  send(data: Buffer, options: { binary: boolean; compress: boolean }, cb?: (err?: Error) => void): void;
}

/** A source that can be throttled: net.Socket, or a ws.WebSocket (pause/resume). */
export interface Pausable {
  pause(): unknown;
  resume(): unknown;
}

const OPEN = 1;
/** Bytes allowed in flight towards the browser before the source is paused. */
export const BACKPRESSURE_HIGH_WATER = 4 * 1024 * 1024;
export const BACKPRESSURE_LOW_WATER = 1 * 1024 * 1024;

/**
 * Forward framebuffer bytes to the browser without ever queueing more than a
 * few MB. Without this, a browser that draws slower than QEMU produces
 * (high resolution, slow link, busy tab) lets Node buffer frames without bound:
 * the console then shows the guest seconds in the past and every click feels
 * slow. Pausing the source pushes back over TCP, and QEMU's VNC/SPICE server
 * then merges updates instead of sending stale ones.
 */
export function createBackpressureForwarder(
  sink: BinarySink,
  source: Pausable,
  high = BACKPRESSURE_HIGH_WATER,
  low = BACKPRESSURE_LOW_WATER,
) {
  let inFlight = 0;
  let paused = false;
  return (data: Buffer) => {
    if (sink.readyState !== OPEN) return;
    inFlight += data.length;
    if (!paused && inFlight > high) {
      paused = true;
      source.pause();
    }
    sink.send(data, { binary: true, compress: false }, () => {
      inFlight -= data.length;
      if (paused && inFlight <= low) {
        paused = false;
        source.resume();
      }
    });
  };
}

/** ws hands over Buffer, Buffer[] (fragmented) or ArrayBuffer depending on binaryType. */
export function rawDataToBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
