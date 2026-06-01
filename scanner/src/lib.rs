//! QR decoder for browsers — pass RGBA frames from a canvas / ImageData.

use image::{GrayImage, Luma};
use rqrr::PreparedImage;
use wasm_bindgen::prelude::*;

/// Decode the first QR code found in an RGBA buffer (`width` × `height`, 4 bytes/pixel).
/// Returns the payload string, or `undefined` in JS when nothing is found.
#[wasm_bindgen(js_name = decodeQrRgba)]
pub fn decode_qr_rgba(data: &[u8], width: u32, height: u32) -> Option<String> {
    let expected = (width as usize)
        .checked_mul(height as usize)?
        .checked_mul(4)?;
    if data.len() != expected || width == 0 || height == 0 {
        return None;
    }

    let gray = rgba_to_luma(data, width, height);
    decode_luma(gray)
}

/// Decode from a PNG/JPEG/WebP byte slice (file upload).
#[wasm_bindgen(js_name = decodeQrImageBytes)]
pub fn decode_qr_image_bytes(bytes: &[u8]) -> Option<String> {
    let img = image::load_from_memory(bytes).ok()?.to_luma8();
    decode_luma(img)
}

fn rgba_to_luma(rgba: &[u8], width: u32, height: u32) -> GrayImage {
    let mut gray = GrayImage::new(width, height);
    for y in 0..height {
        for x in 0..width {
            let i = ((y * width + x) * 4) as usize;
            let r = rgba[i] as f32;
            let g = rgba[i + 1] as f32;
            let b = rgba[i + 2] as f32;
            // ITU-R BT.601 luma
            let l = (0.299 * r + 0.587 * g + 0.114 * b).round() as u8;
            gray.put_pixel(x, y, Luma([l]));
        }
    }
    gray
}

fn decode_luma(gray: GrayImage) -> Option<String> {
    let mut prepared = PreparedImage::prepare(gray);
    for grid in prepared.detect_grids() {
        if let Ok((_, content)) = grid.decode() {
            return Some(content);
        }
    }
    None
}
