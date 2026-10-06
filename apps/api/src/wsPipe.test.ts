import { describe, expect, it } from "vitest";
import { createBackpressureForwarder } from "./wsPipe.js";

function fakeSink() {
  const pending: Array<() => void> = [];
  return {
    readyState: 1,
    sent: 0,
    send(data: Buffer, _opts: unknown, cb?: () => void) {
      this.sent += data.length;
      pending.push(() => cb?.());
    },
    flush(count = pending.length) {
      for (const cb of pending.splice(0, count)) cb();
    },
  };
}

function fakeSource() {
  return { paused: false, pause() { this.paused = true; }, resume() { this.paused = false; } };
}

describe("createBackpressureForwarder", () => {
  it("pauses the source above the high-water mark and resumes below the low one", () => {
    const sink = fakeSink();
    const source = fakeSource();
    const forward = createBackpressureForwarder(sink, source, 100, 40);
    forward(Buffer.alloc(60));
    expect(source.paused).toBe(false);
    forward(Buffer.alloc(60));
    expect(source.paused).toBe(true);
    sink.flush(1); // 60 in flight: still above low water
    expect(source.paused).toBe(true);
    sink.flush(1); // drained
    expect(source.paused).toBe(false);
  });

  it("drops data once the browser socket is no longer open", () => {
    const sink = fakeSink();
    const forward = createBackpressureForwarder(sink, fakeSource());
    sink.readyState = 3;
    forward(Buffer.alloc(10));
    expect(sink.sent).toBe(0);
  });
});
