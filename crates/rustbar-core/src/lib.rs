//! Shared barcode decode pipeline for WASM and native mobile.

pub mod session;

use rxing::helpers::detect_in_luma_filtered_with_hints;
use rxing::BarcodeFormat;
use rxing::DecodeHints;
use rxing::RXingResult;
use std::collections::HashSet;
use std::str::FromStr;

const MAX_SCALE_DIM: u32 = 2560;
const MAX_STILL_DECODE_DIM: u32 = 4096;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScanResult {
    pub text: String,
    pub format: String,
}

/// Full pipeline: center ROI crop → bilinear resize → luma → multi-scale decode.
pub fn decode_rgba_frame(
    rgba: &[u8],
    frame_width: u32,
    frame_height: u32,
    roi_fraction: f32,
    target_size: u32,
    formats_hint: &str,
) -> Option<ScanResult> {
    let expected = (frame_width as usize)
        .checked_mul(frame_height as usize)?
        .checked_mul(4)?;
    if rgba.len() != expected || frame_width == 0 || frame_height == 0 || target_size == 0 {
        return None;
    }

    let roi = roi_fraction.clamp(0.5, 1.0);
    let luma = frame_to_decode_luma(rgba, frame_width, frame_height, roi, target_size)?;
    decode_luma_multiscale(luma, target_size, target_size, formats_hint)
}

/// Pre-cropped square RGBA buffer.
pub fn decode_frame_rgba(
    data: &[u8],
    width: u32,
    height: u32,
    formats_hint: &str,
) -> Option<ScanResult> {
    let expected = (width as usize)
        .checked_mul(height as usize)?
        .checked_mul(4)?;
    if data.len() != expected || width == 0 || height == 0 {
        return None;
    }

    let luma = rgba_to_luma_vec(data, width, height);
    decode_luma_multiscale(luma, width, height, formats_hint)
}

/// Decode from JPEG/PNG bytes (still capture path — larger cap + extra rotation).
pub fn decode_image_bytes(bytes: &[u8], formats_hint: &str) -> Option<ScanResult> {
    let img = image::load_from_memory(bytes).ok()?.to_luma8();
    let (mut width, mut height) = img.dimensions();
    let mut luma = img.into_raw();
    let max_side = width.max(height);
    if max_side > MAX_STILL_DECODE_DIM {
        let scale = MAX_STILL_DECODE_DIM as f32 / max_side as f32;
        let (scaled, nw, nh) = scale_luma(&luma, width, height, scale);
        luma = scaled;
        width = nw;
        height = nh;
    }
    decode_luma_still_multiscale(luma, width, height, formats_hint)
}

fn luma_from_rgb(r: f32, g: f32, b: f32) -> u8 {
    (0.299 * r + 0.587 * g + 0.114 * b).round() as u8
}

fn sample_rgba_luma_bilinear(
    rgba: &[u8],
    frame_width: u32,
    frame_height: u32,
    fx: f32,
    fy: f32,
) -> u8 {
    let max_x = (frame_width - 1) as f32;
    let max_y = (frame_height - 1) as f32;
    let x = fx.clamp(0.0, max_x);
    let y = fy.clamp(0.0, max_y);
    let x0 = x.floor() as u32;
    let y0 = y.floor() as u32;
    let x1 = (x0 + 1).min(frame_width - 1);
    let y1 = (y0 + 1).min(frame_height - 1);
    let tx = x - x0 as f32;
    let ty = y - y0 as f32;

    let mut rgb = [0.0f32; 3];
    for (corner_x, corner_y, wx, wy) in [
        (x0, y0, 1.0 - tx, 1.0 - ty),
        (x1, y0, tx, 1.0 - ty),
        (x0, y1, 1.0 - tx, ty),
        (x1, y1, tx, ty),
    ] {
        let w = wx * wy;
        let i = ((corner_y * frame_width + corner_x) * 4) as usize;
        rgb[0] += rgba[i] as f32 * w;
        rgb[1] += rgba[i + 1] as f32 * w;
        rgb[2] += rgba[i + 2] as f32 * w;
    }
    luma_from_rgb(rgb[0], rgb[1], rgb[2])
}

fn sample_luma_bilinear(luma: &[u8], width: u32, height: u32, fx: f32, fy: f32) -> u8 {
    let max_x = (width - 1) as f32;
    let max_y = (height - 1) as f32;
    let x = fx.clamp(0.0, max_x);
    let y = fy.clamp(0.0, max_y);
    let x0 = x.floor() as u32;
    let y0 = y.floor() as u32;
    let x1 = (x0 + 1).min(width - 1);
    let y1 = (y0 + 1).min(height - 1);
    let tx = x - x0 as f32;
    let ty = y - y0 as f32;

    let i00 = luma[(y0 * width + x0) as usize] as f32;
    let i10 = luma[(y0 * width + x1) as usize] as f32;
    let i01 = luma[(y1 * width + x0) as usize] as f32;
    let i11 = luma[(y1 * width + x1) as usize] as f32;
    let top = i00 * (1.0 - tx) + i10 * tx;
    let bottom = i01 * (1.0 - tx) + i11 * tx;
    (top * (1.0 - ty) + bottom * ty).round() as u8
}

