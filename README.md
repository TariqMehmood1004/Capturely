# Capturely

Screen recorder with smooth click zooms, by **SyntaxilitY**.

## Install

**Windows:** [`apps/windows/Capturely_0.1.4_x64-setup.exe`](apps/windows/ReeliF%20Capture_0.1.4_x64-setup.exe). Run it and
follow the steps.

Recordings are saved in your Videos folder, in `Capturely`.

**Remaining platforms:** Mac and Ubuntu are coming soon.

| | Windows | Ubuntu | macOS |
|---|---|---|---|
| Screen | yes | yes (Xorg) | yes |
| One window | yes | yes | not yet |
| System sound | yes | yes | no |
| Microphone, camera | yes | yes | yes |
| Bar and frame left out of recordings | yes | no | no |

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

Windows: FFmpeg and FFprobe go in `src-tauri/binaries/` as `ffmpeg-x86_64-pc-windows-msvc.exe` and
`ffprobe-x86_64-pc-windows-msvc.exe` (not committed). Ubuntu and macOS use the system's FFmpeg.

## Build the installers

All three systems: push a tag (`git tag v0.1.1`, `git push origin v0.1.1`). GitHub Actions
(`.github/workflows/installers.yml`) builds them into a draft release.

One system, on that system:

```
npm run tauri build
```

Output: `src-tauri/target/release/bundle/`.
