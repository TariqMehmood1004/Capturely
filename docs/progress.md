# Progress

## 0.1.1 (2026-10-27): capture bar and editor window

- The app starts as a floating capture bar at the bottom of the screen (always on top, not
  recorded): drag grip, source picker (screens and windows), microphone, camera, system sound,
  countdown (off/3/5), record, more settings, minimize, quit. Panels open above the bar and the
  window is sized to them (`bar_fit`).
- Countdown shows in the middle of the recorded screen (click-through overlay window).
- Recording controls (marker, restart, pause, stop, teleprompter) live in the same bar; the
  separate HUD window is gone. After Stop the bar shows "Preparing recording", then the editor
  window opens maximized on the take. The editor also holds the library.
- Look: flat surfaces, no borders or gradients; one soft shadow on the bar and its panels.
- Editor relayout: tool rail (Zoom, Clicks, Frame, Camera), a settings panel, the picture as
  large as it fits, Export / folder / delete at the top right, and a timeline (ruler, markers,
  clip lane, zoom lane, playhead; drag or arrow keys to seek).
- Custom controls (`ui/controls.tsx`): switch, segmented radio with a gliding highlight, slider
  (drag, arrows, Page, Home/End), swatches; used by the bar and the editor.
- Moving the bar scales it out a little; it springs back when let go.
- Editor laid out like ReeliF Studio: rail + side panel (details, clicks, markers), player
  (tools, stage, transport with timecode), inspector with underlined tabs, full-width timeline
  with track heads; 5 px splitters resize the panels (remembered; double-click resets).
- Title bar like Studio's compact one (40 px): logo and name, Library/Recording pages, the open recording in the
  middle, New recording, and Studio's window buttons (maximise/restore follows the window).
- Editing (`core/edits.ts`, saved in take.json `edit`): split at the playhead (S), delete or
  restore a piece (Delete), select one zoom to change its depth or turn it off, undo/redo
  (Ctrl+Z / Ctrl+Y). Playback skips cuts; exports trim picture and sound with select/aselect
  after all effects (checked with FFmpeg: a 10 s clip with a 2 s cut gives 8 s MP4 and GIF).
- Library: a delete button on each card (asks once), and Select (one by one, Select all,
  Ctrl+A) to delete several.
- Export dropdown (Recordly-style): MP4 or GIF, quality Low/Medium/High/Original (60/75/90/100 %
  of the recording), encoding Fast/Balanced/Quality (x264 preset + CRF), frame rate; remembered.
  GIFs use a palette made from the clip. Presets dropdown saves the whole look under a name.
- The bar's settings popover has tabs (Recording, Effects, Script) instead of one scrolling list.
- The recording frame traces itself in, flashes when recording starts and breathes; it is drawn
  only when Windows confirms the overlay is left out of captures (read back after showing).
- A yellow frame marks what is recorded from the countdown until Stop (grey and "Paused" while
  paused); it is a click-through overlay window left out of the recording.
- The editor window always opens on the library; the take just recorded is marked "New".
- Gliding hover pill (Studio's menu bar) on button groups everywhere (`ui/glide.ts`).
- Theme switch in the title bar (as in ReeliF Studio): dark or light, revealed by a circle
  growing from the switch (View Transitions), the chosen icon turns in; remembered and applied
  in every window (`ui/theme.ts`, `ui/ThemeSwitch.tsx`). Until chosen, Windows decides.
- Theme follows Windows app mode (dark or light tokens via prefers-color-scheme); thin custom
  scrollbars everywhere. Editor keys: Space play/pause, arrows step a second, Home/End.
- Fixed: windows were built in synchronous commands, which deadlocks on Windows (Record hung).
- Checked: typecheck, unit tests, `cargo check`, the idle bar seen on screen, the editor and the
  bar's panels seen in a browser preview with sample data. Not yet checked
  by hand: a full record → countdown → stop → editor run.

## 0.1.0 (2026-10-27): first version

- Project created (Tauri 2 + React + TypeScript), separate from ReeliF Studio.
- Recorder page (screen or window, system sound, microphone with level and noise reduction,
  camera bubble with live preview and corner/size, click zoom depth/hold/follow, click rings,
  cursor, countdown, 30/60 fps, stop after, teleprompter), remembered choices.
- Native capture with a floating bar (always on top, excluded from capture) for pause, marker,
  restart and stop; steps with progress after Stop.
- Take page: preview with the zooms, click rings, frame and camera bubble as they will export;
  export with progress and ffprobe check; show in folder; delete.
- Library of takes.
- Checked: typecheck, unit tests (zoom curves match the export expressions, export graph order),
  `cargo check`, a full export graph (zoom + ring + frame + camera) rendered by FFmpeg.
