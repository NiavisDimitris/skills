# Showcase video

An 87-second product video for design-qa, rendered from code. There is no video editor and no screen recording: every frame is a deterministic function of time, so the video can be edited like any other source file and re-rendered bit for bit.

## How it is built

| File | Role |
|---|---|
| `cues.json` | The shared timeline: 65.4 s of scenes on a 120 BPM grid and 154 timed events, played back at 0.75× (87.2 s, 90 BPM). Every cut, pin drop, keystroke and click sits on the beat grid, so a soundtrack can be laid on later without re-timing. |
| `index.html`, `video.js`, `video.css` | The animation. `window.renderFrame(t)` draws the frame at `t` seconds of video. `STRETCH` in `video.js` sets the playback speed (4/3 = 0.75×). A virtual camera handles the close-ins, and motion blur comes from camera velocity. |
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
node docs/showcase/render.mjs --frames 5.7,42.5,62.8
```

```bash
node docs/showcase/render.mjs --sheet 0:86:1 --cols 5 --name sheet
```

To scrub in a browser, serve the folder over HTTP and open `index.html?play`, or `index.html?play=40` to start at 40 s, or `index.html?t=42.5` for a single frame.

## Editing

- To retime a moment, change it in `cues.json` and in the matching scene in `video.js`, then re-render.
- To change the pace, edit `STRETCH` in `video.js` and re-render; the video length follows.
- To add music, drop a WAV at `audio/soundtrack.wav` and re-render. At the default pace every cut sits on a 90 BPM grid. Any 90 BPM track starting on the downbeat at 0.0 s fits.
- All product data is fictional: Acme Console, the ACME-482 ticket and the preview URL are sample content.
