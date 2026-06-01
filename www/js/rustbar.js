/**
 * Rustbar — thin JS shell: camera + DOM. Scan pipeline lives in Rust/WASM.
 */

import init, { decodeVideoFrame, decodeImageBytes } from "../pkg/rustbar_scanner.js";
import {
  applyCameraEnhancements,
  getStreamSettings,
  maybeRepickCamera,
  openCameraStream,
  pickBestCameraDevice,
  syncNativeVideoSize,
  toggleTorch,
  upgradeStreamIfLow,
} from "./camera.js";
import {
  captureHighResStill,
  createImageCapture,
  isImageCaptureSupported,
} from "./capture.js";
import { createScannerOverlay, setOverlayStatus } from "./scanner-ui.js";

const DEFAULT_DECODE = 2048;
const FAST_DECODE = 1536;
const MAX_DECODE_4K = 2560;
const DEFAULT_ROI = 0.85;
const CONFIRM_FRAMES = 1;
const SLOW_MS = 50;
const DEFAULT_FORMATS = ["qrcode", "datamatrix"];
const DEFAULT_STILL_INTERVAL_MS = 500;
const MISS_STILL_THRESHOLD = 3;
const NATIVE_DETECT_MAX = 800;

let wasmInit = null;
let worker = null;
let activeSession = null;
let nativeDetector = null;
let nativeDetectorFormats = null;

const frameCanvas = document.createElement("canvas");
const frameCtx = frameCanvas.getContext("2d", { willReadFrequently: true });
const detectCanvas = document.createElement("canvas");
const detectCtx = detectCanvas.getContext("2d", { willReadFrequently: true });

async function ensureWasm() {
  if (!wasmInit) wasmInit = init();
  await wasmInit;
}

function getWorker() {
  if (!worker) worker = new DecodeWorker();
  return worker;
}

class DecodeWorker {
  constructor() {
    this.w = new Worker(new URL("./decode-worker.js", import.meta.url), {
      type: "module",
    });
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      const onMsg = (e) => {
        const m = e.data;
        if (m.type === "ready") {
          this.w.removeEventListener("message", onMsg);
          resolve();
        } else if (m.type === "error") reject(new Error(m.message));
        else if (m.type === "result") {
          const cb = this.pending.get(m.id);
          if (cb) {
            this.pending.delete(m.id);
            cb(m.result);
          }
        }
      };
      this.w.addEventListener("message", onMsg);
      this.w.postMessage({ type: "init" });
    });
  }

  decode(buffer, frameWidth, frameHeight, roi, target, formatsHint) {
    const job = ++this.id;
    const copy = new Uint8ClampedArray(buffer);
    return new Promise((resolve) => {
      this.pending.set(job, resolve);
      this.w.postMessage(
        {
          type: "decode",
          id: job,
          buffer: copy.buffer,
          frameWidth,
          frameHeight,
          roiFraction: roi,
          targetSize: target,
          formatsHint,
        },
        [copy.buffer],
      );
    });
  }

  decodeImage(buffer, formatsHint) {
    const job = ++this.id;
    const copy = buffer.slice(0);
    return new Promise((resolve) => {
      this.pending.set(job, resolve);
      this.w.postMessage(
        { type: "decodeImage", id: job, buffer: copy.buffer, formatsHint },
        [copy.buffer],
      );
    });
  }
}

function formatsHint(formats) {
  return formats.map((f) => f.trim().toLowerCase()).join(",");
}

function clampDecode(n, prefer4K) {
  const max = prefer4K ? MAX_DECODE_4K : 2048;
  const v = Number(n) || DEFAULT_DECODE;
  return Math.min(max, Math.max(1024, Math.round(v / 256) * 256));
}

async function ensureNativeDetector(formats) {
  if (typeof BarcodeDetector === "undefined") return null;
  const wanted = formats.map((f) => f.trim().toLowerCase());
  const onlyQr = wanted.every((f) => f === "qrcode" || f === "qr");
  if (!onlyQr) return null;

  const supported = (await BarcodeDetector.getSupportedFormats?.()) ?? [];
  if (!supported.includes("qr_code")) return null;

  if (
    nativeDetector &&
    nativeDetectorFormats === wanted.join(",")
  ) {
    return nativeDetector;
  }

  nativeDetector = new BarcodeDetector({ formats: ["qr_code"] });
  nativeDetectorFormats = wanted.join(",");
  return nativeDetector;
}

