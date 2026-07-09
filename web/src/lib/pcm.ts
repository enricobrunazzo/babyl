/**
 * Conversioni PCM16 mono ↔ ArrayBuffer usate dal trasporto audio.
 *
 * L'audio viaggia sul WebSocket come frame binari (PCM16 little-endian): niente
 * base64, niente wrapper JSON — si risparmia il ~33% di overhead sul hop
 * client↔server rispetto alla codifica testuale.
 */

export const SAMPLE_RATE = 24000;

export function floatToPcmBuffer(samples: Float32Array): ArrayBuffer {
  const int16 = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16.buffer;
}

export function pcmBufferToFloat(buffer: ArrayBuffer): Float32Array {
  const int16 = new Int16Array(buffer, 0, Math.floor(buffer.byteLength / 2));
  const float = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float[i] = int16[i] / 0x8000;
  }
  return float;
}
