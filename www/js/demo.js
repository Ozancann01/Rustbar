/**
 * Minimal demo host for RustbarScanner library.
 */

import { RustbarScanner } from "./rustbar.js";

const scanBtn = document.getElementById("scan-btn");
const resultEl = document.getElementById("demo-result");
const formatEl = document.getElementById("demo-format");

scanBtn.addEventListener("click", async () => {
  resultEl.hidden = true;
  if (formatEl) formatEl.hidden = true;

  await RustbarScanner.open({
    onScan(text, format) {
      resultEl.textContent = text;
      resultEl.hidden = false;
      if (formatEl) {
        formatEl.textContent = `Format: ${format}`;
        formatEl.hidden = false;
      }
    },
    showStreamDebug: true,
    onCameraReady(info) {
      console.log(
        "Preview:",
        info.width,
        "x",
        info.height,
        "| preview decode:",
        info.previewRecognitionResolution,
        "| still decode:",
        info.recognitionResolution,
        "| max still width:",
        info.photoWidthMax || "n/a",
        info,
      );
    },
    onError(err) {
      console.error("Rustbar:", err);
    },
    formats: ["qrcode", "datamatrix"],
    prefer4K: true,
    use4KStream: true,
    recognitionResolution: 2048,
    showResultSheet: true,
    continuous: false,
    closeOnScan: true,
  });
});

RustbarScanner.init().catch((err) => {
  console.error("Failed to init WASM:", err);
  scanBtn.disabled = true;
  scanBtn.textContent = "Scanner failed to load";
});
