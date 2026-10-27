# ReeliF Capture

**ReeliF Capture** by SyntaxilitY — a screen recorder with smooth click zooms. A separate app from
ReeliF Studio (the editor keeps its own recorder).

- Records a whole screen or one window natively on Windows: no system picker, no "sharing your
  screen" bar. Smooth 30/60 fps (FFmpeg Desktop Duplication), cursor shown or hidden.
- System sound (Windows loopback), microphone (optional), camera bubble (optional).
- Floating recording bar: its own always-on-top window, left out of the recording.
- Every click becomes a smooth zoom that glides between clicks and follows the mouse (or zooms out
  when it moves away); click rings; markers; teleprompter; countdown; stop after a set time.
- Library in `Videos\ReeliF Capture`; export with zooms, click rings, a background frame (padding,
  rounded corners, shadow) and the camera bubble, checked with ffprobe after rendering.

## Develop

```
npm install
npm run tauri dev
```

FFmpeg/FFprobe sidecars go in `src-tauri/binaries/` as `ffmpeg-x86_64-pc-windows-msvc.exe` and
`ffprobe-x86_64-pc-windows-msvc.exe` (GPL build, not committed; copy them from ReeliF Studio's
`src-tauri/binaries`).

Checks: `npm run typecheck`, `npm test`, `cargo test` (in `src-tauri`).

## Platforms

Windows first. Native capture, system sound and the click log are Windows-only for now.
