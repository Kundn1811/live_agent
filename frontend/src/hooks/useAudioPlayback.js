import { useRef, useCallback, useState } from 'react';
import config from '../config.js';

export default function useAudioPlayback() {
  const [isPlaying, setIsPlaying] = useState(false);
  const audioContextRef = useRef(null);
  const bufferQueueRef = useRef([]);
  const activeSourcesRef = useRef([]);
  const nextPlayTimeRef = useRef(0);
  const isPlayingRef = useRef(false);

  const getAudioContext = useCallback(() => {
    if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
      audioContextRef.current = new AudioContext({ sampleRate: config.outputSampleRate });
    }
    return audioContextRef.current;
  }, []);

  const scheduleBuffers = useCallback(() => {
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') {
      ctx.resume();
    }

    while (bufferQueueRef.current.length > 0) {
      const audioBuffer = bufferQueueRef.current.shift();
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);

      const startTime = Math.max(ctx.currentTime, nextPlayTimeRef.current);
      source.start(startTime);
      nextPlayTimeRef.current = startTime + audioBuffer.duration;

      activeSourcesRef.current.push(source);

      source.onended = () => {
        activeSourcesRef.current = activeSourcesRef.current.filter((s) => s !== source);
        if (activeSourcesRef.current.length === 0 && bufferQueueRef.current.length === 0) {
          isPlayingRef.current = false;
          setIsPlaying(false);
        }
      };
    }
  }, [getAudioContext]);

  const queueAudio = useCallback((base64Data) => {
    // Decode base64 to PCM bytes
    const binaryStr = atob(base64Data);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }

    // Convert 16-bit PCM to float32
    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768.0;
    }

    // Create AudioBuffer
    const ctx = getAudioContext();
    const audioBuffer = ctx.createBuffer(1, float32.length, config.outputSampleRate);
    audioBuffer.getChannelData(0).set(float32);

    bufferQueueRef.current.push(audioBuffer);

    if (!isPlayingRef.current) {
      isPlayingRef.current = true;
      setIsPlaying(true);
    }

    scheduleBuffers();
  }, [getAudioContext, scheduleBuffers]);

  const stopPlayback = useCallback(() => {
    // Stop all active sources
    activeSourcesRef.current.forEach((source) => {
      try {
        source.stop();
      } catch {
        // May already be stopped
      }
    });
    activeSourcesRef.current = [];
    bufferQueueRef.current = [];
    nextPlayTimeRef.current = 0;
    isPlayingRef.current = false;
    setIsPlaying(false);
  }, []);

  const cleanup = useCallback(() => {
    stopPlayback();
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
  }, [stopPlayback]);

  return {
    isPlaying,
    queueAudio,
    stopPlayback,
    cleanup,
  };
}