async function tryNativeDetect(video, formats) {
  const detector = await ensureNativeDetector(formats);
  if (!detector) return null;

  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;

  const scale = Math.min(1, NATIVE_DETECT_MAX / Math.max(w, h));
  const dw = Math.max(1, Math.round(w * scale));
  const dh = Math.max(1, Math.round(h * scale));
  detectCanvas.width = dw;
  detectCanvas.height = dh;
  detectCtx.drawImage(video, 0, 0, dw, dh);

  try {
    const codes = await detector.detect(detectCanvas);
    const hit = codes?.[0];
    if (!hit?.rawValue) return null;
    return { text: hit.rawValue, format: "qrcode" };
  } catch {
    return null;
  }
}

/** Copy full camera frame to RGBA buffer (only JS step before Rust). */
function captureFrameRgba(video) {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;
  frameCanvas.width = w;
  frameCanvas.height = h;
  frameCtx.drawImage(video, 0, 0, w, h);
  return { data: frameCtx.getImageData(0, 0, w, h).data, width: w, height: h };
}

class Session {
  constructor(opts) {
    this.opts = opts;
    this.formats = opts.formats?.length ? opts.formats : DEFAULT_FORMATS;
    this.hint = formatsHint(this.formats);
    this.prefer4K = opts.prefer4K ?? false;
    this.decodeRes = clampDecode(opts.decodeResolution, this.prefer4K);
    this.roi = Math.min(0.95, Math.max(0.5, opts.roiFraction ?? DEFAULT_ROI));
    this.useWorker = opts.useWorker !== false;
    this.adaptiveDecode = opts.adaptiveDecode === true;
    this.highResStills =
      opts.highResStills !== false && isImageCaptureSupported();
    this.stillIntervalMs = opts.stillIntervalMs ?? DEFAULT_STILL_INTERVAL_MS;
    this.closed = false;
    this.stream = null;
    this.imageCapture = null;
    this.scanning = false;
    this.videoDecodeBusy = false;
    this.stillDecodeBusy = false;
    this.fastNext = false;
    this.torchOn = false;
    this.repicked = false;
    this.raf = null;
    this.hit = null;
    this.hitN = 0;
    this.missCount = 0;
    this.lastStillAt = 0;
    this.ui = null;
    this.last = "";
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ui?.destroy();
    this.opts.onClose?.(this.last);
    if (activeSession === this) activeSession = null;
  }

  _decodeSize() {
    if (this.adaptiveDecode && this.fastNext) {
      this.fastNext = false;
      return FAST_DECODE;
    }
    return this.decodeRes;
  }

  _handleResult(result) {
    if (!result) {
      this.hit = null;
      this.hitN = 0;
      this.missCount++;
      return false;
    }

    this.missCount = 0;
    const key = `${result.format}:${result.text}`;
    if (this.hit?.key === key) this.hitN++;
    else {
      this.hit = { key, ...result };
      this.hitN = 1;
    }
    if (this.hitN < CONFIRM_FRAMES) return false;

    this.last = result.text;
    this.opts.onScan(result.text, result.format);
    if (navigator.vibrate) navigator.vibrate(40);

    if (!this.opts.continuous) {
      this.scanning = false;
      if (this.opts.closeOnScan !== false) this.close();
    }
    return true;
  }

  async _decodeRust(frame, target) {
    if (this.useWorker) {
      await getWorker().ready;
      return getWorker().decode(
        frame.data.buffer,
        frame.width,
        frame.height,
        this.roi,
        target,
        this.hint,
      );
    }
    await ensureWasm();
    const r = decodeVideoFrame(
      frame.data,
      frame.width,
      frame.height,
      this.roi,
      target,
      this.hint,
    );
    return r ? { text: r.text, format: r.format } : null;
  }

  async _decodeStillBlob(blob) {
    const buf = await blob.arrayBuffer();
    if (this.useWorker) {
      await getWorker().ready;
      return getWorker().decodeImage(buf, this.hint);
    }
    await ensureWasm();
    const r = decodeImageBytes(new Uint8Array(buf), this.hint);
    return r ? { text: r.text, format: r.format } : null;
  }

  async _processVideoFrame(frame) {
    const target = this._decodeSize();
    const t0 = performance.now();
    try {
      const native = await tryNativeDetect(this.ui.video, this.formats);
      if (native && this._handleResult(native)) return;

      const result = await this._decodeRust(frame, target);
      if (this.adaptiveDecode && performance.now() - t0 > SLOW_MS) {
        this.fastNext = true;
      }
      this._handleResult(result);
    } finally {
      this.videoDecodeBusy = false;
    }
  }

