/**
 * ImageCapture high-res still path (when supported by the browser).
 */

export function isImageCaptureSupported() {
  return typeof ImageCapture !== "undefined";
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
 * @returns {Promise<Blob|null>}
 */
export async function captureHighResStill(imageCapture) {
  if (!imageCapture?.takePhoto) return null;

  let photoOptions;
  try {
    const caps = await imageCapture.getPhotoCapabilities?.();
    if (caps?.imageWidth?.max) {
      photoOptions = { imageWidth: caps.imageWidth.max };
    }
  } catch {
    /* use default takePhoto */
  }

  try {
    const blob = await imageCapture.takePhoto(photoOptions);
    return blob instanceof Blob ? blob : null;
  } catch {
    return null;
  }
}
