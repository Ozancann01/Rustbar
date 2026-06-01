/**
 * Browser camera glue only — must stay in JS (getUserMedia APIs).
 */

const BAD_CAMERA_RE =
  /telephoto|ultra\s*wide|ultrawide|0\.5x|fish|macro|depth/i;
const GOOD_CAMERA_RE = /back|rear|environment|wide|camera\s*2|main/i;

const DEFAULT_MIN_WIDTH = 1280;

export function scoreCamera(cam) {
  const label = (cam.label || "").toLowerCase();
  let score = 0;
  if (GOOD_CAMERA_RE.test(label)) score += 10;
  if (BAD_CAMERA_RE.test(label)) score -= 20;
  if (/front|user|selfie|face/i.test(label)) score -= 30;
  if (label.length > 0) score += 2;
  return score;
}

export async function pickBestCameraDevice(excludeId) {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter((d) => d.kind === "videoinput");
  if (cams.length === 0) return undefined;

  const scored = cams
    .map((cam) => ({ cam, score: scoreCamera(cam) }))
    .filter((s) => s.cam.deviceId !== excludeId || cams.length === 1)
    .sort((a, b) => b.score - a.score);

  const best = scored.find((s) => s.score > -10) ?? scored[0];
  return best?.cam.deviceId;
}

const FRAME_RATE_HINT = { ideal: 30, max: 30 };

function buildVideoConstraints(deviceId) {
  const base = deviceId ? { deviceId: { exact: deviceId } } : {};
  const facing = { facingMode: { ideal: "environment" } };
  const fps = { frameRate: FRAME_RATE_HINT };
  return [
    { ...base, ...facing, ...fps, width: { ideal: 3840 }, height: { ideal: 2160 } },
    { ...base, ...facing, ...fps, width: { ideal: 1920 }, height: { ideal: 1080 } },
    {
      ...base,
      ...facing,
      ...fps,
      width: { min: 1920 },
      height: { min: 1080 },
    },
    { ...facing, ...fps, width: { ideal: 1920 }, height: { ideal: 1080 } },
    { facingMode: "environment", ...fps },
  ];
}

function buildUpgradeConstraints(deviceId) {
  const base = deviceId ? { deviceId: { exact: deviceId } } : {};
  const facing = { facingMode: { ideal: "environment" } };
  const fps = { frameRate: FRAME_RATE_HINT };
  return [
    {
      ...base,
      ...facing,
      ...fps,
      width: { min: 1920 },
      height: { min: 1080 },
    },
    {
      ...base,
      ...facing,
      ...fps,
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  ];
}

/** Pick width×height from track capabilities (16:9 ladder). */
function resolutionLadder(caps) {
  const maxW = caps?.width?.max ?? 1920;
  const candidates = [
    [3840, 2160],
    [1920, 1080],
    [1280, 720],
    [960, 540],
  ];
  return candidates.filter(([w]) => w <= maxW);
}

/**
 * After initial stream, retry with best resolution from capabilities.
 */
export async function upgradeStreamFromCapabilities(
  stream,
  videoEl,
  minWidth = DEFAULT_MIN_WIDTH,
) {
  const track = stream?.getVideoTracks()?.[0];
  if (!track) return stream;

  const settings = track.getSettings?.() ?? {};
  if ((settings.width ?? 0) >= minWidth) {
    await applyResizeModeNone(stream);
    return stream;
  }

  const deviceId = settings.deviceId;
  const caps = track.getCapabilities?.();
  const ladder = resolutionLadder(caps);

  for (const t of stream.getTracks()) t.stop();

  for (const [w, h] of ladder) {
    if (w < minWidth) continue;
    try {
      const base = deviceId ? { deviceId: { exact: deviceId } } : {};
      const next = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          ...base,
          facingMode: { ideal: "environment" },
          frameRate: FRAME_RATE_HINT,
          width: { ideal: w },
          height: { ideal: h },
        },
      });
      videoEl.srcObject = next;
      await videoEl.play().catch(() => {});
      await applyResizeModeNone(next);
      await applyCameraEnhancements(next, undefined);
      const nw = next.getVideoTracks()[0]?.getSettings?.()?.width ?? 0;
      if (nw >= minWidth) return next;
      for (const t of next.getTracks()) t.stop();
    } catch {
      /* try next size */
    }
  }

  const fallback = await openCameraStream(deviceId);
  videoEl.srcObject = fallback;
  await videoEl.play().catch(() => {});
  await applyCameraEnhancements(fallback, undefined);
  return fallback;
}

export async function openCameraStream(deviceId, constraintList) {
  const list = constraintList ?? buildVideoConstraints(deviceId);
  let lastErr;
  for (const video of list) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: false, video });
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("Could not open camera");
}

export function getStreamSettings(stream) {
  const track = stream?.getVideoTracks()?.[0];
  const s = track?.getSettings?.() ?? {};
  return {
    width: s.width ?? 0,
    height: s.height ?? 0,
    frameRate: s.frameRate ?? 0,
    deviceId: s.deviceId,
    deviceLabel: track?.label ?? "",
  };
}