  async _maybeCaptureStill() {
    if (!this.highResStills || !this.imageCapture || this.stillDecodeBusy) {
      return;
    }

    const now = performance.now();
    const dueByTime = now - this.lastStillAt >= this.stillIntervalMs;
    const dueByMiss = this.missCount >= MISS_STILL_THRESHOLD;
    if (!dueByTime && !dueByMiss) return;

    this.lastStillAt = now;
    this.stillDecodeBusy = true;
    try {
      const blob = await captureHighResStill(this.imageCapture);
      if (!blob || this.closed || !this.scanning) return;
      const result = await this._decodeStillBlob(blob);
      this._handleResult(result);
    } catch {
      /* still capture failed */
    } finally {
      this.stillDecodeBusy = false;
    }
  }

  _tick() {
    const video = this.ui?.video;
    if (!video || video.readyState < 2) return;

    if (!this.videoDecodeBusy) {
      const frame = captureFrameRgba(video);
      if (frame) {
        this.videoDecodeBusy = true;
        const snapshot = {
          data: new Uint8ClampedArray(frame.data),
          width: frame.width,
          height: frame.height,
        };
        this._processVideoFrame(snapshot).catch(() => {
          this.videoDecodeBusy = false;
        });
      }
    }

    void this._maybeCaptureStill();
  }

  _loop() {
    if (!this.scanning || this.closed) return;
    this._tick();
    this.raf = requestAnimationFrame(() => this._loop());
  }

  _notifyCameraReady() {
    const info = getStreamSettings(this.stream);
    this.opts.onCameraReady?.({
      width: info.width,
      height: info.height,
      frameRate: info.frameRate,
      deviceLabel: info.deviceLabel,
      imageCapture: this.highResStills,
    });
  }

  async _startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Camera not supported");
    }

    const deviceId = await pickBestCameraDevice().catch(() => undefined);
    this.stream = await openCameraStream(deviceId);
    const video = this.ui.video;
    video.srcObject = this.stream;
    video.setAttribute("playsinline", "");
    video.muted = true;
    await new Promise((r) => {
      if (video.readyState >= 2) r();
      else video.onloadedmetadata = r;
    });
    await video.play().catch(() => {});
    syncNativeVideoSize(video);
    await applyCameraEnhancements(this.stream, this.ui.torchBtn);

    if (!this.repicked) {
      this.repicked = true;
      this.stream = await maybeRepickCamera(this.stream, this.prefer4K, video);
      syncNativeVideoSize(video);
    }

    this.stream = await upgradeStreamIfLow(this.stream, video);
    syncNativeVideoSize(video);

    this.imageCapture = this.highResStills
      ? createImageCapture(this.stream)
      : null;
    if (!this.imageCapture) this.highResStills = false;

    const s = getStreamSettings(this.stream);
    if (this.prefer4K && s.width >= 1920) {
      this.decodeRes = clampDecode(MAX_DECODE_4K, true);
    }

    this._notifyCameraReady();
  }

  async open() {
    if (activeSession) activeSession.close();
    activeSession = this;

    this.ui = createScannerOverlay();
    this.ui.closeBtn.onclick = () => this.close();
    this.ui.torchBtn.onclick = async () => {
      this.torchOn = await toggleTorch(this.stream, this.torchOn);
      this.ui.torchBtn.classList.toggle(
        "rustbar-overlay__torch--on",
        this.torchOn,
      );
      this.ui.torchBtn.textContent = this.torchOn ? "Flash off" : "Flash";
    };
    this.ui.allowBtn.onclick = () => {
      this.ui.allowBtn.hidden = true;
      this._runCamera()
        .then(() => this._loop())
        .catch((e) => this._cameraError(e));
    };

    await ensureWasm();
    if (this.useWorker) await getWorker().ready;

    setOverlayStatus(this.ui.status, "Requesting camera…");
    this.ui.allowBtn.hidden = true;
    await this._runCamera();
    this._loop();
  }

  async _runCamera() {
    await this._startCamera();
    this.scanning = true;
    this.lastStillAt = performance.now();
    setOverlayStatus(this.ui.status, "Point at a QR or Data Matrix code", "scanning");
  }

  _cameraError(e) {
    this.ui.allowBtn.hidden = false;
    setOverlayStatus(this.ui.status, e.message, "error");
    this.opts.onError?.(e);
  }
}

export const RustbarScanner = {
  init: ensureWasm,
  async open(options) {
    if (!options?.onScan) throw new Error("RustbarScanner.open requires onScan");
    await ensureWasm();
    const s = new Session(options);
    await s.open();
    return { close: () => s.close() };
  },
};
