import { useState, useRef, useCallback } from 'react';
import config from '../config.js';

export default function useAudioCapture({ onAudioChunk, onSpeechActivity }) {
  const [isCapturing, setIsCapturing] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const audioContextRef = useRef(null);
  const processorRef = useRef(null);
  const sourceRef = useRef(null);
  const streamRef = useRef(null);
  const isMutedRef = useRef(false);

  // Track speech activity via volume level
  const activityThreshold = 0.01;
  const silenceFrameCountRef = useRef(0);
  const silenceFrameThreshold = 10; // frames of silence before considered silent

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: config.inputSampleRate,
          channelCount: config.audioChannels,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
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

        // Detect speech activity
        let maxAmplitude = 0;
        for (let i = 0; i < inputData.length; i++) {
          const abs = Math.abs(inputData[i]);
          if (abs > maxAmplitude) maxAmplitude = abs;
        }

        if (maxAmplitude > activityThreshold) {
          silenceFrameCountRef.current = 0;
          onSpeechActivity?.(true);
        } else {
          silenceFrameCountRef.current++;
          if (silenceFrameCountRef.current >= silenceFrameThreshold) {
            onSpeechActivity?.(false);
          }
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

      source.connect(processor);
      processor.connect(audioContext.destination);
      setIsCapturing(true);
    } catch (err) {
      console.error('Failed to start audio capture:', err);
      throw err;
    }
  }, [onAudioChunk, onSpeechActivity]);

  const stop = useCallback(() => {
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
    silenceFrameCountRef.current = 0;
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
