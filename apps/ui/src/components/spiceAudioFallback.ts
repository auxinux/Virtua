import { OpusDecoder } from "opus-decoder";
import { Constants, SpicePlaybackConn } from "spice-client";

type PlaybackMessage = { type: number; data: ArrayBuffer | ArrayBuffer[] };
type PlaybackConnection = SpicePlaybackConn & { parent?: { screen_id?: string } };
type PlaybackPrototype = {
  process_channel_message: (message: PlaybackMessage) => boolean;
};

interface PlaybackState {
  context: AudioContext;
  decoder: OpusDecoder<48000>;
  nextTime: number;
  queue: Promise<void>;
  screenId?: string;
}

const states = new WeakMap<object, PlaybackState>();
const contextsByScreen = new Map<string, AudioContext>();
let installed = false;

function bytes(data: ArrayBuffer | ArrayBuffer[]): Uint8Array {
  if (!Array.isArray(data)) return new Uint8Array(data);
  const parts = data.map((part) => new Uint8Array(part));
  const merged = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return merged;
}

function shouldUseFallback(): boolean {
  const safari = /AppleWebKit/i.test(navigator.userAgent) && !/(Chrome|Chromium|CriOS|Edg)/i.test(navigator.userAgent);
  return safari || !window.MediaSource?.isTypeSupported('audio/webm; codecs="opus"');
}

function closeState(connection: object) {
  const state = states.get(connection);
  if (!state) return;
  state.decoder.free();
  void state.context.close();
  if (state.screenId) contextsByScreen.delete(state.screenId);
  states.delete(connection);
}

export function installSpiceAudioFallback() {
  if (installed || !shouldUseFallback()) return;
  installed = true;
  const prototype = SpicePlaybackConn.prototype as unknown as PlaybackPrototype;
  const original = prototype.process_channel_message;

  prototype.process_channel_message = function (this: PlaybackConnection, message: PlaybackMessage) {
    if (message.type === Constants.SPICE_MSG_PLAYBACK_START) {
      closeState(this);
      const raw = bytes(message.data);
      const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      const channels = view.getUint32(0, true) || 2;
      const context = new AudioContext({ sampleRate: 48_000 });
      const decoder = new OpusDecoder({
        sampleRate: 48_000,
        channels,
        forceStereo: channels === 2,
      });
      const screenId = this.parent?.screen_id;
      const state: PlaybackState = { context, decoder, nextTime: 0, queue: Promise.resolve(), screenId };
      states.set(this, state);
      if (screenId) contextsByScreen.set(screenId, context);
      return true;
    }

    if (message.type === Constants.SPICE_MSG_PLAYBACK_DATA) {
      const state = states.get(this);
      if (!state) return true;
      const packet = bytes(message.data).subarray(4);
      if (!packet.byteLength) return true;
      state.queue = state.queue.then(async () => {
        await state.decoder.ready;
        const decoded = state.decoder.decodeFrame(packet);
        if (!decoded.samplesDecoded || decoded.errors.length) return;
        const buffer = state.context.createBuffer(decoded.channelData.length, decoded.samplesDecoded, decoded.sampleRate);
        decoded.channelData.forEach((channel, index) => buffer.copyToChannel(new Float32Array(channel), index));
        const source = state.context.createBufferSource();
        source.buffer = buffer;
        source.connect(state.context.destination);
        const earliest = state.context.currentTime + 0.04;
        if (state.nextTime < earliest || state.nextTime > state.context.currentTime + 0.5) state.nextTime = earliest;
        source.start(state.nextTime);
        state.nextTime += decoded.samplesDecoded / decoded.sampleRate;
      }).catch(() => undefined);
      return true;
    }

    if (message.type === Constants.SPICE_MSG_PLAYBACK_MODE) return true;
    if (message.type === Constants.SPICE_MSG_PLAYBACK_STOP) {
      closeState(this);
      return true;
    }
    return original.call(this, message);
  };
}

export async function resumeSpiceAudio(screenId: string): Promise<boolean> {
  const context = contextsByScreen.get(screenId);
  if (!context) return false;
  await context.resume();
  return context.state === "running";
}
