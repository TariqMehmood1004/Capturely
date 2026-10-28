//! Words to hide, found on screen while recording. About once a second the recorded area is
//! copied (GDI; ReeliF's own windows are left out of captures) and read with Windows' built-in text
//! recognition (Windows.Media.Ocr: offline, nothing downloaded). Where a remembered word or phrase
//! is seen, its box and the moment are logged; when recording stops the bar turns the log into
//! blur marks (core/redact.ts) that the editor shows and every export applies.
//! Other systems have no built-in text recognition: `redact_start` reports that.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::capture::CaptureRect;
use crate::error::AppResult;

/// A word or phrase seen on screen: when (ms since scanning started) and where (screen pixels).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Hit {
    pub ms: f64,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// A recognised word and its box (pixels of the scanned picture).
#[derive(Clone, Debug)]
pub struct Word {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

/// Letters and digits only, lower case: "Tariq," and "tariq" are the same word.
fn norm(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric() || *c == '@' || *c == '.').flat_map(char::to_lowercase).collect::<String>().trim_matches('.').to_string()
}

/// Boxes (x, y, w, h) where any phrase appears in the recognised lines. A one-word phrase also
/// matches inside a longer word ("acme" in "acme.com"); longer phrases match word by word.
pub fn find_phrases(lines: &[Vec<Word>], phrases: &[String]) -> Vec<(f32, f32, f32, f32)> {
    let wanted: Vec<Vec<String>> = phrases.iter().map(|p| p.split_whitespace().map(norm).filter(|w| !w.is_empty()).collect::<Vec<_>>()).filter(|p| !p.is_empty()).collect();
    let mut out = Vec::new();
    for line in lines {
        let words: Vec<String> = line.iter().map(|w| norm(&w.text)).collect();
        for p in &wanted {
            if p.len() > words.len() {
                continue;
            }
            for i in 0..=words.len() - p.len() {
                let hit = if p.len() == 1 { words[i].len() >= p[0].len() && words[i].contains(&p[0]) } else { p.iter().enumerate().all(|(k, t)| words[i + k] == *t) };
                if hit {
                    let ws = &line[i..i + p.len()];
                    let x0 = ws.iter().map(|w| w.x).fold(f32::MAX, f32::min);
                    let y0 = ws.iter().map(|w| w.y).fold(f32::MAX, f32::min);
                    let x1 = ws.iter().map(|w| w.x + w.w).fold(f32::MIN, f32::max);
                    let y1 = ws.iter().map(|w| w.y + w.h).fold(f32::MIN, f32::max);
                    out.push((x0, y0, x1 - x0, y1 - y0));
                }
            }
        }
    }
    out
}

struct Scan {
    stop: Arc<AtomicBool>,
    hits: Arc<Mutex<Vec<Hit>>>,
    done: std::thread::JoinHandle<()>,
}

static SCAN: Mutex<Option<Scan>> = Mutex::new(None);

/// Seconds between scans (one scan itself takes a little time too).
const EVERY: Duration = Duration::from_millis(700);

