/**
 * WASM worker — decode runs off the main thread for smooth video preview.
 */

import init, {
  decodeVideoFrame,
  decodeFrameRgba,
  decodeImageBytes,
} from "../pkg/rustbar_scanner.js";

const wasmReady = init();

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

  if (type === "decodeFrame") {
    const { id, buffer, width, height, targetSize, formatsHint } = event.data;
    try {
      await wasmReady;
      const rgba = new Uint8Array(buffer);
      const result =
        targetSize > 0 && targetSize !== width
          ? decodeVideoFrame(rgba, width, height, 1.0, targetSize, formatsHint)
          : decodeFrameRgba(rgba, width, height, formatsHint);
      self.postMessage({
        type: "result",
        id,
        result: result
          ? { text: result.text, format: result.format }
          : null,
      });
    } catch (err) {
      self.postMessage({ type: "result", id, result: null, error: String(err) });
    }
    return;
  }

  if (type === "decodeImage") {
    const { id, buffer, formatsHint } = event.data;
    try {
      await wasmReady;
      const bytes = new Uint8Array(buffer);
      const result = decodeImageBytes(bytes, formatsHint);
      self.postMessage({
        type: "result",
        id,
        result: result
          ? { text: result.text, format: result.format }
          : null,
      });
    } catch (err) {
      self.postMessage({ type: "result", id, result: null, error: String(err) });
    }
  }
};