fn frame_to_decode_luma(
    rgba: &[u8],
    frame_width: u32,
    frame_height: u32,
    roi_fraction: f32,
    target: u32,
) -> Option<Vec<u8>> {
    let side = ((frame_width.min(frame_height) as f32) * roi_fraction) as u32;
    let side = side.max(8).min(frame_width.min(frame_height));
    let sx = (frame_width - side) / 2;
    let sy = (frame_height - side) / 2;

    let mut luma = Vec::with_capacity((target * target) as usize);
    for dy in 0..target {
        let fy = sy as f32 + (dy as f32 + 0.5) / target as f32 * side as f32 - 0.5;
        for dx in 0..target {
            let fx = sx as f32 + (dx as f32 + 0.5) / target as f32 * side as f32 - 0.5;
            luma.push(sample_rgba_luma_bilinear(
                rgba,
                frame_width,
                frame_height,
                fx,
                fy,
            ));
        }
    }
    Some(luma)
}

fn rgba_to_luma_vec(rgba: &[u8], width: u32, height: u32) -> Vec<u8> {
    let mut luma = Vec::with_capacity((width * height) as usize);
    for y in 0..height {
        for x in 0..width {
            let i = ((y * width + x) * 4) as usize;
            let r = rgba[i] as f32;
            let g = rgba[i + 1] as f32;
            let b = rgba[i + 2] as f32;
            luma.push(luma_from_rgb(r, g, b));
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

fn scale_luma(luma: &[u8], width: u32, height: u32, scale: f32) -> (Vec<u8>, u32, u32) {
    let mut nw = ((width as f32) * scale).max(64.0) as u32;
    let mut nh = ((height as f32) * scale).max(64.0) as u32;
    let max_side = nw.max(nh);
    if max_side > MAX_SCALE_DIM {
        let cap = MAX_SCALE_DIM as f32 / max_side as f32;
        nw = (nw as f32 * cap) as u32;
        nh = (nh as f32 * cap) as u32;
    }
    let mut out = Vec::with_capacity((nw * nh) as usize);
    for y in 0..nh {
        let fy = (y as f32 + 0.5) / nh as f32 * height as f32 - 0.5;
        for x in 0..nw {
            let fx = (x as f32 + 0.5) / nw as f32 * width as f32 - 0.5;
            out.push(sample_luma_bilinear(luma, width, height, fx, fy));
        }
    }
    (out, nw, nh)
}

fn decode_luma_multiscale(
    mut luma: Vec<u8>,
    width: u32,
    height: u32,
    formats_hint: &str,
) -> Option<ScanResult> {
    contrast_stretch(&mut luma);

    if let Some(frame) = try_decode_luma(luma.clone(), width, height, formats_hint) {
        return Some(frame);
    }

    let (luma_up, w_up, h_up) = scale_luma(&luma, width, height, 1.35);
    if let Some(frame) = try_decode_luma(luma_up, w_up, h_up, formats_hint) {
        return Some(frame);
    }

    let (luma_dn, w_dn, h_dn) = scale_luma(&luma, width, height, 0.75);
    if let Some(frame) = try_decode_luma(luma_dn, w_dn, h_dn, formats_hint) {
        return Some(frame);
    }

    let (luma_rot, w_rot, h_rot) = rotate_luma_90(&luma, width, height);
    try_decode_luma(luma_rot, w_rot, h_rot, formats_hint)
}

/// Still JPEG path: multiscale + 90° (in multiscale) + extra 270° for phone orientation.
fn decode_luma_still_multiscale(
    luma: Vec<u8>,
    width: u32,
    height: u32,
    formats_hint: &str,
) -> Option<ScanResult> {
    if let Some(frame) = decode_luma_multiscale(luma.clone(), width, height, formats_hint) {
        return Some(frame);
    }
    let (luma270, w270, h270) = rotate_luma_270(&luma, width, height);
    try_decode_luma(luma270, w270, h270, formats_hint)
}

fn rotate_luma_90(luma: &[u8], width: u32, height: u32) -> (Vec<u8>, u32, u32) {
    let mut out = Vec::with_capacity(luma.len());
    for x in 0..width {
        for y in (0..height).rev() {
            out.push(luma[(y * width + x) as usize]);
        }
    }
    (out, height, width)
}

fn rotate_luma_270(luma: &[u8], width: u32, height: u32) -> (Vec<u8>, u32, u32) {
    let mut out = Vec::with_capacity(luma.len());
    for x in (0..width).rev() {
        for y in 0..height {
            out.push(luma[(y * width + x) as usize]);
        }
    }
    (out, height, width)
}

fn try_decode_luma(
    luma: Vec<u8>,
    width: u32,
    height: u32,
    formats_hint: &str,
) -> Option<ScanResult> {
    let mut hints = DecodeHints::default();
    hints.TryHarder = Some(true);
    hints.AlsoInverted = Some(true);
    let formats = parse_formats(formats_hint);
    if !formats.is_empty() {
        hints.PossibleFormats = Some(formats);
    }

    let result =
        detect_in_luma_filtered_with_hints(luma, width, height, None, &mut hints).ok()?;
    Some(result_to_scan(result))
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

fn result_to_scan(result: RXingResult) -> ScanResult {
    ScanResult {
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
