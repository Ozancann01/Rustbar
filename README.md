# Rustbar — Browser Barcode Scanner (Rust + WASM)

Embeddable **browser** library: call **`RustbarScanner.open()`** and it opens the camera, scans **QR codes** and **Data Matrix** live using Rust/WebAssembly ([rxing](https://github.com/rxing-core/rxing)), and returns decoded text to your app.

**Demo:** [https://ozancann01.github.io/Rustbar/](https://ozancann01.github.io/Rustbar/)

Uses the browser’s **native camera APIs** (`getUserMedia`, `ImageCapture`, `MediaStreamTrack` constraints, optional `BarcodeDetector`) for the best quality possible in one web page—not a separate app install.

> **HTTPS + user gesture** required for camera access. Mobile browsers may cap live preview resolution; `ImageCapture` stills often provide more megapixels for decode.

## Scanbot web demo comparison

[Scanbot’s browser demo](https://websdk-barcode.scanbot.io) and Rustbar both run in the mobile browser with the same class of APIs. Rustbar targets similar **camera + UX** (full-bleed preview, large finder, 4K stream negotiation, early high-res stills, result sheet)—not Scanbot’s proprietary WASM decoder.

| Area | Scanbot Web SDK | Rustbar |
|------|-----------------|---------|
| Decoder | Proprietary WASM | **rxing** (open source; different accuracy ceiling) |
| Preview UI | Full-screen, large finder | Full-bleed overlay + large finder |
| Stream | Optional 4K + constraints | `use4KStream` + upgrade ladder |
| Stills | `ImageCapture` | Mobile-first still (~800ms), 350ms interval |
| After scan | Result card | Optional `showResultSheet` (default on mobile) |

## Features

- **One-browser embed** — GitHub Pages, your site, or local HTTPS
- **Rust decode** — bilinear ROI crop, multi-scale + rotation (preview 90°; stills +270°)
- **Scan pipeline** — throttled preview (~14 Hz) → focus hint → max-res still (`detect → lock → snap`)
- **High-res camera** — 4K→1080p→min-1080p ladder, stream upgrade, `resizeMode: none`
- **ImageCapture** — mobile early still, periodic / miss-triggered JPEG decode
- **Web Worker** — WASM off main thread; torch in overlay
- **Chrome fast path** — `BarcodeDetector` on center finder crop (~1200px) for QR-only

## Build

```bash
chmod +x build.sh && ./build.sh
```

Outputs WASM to `www/pkg/`.

## Run locally

```bash
cd www && python -m http.server 8080
```

Open [http://localhost:8080](http://localhost:8080) (use HTTPS or localhost for camera).

## Library usage

Copy into your static host:

- `www/js/rustbar.js`, `camera.js`, `capture.js`, `scan-state.js`, `decode-worker.js`, `scanner-ui.js`
- `www/css/scanner-overlay.css`
- `www/pkg/` (from `./build.sh`)

```javascript
import { RustbarScanner } from "./js/rustbar.js";

await RustbarScanner.open({
  onScan(text, format) { console.log(format, text); },
  formats: ["qrcode", "datamatrix"],
  prefer4K: true,
  use4KStream: true,
  recognitionResolution: 2048,
  onCameraReady(info) {
    console.log("preview", info.width, "x", info.height);
    console.log("max still width", info.photoWidthMax);
  },
});
```

### `open()` options

| Option | Default | Description |
|--------|---------|-------------|
| `onScan` | required | `(text, format) => void` |
| `onCameraReady` | — | `width`, `height`, `frameRate`, `imageCapture`, `photoWidthMax`, `recognitionResolution` |
| `prefer4K` | `true` | Stronger `getUserMedia` constraints |
| `use4KStream` | `true` when `prefer4K` | Re-negotiate stream if width &lt; 1920 |
| `recognitionResolution` | `2048` | Decode size: `1536` / `2048` / `2560` (like Scanbot `setRecognitionResolution`) |
| `decodeResolution` | — | Alias for `recognitionResolution` |
| `highResStills` | `true` if supported | `ImageCapture` on timer / after misses |
| `stillIntervalMs` | `350` mobile, `500` desktop | Min ms between still captures |
| `mobileStillFirst` | `true` on mobile | Defer preview decode ~800ms; fire early still |
| `showResultSheet` | `true` on mobile | Bottom card with thumbnail, Copy / Close |
| `roiFraction` | `0.85` | Center crop (auto-expands to `0.92` after misses) |
| `adaptiveDecode` | `false` | Drop to 1536px after slow frames if `true` |
| `useWorker` | `true` | WASM in Web Worker |
| `continuous` / `closeOnScan` | `false` / `true` | Session behavior |

## Mobile test checklist (Brave / Chrome, HTTPS)

| Test | Expected |
|------|----------|
| Open demo | Full-screen video, large finder (not a small boxed preview) |
| `onCameraReady` | `width` ≥ 1280 when the device allows; `photoWidthMax` &gt; preview width when `ImageCapture` works |
| Small QR ~40cm | Still capture within ~1s; decode succeeds |
| After scan | Result sheet with format + text (if `showResultSheet`) |
| vs Scanbot web demo | Similar sharp preview; tiny/damaged codes may differ (rxing vs proprietary engine) |

## Architecture

```
www/js/rustbar.js      # API + scan state machine
www/js/camera.js       # getUserMedia, focus hints, torch
www/js/capture.js      # ImageCapture takePhoto / grabFrame
crates/rustbar-core/   # rxing decode pipeline
scanner/               # wasm-bindgen → www/pkg
```

## WASM exports

| Export | Description |
|--------|-------------|
| `decodeVideoFrame` | Main live path — ROI crop + decode |
| `decodeImageBytes` | JPEG/PNG still (capped at 4096px, +270° rotation) |
| `decodeFrameRgba` | Pre-sized RGBA square |

## License

MIT OR Apache-2.0