/** Match video element internal size to native frame dimensions. */
export function syncNativeVideoSize(video) {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return;
  video.width = w;
  video.height = h;
}

export async function applyResizeModeNone(stream) {
  const track = stream?.getVideoTracks()?.[0];
  if (!track?.applyConstraints) return;
  const caps = track.getCapabilities?.();
  if (!caps?.resizeMode?.includes?.("none")) return;
  try {
    await track.applyConstraints({ resizeMode: "none" });
  } catch {
    /* unsupported */
  }
}

/**
 * Center focus/exposure hint before a still capture (browser-native analogue of ROI lock).
 */
export async function applyCenterFocusHint(stream) {
  const track = stream?.getVideoTracks()?.[0];
  if (!track?.applyConstraints) return;

  const advanced = [];
  const caps = track.getCapabilities?.();
  if (caps?.focusMode?.includes?.("single-shot")) {
    advanced.push({ focusMode: "single-shot" });
  } else if (caps?.focusMode?.includes?.("manual")) {
    advanced.push({ focusMode: "manual" });
  }
  if (caps?.pointsOfInterest) {
    advanced.push({ pointsOfInterest: [{ x: 0.5, y: 0.5 }] });
  }
  if (advanced.length > 0) {
    try {
      await track.applyConstraints({ advanced });
    } catch {
      /* unsupported */
    }
  }

  await new Promise((r) => setTimeout(r, 300));

  try {
    await track.applyConstraints({
      advanced: [
        { focusMode: "continuous" },
        { exposureMode: "continuous" },
      ],
    });
  } catch {
    try {
      await track.applyConstraints({
        focusMode: "continuous",
        exposureMode: "continuous",
      });
    } catch {
      /* unsupported */
    }
  }
}

export async function applyCameraEnhancements(stream, torchBtn) {
  const track = stream?.getVideoTracks()?.[0];
  if (!track?.applyConstraints) return;

  await applyResizeModeNone(stream);

  try {
    await track.applyConstraints({
      advanced: [
        { focusMode: "continuous" },
        { exposureMode: "continuous" },
        { whiteBalanceMode: "continuous" },
      ],
    });
  } catch {
    try {
      await track.applyConstraints({
        focusMode: "continuous",
        exposureMode: "continuous",
      });
    } catch {
      /* unsupported */
    }
  }

  const caps = track.getCapabilities?.();
  if (caps?.torch && torchBtn) torchBtn.hidden = false;
  if (caps?.zoom) {
    try {
      await track.applyConstraints({
        advanced: [{ zoom: Math.min(1.2, caps.zoom.max ?? 1.2) }],
      });
    } catch {
      /* optional */
    }
  }
}

export async function toggleTorch(stream, torchOn) {
  const track = stream?.getVideoTracks()?.[0];
  if (!track?.applyConstraints) return torchOn;
  const next = !torchOn;
  await track.applyConstraints({ advanced: [{ torch: next }] });
  return next;
}

export async function maybeRepickCamera(stream, _prefer4K, videoEl) {
  const track = stream?.getVideoTracks()?.[0];
  const currentId = track?.getSettings?.()?.deviceId;
  const betterId = await pickBestCameraDevice(currentId);
  if (!betterId || betterId === currentId) return stream;

  const devices = await navigator.mediaDevices.enumerateDevices();
  const betterCam = devices.find((d) => d.deviceId === betterId);
  const currentCam = devices.find((d) => d.deviceId === currentId);
  if (!betterCam || !currentCam || scoreCamera(betterCam) <= scoreCamera(currentCam)) {
    return stream;
  }

  for (const t of stream.getTracks()) t.stop();
  const next = await openCameraStream(betterId);
  videoEl.srcObject = next;
  await videoEl.play().catch(() => {});
  await applyCameraEnhancements(next, undefined);
  return next;
}

/**
 * Re-open stream with stronger constraints when negotiated width is too low.
 */
export async function upgradeStreamIfLow(stream, videoEl, minWidth = DEFAULT_MIN_WIDTH) {
  const track = stream?.getVideoTracks()?.[0];
  const settings = track?.getSettings?.();
  const currentWidth = settings?.width ?? 0;
  if (currentWidth >= minWidth) return stream;

  const deviceId = settings?.deviceId;
  for (const t of stream.getTracks()) t.stop();

  try {
    const next = await openCameraStream(deviceId, buildUpgradeConstraints(deviceId));
    videoEl.srcObject = next;
    await videoEl.play().catch(() => {});
    await applyCameraEnhancements(next, undefined);
    return next;
  } catch {
    const fallback = await openCameraStream(deviceId);
    videoEl.srcObject = fallback;
    await videoEl.play().catch(() => {});
    await applyCameraEnhancements(fallback, undefined);
    return fallback;
  }
}
