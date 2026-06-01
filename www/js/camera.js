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

function buildVideoConstraints(deviceId) {
  const base = deviceId ? { deviceId: { exact: deviceId } } : {};
  const facing = { facingMode: { ideal: "environment" } };
  return [
    { ...base, ...facing, width: { ideal: 3840 }, height: { ideal: 2160 } },
    { ...base, ...facing, width: { ideal: 1920 }, height: { ideal: 1080 } },
    {
      ...base,
      ...facing,
      width: { min: 1920 },
      height: { min: 1080 },
    },
    { ...facing, width: { ideal: 1920 }, height: { ideal: 1080 } },
    { facingMode: "environment" },
  ];
}

function buildUpgradeConstraints(deviceId) {
  const base = deviceId ? { deviceId: { exact: deviceId } } : {};
  const facing = { facingMode: { ideal: "environment" } };
  return [
    {
      ...base,
      ...facing,
      width: { min: 1920 },
      height: { min: 1080 },
    },
    {
      ...base,
      ...facing,
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  ];
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
  syncNativeVideoSize(videoEl);
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
    syncNativeVideoSize(videoEl);
    return next;
  } catch {
    const fallback = await openCameraStream(deviceId);
    videoEl.srcObject = fallback;
    await videoEl.play().catch(() => {});
    await applyCameraEnhancements(fallback, undefined);
    syncNativeVideoSize(videoEl);
    return fallback;
  }
}
