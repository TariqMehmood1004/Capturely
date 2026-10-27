//! Linux (X11): the window list and the pointer through Xlib (loaded at run time with x11-dl, as
//! Tauri's windowing does). Screens and windows are grabbed by FFmpeg's `x11grab` (capture.rs).
use std::ffi::CString;
use std::os::raw::{c_int, c_long, c_uchar, c_uint, c_ulong};

use x11_dl::xlib;

use crate::capture::{CaptureRect, CaptureWindow};

/// An open X display; closed when dropped.
struct Display {
    xl: xlib::Xlib,
    dpy: *mut xlib::Display,
}

impl Display {
    fn open() -> Option<Self> {
        let xl = xlib::Xlib::open().ok()?;
        // SAFETY: XOpenDisplay with NULL opens $DISPLAY; checked for null below.
        let dpy = unsafe { (xl.XOpenDisplay)(std::ptr::null()) };
        (!dpy.is_null()).then_some(Self { xl, dpy })
    }

    fn root(&self) -> xlib::Window {
        // SAFETY: a valid open display.
        unsafe { (self.xl.XDefaultRootWindow)(self.dpy) }
    }

    fn atom(&self, name: &str) -> xlib::Atom {
        let c = CString::new(name).unwrap_or_default();
        // SAFETY: a valid display and a NUL-terminated name.
        unsafe { (self.xl.XInternAtom)(self.dpy, c.as_ptr(), xlib::False) }
    }

    /// A window property as raw items: bytes for 8-bit formats, longs for 32-bit ones.
    fn property(&self, win: xlib::Window, prop: xlib::Atom, kind: xlib::Atom) -> Option<(c_int, Vec<u8>, usize)> {
        let (mut actual, mut format, mut n, mut after) = (0 as xlib::Atom, 0 as c_int, 0 as c_ulong, 0 as c_ulong);
        let mut data: *mut c_uchar = std::ptr::null_mut();
        // SAFETY: out-parameters are locals; the returned buffer is copied, then freed with XFree.
        unsafe {
            let st = (self.xl.XGetWindowProperty)(self.dpy, win, prop, 0, 1 << 16, xlib::False, kind, &mut actual, &mut format, &mut n, &mut after, &mut data);
            if st != 0 || data.is_null() {
                return None;
            }
            // 32-bit items come back as C longs.
            let item = match format {
                32 => std::mem::size_of::<c_long>(),
                16 => 2,
                _ => 1,
            };
            let bytes = std::slice::from_raw_parts(data, n as usize * item).to_vec();
            (self.xl.XFree)(data as *mut _);
            Some((format, bytes, n as usize))
        }
    }

    fn title(&self, win: xlib::Window) -> Option<String> {
        let utf8 = self.atom("UTF8_STRING");
        if let Some((8, bytes, _)) = self.property(win, self.atom("_NET_WM_NAME"), utf8) {
            return Some(String::from_utf8_lossy(&bytes).into_owned());
        }
        match self.property(win, xlib::XA_WM_NAME, xlib::AnyPropertyType as xlib::Atom) {
            Some((8, bytes, _)) => Some(String::from_utf8_lossy(&bytes).into_owned()),
            _ => None,
        }
    }

    /// The window's area on the root window, or None when it is not shown.
    fn rect(&self, win: xlib::Window) -> Option<CaptureRect> {
        // SAFETY: zeroed attributes are filled by the call; coordinates are written to locals.
        unsafe {
            let mut a: xlib::XWindowAttributes = std::mem::zeroed();
            if (self.xl.XGetWindowAttributes)(self.dpy, win, &mut a) == 0 || a.map_state != xlib::IsViewable {
                return None;
            }
            let (mut x, mut y, mut child) = (0 as c_int, 0 as c_int, 0 as xlib::Window);
            (self.xl.XTranslateCoordinates)(self.dpy, win, self.root(), 0, 0, &mut x, &mut y, &mut child);
            Some(CaptureRect { x, y, width: a.width.max(0) as u32, height: a.height.max(0) as u32 })
        }
    }

    fn screen_size(&self) -> (i32, i32) {
        // SAFETY: a valid display; the default screen always exists.
        unsafe {
            let s = (self.xl.XDefaultScreen)(self.dpy);
            ((self.xl.XDisplayWidth)(self.dpy, s), (self.xl.XDisplayHeight)(self.dpy, s))
        }
    }
}

impl Drop for Display {
    fn drop(&mut self) {
        // SAFETY: closes the display this value opened.
        unsafe {
            (self.xl.XCloseDisplay)(self.dpy);
        }
    }
}

/// Windows the window manager lists (front-most last there, so reversed), shown, with a title.
pub fn windows() -> Vec<CaptureWindow> {
    let Some(d) = Display::open() else { return Vec::new() };
    let Some((32, bytes, n)) = d.property(d.root(), d.atom("_NET_CLIENT_LIST"), xlib::XA_WINDOW) else { return Vec::new() };
    let size = std::mem::size_of::<c_long>();
    let mut out = Vec::new();
    for i in (0..n).rev() {
        let Ok(raw) = <[u8; std::mem::size_of::<c_ulong>()]>::try_from(&bytes[i * size..(i + 1) * size]) else { continue };
        let win = c_ulong::from_ne_bytes(raw);
        let Some(r) = d.rect(win) else { continue };
        if r.width < 80 || r.height < 60 {
            continue;
        }
        if let Some(title) = d.title(win).filter(|t| !t.trim().is_empty()) {
            out.push(CaptureWindow { id: win.to_string(), title });
        }
    }
    out
}

/// A window's area, kept on the screen (x11grab cannot read outside it).
pub fn window_rect(id: &str) -> Option<CaptureRect> {
    let win: c_ulong = id.parse().ok()?;
    let d = Display::open()?;
    let r = d.rect(win)?;
    let (sw, sh) = d.screen_size();
    let x = r.x.clamp(0, sw - 2);
    let y = r.y.clamp(0, sh - 2);
    let w = (r.width as i32).min(sw - x).max(2);
    let h = (r.height as i32).min(sh - y).max(2);
    Some(CaptureRect { x, y, width: w as u32, height: h as u32 })
}

/// Where the pointer is (root window pixels) and whether the left button is down.
pub struct Pointer {
    d: Display,
}

impl Pointer {
    pub fn new(_monitors: &[super::MonitorScale]) -> Option<Self> {
        Display::open().map(|d| Self { d })
    }

    pub fn read(&mut self) -> Option<(i32, i32, bool)> {
        let (mut root, mut child) = (0 as xlib::Window, 0 as xlib::Window);
        let (mut rx, mut ry, mut wx, mut wy) = (0 as c_int, 0 as c_int, 0 as c_int, 0 as c_int);
        let mut mask: c_uint = 0;
        // SAFETY: a valid display; all out-parameters are locals.
        let ok = unsafe { (self.d.xl.XQueryPointer)(self.d.dpy, self.d.root(), &mut root, &mut child, &mut rx, &mut ry, &mut wx, &mut wy, &mut mask) };
        (ok != 0).then_some((rx, ry, mask & xlib::Button1Mask != 0))
    }
}

/// The X display FFmpeg's x11grab should read (the app's own).
pub fn display_name() -> String {
    std::env::var("DISPLAY").ok().filter(|d| !d.is_empty()).unwrap_or_else(|| ":0".into())
}
