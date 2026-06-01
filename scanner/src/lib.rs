//! WASM facade over rustbar-core.

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
