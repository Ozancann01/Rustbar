//! WASM facade over rustbar-core.

use rustbar_core::session::{ScanSession as CoreSession, TICK_CAPTURE_STILL, TICK_RUN_PREVIEW};
use rustbar_core::ScanResult;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct FrameDecodeResult {
    text: String,
    format: String,
}

#[wasm_bindgen]
impl FrameDecodeResult {
    #[wasm_bindgen(getter)]
    pub fn text(&self) -> String {
        self.text.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn format(&self) -> String {
        self.format.clone()
    }
}

fn to_wasm(r: ScanResult) -> FrameDecodeResult {
    FrameDecodeResult {
        text: r.text,
        format: r.format,
    }
}

#[wasm_bindgen]
pub struct ScanSession {
    inner: CoreSession,
}

#[wasm_bindgen]
impl ScanSession {
    #[wasm_bindgen(constructor)]
    pub fn new(
        miss_threshold: u32,
        still_interval_ms: f64,
        mobile_early_still_ms: f64,
        preview_interval_ms: f64,
        base_roi: f32,
        expanded_roi: f32,
        confirm_frames: u32,
        now_ms: f64,
    ) -> ScanSession {
        ScanSession {
            inner: CoreSession::new(
                miss_threshold,
                still_interval_ms,
                mobile_early_still_ms,
                preview_interval_ms,
                base_roi,
                expanded_roi,
                confirm_frames,
                now_ms,
            ),
        }
    }

    pub fn reset(&mut self, now_ms: f64) {
        self.inner.reset(now_ms);
    }

    /// Bit flags: `1` = capture still, `2` = run preview decode.
    pub fn tick(&mut self, now_ms: f64, still_pipeline_busy: bool, preview_enabled: bool) -> u32 {
        self.inner.tick(now_ms, still_pipeline_busy, preview_enabled)
    }

    pub fn roi_fraction(&self) -> f32 {
        self.inner.roi_fraction()
    }

    pub fn should_apply_focus_before_still(&self) -> bool {
        self.inner.should_apply_focus_before_still()
    }

    pub fn phase_blocks_preview(&self) -> bool {
        self.inner.phase_blocks_preview()
    }

    pub fn can_capture_still(&self) -> bool {
        self.inner.can_capture_still()
    }

    pub fn force_still(&mut self) {
        self.inner.force_still();
    }

    pub fn on_preview_miss(&mut self) {
        self.inner.on_preview_miss();
    }

    pub fn on_roi_lock_settled(&mut self) {
        self.inner.on_roi_lock_settled();
    }

    pub fn on_still_capture_started(&mut self) {
        self.inner.on_still_capture_started();
    }

    pub fn on_still_decode_done(&mut self, found: bool, now_ms: f64) {
        self.inner.on_still_decode_done(found, now_ms);
    }

    pub fn mark_preview_attempt(&mut self, now_ms: f64) {
        self.inner.mark_preview_attempt(now_ms);
    }

    pub fn clear_hit_streak(&mut self) {
        self.inner.clear_hit_streak();
    }

    pub fn take_fast_decode_next(&mut self) -> bool {
        self.inner.take_fast_decode_next()
    }

    pub fn set_fast_decode_next(&mut self, value: bool) {
        self.inner.set_fast_decode_next(value);
    }

    /// Returns confirmed decode result, or null if not yet confirmed / needs more frames.
    pub fn consider_decode_result(&mut self, text: &str, format: &str) -> Option<FrameDecodeResult> {
        self.inner
            .consider_decode_result(text, format)
            .map(to_wasm)
    }
}

#[wasm_bindgen(js_name = tickCaptureStill)]
pub fn tick_capture_still() -> u32 {
    TICK_CAPTURE_STILL
}

#[wasm_bindgen(js_name = tickRunPreview)]
pub fn tick_run_preview() -> u32 {
    TICK_RUN_PREVIEW
}

#[wasm_bindgen(js_name = decodeVideoFrame)]
pub fn decode_video_frame(
    rgba: &[u8],
    frame_width: u32,
    frame_height: u32,
    roi_fraction: f32,
    target_size: u32,
    formats_hint: &str,
) -> Option<FrameDecodeResult> {
    rustbar_core::decode_rgba_frame(
        rgba,
        frame_width,
        frame_height,
        roi_fraction,
        target_size,
        formats_hint,
    )
    .map(to_wasm)
}

#[wasm_bindgen(js_name = decodeFrameRgba)]
pub fn decode_frame_rgba(
    data: &[u8],
    width: u32,
    height: u32,
    formats_hint: &str,
) -> Option<FrameDecodeResult> {
    rustbar_core::decode_frame_rgba(data, width, height, formats_hint).map(to_wasm)
}

#[wasm_bindgen(js_name = decodeImageBytes)]
pub fn decode_image_bytes(bytes: &[u8], formats_hint: &str) -> Option<FrameDecodeResult> {
    rustbar_core::decode_image_bytes(bytes, formats_hint).map(to_wasm)
}

#[wasm_bindgen(js_name = decodeQrRgba)]
pub fn decode_qr_rgba(data: &[u8], width: u32, height: u32) -> Option<String> {
    rustbar_core::decode_frame_rgba(data, width, height, "qrcode,datamatrix").map(|r| r.text)
}
