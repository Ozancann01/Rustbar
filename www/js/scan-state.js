/**
 * detect → lock → snap state machine for browser scanning.
 */

export const ScanPhase = {
  PreviewScan: "previewScan",
  RoiLock: "roiLock",
  CaptureStill: "captureStill",
  DecodeStill: "decodeStill",
  Done: "done",
};

export class ScanStateMachine {
  /**
   * @param {number} missThreshold
   * @param {number} stillIntervalMs
   * @param {{ mobileEarlyStillMs?: number }} [opts]
   */
  constructor(missThreshold = 3, stillIntervalMs = 500, opts = {}) {
    this.phase = ScanPhase.PreviewScan;
    this.missThreshold = missThreshold;
    this.stillIntervalMs = stillIntervalMs;
    this.mobileEarlyStillMs = opts.mobileEarlyStillMs ?? 0;
    this.missCount = 0;
    this.lastStillAt = performance.now();
    this.startedAt = performance.now();
    this.mobileEarlyFired = false;
  }

  reset() {
    this.phase = ScanPhase.PreviewScan;
    this.missCount = 0;
    this.lastStillAt = performance.now();
    this.startedAt = performance.now();
    this.mobileEarlyFired = false;
  }

  forceStill() {
    if (
      this.phase === ScanPhase.PreviewScan ||
      this.phase === ScanPhase.RoiLock
    ) {
      this.phase = ScanPhase.RoiLock;
    }
  }

  onPreviewMiss() {
    this.missCount++;
    if (
      this.phase === ScanPhase.PreviewScan &&
      this.missCount >= this.missThreshold
    ) {
      this.phase = ScanPhase.RoiLock;
    }
  }

  onPreviewHit() {
    this.missCount = 0;
    this.phase = ScanPhase.Done;
  }

  onRoiLockSettled() {
    if (this.phase === ScanPhase.RoiLock) {
      this.phase = ScanPhase.CaptureStill;
    }
  }

  onStillCaptureStarted() {
    this.phase = ScanPhase.DecodeStill;
  }

  onStillDecodeDone(found) {
    if (!found) this.missCount++;
    else this.missCount = 0;
    this.phase = ScanPhase.PreviewScan;
    this.lastStillAt = performance.now();
  }

  requestStillByTimer() {
    const now = performance.now();
    if (
      this.phase === ScanPhase.PreviewScan &&
      this.mobileEarlyStillMs > 0 &&
      !this.mobileEarlyFired &&
      now - this.startedAt >= this.mobileEarlyStillMs
    ) {
      this.mobileEarlyFired = true;
      this.phase = ScanPhase.RoiLock;
      return;
    }
    if (
      this.phase === ScanPhase.PreviewScan &&
      now - this.lastStillAt >= this.stillIntervalMs
    ) {
      this.phase = ScanPhase.RoiLock;
    }
  }

  shouldRunStillPath() {
    return (
      this.phase === ScanPhase.RoiLock ||
      this.phase === ScanPhase.CaptureStill ||
      this.phase === ScanPhase.DecodeStill
    );
  }

  canCaptureStill() {
    return this.phase === ScanPhase.RoiLock;
  }
}
