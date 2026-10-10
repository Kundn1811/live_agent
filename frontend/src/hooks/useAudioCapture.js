import { useState, useRef, useCallback } from 'react';
import config from '../config.js';
import { analysers, createAnalyser } from '../audioLevels.js';

export default function useAudioCapture({ onAudioChunk, onSpeechActivity }) {
  const [isCapturing, setIsCapturing] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const audioContextRef = useRef(null);
  const processorRef = useRef(null);
  const sourceRef = useRef(null);
  const streamRef = useRef(null);
  const isMutedRef = useRef(false);

  // Speech-activity state for time-based end-of-speech detection.
  //  - lastVoicedAtRef: performance.now() of the most recent voiced frame.
  //  - speakingRef: are we inside a voiced run? Gates the single silent edge.
  const lastVoicedAtRef = useRef(null);
  const speakingRef = useRef(false);

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: config.inputSampleRate,
          channelCount: config.audioChannels,
          echoCancellation: true,
          noiseSuppression: true,
          // AGC ramps gain up during pauses, pushing the noise floor over the
          // VAD threshold so silence reads as speech — off for reliable EoS.
          autoGainControl: false,
        },
      });
      streamRef.current = stream;

      const audioContext = new AudioContext({ sampleRate: config.inputSampleRate });
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      sourceRef.current = source;

      const processor = audioContext.createScriptProcessor(config.audioBufferSize, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (event) => {
        if (isMutedRef.current) return;

        const inputData = event.inputBuffer.getChannelData(0);

        // Speech activity via short-term RMS energy (steadier than peak — one
        // transient sample no longer flags a whole 256ms frame as speech). We
        // emit `true` on every voiced frame (App timestamps each), and a single
        // `false` once the gap since the last voiced frame exceeds vadSilenceMs.
        // Time-based, so it fires ~400ms into a pause regardless of frame size —
        // unlike the old 10-frame count (2.56s at 4096/16k), which was longer
        // than Gemini's whole response so end-of-speech never fired in time.
        let sumSquares = 0;
        for (let i = 0; i < inputData.length; i++) {
          sumSquares += inputData[i] * inputData[i];
        }
        const rms = Math.sqrt(sumSquares / inputData.length);
        const now = performance.now();

        if (rms > config.vadEnergyThreshold) {
          lastVoicedAtRef.current = now;
          speakingRef.current = true;
          onSpeechActivity?.(true);
        } else if (
          speakingRef.current &&
          lastVoicedAtRef.current != null &&
          now - lastVoicedAtRef.current >= config.vadSilenceMs
        ) {
          speakingRef.current = false;
          onSpeechActivity?.(false);
        }

        // Convert float32 to 16-bit PCM
        const pcmData = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        // Convert to base64
        const bytes = new Uint8Array(pcmData.buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);

        onAudioChunk?.(base64);
      };

      // Tap the mic for the 3D visual (read-only branch, doesn't affect the send path).
      const analyser = createAnalyser(audioContext);
      source.connect(analyser);
      analysers.input = analyser;

      source.connect(processor);
      processor.connect(audioContext.destination);
      setIsCapturing(true);
    } catch (err) {
      console.error('Failed to start audio capture:', err);
      throw err;
    }
  }, [onAudioChunk, onSpeechActivity]);

  const stop = useCallback(() => {
    analysers.input = null;
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setIsCapturing(false);
    lastVoicedAtRef.current = null;
    speakingRef.current = false;
  }, []);

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => {
      const next = !prev;
      isMutedRef.current = next;
      return next;
    });
  }, []);

  return {
    isCapturing,
    isMuted,
    start,
    stop,
    toggleMute,
  };
}
