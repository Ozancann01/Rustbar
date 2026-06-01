/**
 * Rustbar — embeddable live barcode scanner (Rust + WebAssembly / rxing).
 */

import init, { decodeFrameRgba } from "../pkg/rustbar_scanner.js";
import { createScannerOverlay, setOverlayStatus } from "./scanner-ui.js";

const DEFAULT_DECODE_RESOLUTION = 2048;
const FAST_DECODE_RESOLUTION = 1536;
const MAX_DECODE_4K = 2560;
const DEFAULT_ROI_FRACTION = 0.85;
const CONFIRM_FRAMES = 1;
const DECODE_SLOW_MS = 50;
const DEFAULT_FORMATS = ["qrcode", "datamatrix"];

const BAD_CAMERA_RE =
  /telephoto|ultra\s*wide|ultrawide|0\.5x|fish|macro|depth/i;
const GOOD_CAMERA_RE = /back|rear|environment|wide|camera\s*2|main/i;

let wasmInitPromise = null;
let wasmWorker = null;
/** @type {BarcodeDetector | null | undefined} */
let nativeDetector;
let activeSession = null;

const captureCanvas = document.createElement("canvas");
const captureCtx = captureCanvas.getContext("2d", { willReadFrequently: true });
captureCtx.imageSmoothingEnabled = false;

async function ensureWasm() {
  if (!wasmInitPromise) {
    wasmInitPromise = init();
  }
  await wasmInitPromise;
}

function getWasmWorker() {
  if (!wasmWorker) {
    wasmWorker = new WasmDecodePool();
  }
  return wasmWorker;
}

class WasmDecodePool {
  constructor() {
    this.worker = new Worker(
      new URL("./decode-worker.js", import.meta.url),
      { type: "module" },
    );
    this.nextId = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      const onMessage = (event) => {
        const msg = event.data;
        if (msg.type === "ready") {
          this.worker.removeEventListener("message", onMessage);
          resolve();
          return;
        }
        if (msg.type === "error") {
          reject(new Error(msg.message));
          return;
        }
        if (msg.type === "result") {
          const cb = this.pending.get(msg.id);
          if (cb) {
            this.pending.delete(msg.id);
            cb(msg.result);
          }
        }
      };
      this.worker.addEventListener("message", onMessage);
      this.worker.postMessage({ type: "init" });
    });
  }

  async decode(imageData, width, height, formatsHint) {
    await this.ready;
    const id = ++this.nextId;
    const copy = new Uint8ClampedArray(imageData.data);
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.worker.postMessage(
        {
          type: "decode",
          id,
          buffer: copy.buffer,
          width,
          height,
          formatsHint,
        },
        [copy.buffer],
      );
    });
  }
}

async function ensureNativeDetector() {
  if (nativeDetector !== undefined) return nativeDetector;
  if (typeof BarcodeDetector === "undefined") {
    nativeDetector = null;
    return null;
  }
  try {
    const supported = await BarcodeDetector.getSupportedFormats();
    if (!supported.includes("qr_code")) {
      nativeDetector = null;
      return null;
    }
    nativeDetector = new BarcodeDetector({ formats: ["qr_code"] });
  } catch {
    nativeDetector = null;
  }
  return nativeDetector;
}

async function tryNativeQrDecode(formats, imageData, width, height) {
  const wantsQr = formats.some((f) =>
    ["qrcode", "qr", "qr_code"].includes(f.toLowerCase()),
  );
  if (!wantsQr) return null;

  const detector = await ensureNativeDetector();
  if (!detector) return null;

  try {
    captureCanvas.width = width;
    captureCanvas.height = height;
    captureCtx.putImageData(imageData, 0, 0);
    const bitmap = await createImageBitmap(captureCanvas);
    const codes = await detector.detect(bitmap);
    bitmap.close();
    if (!codes?.length || !codes[0].rawValue) return null;
    return { text: codes[0].rawValue, format: "qrcode" };
  } catch {
    return null;
  }
}

function formatsToHint(formats) {
  return formats.map((f) => f.trim().toLowerCase()).join(",");
}

