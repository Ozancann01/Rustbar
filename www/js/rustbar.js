/**
 * Rustbar — camera + DOM glue; scan state and decode in Rust/WASM.
 */

import init, {
  ScanSession,
  decodeVideoFrame,
  decodeImageBytes,
  tickCaptureStill,
  tickRunPreview,
} from "../pkg/rustbar_scanner.js";
import {
  applyCameraEnhancements,
  applyCenterFocusHint,
  getStreamSettings,
  maybeRepickCamera,
  openCameraStream,
  pickBestCameraDevice,
  toggleTorch,
  upgradeStreamFromCapabilities,
} from "./camera.js";
import {
  captureHighResStill,
  createImageCapture,
  getPhotoMaxWidth,
  isImageCaptureSupported,
} from "./capture.js";
import {
  createScannerOverlay,
  hideResultSheet,
  setOverlayStatus,
  setStreamDebug,
  showResultSheet,
} from "./scanner-ui.js";

const DEFAULT_DECODE = 2048;
const FAST_DECODE = 1536;
const MAX_DECODE_4K = 2560;
const DEFAULT_ROI = 0.85;
const EXPANDED_ROI = 0.92;
const SLOW_MS = 50;
const DEFAULT_FORMATS = ["qrcode", "datamatrix"];
const DESKTOP_STILL_INTERVAL_MS = 500;
const MOBILE_STILL_INTERVAL_MS = 350;
const MOBILE_FIRST_STILL_MS = 800;
const MOBILE_PREVIEW_DEFER_MS = 800;
const MOBILE_PREVIEW_INTERVAL_MS = 100;
const DESKTOP_PREVIEW_INTERVAL_MS = 72;
const ROI_CAPTURE_PX = 640;
const NATIVE_DETECT_CROP_MAX = 768;
const LOW_WIDTH_HINT = 1280;

let wasmInit = null;
let worker = null;
let activeSession = null;
let nativeDetector = null;
let nativeDetectorFormats = null;

const TICK_CAPTURE_STILL = tickCaptureStill();
const TICK_RUN_PREVIEW = tickRunPreview();

