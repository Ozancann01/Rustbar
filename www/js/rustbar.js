/**
 * Rustbar — thin JS shell: camera + DOM. Scan pipeline lives in Rust/WASM.
 */

import init, { decodeVideoFrame, decodeImageBytes } from "../pkg/rustbar_scanner.js";
import {
  applyCameraEnhancements,
  applyCenterFocusHint,
  getStreamSettings,
  maybeRepickCamera,
  openCameraStream,
  pickBestCameraDevice,
  toggleTorch,
  upgradeStreamIfLow,
} from "./camera.js";
import {
  captureHighResStill,
  createImageCapture,
  getPhotoMaxWidth,
  isImageCaptureSupported,
} from "./capture.js";
import { ScanPhase, ScanStateMachine } from "./scan-state.js";
import {
  createScannerOverlay,
  hideResultSheet,
  setOverlayStatus,
  showResultSheet,
} from "./scanner-ui.js";

const DEFAULT_DECODE = 2048;
const FAST_DECODE = 1536;
const MAX_DECODE_4K = 2560;
const DEFAULT_ROI = 0.85;
const EXPANDED_ROI = 0.92;
const CONFIRM_FRAMES = 1;
const SLOW_MS = 50;
const DEFAULT_FORMATS = ["qrcode", "datamatrix"];
const DESKTOP_STILL_INTERVAL_MS = 500;
const MOBILE_STILL_INTERVAL_MS = 350;
const MOBILE_FIRST_STILL_MS = 800;
const PREVIEW_INTERVAL_MS = 72;
const NATIVE_DETECT_CROP_MAX = 1200;
const MOBILE_PREVIEW_DEFER_MS = 800;

let wasmInit = null;
let worker = null;
let activeSession = null;
let nativeDetector = null;
let nativeDetectorFormats = null;

const decodeCanvas = document.createElement("canvas");
const decodeCtx = decodeCanvas.getContext("2d", { willReadFrequently: true });
const captureCanvas = document.createElement("canvas");
const captureCtx = captureCanvas.getContext("2d", { willReadFrequently: true });
const thumbCanvas = document.createElement("canvas");
const thumbCtx = thumbCanvas.getContext("2d");

function isMobileUa() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

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

function recognitionToDecodeSize(recognitionResolution, prefer4K) {
  const n = Number(recognitionResolution);
  if (n === 1536 || n === 2048 || n === 2560) return n;
  return clampDecode(n || DEFAULT_DECODE, prefer4K);
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

  if (nativeDetector && nativeDetectorFormats === wanted.join(",")) {
    return nativeDetector;
  }

  nativeDetector = new BarcodeDetector({ formats: ["qr_code"] });
  nativeDetectorFormats = wanted.join(",");
  return nativeDetector;
}

/**
 * BarcodeDetector on center finder crop (~1200px wide).
 * @returns {Promise<{ text: string, format: string } | { nativeMiss: true } | null>}
 */
async function tryNativeDetect(video, formats, roiFraction) {
  const detector = await ensureNativeDetector(formats);
  if (!detector) return null;

  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;

  const roi = Math.min(0.95, Math.max(0.5, roiFraction));
  const side = Math.min(w, h) * roi;
  const sx = (w - side) / 2;
  const sy = (h - side) / 2;
  const scale = Math.min(1, NATIVE_DETECT_CROP_MAX / side);
  const dw = Math.max(1, Math.round(side * scale));
  const dh = Math.max(1, Math.round(side * scale));
  detectCanvas.width = dw;
  detectCanvas.height = dh;
  decodeCtx.drawImage(video, sx, sy, side, side, 0, 0, dw, dh);

  try {
    const codes = await detector.detect(detectCanvas);
    const hit = codes?.[0];
    if (!hit?.rawValue) return { nativeMiss: true };
    return { text: hit.rawValue, format: "qrcode" };
  } catch {
    return null;
  }
}