function clampDecodeResolution(n, prefer4K) {
  const v = Number(n) || DEFAULT_DECODE_RESOLUTION;
  const max = prefer4K ? MAX_DECODE_4K : 2048;
  return Math.min(max, Math.max(1024, Math.round(v / 256) * 256));
}

function scoreCamera(cam) {
  const label = (cam.label || "").toLowerCase();
  let score = 0;
  if (GOOD_CAMERA_RE.test(label)) score += 10;
  if (BAD_CAMERA_RE.test(label)) score -= 20;
  if (/front|user|selfie|face/i.test(label)) score -= 30;
  if (label.length > 0) score += 2;
  return score;
}

async function pickBestCameraDevice(excludeId) {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter((d) => d.kind === "videoinput");
  if (cams.length === 0) return undefined;

  const scored = cams
    .map((cam) => ({ cam, score: scoreCamera(cam) }))
    .filter((s) => s.cam.deviceId !== excludeId || cams.length === 1)
    .sort((a, b) => b.score - a.score);

  const best = scored.find((s) => s.score > -10) ?? scored[0];
  return best?.cam.deviceId;
}

function buildVideoConstraints(deviceId, prefer4K) {
  const base = deviceId ? { deviceId: { exact: deviceId } } : {};
  const facing = { facingMode: { ideal: "environment" } };

  const attempts = [
    { ...base, ...facing, width: { ideal: 3840 }, height: { ideal: 2160 } },
    { ...base, ...facing, width: { ideal: 1920 }, height: { ideal: 1080 } },
    { ...facing, width: { ideal: 1920 }, height: { ideal: 1080 } },
    { facingMode: "environment" },
  ];

  if (!prefer4K) {
    return attempts;
  }
  return attempts;
}

async function openCameraStream(deviceId, prefer4K) {
  const attempts = buildVideoConstraints(deviceId, prefer4K);
  let lastErr;
  for (const video of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: false, video });
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("Could not open camera");
}

function vibrateOnScan() {
  if (navigator.vibrate) navigator.vibrate(40);
}

/**
 * @typedef {Object} OpenOptions
 * @property {(text: string, format: string) => void} onScan
 * @property {(error: Error) => void} [onError]
 * @property {(lastText?: string) => void} [onClose]
 * @property {string[]} [formats]
 * @property {number} [decodeResolution]
 * @property {number} [roiFraction]
 * @property {boolean} [prefer4K]
 * @property {boolean} [useWorker=true]
 * @property {boolean} [continuous]
 * @property {boolean} [closeOnScan]
 */

class ScannerSessionImpl {
  constructor(options) {
    this.options = options;
    this.formats = options.formats?.length ? options.formats : DEFAULT_FORMATS;
    this.formatsHint = formatsToHint(this.formats);
    this.prefer4K = options.prefer4K ?? false;
    this.decodeResolution = clampDecodeResolution(
      options.decodeResolution ?? DEFAULT_DECODE_RESOLUTION,
      this.prefer4K,
    );
    this.roiFraction = Math.min(
      0.95,
      Math.max(0.5, options.roiFraction ?? DEFAULT_ROI_FRACTION),
    );
    this.useWorker = options.useWorker !== false;
    this.closed = false;
    this.stream = null;
    this.scanning = false;
    this.decodeInFlight = false;
    this.useFastDecode = false;
    this.torchOn = false;
    this.cameraRepicked = false;
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
    this.useFastDecode = false;
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

  _currentDecodeSize() {
    if (this.useFastDecode) {
      this.useFastDecode = false;
      return FAST_DECODE_RESOLUTION;
    }
    return this.decodeResolution;
  }

  _captureRoiImageData(video, decodeSize) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;

    const side = Math.floor(Math.min(vw, vh) * this.roiFraction);
    const sx = Math.floor((vw - side) / 2);
    const sy = Math.floor((vh - side) / 2);
    const target = Math.min(decodeSize, side);

    captureCanvas.width = target;
    captureCanvas.height = target;
    captureCtx.imageSmoothingEnabled = false;
    captureCtx.drawImage(video, sx, sy, side, side, 0, 0, target, target);
    return captureCtx.getImageData(0, 0, target, target);
  }

