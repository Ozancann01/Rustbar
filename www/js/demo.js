/**
 * Minimal demo host for RustbarScanner library.
 */

import { RustbarScanner } from "./rustbar.js";

const scanBtn = document.getElementById("scan-btn");
const resultEl = document.getElementById("demo-result");

let session = null;

scanBtn.addEventListener("click", async () => {
  resultEl.hidden = true;

  session = await RustbarScanner.open({
    onScan(text) {
      resultEl.textContent = text;
      resultEl.hidden = false;
    },
    onError(err) {
      console.error("Rustbar:", err);
    },
    continuous: false,
    closeOnScan: true,
  });
});

RustbarScanner.init().catch((err) => {
  console.error("Failed to init WASM:", err);
  scanBtn.disabled = true;
  scanBtn.textContent = "Scanner failed to load";
});
