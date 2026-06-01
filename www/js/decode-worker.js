/**
 * WASM worker — all image processing and decode run in Rust.
 */

import init, { decodeVideoFrame, decodeImageBytes } from "../pkg/rustbar_scanner.js";

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

  if (type === "decode") {
    const {
      id,
      buffer,
      frameWidth,
      frameHeight,
      roiFraction,
      targetSize,
      formatsHint,
    } = event.data;
    try {
      await wasmReady;
      const rgba = new Uint8Array(buffer);
      const result = decodeVideoFrame(
        rgba,
        frameWidth,
        frameHeight,
        roiFraction,
        targetSize,
        formatsHint,
      );
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
