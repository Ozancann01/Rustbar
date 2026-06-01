/**
 * ImageCapture high-res still path (when supported by the browser).
 */

export function isImageCaptureSupported() {
  return typeof ImageCapture !== "undefined";
}

/** Max still width from ImageCapture photo capabilities (0 if unknown). */
export async function getPhotoMaxWidth(imageCapture) {
  if (!imageCapture?.getPhotoCapabilities) return 0;
  try {
    const caps = await imageCapture.getPhotoCapabilities();
    return caps?.imageWidth?.max ?? 0;
  } catch {
    return 0;
  }
}

export function createImageCapture(stream) {
  if (!isImageCaptureSupported()) return null;
  const track = stream?.getVideoTracks()?.[0];
  if (!track) return null;
  try {
    return new ImageCapture(track);
  } catch {
    return null;
  }
}

/**
 * Capture a full-resolution still from the active camera track.
 * @param {ImageCapture} imageCapture
 * @param {{ torchOn?: boolean }} [opts]
 * @returns {Promise<Blob|null>}
 */
export async function captureHighResStill(imageCapture, opts = {}) {
  if (!imageCapture) return null;

  let photoOptions;
  try {
    const caps = await imageCapture.getPhotoCapabilities?.();
    if (caps?.imageWidth?.max) {
      photoOptions = { imageWidth: caps.imageWidth.max };
    }
    if (opts.torchOn && caps?.fillLightMode?.includes?.("flash")) {
      photoOptions = { ...photoOptions, fillLightMode: "flash" };
    }
  } catch {
    /* use defaults */
  }

  if (imageCapture.takePhoto) {
    try {
      const blob = await imageCapture.takePhoto(photoOptions);
      if (blob instanceof Blob) return blob;
    } catch {
      /* fall through to grabFrame */
    }
  }

  if (imageCapture.grabFrame) {
    try {
      const bitmap = await imageCapture.grabFrame();
      const blob = await bitmapToJpegBlob(bitmap);
      bitmap.close?.();
      return blob;
    } catch {
      return null;
    }
  }

  return null;
}

async function bitmapToJpegBlob(bitmap) {
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/jpeg", 0.95);
  });
}