const roiCanvas = document.createElement("canvas");
const roiCtx = roiCanvas.getContext("2d", { willReadFrequently: true });
const nativeCanvas = document.createElement("canvas");
const nativeCtx = nativeCanvas.getContext("2d", { willReadFrequently: true });
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

  decodeFrame(buffer, width, height, targetSize, formatsHint) {
    const job = ++this.id;
    const copy = new Uint8ClampedArray(buffer);
    return new Promise((resolve) => {
      this.pending.set(job, resolve);
      this.w.postMessage(
        {
          type: "decodeFrame",
          id: job,
          buffer: copy.buffer,
          width,
          height,
          targetSize,
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

function finderRect(video, roiFraction) {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;
  const roi = Math.min(0.95, Math.max(0.5, roiFraction));
  const side = Math.min(w, h) * roi;
  return {
    sx: (w - side) / 2,
    sy: (h - side) / 2,
    side,
    w,
    h,
  };
}

async function tryNativeDetect(video, formats, roiFraction) {
  const detector = await ensureNativeDetector(formats);
  if (!detector) return null;

  const rect = finderRect(video, roiFraction);
  if (!rect) return null;

  const scale = Math.min(1, NATIVE_DETECT_CROP_MAX / rect.side);
  const dw = Math.max(1, Math.round(rect.side * scale));
  const dh = dw;
  nativeCanvas.width = dw;
  nativeCanvas.height = dh;
  nativeCtx.drawImage(
    video,
    rect.sx,
    rect.sy,
    rect.side,
    rect.side,
    0,
    0,
    dw,
    dh,
  );

  try {
    const codes = await detector.detect(nativeCanvas);
    const hit = codes?.[0];
    if (!hit?.rawValue) return { nativeMiss: true };
    return { text: hit.rawValue, format: "qrcode" };
  } catch {
    return null;
  }
}

/** Small finder crop only — keeps main thread light for smooth video. */
function captureRoiRgba(video, roiFraction) {
  const rect = finderRect(video, roiFraction);
  if (!rect) return null;

  const size = ROI_CAPTURE_PX;
  roiCanvas.width = size;
  roiCanvas.height = size;
  roiCtx.drawImage(
    video,
    rect.sx,
    rect.sy,
    rect.side,
    rect.side,
    0,
    0,
    size,
    size,
  );

  return {
    data: roiCtx.getImageData(0, 0, size, size).data,
    width: size,
    height: size,
  };
}

function makeFinderThumb(video, roiFraction) {
  const rect = finderRect(video, roiFraction);
  if (!rect) return undefined;
  const size = 96;
  thumbCanvas.width = size;
  thumbCanvas.height = size;
  thumbCtx.drawImage(
    video,
    rect.sx,
    rect.sy,
    rect.side,
    rect.side,
    0,
    0,
    size,
    size,
  );
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
    this.stillDecodeRes = recognitionToDecodeSize(rec, this.prefer4K);
    this.previewDecodeRes =
      opts.previewRecognitionResolution ??
      (this.isMobile ? FAST_DECODE : this.stillDecodeRes);
    this.baseRoi = Math.min(0.95, Math.max(0.5, opts.roiFraction ?? DEFAULT_ROI));
    this.useWorker = opts.useWorker !== false;
    this.adaptiveDecode = opts.adaptiveDecode === true;
    this.highResStills =
      opts.highResStills !== false && isImageCaptureSupported();
    const stillMs = this.isMobile
      ? MOBILE_STILL_INTERVAL_MS
      : DESKTOP_STILL_INTERVAL_MS;
    this.stillIntervalMs = opts.stillIntervalMs ?? stillMs;
    const earlyStill =
      this.isMobile && this.highResStills ? MOBILE_FIRST_STILL_MS : 0;
    const previewInterval = this.isMobile
      ? MOBILE_PREVIEW_INTERVAL_MS
      : DESKTOP_PREVIEW_INTERVAL_MS;
    this.scan = null;
    this.showResultSheet =
      opts.showResultSheet ?? (this.isMobile && opts.continuous !== true);
    this.showStreamDebug = opts.showStreamDebug === true;
    this._scanConfig = {
      stillIntervalMs: this.stillIntervalMs,
      earlyStill,
      previewInterval,
    };
    this.closed = false;
    this.stream = null;
    this.imageCapture = null;
    this.scanning = false;
    this.videoDecodeBusy = false;
    this.stillPipelineBusy = false;
    this.torchOn = false;
    this.repicked = false;
    this.rvfcHandle = null;
    this.raf = null;
    this.ui = null;
    this.last = "";
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
    const video = this.ui?.video;
    if (video?.cancelVideoFrameCallback && this.rvfcHandle != null) {
      video.cancelVideoFrameCallback(this.rvfcHandle);
    }
    if (this.raf) cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ui?.destroy();
    this.opts.onClose?.(this.last);
    if (activeSession === this) activeSession = null;
  }

  _previewTarget() {
    if (this.adaptiveDecode && this.scan?.take_fast_decode_next()) {
      return FAST_DECODE;
    }
    return this.previewDecodeRes;
  }

  _finishScan(result) {
    this.last = result.text;
    this.opts.onScan(result.text, result.format);
    if (navigator.vibrate) navigator.vibrate(40);

    const shouldClose = this.opts.closeOnScan !== false && !this.opts.continuous;

    if (this.showResultSheet && this.ui) {
      const thumb = makeFinderThumb(this.ui.video, this.scan.roi_fraction());
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
      this._resetScanState();
    }
  }

  _resetScanState() {
    const now = performance.now();
    this.scan.reset(now);
    this.nativeMissStillDone = false;
    if (this.mobilePreviewDefer) {
      this.previewDecodeEnabled = false;
      this.sessionStartedAt = now;
      setTimeout(() => {
        this.previewDecodeEnabled = true;
      }, MOBILE_PREVIEW_DEFER_MS);
    }
  }

  _handleConfirmed(result) {
    if (!result) return false;
    this._finishScan({ text: result.text, format: result.format });
    return true;
  }

  _handleDecodeResult(result) {
    if (!result) {
      this.scan.clear_hit_streak();
      this.scan.on_preview_miss();
      return false;
    }
    const confirmed = this.scan.consider_decode_result(
      result.text,
      result.format,
    );
    if (!confirmed) return false;
    return this._handleConfirmed({
      text: confirmed.text,
      format: confirmed.format,
    });
  }

  async _decodePreviewFrame(frame) {
    const target = this._previewTarget();
    if (this.useWorker) {
      await getWorker().ready;
      return getWorker().decodeFrame(
        frame.data.buffer,
        frame.width,
        frame.height,
        target,
        this.hint,
      );
    }
    await ensureWasm();
    const r = decodeVideoFrame(
      frame.data,
      frame.width,
      frame.height,
      1.0,
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
    this.scan.force_still();
  }

  async _processPreviewFrame(frame, now) {
    if (this.scan.phase_blocks_preview()) return;

    const t0 = performance.now();
    try {
      const native = await tryNativeDetect(
        this.ui.video,
        this.formats,
        this.scan.roi_fraction(),
      );
      if (native?.text && this._handleDecodeResult(native)) return;
      if (native?.nativeMiss) this._onNativeMiss();

      const result = await this._decodePreviewFrame(frame);
      if (this.adaptiveDecode && performance.now() - t0 > SLOW_MS) {
        this.scan.set_fast_decode_next(true);
      }
      this._handleDecodeResult(result);
    } finally {
      this.videoDecodeBusy = false;
    }
  }

  async _runStillPipeline() {
    if (
      !this.highResStills ||
      !this.imageCapture ||
      this.stillPipelineBusy ||
      !this.scan.can_capture_still()
    ) {
      return;
    }

    this.stillPipelineBusy = true;
    try {
      if (this.scan.should_apply_focus_before_still()) {
        await applyCenterFocusHint(this.stream);
      }
      this.scan.on_roi_lock_settled();
      this.scan.on_still_capture_started();

      const blob = await captureHighResStill(this.imageCapture, {
        torchOn: this.torchOn,
      });
      const now = performance.now();
      if (!blob || this.closed || !this.scanning) {
        this.scan.on_still_decode_done(false, now);
        return;
      }

      const result = await this._decodeStillBlob(blob);
      const found = result ? this._handleDecodeResult(result) : false;
      this.scan.on_still_decode_done(found, now);
      if (this.mobilePreviewDefer && !found) {
        this.previewDecodeEnabled = true;
      }
    } catch {
      this.scan.on_still_decode_done(false, performance.now());
      if (this.mobilePreviewDefer) this.previewDecodeEnabled = true;
    } finally {
      this.stillPipelineBusy = false;
    }
  }

  _onScanFrame(now) {
    const video = this.ui?.video;
    if (!video || video.readyState < 2 || !this.scan) return;

    if (
      this.mobilePreviewDefer &&
      !this.previewDecodeEnabled &&
      now - this.sessionStartedAt >= MOBILE_PREVIEW_DEFER_MS
    ) {
      this.previewDecodeEnabled = true;
    }

    const flags = this.scan.tick(
      now,
      this.stillPipelineBusy,
      this.previewDecodeEnabled,
    );

    if ((flags & TICK_CAPTURE_STILL) !== 0 && !this.stillPipelineBusy) {
      void this._runStillPipeline();
    }

    if (
      (flags & TICK_RUN_PREVIEW) !== 0 &&
      !this.stillPipelineBusy &&
      !this.videoDecodeBusy
    ) {
      const frame = captureRoiRgba(video, this.scan.roi_fraction());
      if (frame) {
        this.scan.mark_preview_attempt(now);
        this.videoDecodeBusy = true;
        const snapshot = {
          data: new Uint8ClampedArray(frame.data),
          width: frame.width,
          height: frame.height,
        };
        this._processPreviewFrame(snapshot, now).catch(() => {
          this.videoDecodeBusy = false;
        });
      }
    }
  }

  _scheduleScanLoop() {
    const video = this.ui.video;
    const loop = (now) => {
      if (!this.scanning || this.closed) return;
      this._onScanFrame(typeof now === "number" ? now : performance.now());
      if (video.requestVideoFrameCallback) {
        this.rvfcHandle = video.requestVideoFrameCallback(loop);
      } else {
        this.raf = requestAnimationFrame(() => loop(performance.now()));
      }
    };

    if (video.requestVideoFrameCallback) {
      this.rvfcHandle = video.requestVideoFrameCallback(loop);
    } else {
      this.raf = requestAnimationFrame(() => loop(performance.now()));
    }
  }

  _initScanSession() {
    const now = performance.now();
    const c = this._scanConfig;
    this.scan = new ScanSession(
      3,
      c.stillIntervalMs,
      c.earlyStill,
      c.previewInterval,
      this.baseRoi,
      EXPANDED_ROI,
      1,
      now,
    );
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
      recognitionResolution: this.stillDecodeRes,
      previewRecognitionResolution: this.previewDecodeRes,
    });

    if (this.showStreamDebug && this.ui) {
      setStreamDebug(
        this.ui,
        `${info.width}×${info.height} @ ${Math.round(info.frameRate || 0)}fps`,
      );
    }

    if (info.width > 0 && info.width < LOW_WIDTH_HINT) {
      setOverlayStatus(
        this.ui.status,
        "Low camera resolution — move closer or try Chrome",
        "scanning",
      );
    }
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

    const minW = this.use4KStream ? 1920 : 1280;
    this.stream = await upgradeStreamFromCapabilities(this.stream, video, minW);

    this.imageCapture = this.highResStills
      ? createImageCapture(this.stream)
      : null;
    if (!this.imageCapture) this.highResStills = false;

    const s = getStreamSettings(this.stream);
    if (this.use4KStream && s.width >= 1920) {
      this.stillDecodeRes = clampDecode(
        Math.max(this.stillDecodeRes, MAX_DECODE_4K),
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
        this._resetScanState();
        setOverlayStatus(this.ui.status, "", "");
        this.ui.finderHint.hidden = false;
        this._scheduleScanLoop();
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
        .then(() => this._scheduleScanLoop())
        .catch((e) => this._cameraError(e));
    };

    await ensureWasm();
    if (this.useWorker) await getWorker().ready;

    setOverlayStatus(this.ui.status, "Requesting camera…");
    this.ui.allowBtn.hidden = true;
    await this._runCamera();
    this._initScanSession();
    this.sessionStartedAt = performance.now();
    this.scanning = true;
    this._scheduleScanLoop();
  }

  async _runCamera() {
    await this._startCamera();
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
