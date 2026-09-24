# Showcase video

A 60-second product video for design-qa, rendered from code. There is no video editor and no screen recording: every frame is a deterministic function of time, so the video can be edited like any other source file and re-rendered bit for bit.

## How it is built

| File | Role |
|---|---|
| `cues.json` | The shared timeline: 14 scenes on a 120 BPM grid and 137 timed sound events. Every cut, pin drop, keystroke and click sits on the beat grid, so a soundtrack can be laid on later without re-timing. |
| `index.html`, `video.js`, `video.css` | The animation. `window.renderFrame(t)` draws the frame at `t` seconds. A virtual camera handles the close-ins, and motion blur comes from camera velocity. |
| `ui.js`, `acme.css` | The fictional "Acme Console" orders app, built as vector DOM in two variants: the Figma design and the shipped app with deliberate mismatches, across nine states. Because it is vector, close-ins stay sharp at 5×. |
| `render.mjs` | Serves the folder, drives headless Chromium frame by frame in parallel, and pipes PNG frames into ffmpeg (libx264). If `audio/soundtrack.wav` exists, it is muxed in. |
| `fonts/` | Geist and Geist Mono (SIL Open Font License 1.1, see `fonts/OFL.txt`). |

The look follows the report itself: shadcn/ui Neutral tokens, Geist, and the report's severity pin colours.

## Render

Requires Node 20+, ffmpeg with libx264 on `PATH`, and Chromium for Playwright (`npx playwright install chromium`).

```bash
node docs/showcase/render.mjs --video --workers 6
```

The output is `docs/showcase/out/design-qa-showcase.mp4` (1920 × 1080, 60 fps, H.264, silent). Render output is gitignored.

For review while editing:

```bash
node docs/showcase/render.mjs --frames 4.3,31.9,50.7
```

```bash
node docs/showcase/render.mjs --sheet 0:59:1 --cols 5 --name sheet
```

To scrub in a browser, serve the folder over HTTP and open `index.html?play`, or `index.html?play=30` to start at 30 s, or `index.html?t=31.9` for a single frame.

## Editing

- To retime a moment, change it in `cues.json` and in the matching scene in `video.js`, then re-render.
- To add music, drop a WAV at `audio/soundtrack.wav` and re-render. Keep the 120 BPM grid. Every cut sits on a beat, so any 120 BPM track starting on the downbeat at 0.0 s fits.
- All product data is fictional: Acme Console, the ACME-482 ticket and the preview URL are sample content.
