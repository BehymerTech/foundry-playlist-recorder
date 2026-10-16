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

    // The node is configured for 2 explicit channels, so mono input arrives up-mixed.
    const left = input[0];
    const right = input[1] ?? input[0];
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
