// Cattura i frame del microfono e li inoltra al main thread.
// L'AudioContext è creato a 24 kHz, quindi i frame sono già alla frequenza
// attesa dal protocollo (PCM16 mono 24 kHz dopo la conversione).
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      // Copia: il buffer sottostante viene riciclato dal motore audio.
      this.port.postMessage(channel.slice(0));
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
