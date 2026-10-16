/**
 * AudioWorklet that buffers microphone PCM and posts it to the main thread
 * in blocks of BLOCK_SIZE frames as a [left, right] pair of Float32Arrays.
 */
const BLOCK_SIZE = 4096;

class PlaylistRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.left = new Float32Array(BLOCK_SIZE);
    this.right = new Float32Array(BLOCK_SIZE);
    this.offset = 0;
    this.peak = 0;
    this.stereoSeen = false;
    this.active = true;
    this.port.onmessage = event => {
      if (event.data !== "stop") return;
      this.flush();
      this.active = false;
      this.port.postMessage({ done: true });
    };
  }

  process(inputs) {
    if (!this.active) return false;
    const input = inputs[0];
    if (!input?.length) return true;

    // Mono microphones arrive as one channel; iOS Safari instead reports two channels
    // with a digitally silent right channel. Either way, duplicate the left channel.
    const left = input[0];
    if (input[1] && !this.isEmpty(input[1])) this.stereoSeen = true;
    const right = input[1] && (this.stereoSeen || this.isEmpty(left)) ? input[1] : left;
    let i = 0;
    while (i < left.length) {
      const count = Math.min(left.length - i, BLOCK_SIZE - this.offset);
      this.left.set(left.subarray(i, i + count), this.offset);
      this.right.set(right.subarray(i, i + count), this.offset);
      for (let j = i; j < i + count; j++) {
        const level = Math.max(Math.abs(left[j]), Math.abs(right[j]));
        if (level > this.peak) this.peak = level;
      }
      this.offset += count;
      i += count;
      if (this.offset === BLOCK_SIZE) this.flush();
    }
    return true;
  }

  isEmpty(channel) {
    for (let i = 0; i < channel.length; i++) if (channel[i] !== 0) return false;
    return true;
  }

  flush() {
    if (!this.offset) return;
    const left = this.left.slice(0, this.offset);
    const right = this.right.slice(0, this.offset);
    this.port.postMessage({ samples: [left, right], peak: this.peak }, [left.buffer, right.buffer]);
    this.offset = 0;
    this.peak = 0;
  }
}

registerProcessor("playlist-recorder", PlaylistRecorderProcessor);
