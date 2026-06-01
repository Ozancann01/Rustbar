/**
 * Rustbar — embeddable live barcode scanner (Rust + WebAssembly / rxing).
 */

import init, { decodeFrameRgba } from "../pkg/rustbar_scanner.js";
import { createScannerOverlay, setOverlayStatus } from "./scanner-ui.js";

const DECODE_SIZE = 1024;
const ROI_FRACTION = 0.72;
const CONFIRM_FRAMES = 2;
const DEFAULT_FORMATS = ["qrcode", "datamatrix"];

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

function formatsToHint(formats) {
  return formats.map((f) => f.trim().toLowerCase()).join(",");
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
 * @property {(text: string, format: string) => void} onScan
 * @property {(error: Error) => void} [onError]
 * @property {(lastText?: string) => void} [onClose]
 * @property {string[]} [formats] - e.g. ["qrcode", "datamatrix"]
 * @property {boolean} [continuous=false]
 * @property {boolean} [closeOnScan=true]
 */

class ScannerSessionImpl {
  constructor(options) {
    this.options = options;
    this.formats = options.formats?.length ? options.formats : DEFAULT_FORMATS;
    this.formatsHint = formatsToHint(this.formats);
    this.closed = false;
    this.stream = null;
    this.scanning = false;
    this.decodeInFlight = false;
    this.rafId = null;
    this.pendingHit = null;
    this.confirmCount = 0;
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
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.scanning = false;
    this.decodeInFlight = false;
    this.pendingHit = null;
    this.confirmCount = 0;
  }

  _startScanLoop() {
    this._stopScanLoop();
    this.scanning = true;
    const tick = () => {
      if (!this.scanning || this.closed) return;
      if (!this.decodeInFlight) {
        this._tryDecodeFrame();
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  /** Crop center square (viewfinder) and scale for decode. */
  _captureRoiImageData(video) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;

    const side = Math.floor(Math.min(vw, vh) * ROI_FRACTION);
    const sx = Math.floor((vw - side) / 2);
    const sy = Math.floor((vh - side) / 2);

    captureCanvas.width = DECODE_SIZE;
    captureCanvas.height = DECODE_SIZE;
    captureCtx.drawImage(video, sx, sy, side, side, 0, 0, DECODE_SIZE, DECODE_SIZE);
    return captureCtx.getImageData(0, 0, DECODE_SIZE, DECODE_SIZE);
  }

  _tryDecodeFrame() {
    const video = this.ui?.video;
    if (!video || video.readyState < 2) return;

    const imageData = this._captureRoiImageData(video);
    if (!imageData) return;

    this.decodeInFlight = true;
    try {
      const result = decodeFrameRgba(
        imageData.data,
        DECODE_SIZE,
        DECODE_SIZE,
        this.formatsHint,
      );

      if (!result) {
        this.pendingHit = null;
        this.confirmCount = 0;
        return;
      }

      const text = result.text;
      const format = result.format;
      const key = `${format}:${text}`;

      if (this.pendingHit?.key === key) {
        this.confirmCount += 1;
      } else {
        this.pendingHit = { key, text, format };
        this.confirmCount = 1;
      }

      if (this.confirmCount < CONFIRM_FRAMES) return;

      this._onDecodeSuccess(text, format);
    } finally {
      this.decodeInFlight = false;
    }
  }

  _onDecodeSuccess(text, format) {
    if (text === this.lastResult && !this.options.continuous) return;

    this.lastResult = text;
    this.pendingHit = null;
    this.confirmCount = 0;
    vibrateOnScan();
    this.options.onScan(text, format);

    const { continuous = false, closeOnScan = true } = this.options;

    if (continuous) {
      this._setStatus(`Found ${format} — keep scanning`, "scanning");
      return;
    }

    this._stopScanLoop();
    this._setStatus("Code found", "scanning");

    if (closeOnScan) {
      this.close();
    }
  }

  async _applyCameraEnhancements() {
    const track = this.stream?.getVideoTracks()?.[0];
    if (!track?.applyConstraints) return;

    const advanced = [
      { focusMode: "continuous" },
      { exposureMode: "continuous" },
      { whiteBalanceMode: "continuous" },
    ];

    try {
      await track.applyConstraints({ advanced });
    } catch {
      try {
        await track.applyConstraints({
          focusMode: "continuous",
          exposureMode: "continuous",
        });
      } catch {
        /* unsupported on this device */
      }
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
    await this._applyCameraEnhancements();

    this._startScanLoop();
    this._setStatus("Point at a QR or Data Matrix code", "scanning");
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
    const { status, allowBtn, closeBtn } = this.ui;

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
  async init() {
    await ensureWasm();
  },

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
