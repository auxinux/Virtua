declare module "@novnc/novnc/lib/rfb" {
  export default class RFB extends EventTarget {
    constructor(target: Element, urlOrChannel: string, options?: Record<string, unknown>);
    scaleViewport: boolean;
    resizeSession: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;
    disconnect(): void;
  }
}