/** Copy full camera frame to RGBA (off-DOM decode canvas). */
async function captureFrameRgba(video) {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;

  captureCanvas.width = w;
  captureCanvas.height = h;

  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(video);
      captureCtx.drawImage(bitmap, 0, 0, w, h);
      bitmap.close?.();
    } catch {
      captureCtx.drawImage(video, 0, 0, w, h);
    }
  } else {
    captureCtx.drawImage(video, 0, 0, w, h);
  }

  return {
    data: captureCtx.getImageData(0, 0, w, h).data,
    width: w,
    height: h,
  };
}

function makeFinderThumb(video, roiFraction) {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return undefined;
  const roi = Math.min(0.95, Math.max(0.5, roiFraction));
  const side = Math.min(w, h) * roi;
  const sx = (w - side) / 2;
  const sy = (h - side) / 2;
  const size = 96;
  thumbCanvas.width = size;
  thumbCanvas.height = size;
  thumbCtx.drawImage(video, sx, sy, side, side, 0, 0, size, size);
  return thumbCanvas.toDataURL("image/jpeg", 0.75);
}

class Session {
  constructor(opts) {
    this.opts = opts;
    this.formats = opts.formats?.length ? opts.formats : DEFAULT_FORMATS;
    this.hint = formatsHint(this.formats);
    this.isMobile = opts.mobile ?? isMobileUa();
    this.prefer4K = opts.prefer4K !== false;
    this.use4KStream = opts.use4KStream ?? this.prefer4K;
    const rec =
      opts.recognitionResolution ?? opts.decodeResolution ?? DEFAULT_DECODE;
    this.decodeRes = recognitionToDecodeSize(rec, this.prefer4K);
    this.baseRoi = Math.min(0.95, Math.max(0.5, opts.roiFraction ?? DEFAULT_ROI));
    this.roi = this.baseRoi;
    this.roiExpanded = false;
    this.useWorker = opts.useWorker !== false;
    this.adaptiveDecode = opts.adaptiveDecode === true;
    this.highResStills =
      opts.highResStills !== false && isImageCaptureSupported();
    const defaultStillMs = this.isMobile
      ? MOBILE_STILL_INTERVAL_MS
      : DESKTOP_STILL_INTERVAL_MS;
    this.stillIntervalMs = opts.stillIntervalMs ?? defaultStillMs;
    const earlyStill =
      this.isMobile && this.highResStills ? MOBILE_FIRST_STILL_MS : 0;
    this.scanState = new ScanStateMachine(3, this.stillIntervalMs, {
      mobileEarlyStillMs: earlyStill,
    });
    this.showResultSheet =
      opts.showResultSheet ?? (this.isMobile && opts.continuous !== true);
    this.closed = false;
    this.stream = null;
    this.imageCapture = null;
    this.scanning = false;
    this.videoDecodeBusy = false;
    this.stillDecodeBusy = false;
    this.stillPipelineBusy = false;
    this.fastNext = false;
    this.torchOn = false;
    this.repicked = false;
    this.raf = null;
    this.hit = null;
    this.hitN = 0;
    this.ui = null;
    this.last = "";
    this.lastPreviewAt = 0;
    this.nativeMissStillDone = false;
    this.mobilePreviewDefer =
      this.isMobile && this.highResStills && opts.mobileStillFirst !== false;
    this.previewDecodeEnabled = !this.mobilePreviewDefer;
    this.sessionStartedAt = 0;
    this.pendingClose = false;
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

  _expandRoiOnMiss() {
    if (!this.roiExpanded && this.scanState.missCount >= 2) {
      this.roi = Math.max(this.roi, EXPANDED_ROI);
      this.roiExpanded = true;
    }
  }

  _finishScan(result) {
    this.last = result.text;
    this.opts.onScan(result.text, result.format);
    if (navigator.vibrate) navigator.vibrate(40);

    const shouldClose = this.opts.closeOnScan !== false && !this.opts.continuous;

    if (this.showResultSheet && this.ui) {
      const thumb = makeFinderThumb(this.ui.video, this.roi);
      showResultSheet(this.ui, {
        text: result.text,
        format: result.format,
        thumbUrl: thumb,
      });
      this.scanning = false;
      this.pendingClose = shouldClose;
      return;
    }

    if (!this.opts.continuous) {
      this.scanning = false;
      if (shouldClose) this.close();
    } else {
      this.scanState.reset();
      this.roi = this.baseRoi;
      this.roiExpanded = false;
      this.nativeMissStillDone = false;
      if (this.mobilePreviewDefer) {
        this.previewDecodeEnabled = false;
        this.sessionStartedAt = performance.now();
        setTimeout(() => {
          this.previewDecodeEnabled = true;
        }, MOBILE_PREVIEW_DEFER_MS);
      }
    }
  }

  _handleResult(result) {
    if (!result) {
      this.hit = null;
      this.hitN = 0;
      this.scanState.onPreviewMiss();
      this._expandRoiOnMiss();
      return false;
    }

    this.scanState.onPreviewHit();
    const key = `${result.format}:${result.text}`;
    if (this.hit?.key === key) this.hitN++;
    else {
      this.hit = { key, ...result };
      this.hitN = 1;
    }
    if (this.hitN < CONFIRM_FRAMES) return false;

    this._finishScan(result);
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

  _onNativeMiss() {
    if (!this.isMobile || this.nativeMissStillDone || !this.highResStills) {
      return;
    }
    this.nativeMissStillDone = true;
    this.scanState.forceStill();
  }

  async _processVideoFrame(frame) {
    if (this.scanState.phase === ScanPhase.DecodeStill) return;

    const target = this._decodeSize();
    const t0 = performance.now();
    try {
      const native = await tryNativeDetect(
        this.ui.video,
        this.formats,
        this.roi,
      );
      if (native?.text && this._handleResult(native)) return;
      if (native?.nativeMiss) this._onNativeMiss();

      const result = await this._decodeRust(frame, target);
      if (this.adaptiveDecode && performance.now() - t0 > SLOW_MS) {
        this.fastNext = true;
      }
      this._handleResult(result);
    } finally {
      this.videoDecodeBusy = false;
    }
  }

  async _runStillPipeline() {
    if (
      !this.highResStills ||
      !this.imageCapture ||
      this.stillDecodeBusy ||
      this.stillPipelineBusy ||
      !this.scanState.canCaptureStill()
    ) {
      return;
    }

    this.stillPipelineBusy = true;
    try {
      await applyCenterFocusHint(this.stream);
      this.scanState.onRoiLockSettled();

      this.stillDecodeBusy = true;
      this.scanState.onStillCaptureStarted();

      const blob = await captureHighResStill(this.imageCapture, {
        torchOn: this.torchOn,
      });
      if (!blob || this.closed || !this.scanning) {
        this.scanState.onStillDecodeDone(false);
        return;
      }

      const result = await this._decodeStillBlob(blob);
      const found = this._handleResult(result);
      this.scanState.onStillDecodeDone(found);
      if (found) this.scanState.phase = ScanPhase.Done;
      if (this.mobilePreviewDefer && !found) {
        this.previewDecodeEnabled = true;
      }
    } catch {
      this.scanState.onStillDecodeDone(false);
      if (this.mobilePreviewDefer) this.previewDecodeEnabled = true;
    } finally {
      this.stillDecodeBusy = false;
      this.stillPipelineBusy = false;
    }
  }

  async _tick() {
    const video = this.ui?.video;
    if (!video || video.readyState < 2) return;

    const now = performance.now();
    if (
      this.mobilePreviewDefer &&
      !this.previewDecodeEnabled &&
      now - this.sessionStartedAt >= MOBILE_PREVIEW_DEFER_MS
    ) {
      this.previewDecodeEnabled = true;
    }

    this.scanState.requestStillByTimer();

    if (
      this.scanState.phase === ScanPhase.RoiLock &&
      !this.stillPipelineBusy
    ) {
      void this._runStillPipeline();
    }

    if (this.stillPipelineBusy) return;

    if (!this.previewDecodeEnabled) return;

    if (now - this.lastPreviewAt < PREVIEW_INTERVAL_MS) return;

    if (
      !this.videoDecodeBusy &&
      this.scanState.phase !== ScanPhase.DecodeStill &&
      this.scanState.phase !== ScanPhase.CaptureStill
    ) {
      const frame = await captureFrameRgba(video);
      if (frame) {
        this.lastPreviewAt = now;
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
  }

  _loop() {
    if (!this.scanning || this.closed) return;
    void this._tick();
    this.raf = requestAnimationFrame(() => this._loop());
  }

  async _notifyCameraReady() {
    const info = getStreamSettings(this.stream);
    const photoWidthMax = this.imageCapture
      ? await getPhotoMaxWidth(this.imageCapture)
      : 0;
    this.opts.onCameraReady?.({
      width: info.width,
      height: info.height,
      frameRate: info.frameRate,
      deviceLabel: info.deviceLabel,
      imageCapture: this.highResStills,
      photoWidthMax,
      use4KStream: this.use4KStream,
      recognitionResolution: this.decodeRes,
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
    await applyCameraEnhancements(this.stream, this.ui.torchBtn);

    if (!this.repicked) {
      this.repicked = true;
      this.stream = await maybeRepickCamera(this.stream, this.use4KStream, video);
    }

    if (this.use4KStream) {
      this.stream = await upgradeStreamIfLow(this.stream, video, 1920);
    } else {
      this.stream = await upgradeStreamIfLow(this.stream, video, 1280);
    }

    this.imageCapture = this.highResStills
      ? createImageCapture(this.stream)
      : null;
    if (!this.imageCapture) this.highResStills = false;

    const s = getStreamSettings(this.stream);
    if (this.use4KStream && s.width >= 1920) {
      this.decodeRes = clampDecode(
        Math.max(this.decodeRes, MAX_DECODE_4K),
        true,
      );
    }

    this._notifyCameraReady();
  }

  _wireResultSheet() {
    this.ui.resultCloseBtn.onclick = () => {
      hideResultSheet(this.ui);
      if (this.pendingClose) {
        this.close();
      } else if (this.opts.continuous) {
        this.scanning = true;
        this.scanState.reset();
        this.hit = null;
        this.hitN = 0;
        this.roi = this.baseRoi;
        this.roiExpanded = false;
        this.nativeMissStillDone = false;
        setOverlayStatus(
          this.ui.status,
          "Point at a QR or Data Matrix code",
          "scanning",
        );
        this._loop();
      }
    };
    this.ui.resultCopyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(this.last);
        this.ui.resultCopyBtn.textContent = "Copied";
        setTimeout(() => {
          this.ui.resultCopyBtn.textContent = "Copy";
        }, 1500);
      } catch {
        /* clipboard denied */
      }
    };
  }

  async open() {
    if (activeSession) activeSession.close();
    activeSession = this;

    this.ui = createScannerOverlay();
    this._wireResultSheet();
    this.ui.closeBtn.onclick = () => this.close();
    this.ui.torchBtn.onclick = async () => {
      this.torchOn = await toggleTorch(this.stream, this.torchOn);
      this.ui.torchBtn.classList.toggle(
        "rustbar-overlay__icon-btn--on",
        this.torchOn,
      );
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
    this.sessionStartedAt = performance.now();
    this._loop();
  }

  async _runCamera() {
    await this._startCamera();
    this.scanning = true;
    this.scanState.reset();
    this.sessionStartedAt = performance.now();
    setOverlayStatus(this.ui.status, "", "");
    this.ui.finderHint.hidden = false;
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
