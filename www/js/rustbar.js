/**
 * Rustbar — embeddable live QR scanner (Rust + WebAssembly).
 *
 * @example
 * import { RustbarScanner } from "./js/rustbar.js";
 *
 * await RustbarScanner.init();
 * const session = await RustbarScanner.open({
 *   onScan(text) { console.log(text); session.close(); },
 * });
 */

import init, { decodeQrRgba } from "../pkg/rustbar_scanner.js";
import { createScannerOverlay, setOverlayStatus } from "./scanner-ui.js";

const SCAN_FPS = 8;
const SCAN_INTERVAL_MS = 1000 / SCAN_FPS;

let wasmInitPromise = null;
let activeSession = null;

const captureCanvas = document.createElement("canvas");
const captureCtx = captureCanvas.getContext("2d", { willReadFrequently: true });

async function ensureWasm() {
  if (!wasmInitPromise) {
    wasmInitPromise = init();
  }
  await wasmInitPromise;
}

async function pickCameraDevice() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter((d) => d.kind === "videoinput");
  const back =
    cams.find((d) => /back|rear|environment/i.test(d.label)) ??
    cams[cams.length - 1];
  return back?.deviceId;
}

function vibrateOnScan() {
  if (navigator.vibrate) navigator.vibrate(40);
}

/**
 * @typedef {Object} OpenOptions
 * @property {(text: string) => void} onScan - Called when a QR code is decoded.
 * @property {(error: Error) => void} [onError] - Camera or permission errors.
 * @property {(text: string) => void} [onClose] - Called when the session closes.
 * @property {boolean} [continuous=false] - If true, keep scanning after each result.
 * @property {boolean} [closeOnScan=true] - If true, close overlay after first scan (when continuous is false).
 */

/**
 * @typedef {Object} ScannerSession
 * @property {() => void} close - Stop camera and remove overlay.
 */

class ScannerSessionImpl {
  /** @param {OpenOptions} options */
  constructor(options) {
    this.options = options;
    this.closed = false;
    this.stream = null;
    this.scanTimer = null;
    this.scanning = false;
    this.lastResult = "";
    this.ui = null;
    this._onVisibility = null;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this._teardown();
    this.options.onClose?.(this.lastResult);
    if (activeSession === this) activeSession = null;
  }

  _teardown() {
    this._stopScanLoop();
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.ui) {
      this.ui.video.srcObject = null;
      this.ui.destroy();
      this.ui = null;
    }
    if (this._onVisibility) {
      document.removeEventListener("visibilitychange", this._onVisibility);
      this._onVisibility = null;
    }
  }

  _setStatus(text, kind = "") {
    if (this.ui) setOverlayStatus(this.ui.status, text, kind);
  }

  _stopScanLoop() {
    if (this.scanTimer !== null) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    this.scanning = false;
  }

  _startScanLoop() {
    this._stopScanLoop();
    this.scanning = true;
    const video = this.ui.video;
    this.scanTimer = setInterval(() => {
      if (!this.scanning || this.closed || video.readyState < 2) return;
      this._tryDecodeFrame();
    }, SCAN_INTERVAL_MS);
  }

  _tryDecodeFrame() {
    const video = this.ui.video;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return;

    if (captureCanvas.width !== w || captureCanvas.height !== h) {
      captureCanvas.width = w;
      captureCanvas.height = h;
    }

    captureCtx.drawImage(video, 0, 0, w, h);
    const imageData = captureCtx.getImageData(0, 0, w, h);
    const payload = decodeQrRgba(imageData.data, w, h);

    if (!payload || payload === this.lastResult) return;

    this.lastResult = payload;
    vibrateOnScan();
    this.options.onScan(payload);

    const { continuous = false, closeOnScan = true } = this.options;

    if (continuous) {
      this._setStatus("QR found — keep scanning", "scanning");
      return;
    }

    this._stopScanLoop();
    this._setStatus("QR code found", "scanning");

    if (closeOnScan) {
      this.close();
    }
  }

  async _startCamera() {
    if (this.closed) return;

    if (!navigator.mediaDevices?.getUserMedia) {
      const err = new Error("Camera not supported in this browser");
      this._setStatus(err.message, "error");
      this.options.onError?.(err);
      return;
    }

    this._setStatus("Requesting camera…");
    if (this.ui.allowBtn) this.ui.allowBtn.hidden = true;

    const deviceId = await pickCameraDevice().catch(() => undefined);
    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (firstErr) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: "environment" },
        });
      } catch (secondErr) {
        const err = /** @type {Error} */ (secondErr || firstErr);
        this._setStatus(
          err.message || "Could not access camera — use HTTPS",
          "error",
        );
        this._showAllowFallback();
        this.options.onError?.(err);
        return;
      }
    }

    const video = this.ui.video;
    video.srcObject = this.stream;
    video.setAttribute("playsinline", "");
    video.muted = true;

    await new Promise((resolve) => {
      if (video.readyState >= 2) resolve();
      else video.onloadedmetadata = () => resolve();
    });
    await video.play().catch(() => {});

    this._startScanLoop();
    this._setStatus("Point at a QR code", "scanning");
  }

  _showAllowFallback() {
    if (!this.ui?.allowBtn || this.closed) return;
    this.ui.allowBtn.hidden = false;
    this._setStatus("Tap Allow camera to continue", "error");
  }

  async open() {
    if (activeSession && activeSession !== this) {
      activeSession.close();
    }
    activeSession = this;

    this.ui = createScannerOverlay();
    const { video, status, allowBtn, closeBtn } = this.ui;

    closeBtn.addEventListener("click", () => this.close());

    allowBtn.addEventListener("click", () => {
      allowBtn.hidden = true;
      this._startCamera();
    });

    this._onVisibility = () => {
      if (document.hidden) {
        this._stopScanLoop();
      } else if (this.stream && !this.closed) {
        this._startScanLoop();
      }
    };
    document.addEventListener("visibilitychange", this._onVisibility);

    setOverlayStatus(status, "Loading scanner…");

    try {
      await ensureWasm();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this._setStatus("Failed to load scanner", "error");
      this.options.onError?.(error);
      return this;
    }

    await this._startCamera();
    return this;
  }
}

export const RustbarScanner = {
  /** Load WASM module once. Safe to call multiple times. */
  async init() {
    await ensureWasm();
  },

  /**
   * Open full-screen scanner: camera + live decode.
   * @param {OpenOptions} options
   * @returns {Promise<ScannerSession>}
   */
  async open(options) {
    if (!options?.onScan) {
      throw new Error("RustbarScanner.open requires onScan callback");
    }
    await ensureWasm();
    const session = new ScannerSessionImpl(options);
    await session.open();
    return {
      close: () => session.close(),
    };
  },
};
