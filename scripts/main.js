/**
 * Playlist Recorder
 * Adds a Record button to the Playlists sidebar. Audio is captured from the microphone,
 * encoded in the browser to Ogg Vorbis (the format of Foundry's bundled sounds), and
 * uploaded to the user data folder under "recordings/".
 */

const MODULE_ID = "playlist-recorder";
const SOURCE = "data";
const FOLDER = "recordings";
const CHANNELS = 2;
/** Peaks kept for the waveform; each covers 1024 frames (~21 ms at 48 kHz). */
const WAVEFORM_HISTORY = 600;

const localize = key => game.i18n.localize(`PLAYLIST_RECORDER.${key}`);
const format = (key, data) => game.i18n.format(`PLAYLIST_RECORDER.${key}`, data);
const moduleUrl = path => foundry.utils.getRoute(`modules/${MODULE_ID}/${path}`);
const getFilePicker = () => foundry.applications?.apps?.FilePicker?.implementation ?? FilePicker;

/* -------------------------------------------- */
/*  Recorder                                    */
/* -------------------------------------------- */

class Recorder {
  /** @type {"idle"|"starting"|"recording"|"stopping"} */
  state = "idle";
  startedAt = 0;
  chunks = [];
  history = [];
  maxPeak = 0;

  get elapsed() {
    return this.state === "recording" ? (Date.now() - this.startedAt) / 1000 : 0;
  }

  async toggle() {
    if (this.state === "idle") return this.start();
    if (this.state === "recording") return this.stop();
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      ui.notifications.error(localize("ErrorNoMicrophoneApi"));
      return;
    }
    this.#setState("starting");
    try {
      // Load the encoder before opening the microphone so a failure doesn't leave it open.
      this.encoder = await WasmMediaEncoder.createEncoder("audio/ogg", moduleUrl("scripts/vendor/ogg.wasm"));
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: game.settings.get(MODULE_ID, "autoGain")
        },
        video: false
      });
      this.context = new AudioContext();
      await this.context.audioWorklet.addModule(moduleUrl("scripts/recorder-worklet.js"));
      await this.context.resume();

      this.encoder.configure({
        channels: CHANNELS,
        sampleRate: this.context.sampleRate,
        vbrQuality: Number(game.settings.get(MODULE_ID, "quality"))
      });
      this.chunks = [];
      this.history = [];
      this.maxPeak = 0;

      this.source = this.context.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.context, "playlist-recorder", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [CHANNELS],
        channelCount: CHANNELS,
        channelCountMode: "explicit",
        channelInterpretation: "speakers"
      });
      this.node.port.onmessage = event => this.#onWorkletMessage(event.data);
      // The worklet writes nothing to its output; connecting it keeps the graph pulling audio.
      this.source.connect(this.node);
      this.node.connect(this.context.destination);

      this.startedAt = Date.now();
      this.#setState("recording");
    } catch (err) {
      console.error(`${MODULE_ID} | Failed to start recording`, err);
      const reason = err?.name === "NotAllowedError" ? localize("ErrorPermissionDenied") : err.message;
      ui.notifications.error(format("ErrorStart", { reason }));
      await this.#teardown();
      this.#setState("idle");
    }
  }

  async stop() {
    const duration = this.elapsed;
    this.#setState("stopping");
    let blob;
    try {
      // Ask the worklet to flush its partial block, then wait for confirmation.
      await new Promise(resolve => {
        this._resolveDone = resolve;
        this.node.port.postMessage("stop");
      });
      this.chunks.push(this.encoder.finalize().slice());
      blob = new Blob(this.chunks, { type: "audio/ogg" });
    } catch (err) {
      console.error(`${MODULE_ID} | Failed to finish recording`, err);
      ui.notifications.error(format("ErrorEncode", { reason: err.message }));
    } finally {
      await this.#teardown();
      this.chunks = [];
      this.#setState("idle");
    }
    if (!blob) return;

    if (this.maxPeak < 0.001) ui.notifications.warn(localize("WarnSilent"));
    else if (this.maxPeak < 0.1) ui.notifications.warn(localize("WarnQuiet"));
    await saveRecording(blob, duration);
  }

  #onWorkletMessage(data) {
    if (data.samples) {
      const encoded = this.encoder.encode(data.samples);
      // The encoder owns the returned buffer, so it must be copied before the next call.
      if (encoded.length) this.chunks.push(encoded.slice());
      this.maxPeak = Math.max(this.maxPeak, data.peak);
      this.history.push(...data.peaks);
      if (this.history.length > WAVEFORM_HISTORY) this.history.splice(0, this.history.length - WAVEFORM_HISTORY);
    } else if (data.done) {
      this._resolveDone?.();
      this._resolveDone = null;
    }
  }

  async #teardown() {
    try { this.source?.disconnect(); } catch {}
    try { this.node?.disconnect(); } catch {}
    this.stream?.getTracks().forEach(track => track.stop());
    if (this.context && this.context.state !== "closed") await this.context.close().catch(() => {});
    this.source = this.node = this.stream = this.context = this.encoder = null;
  }

  #setState(state) {
    this.state = state;
    clearInterval(this._timer);
    cancelAnimationFrame(this._frame);
    if (state === "recording") {
      this._timer = setInterval(() => updateButtons(), 250);
      const draw = () => {
        drawWaveforms(this.history);
        this._frame = requestAnimationFrame(draw);
      };
      draw();
    }
    updateButtons();
  }
}