  async _decodeFrame(imageData, width, height) {
    const native = await tryNativeQrDecode(
      this.formats,
      imageData,
      width,
      height,
    );
    if (native) return native;

    if (this.useWorker) {
      return getWasmWorker().decode(
        imageData,
        width,
        height,
        this.formatsHint,
      );
    }

    await ensureWasm();
    return decodeFrameRgba(
      imageData.data,
      width,
      height,
      this.formatsHint,
    );
  }

  async _tryDecodeFrame() {
    const video = this.ui?.video;
    if (!video || video.readyState < 2) return;

    const decodeSize = this._currentDecodeSize();
    const imageData = this._captureRoiImageData(video, decodeSize);
    if (!imageData) return;

    this.decodeInFlight = true;
    const t0 = performance.now();
    try {
      const result = await this._decodeFrame(imageData, decodeSize, decodeSize);

      const elapsed = performance.now() - t0;
      if (elapsed > DECODE_SLOW_MS) {
        this.useFastDecode = true;
      }

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
        /* unsupported */
      }
    }

    const caps = track.getCapabilities?.();
    if (caps?.torch && this.ui?.torchBtn) {
      this.ui.torchBtn.hidden = false;
    }
    if (caps?.zoom) {
      const zoom = Math.min(1.2, caps.zoom.max ?? 1.2);
      try {
        await track.applyConstraints({ advanced: [{ zoom }] });
      } catch {
        /* optional */
      }
    }
  }

  async _toggleTorch() {
    const track = this.stream?.getVideoTracks()?.[0];
    if (!track?.applyConstraints || !this.ui?.torchBtn) return;
    this.torchOn = !this.torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: this.torchOn }] });
      this.ui.torchBtn.classList.toggle("rustbar-overlay__torch--on", this.torchOn);
      this.ui.torchBtn.textContent = this.torchOn ? "Flash off" : "Flash";
    } catch {
      this.torchOn = false;
    }
  }

  async _maybeRepickCamera() {
    if (this.cameraRepicked || this.closed) return;
    const track = this.stream?.getVideoTracks()?.[0];
    const currentId = track?.getSettings?.()?.deviceId;
    const betterId = await pickBestCameraDevice(currentId);
    if (!betterId || betterId === currentId) return;

    const devices = await navigator.mediaDevices.enumerateDevices();
    const betterCam = devices.find((d) => d.deviceId === betterId);
    const currentCam = devices.find((d) => d.deviceId === currentId);
    if (!betterCam || !currentCam) return;
    if (scoreCamera(betterCam) <= scoreCamera(currentCam)) return;

    this.cameraRepicked = true;
    for (const t of this.stream.getTracks()) t.stop();

    try {
      this.stream = await openCameraStream(betterId, this.prefer4K);
      this.ui.video.srcObject = this.stream;
      await this.ui.video.play().catch(() => {});
      await this._applyCameraEnhancements();
      console.debug("Rustbar: switched to better camera", betterCam.label);
    } catch {
      this.cameraRepicked = false;
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

    const deviceId = await pickBestCameraDevice().catch(() => undefined);

    try {
      this.stream = await openCameraStream(deviceId, this.prefer4K);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this._setStatus(
        error.message || "Could not access camera — use HTTPS",
        "error",
      );
      this._showAllowFallback();
      this.options.onError?.(error);
      return;
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
    await this._maybeRepickCamera();

    const track = this.stream.getVideoTracks()[0];
    const settings = track?.getSettings?.();
    if (settings?.width && settings?.height) {
      if (this.prefer4K && settings.width >= 1920) {
        this.decodeResolution = clampDecodeResolution(
          MAX_DECODE_4K,
          true,
        );
      }
      console.debug(
        `Rustbar camera: ${settings.width}×${settings.height} decode=${this.decodeResolution} roi=${this.roiFraction}`,
      );
    }

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
    const { status, allowBtn, closeBtn, torchBtn } = this.ui;

    closeBtn.addEventListener("click", () => this.close());
    torchBtn.addEventListener("click", () => this._toggleTorch());

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
      if (this.useWorker) {
        await getWasmWorker().ready;
      }
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
