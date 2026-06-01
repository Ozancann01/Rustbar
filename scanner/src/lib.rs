//! Barcode decoder for browsers — QR + Data Matrix via rxing (ZXing).

use rxing::helpers::detect_in_luma_filtered_with_hints;
use rxing::BarcodeFormat;
use rxing::DecodeHints;
use rxing::RXingResult;
use std::collections::HashSet;
use std::str::FromStr;
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

/// Decode barcodes in an RGBA buffer (`width` × `height`, 4 bytes/pixel).
/// `formats_hint` — comma-separated names, e.g. `"qrcode,datamatrix"`.
#[wasm_bindgen(js_name = decodeFrameRgba)]
pub fn decode_frame_rgba(
    data: &[u8],
    width: u32,
    height: u32,
    formats_hint: &str,
) -> Option<FrameDecodeResult> {
    let expected = (width as usize)
        .checked_mul(height as usize)?
        .checked_mul(4)?;
    if data.len() != expected || width == 0 || height == 0 {
        return None;
    }

    let luma = rgba_to_luma_vec(data, width, height);
    decode_luma_multiscale(luma, width, height, formats_hint)
}

/// Decode from PNG/JPEG/WebP bytes.
#[wasm_bindgen(js_name = decodeImageBytes)]
pub fn decode_image_bytes(bytes: &[u8], formats_hint: &str) -> Option<FrameDecodeResult> {
    let img = image::load_from_memory(bytes).ok()?.to_luma8();
    let (width, height) = img.dimensions();
    decode_luma_multiscale(img.into_raw(), width, height, formats_hint)
}

/// Backward-compatible alias (text only).
#[wasm_bindgen(js_name = decodeQrRgba)]
pub fn decode_qr_rgba(data: &[u8], width: u32, height: u32) -> Option<String> {
    decode_frame_rgba(data, width, height, "qrcode,datamatrix").map(|r| r.text)
}

fn rgba_to_luma_vec(rgba: &[u8], width: u32, height: u32) -> Vec<u8> {
    let mut luma = Vec::with_capacity((width * height) as usize);
    for y in 0..height {
        for x in 0..width {
            let i = ((y * width + x) * 4) as usize;
            let r = rgba[i] as f32;
            let g = rgba[i + 1] as f32;
            let b = rgba[i + 2] as f32;
            let l = (0.299 * r + 0.587 * g + 0.114 * b).round() as u8;
            luma.push(l);
        }
    }
    luma
}

fn contrast_stretch(luma: &mut [u8]) {
    let min = luma.iter().copied().min().unwrap_or(0);
    let max = luma.iter().copied().max().unwrap_or(255);
    if max <= min {
        return;
    }
    let range = (max - min) as f32;
    for p in luma.iter_mut() {
        *p = (((*p - min) as f32 / range) * 255.0).round() as u8;
    }
}

fn downscale_luma(luma: &[u8], width: u32, height: u32, scale: f32) -> (Vec<u8>, u32, u32) {
    let nw = ((width as f32) * scale).max(64.0) as u32;
    let nh = ((height as f32) * scale).max(64.0) as u32;
    let mut out = Vec::with_capacity((nw * nh) as usize);
    for y in 0..nh {
        let sy = (y as f32 / nh as f32 * height as f32) as u32;
        let sy = sy.min(height.saturating_sub(1));
        for x in 0..nw {
            let sx = (x as f32 / nw as f32 * width as f32) as u32;
            let sx = sx.min(width.saturating_sub(1));
            out.push(luma[(sy * width + sx) as usize]);
        }
    }
    (out, nw, nh)
}

fn decode_luma_multiscale(
    mut luma: Vec<u8>,
    width: u32,
    height: u32,
    formats_hint: &str,
) -> Option<FrameDecodeResult> {
    contrast_stretch(&mut luma);

    if let Some(frame) = try_decode_luma(luma.clone(), width, height, formats_hint) {
        return Some(frame);
    }

    let (luma2, w2, h2) = downscale_luma(&luma, width, height, 0.75);
    try_decode_luma(luma2, w2, h2, formats_hint)
}

fn try_decode_luma(
    luma: Vec<u8>,
    width: u32,
    height: u32,
    formats_hint: &str,
) -> Option<FrameDecodeResult> {
    let mut hints = DecodeHints::default();
    hints.TryHarder = Some(true);
    hints.AlsoInverted = Some(true);
    let formats = parse_formats(formats_hint);
    if !formats.is_empty() {
        hints.PossibleFormats = Some(formats);
    }

    let result =
        detect_in_luma_filtered_with_hints(luma, width, height, None, &mut hints).ok()?;
    Some(result_to_frame(result))
}

fn parse_formats(formats_hint: &str) -> HashSet<BarcodeFormat> {
    formats_hint
        .split(',')
        .filter_map(|s| {
            let key = s.trim().to_lowercase();
            match key.as_str() {
                "qrcode" | "qr" | "qr_code" => Some(BarcodeFormat::QR_CODE),
                "datamatrix" | "data_matrix" | "dm" => Some(BarcodeFormat::DATA_MATRIX),
                _ => BarcodeFormat::from_str(&key).ok(),
            }
        })
        .collect()
}

fn result_to_frame(result: RXingResult) -> FrameDecodeResult {
    FrameDecodeResult {
        text: result.getText().to_string(),
        format: format_to_string(*result.getBarcodeFormat()),
    }
}

fn format_to_string(format: BarcodeFormat) -> String {
    match format {
        BarcodeFormat::QR_CODE => "qrcode".to_string(),
        BarcodeFormat::DATA_MATRIX => "datamatrix".to_string(),
        other => format!("{:?}", other).to_lowercase(),
    }
}
