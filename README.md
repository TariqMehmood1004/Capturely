# ReeliF Capture

Screen recorder with smooth click zooms, by **SyntaxilitY**.

## Install

Windows installer: [`.exe/ReeliF Capture_0.1.0_x64-setup.exe`](.exe/ReeliF%20Capture_0.1.0_x64-setup.exe)

Run it and follow the steps. Recordings are saved in `Videos\ReeliF Capture`.

## Features

- Floating capture bar: screen or window, microphone, camera, system sound, countdown.
- Smooth zooms on every click, click rings, cursor, background frame, camera bubble.
- Editor: split and cut, per-zoom depth, undo/redo, markers.
- Export MP4 or GIF with quality, encoding and frame rate choices; saved presets.
- Dark and light themes.

## Develop

```
npm install
npm run tauri dev
```

FFmpeg and FFprobe go in `src-tauri/binaries/` as `ffmpeg-x86_64-pc-windows-msvc.exe` and
`ffprobe-x86_64-pc-windows-msvc.exe` (not committed).

## Build the installer

```
npm run tauri build
```

Output: `src-tauri/target/release/bundle/nsis/`.
