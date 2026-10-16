# Playlist Recorder

A Foundry VTT module that adds a **Record** button to the top of the Playlists sidebar. It records from your microphone, encodes the audio in the browser as **Ogg Vorbis**, asks you for a name, and saves it to your User Data folder under `recordings/`.

## Usage

1. Open the **Playlists** sidebar tab and click **Record**. Allow microphone access when the browser asks.
2. The button turns red and shows the elapsed time, and a live waveform of the incoming audio scrolls underneath it, so you can see the microphone is being captured. Click **Stop** when you're done.
3. Enter a name and click **Save**. The file is saved as `recordings/<name>.ogg`. If that name is taken, a number is added, e.g. `<name> (2).ogg`.

To use a recording, add a sound to any playlist and browse to `recordings/` in the file picker.

The button only appears for users with the **Upload New Files** permission (GMs by default).

## Audio format

Foundry's bundled `.ogg` sounds are Ogg Vorbis, stereo, mostly 44.1 kHz at about 256 kbps. Recordings match that:

| | |
|---|---|
| Codec | Vorbis in an Ogg container |
| Channels | Stereo (mono microphones are duplicated to both channels) |
| Sample rate | Your audio device's rate, usually 48 kHz |
| Bitrate | VBR quality 8, about 256 kbps nominal (configurable) |

Echo cancellation and noise suppression are turned off so the recording sounds natural. Automatic gain control is on by default, because phone and laptop microphones are often far too quiet without it; you can turn it off in the settings.

Chromium-based browsers can't record Ogg natively, so the module bundles a WebAssembly Vorbis encoder ([wasm-media-encoders](https://github.com/arseneyr/wasm-media-encoders), libvorbis). It's served from the module folder; nothing is downloaded from a CDN.

## Settings

- **Recording Quality** (per user): Low (~128 kbps), Medium (~192 kbps), High (~256 kbps, default), Very high (~320 kbps).
- **Automatic Gain Control** (per user, default on): lets the browser level the microphone input.

## Requirements

- Foundry VTT v13 or v14.
- Foundry must be opened over **HTTPS** or `localhost`; browsers only allow microphone access in secure contexts.
- If Foundry sits behind a reverse proxy, its upload size limit must allow the recording size (about 2 MB per minute at the default quality). For example, nginx defaults to `client_max_body_size 1m`.

## Installation

In Foundry: **Add-on Modules → Install Module**, and paste the manifest URL:

```
https://github.com/BehymerTech/foundry-playlist-recorder/releases/latest/download/module.json
```

## Releasing

Push a tag like `v1.0.1` (`git tag v1.0.1 && git push origin v1.0.1`). The release workflow stamps `module.json` with that version and URLs, builds `module.zip`, and publishes a release with both attached. If a release for the tag already exists (for example, one made in the GitHub UI), the files are attached to it instead.

## License

MIT. The bundled encoder is MIT (wasm-media-encoders) and BSD-3-Clause (libogg/libvorbis). See [LICENSE](LICENSE).