const recorder = new Recorder();

/* -------------------------------------------- */
/*  Saving                                      */
/* -------------------------------------------- */

function defaultName() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `Recording ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function sanitizeName(name) {
  return String(name ?? "")
    .replace(/\.ogg$/i, "")
    .replace(/[\\/:*?"<>|#%&{}$!'@+`=^~\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatDuration(seconds) {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Prompt for a file name. Returns the chosen name, or null if the user discards the recording.
 */
async function promptName(blob, duration) {
  const { DialogV2 } = foundry.applications.api;
  const suggested = defaultName();
  const content = `
    <div class="form-group">
      <label>${localize("NameLabel")}</label>
      <div class="form-fields">
        <input type="text" name="recordingName" value="${suggested}" required autofocus>
      </div>
    </div>
    <p class="hint">${format("NameHint", {
      folder: `${FOLDER}/`,
      duration: formatDuration(duration),
      size: (blob.size / 1024).toFixed(0)
    })}</p>`;

  while (true) {
    const result = await DialogV2.wait({
      window: { title: localize("SaveTitle"), icon: "fa-solid fa-microphone" },
      content,
      rejectClose: false,
      buttons: [
        {
          action: "save",
          label: localize("Save"),
          icon: "fa-solid fa-floppy-disk",
          default: true,
          callback: (event, button) => button.form.elements.recordingName.value
        },
        { action: "discard", label: localize("Discard"), icon: "fa-solid fa-trash" }
      ]
    });
    if (typeof result === "string" && result !== "discard") return sanitizeName(result) || suggested;

    // Closing the dialog or pressing Discard must not silently lose the recording.
    const confirmed = await DialogV2.confirm({
      window: { title: localize("DiscardTitle") },
      content: `<p>${localize("DiscardConfirm")}</p>`,
      rejectClose: false
    });
    if (confirmed) return null;
  }
}

async function ensureFolder(FP) {
  try {
    return await FP.browse(SOURCE, FOLDER);
  } catch {
    await FP.createDirectory(SOURCE, FOLDER);
    return { files: [] };
  }
}

function uniqueFileName(name, existingFiles) {
  const taken = new Set(existingFiles.map(f => decodeURIComponent(f.split("/").pop()).toLowerCase()));
  let candidate = `${name}.ogg`;
  for (let i = 2; taken.has(candidate.toLowerCase()); i++) candidate = `${name} (${i}).ogg`;
  return candidate;
}

async function saveRecording(blob, duration) {
  const name = await promptName(blob, duration);
  if (name === null) {
    ui.notifications.info(localize("Discarded"));
    return;
  }
  const FP = getFilePicker();
  try {
    const listing = await ensureFolder(FP);
    const fileName = uniqueFileName(name, listing?.files ?? []);
    const file = new File([blob], fileName, { type: "audio/ogg" });
    const response = await FP.upload(SOURCE, FOLDER, file, {}, { notify: false });
    if (!response?.path) throw new Error(response?.message ?? localize("ErrorUploadUnknown"));
    ui.notifications.info(format("Saved", { path: decodeURIComponent(response.path) }));
  } catch (err) {
    console.error(`${MODULE_ID} | Failed to save recording`, err);
    ui.notifications.error(format("ErrorSave", { reason: err.message }));
  }
}

/* -------------------------------------------- */
/*  UI                                          */
/* -------------------------------------------- */

/**
 * Draw the scrolling waveform (newest audio on the right) into every waveform canvas.
 * Peaks are shown on a -60..0 dBFS scale so normal speech is clearly visible.
 */
function drawWaveforms(history) {
  for (const canvas of document.querySelectorAll(".playlist-recorder-waveform")) {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(canvas.clientWidth * dpr);
    const height = Math.round(canvas.clientHeight * dpr);
    if (!width || !height) continue;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext("2d");
    const color = getComputedStyle(canvas).color;
    const mid = height / 2;
    const stride = 3 * dpr;
    const barWidth = 2 * dpr;
    ctx.clearRect(0, 0, width, height);

    ctx.globalAlpha = 0.35;
    ctx.fillStyle = color;
    ctx.fillRect(0, mid - dpr / 2, width, dpr);

    ctx.globalAlpha = 1;
    const count = Math.min(history.length, Math.floor(width / stride));
    for (let i = 0; i < count; i++) {
      const peak = history[history.length - 1 - i];
      const db = 20 * Math.log10(Math.max(peak, 1e-6));
      const level = Math.min(1, Math.max(0, (db + 60) / 60));
      const barHeight = Math.max(dpr, level * (height - 2 * dpr));
      ctx.fillRect(width - (i + 1) * stride, mid - barHeight / 2, barWidth, barHeight);
    }
  }
}

function updateButtons() {
  const { state } = recorder;
  for (const canvas of document.querySelectorAll(".playlist-recorder-waveform")) {
    canvas.hidden = state !== "recording";
  }
  for (const button of document.querySelectorAll(".playlist-recorder-button")) {
    const label = button.querySelector(".label");
    const icon = button.querySelector("i");
    button.classList.toggle("recording", state === "recording");
    button.disabled = state === "starting" || state === "stopping";
    if (state === "recording") {
      icon.className = "fa-solid fa-stop";
      label.textContent = `${localize("Stop")} ${formatDuration(recorder.elapsed)}`;
      button.dataset.tooltip = localize("StopTooltip");
    } else {
      icon.className = state === "idle" ? "fa-solid fa-microphone" : "fa-solid fa-spinner fa-spin";
      label.textContent = localize("Record");
      button.dataset.tooltip = localize("RecordTooltip");
    }
  }
}

function injectButton(element) {
  if (!game.user.can("FILES_UPLOAD")) return;
  const root = element instanceof HTMLElement ? element : element?.[0];
  const header = root?.querySelector(".header-actions") ?? root?.querySelector(".directory-header");
  if (!header || header.querySelector(".playlist-recorder-button")) return updateButtons();

  const button = document.createElement("button");
  button.type = "button";
  button.className = "playlist-recorder-button";
  button.innerHTML = `<i class="fa-solid fa-microphone" inert></i> <span class="label"></span>`;
  button.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    recorder.toggle();
  });
  header.append(button);

  const canvas = document.createElement("canvas");
  canvas.className = "playlist-recorder-waveform";
  canvas.setAttribute("aria-label", localize("WaveformLabel"));
  if (header.classList.contains("header-actions")) header.after(canvas);
  else header.append(canvas);

  updateButtons();
  if (recorder.state === "recording") drawWaveforms(recorder.history);
}

/* -------------------------------------------- */
/*  Hooks                                       */
/* -------------------------------------------- */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "quality", {
    name: "PLAYLIST_RECORDER.SettingQualityName",
    hint: "PLAYLIST_RECORDER.SettingQualityHint",
    scope: "client",
    config: true,
    type: Number,
    default: 8,
    choices: {
      4: "PLAYLIST_RECORDER.Quality4",
      6: "PLAYLIST_RECORDER.Quality6",
      8: "PLAYLIST_RECORDER.Quality8",
      9: "PLAYLIST_RECORDER.Quality9"
    }
  });

  game.settings.register(MODULE_ID, "autoGain", {
    name: "PLAYLIST_RECORDER.SettingAutoGainName",
    hint: "PLAYLIST_RECORDER.SettingAutoGainHint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });
});

Hooks.on("renderPlaylistDirectory", (app, element) => injectButton(element));
