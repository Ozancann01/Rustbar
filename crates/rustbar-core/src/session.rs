//! Browser scan session state machine (preview / still timing, ROI, hit confirm).

use crate::ScanResult;

/// `tick()` return flags for JS glue.
pub const TICK_CAPTURE_STILL: u32 = 1;
pub const TICK_RUN_PREVIEW: u32 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Phase {
    PreviewScan = 0,
    RoiLock = 1,
    CaptureStill = 2,
    DecodeStill = 3,
    Done = 4,
}

#[derive(Clone, Debug)]
pub struct ScanSession {
    phase: Phase,
    miss_threshold: u32,
    still_interval_ms: f64,
    mobile_early_still_ms: f64,
    preview_interval_ms: f64,
    miss_count: u32,
    last_still_at_ms: f64,
    started_at_ms: f64,
    mobile_early_fired: bool,
    base_roi: f32,
    roi_fraction: f32,
    roi_expanded: bool,
    expanded_roi: f32,
    last_preview_at_ms: f64,
    confirm_frames: u32,
    last_hit_text: Option<String>,
    last_hit_format: Option<String>,
    hit_count: u32,
    fast_decode_next: bool,
    still_requires_focus: bool,
}

impl ScanSession {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        miss_threshold: u32,
        still_interval_ms: f64,
        mobile_early_still_ms: f64,
        preview_interval_ms: f64,
        base_roi: f32,
        expanded_roi: f32,
        confirm_frames: u32,
        now_ms: f64,
    ) -> Self {
        let base_roi = base_roi.clamp(0.5, 0.95);
        let expanded_roi = expanded_roi.clamp(base_roi, 0.95);
        Self {
            phase: Phase::PreviewScan,
            miss_threshold: miss_threshold.max(1),
            still_interval_ms: still_interval_ms.max(100.0),
            mobile_early_still_ms: mobile_early_still_ms.max(0.0),
            preview_interval_ms: preview_interval_ms.max(16.0),
            miss_count: 0,
            last_still_at_ms: now_ms,
            started_at_ms: now_ms,
            mobile_early_fired: false,
            base_roi,
            roi_fraction: base_roi,
            roi_expanded: false,
            expanded_roi,
            last_preview_at_ms: 0.0,
            confirm_frames: confirm_frames.max(1),
            last_hit_text: None,
            last_hit_format: None,
            hit_count: 0,
            fast_decode_next: false,
            still_requires_focus: false,
        }
    }

    pub fn reset(&mut self, now_ms: f64) {
        self.phase = Phase::PreviewScan;
        self.miss_count = 0;
        self.last_still_at_ms = now_ms;
        self.started_at_ms = now_ms;
        self.mobile_early_fired = false;
        self.roi_fraction = self.base_roi;
        self.roi_expanded = false;
        self.last_hit_text = None;
        self.last_hit_format = None;
        self.hit_count = 0;
        self.still_requires_focus = false;
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }

    pub fn roi_fraction(&self) -> f32 {
        self.roi_fraction
    }

    pub fn take_fast_decode_next(&mut self) -> bool {
        let v = self.fast_decode_next;
        self.fast_decode_next = false;
        v
    }

    pub fn set_fast_decode_next(&mut self, value: bool) {
        self.fast_decode_next = value;
    }

    pub fn should_apply_focus_before_still(&self) -> bool {
        self.still_requires_focus
    }

    pub fn phase_blocks_preview(&self) -> bool {
        matches!(
            self.phase,
            Phase::DecodeStill | Phase::CaptureStill
        )
    }

    pub fn can_capture_still(&self) -> bool {
        self.phase == Phase::RoiLock
    }

    pub fn force_still(&mut self) {
        if matches!(self.phase, Phase::PreviewScan | Phase::RoiLock) {
            self.phase = Phase::RoiLock;
            self.still_requires_focus = true;
        }
    }

    pub fn on_preview_miss(&mut self) {
        self.miss_count += 1;
        if self.phase == Phase::PreviewScan && self.miss_count >= self.miss_threshold {
            self.phase = Phase::RoiLock;
            self.still_requires_focus = true;
        }
        if !self.roi_expanded && self.miss_count >= 2 {
            self.roi_fraction = self.roi_fraction.max(self.expanded_roi);
            self.roi_expanded = true;
        }
    }

    pub fn on_preview_hit(&mut self) {
        self.miss_count = 0;
        self.phase = Phase::Done;
    }

    pub fn on_roi_lock_settled(&mut self) {
        if self.phase == Phase::RoiLock {
            self.phase = Phase::CaptureStill;
        }
    }

    pub fn on_still_capture_started(&mut self) {
        self.phase = Phase::DecodeStill;
    }

    pub fn on_still_decode_done(&mut self, found: bool, now_ms: f64) {
        if !found {
            self.miss_count += 1;
        } else {
            self.miss_count = 0;
        }
        self.phase = Phase::PreviewScan;
        self.last_still_at_ms = now_ms;
        self.still_requires_focus = false;
    }

    /// Timer-driven still requests; focus hint only when `still_requires_focus`.
    pub fn tick(&mut self, now_ms: f64, still_pipeline_busy: bool, preview_enabled: bool) -> u32 {
        if self.phase == Phase::PreviewScan {
            if self.mobile_early_still_ms > 0.0
                && !self.mobile_early_fired
                && now_ms - self.started_at_ms >= self.mobile_early_still_ms
            {
                self.mobile_early_fired = true;
                self.enter_timer_still();
            } else if now_ms - self.last_still_at_ms >= self.still_interval_ms {
                self.enter_timer_still();
            }
        }

        let mut flags = 0u32;
        if self.phase == Phase::RoiLock && !still_pipeline_busy {
            flags |= TICK_CAPTURE_STILL;
        }
        if preview_enabled
            && !still_pipeline_busy
            && !self.phase_blocks_preview()
            && now_ms - self.last_preview_at_ms >= self.preview_interval_ms
        {
            flags |= TICK_RUN_PREVIEW;
        }
        flags
    }

    fn enter_timer_still(&mut self) {
        self.phase = Phase::RoiLock;
        self.still_requires_focus = false;
    }

    pub fn mark_preview_attempt(&mut self, now_ms: f64) {
        self.last_preview_at_ms = now_ms;
    }

    /// Hit confirmation; returns confirmed scan when `confirm_frames` reached.
    pub fn consider_decode_result(&mut self, text: &str, format: &str) -> Option<ScanResult> {
        let same = self
            .last_hit_text
            .as_deref()
            .is_some_and(|t| t == text)
            && self
                .last_hit_format
                .as_deref()
                .is_some_and(|f| f == format);

        if same {
            self.hit_count += 1;
        } else {
            self.last_hit_text = Some(text.to_string());
            self.last_hit_format = Some(format.to_string());
            self.hit_count = 1;
        }

        if self.hit_count >= self.confirm_frames {
            self.on_preview_hit();
            return Some(ScanResult {
                text: text.to_string(),
                format: format.to_string(),
            });
        }
        None
    }

    pub fn clear_hit_streak(&mut self) {
        self.last_hit_text = None;
        self.last_hit_format = None;
        self.hit_count = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn miss_threshold_triggers_still_with_focus() {
        let mut s = ScanSession::new(3, 500.0, 0.0, 72.0, 0.85, 0.92, 1, 0.0);
        s.on_preview_miss();
        s.on_preview_miss();
        assert!(!s.should_apply_focus_before_still());
        s.on_preview_miss();
        assert_eq!(s.phase, Phase::RoiLock);
        assert!(s.should_apply_focus_before_still());
    }

    #[test]
    fn timer_still_skips_focus() {
        let mut s = ScanSession::new(3, 100.0, 0.0, 72.0, 0.85, 0.92, 1, 0.0);
        let flags = s.tick(200.0, false, true);
        assert_eq!(s.phase, Phase::RoiLock);
        assert!(!s.should_apply_focus_before_still());
        assert_ne!(flags & TICK_CAPTURE_STILL, 0);
    }

    #[test]
    fn mobile_early_still() {
        let mut s = ScanSession::new(3, 10_000.0, 800.0, 72.0, 0.85, 0.92, 1, 0.0);
        let flags = s.tick(801.0, false, true);
        assert_eq!(s.phase, Phase::RoiLock);
        assert_ne!(flags & TICK_CAPTURE_STILL, 0);
    }

    #[test]
    fn confirm_frames() {
        let mut s = ScanSession::new(3, 500.0, 0.0, 72.0, 0.85, 0.92, 2, 0.0);
        assert!(s.consider_decode_result("a", "qrcode").is_none());
        let r = s.consider_decode_result("a", "qrcode");
        assert!(r.is_some());
        assert_eq!(s.phase, Phase::Done);
    }

    #[test]
    fn roi_expands_after_two_misses() {
        let mut s = ScanSession::new(5, 500.0, 0.0, 72.0, 0.85, 0.92, 1, 0.0);
        s.on_preview_miss();
        s.on_preview_miss();
        assert!((s.roi_fraction() - 0.92).abs() < f32::EPSILON);
    }
}