/// Start looking for `words` in `area` (screen pixels). Errors when this system cannot read text.
#[tauri::command]
pub fn redact_start(words: Vec<String>, area: CaptureRect) -> AppResult<()> {
    let words: Vec<String> = words.into_iter().map(|w| w.trim().to_string()).filter(|w| !w.is_empty()).take(200).collect();
    redact_stop_now();
    if words.is_empty() {
        return Ok(());
    }
    let reader = ocr::Reader::new()?;
    let stop = Arc::new(AtomicBool::new(false));
    let hits: Arc<Mutex<Vec<Hit>>> = Arc::new(Mutex::new(Vec::new()));
    let (stop2, hits2) = (stop.clone(), hits.clone());
    let done = std::thread::spawn(move || {
        let t0 = Instant::now();
        let reader = reader;
        while !stop2.load(Ordering::Relaxed) {
            let started = Instant::now();
            let ms = t0.elapsed().as_secs_f64() * 1000.0;
            match reader.read(area) {
                Ok((lines, scale)) => {
                    let found = find_phrases(&lines, &words);
                    let mut h = hits2.lock().unwrap_or_else(|e| e.into_inner());
                    for (x, y, w, hh) in found {
                        // Back to screen pixels, a little larger than the letters.
                        let pad = (hh / scale * 0.25).max(3.0);
                        h.push(Hit {
                            ms,
                            x: area.x + (x / scale - pad) as i32,
                            y: area.y + (y / scale - pad) as i32,
                            width: (w / scale + 2.0 * pad) as i32,
                            height: (hh / scale + 2.0 * pad) as i32,
                        });
                    }
                }
                Err(e) => log::warn!("text recognition: {e}"),
            }
            let rest = EVERY.saturating_sub(started.elapsed());
            let until = Instant::now() + rest;
            while Instant::now() < until && !stop2.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    });
    *SCAN.lock().unwrap_or_else(|e| e.into_inner()) = Some(Scan { stop, hits, done });
    Ok(())
}

fn redact_stop_now() -> Vec<Hit> {
    let Some(scan) = SCAN.lock().unwrap_or_else(|e| e.into_inner()).take() else { return Vec::new() };
    scan.stop.store(true, Ordering::Relaxed);
    let _ = scan.done.join();
    let hits = scan.hits.lock().unwrap_or_else(|e| e.into_inner()).clone();
    hits
}

/// Stop scanning; returns everything found (empty when nothing was being scanned).
#[tauri::command]
pub fn redact_stop() -> Vec<Hit> {
    redact_stop_now()
}

#[cfg(windows)]
mod ocr {
    use super::Word;
    use crate::capture::CaptureRect;
    use crate::error::{AppError, AppResult};
    use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::DataWriter;
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC, SelectObject, SetStretchBltMode, StretchBlt, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HALFTONE,
        SRCCOPY,
    };

    pub struct Reader {
        engine: OcrEngine,
        max: u32,
    }

    // SAFETY: the engine is only used from the scanning thread it is moved to.
    unsafe impl Send for Reader {}

    impl Reader {
        pub fn new() -> AppResult<Self> {
            let engine = OcrEngine::TryCreateFromUserProfileLanguages().map_err(|_| AppError::Invalid("Windows text recognition is not available. Add a language with \"Optical character recognition\" in Settings > Time & Language > Language.".into()))?;
            let max = OcrEngine::MaxImageDimension().unwrap_or(2600);
            Ok(Self { engine, max })
        }

        /// Copy `area` of the screen and read it; returns the lines and the scale used.
        pub fn read(&self, area: CaptureRect) -> AppResult<(Vec<Vec<Word>>, f32)> {
            let scale = (self.max as f32 / area.width.max(area.height) as f32).min(1.0);
            let w = ((area.width as f32 * scale) as i32).max(1);
            let h = ((area.height as f32 * scale) as i32).max(1);
            let pixels = grab(area, w, h)?;
            let writer = DataWriter::new().map_err(err)?;
            writer.WriteBytes(&pixels).map_err(err)?;
            let buffer = writer.DetachBuffer().map_err(err)?;
            let bitmap = SoftwareBitmap::CreateCopyFromBuffer(&buffer, BitmapPixelFormat::Bgra8, w, h).map_err(err)?;
            let result = self.engine.RecognizeAsync(&bitmap).map_err(err)?.join().map_err(err)?;
            let lines = result.Lines().map_err(err)?;
            let mut out = Vec::new();
            for i in 0..lines.Size().map_err(err)? {
                let words = lines.GetAt(i).map_err(err)?.Words().map_err(err)?;
                let mut line = Vec::new();
                for j in 0..words.Size().map_err(err)? {
                    let word = words.GetAt(j).map_err(err)?;
                    let r = word.BoundingRect().map_err(err)?;
                    line.push(Word { text: word.Text().map_err(err)?.to_string(), x: r.X, y: r.Y, w: r.Width, h: r.Height });
                }
                out.push(line);
            }
            Ok((out, scale))
        }
    }

    fn err(e: windows::core::Error) -> AppError {
        AppError::Process(format!("Text recognition failed: {e}"))
    }

    /// The screen's pixels in `area`, scaled to w×h, as top-down BGRA.
    fn grab(area: CaptureRect, w: i32, h: i32) -> AppResult<Vec<u8>> {
        // SAFETY: GDI objects created here are released before returning; the buffer is sized
        // for w×h 32-bit pixels as the header describes.
        unsafe {
            let screen = GetDC(None);
            let mem = CreateCompatibleDC(Some(screen));
            let bmp = CreateCompatibleBitmap(screen, w, h);
            let old = SelectObject(mem, bmp.into());
            let ok = if w as u32 == area.width && h as u32 == area.height {
                BitBlt(mem, 0, 0, w, h, Some(screen), area.x, area.y, SRCCOPY | CAPTUREBLT).is_ok()
            } else {
                SetStretchBltMode(mem, HALFTONE);
                StretchBlt(mem, 0, 0, w, h, Some(screen), area.x, area.y, area.width as i32, area.height as i32, SRCCOPY | CAPTUREBLT).as_bool()
            };
            let mut info = BITMAPINFO::default();
            info.bmiHeader = BITMAPINFOHEADER { biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32, biCompression: BI_RGB.0, ..Default::default() };
            let mut pixels = vec![0u8; (w * h * 4) as usize];
            let lines = GetDIBits(mem, bmp, 0, h as u32, Some(pixels.as_mut_ptr().cast()), &mut info, DIB_RGB_COLORS);
            SelectObject(mem, old);
            let _ = DeleteObject(bmp.into());
            let _ = DeleteDC(mem);
            ReleaseDC(None, screen);
            if !ok || lines == 0 {
                return Err(AppError::Process("Could not read the screen.".into()));
            }
            for px in pixels.chunks_exact_mut(4) {
                px[3] = 255;
            }
            Ok(pixels)
        }
    }
}

#[cfg(not(windows))]
mod ocr {
    use super::Word;
    use crate::capture::CaptureRect;
    use crate::error::{AppError, AppResult};

    pub struct Reader;

    impl Reader {
        pub fn new() -> AppResult<Self> {
            Err(AppError::Invalid("Blurring words needs Windows' text recognition; on this system, add blur in the editor.".into()))
        }
        pub fn read(&self, _area: CaptureRect) -> AppResult<(Vec<Vec<Word>>, f32)> {
            Ok((Vec::new(), 1.0))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{find_phrases, Word};

    fn w(text: &str, x: f32) -> Word {
        Word { text: text.into(), x, y: 10.0, w: 40.0, h: 12.0 }
    }

    #[test]
    fn finds_words_and_phrases() {
        let lines = vec![vec![w("Signed", 0.0), w("in", 50.0), w("as", 100.0), w("Tariq", 150.0), w("Mehmood,", 200.0)], vec![w("mail:", 0.0), w("tariq@acme.com", 50.0)]];
        let found = find_phrases(&lines, &["tariq mehmood".into(), "acme".into(), "  ".into()]);
        assert_eq!(found, vec![(150.0, 10.0, 90.0, 12.0), (50.0, 10.0, 40.0, 12.0)]);
        assert!(find_phrases(&lines, &["password".into()]).is_empty());
    }
}
