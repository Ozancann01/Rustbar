/**
 * Off-thread WASM barcode decode (keeps camera preview smooth).
 */

import init, { decodeFrameRgba } from "../pkg/rustbar_scanner.js";

const wasmReady = init();
let jobId = 0;
const pending = new Map();

self.onmessage = async (event) => {
  const { type } = event.data;

  if (type === "init") {
    try {
      await wasmReady;
      self.postMessage({ type: "ready" });
    } catch (err) {
      self.postMessage({ type: "error", message: String(err) });
    }
    return;
  }

  if (type === "decode") {
    const { id, buffer, width, height, formatsHint } = event.data;
    try {
      await wasmReady;
      const data = new Uint8Array(buffer);
      const result = decodeFrameRgba(data, width, height, formatsHint);
      self.postMessage({
        type: "result",
        id,
        result: result
          ? { text: result.text, format: result.format }
          : null,
      });
    } catch (err) {
      self.postMessage({
        type: "result",
        id,
        result: null,
        error: String(err),
      });
    }
  }
};
