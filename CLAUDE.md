# ReeliF Capture

Standalone screen recorder by **SyntaxilitY** (app name **ReeliF Capture**, identifier
`com.syntaxility.capture`). Separate from ReeliF Studio (`../ReeliF Studio`), which keeps its own
recorder; code was copied, not shared, so the two can change independently.

## Architecture

- Tauri 2 + React 19 + strict TypeScript. Dev server port **1430** (Studio uses 1420).
- `src/core/*` is pure and tested: `zoom.ts` (click zooms, pointer follow, easing, FFmpeg
  expressions), `exportGraph.ts` (export filter graph), `frame.ts` (background frame),
  `recorder.ts` (click log → recording coordinates).
- `src/platform.ts` is the only file that talks to Tauri. Screens: `src/ui/*`.
- Windows (`shell.rs`): `main` is the capture bar (`ui/Bar.tsx`, also runs the recording),
  `overlay` the frame and countdown over what is recorded (`ui/Overlay.tsx`), `editor` the
  maximized library/take window (`App.tsx`). Hover pills: add `glide` + a `.glide-pill` child.
- Rust: `capture.rs` (ddagrab/gdigrab segments, WASAPI loopback via cpal),
  `clicks.rs` (global click and pointer log), `recordings.rs` (library, takes, raw files, export),
  `jobs.rs` (cancellable processes with progress).
- A take is a folder in `Videos\ReeliF Capture`: `recording.mp4`, `camera.mp4`, `take.json`,
  `Export*.mp4`.

## Rules

- Subprocesses get argv arrays only; the export graph is one argument via `-filter_complex_script`.
- Outputs are written to partial files and renamed; exports are checked with ffprobe.
- Generated streams (backgrounds, masks) are endless: exports always carry `-t <duration>`.
- UI: flat surfaces, dark or light with the Windows theme (tokens in `styles.css`; no borders or gradients; only the bar and its panels get a soft shadow), Heroicons only (no emoji), icon-only buttons are 32 px circles, motion
  with GSAP and always off under reduced motion.
- Nothing is uploaded. Recordings, models and FFmpeg binaries are never committed.
- Keep `docs/progress.md` current.
