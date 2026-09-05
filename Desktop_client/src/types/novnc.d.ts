declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: { wsProtocols?: string[] });
    viewOnly: boolean;
    clipViewport: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;
    focus(options?: FocusOptions): void;
    sendCtrlAltDel(): void;
    disconnect(): void;
  }
}
