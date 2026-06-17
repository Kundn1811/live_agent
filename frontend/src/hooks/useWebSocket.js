import { useState, useRef, useCallback, useEffect } from 'react';
import config from '../config.js';

export default function useWebSocket({
  onAudioOutput,
  onInputTranscript,
  onOutputTranscript,
  onTurnComplete,
  onInterrupted,
  onError,
  onSetupComplete,
  onServerFirstAudio,
}) {
  const [connectionStatus, setConnectionStatus] = useState('disconnected');
  const wsRef = useRef(null);
  // Only pump mic audio once Gemini's session is live. Before setup_complete the
  // backend is blocked in the connect handshake, so anything we send just buffers
  // and gets dumped to Gemini as a backlog afterwards — which inflates the first
  // turn's measured latency. Gating here keeps the first-audio numbers honest.
  const setupCompleteRef = useRef(false);

  const connect = useCallback((sourceLanguage, targetLanguage) => {
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) {
      wsRef.current.close();
    }

    setConnectionStatus('connecting');
    setupCompleteRef.current = false;
    const ws = new WebSocket(config.wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnectionStatus('connected');
      ws.send(JSON.stringify({
        type: 'setup',
        source_language: sourceLanguage,
        target_language: targetLanguage,
      }));
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      switch (msg.type) {
        case 'setup_complete':
          setupCompleteRef.current = true;
          onSetupComplete?.(msg.setup_latency_ms);
          break;
        case 'server_first_audio':
          onServerFirstAudio?.(msg.latency_ms);
          break;
        case 'audio_output':
          onAudioOutput?.(msg.data);
          break;
        case 'input_transcript':
          onInputTranscript?.(msg.text);
          break;
        case 'output_transcript':
          onOutputTranscript?.(msg.text);
          break;
        case 'turn_complete':
          onTurnComplete?.();
          break;
        case 'interrupted':
          onInterrupted?.();
          break;
        case 'error':
          onError?.(msg.message || msg.error || 'Unknown error');
          break;
        default:
          break;
      }
    };

    ws.onclose = () => {
      setConnectionStatus('disconnected');
      setupCompleteRef.current = false;
      wsRef.current = null;
    };

    ws.onerror = () => {
      setConnectionStatus('disconnected');
    };

    return ws;
  }, [onAudioOutput, onInputTranscript, onOutputTranscript, onTurnComplete, onInterrupted, onError, onSetupComplete, onServerFirstAudio]);

  const disconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setConnectionStatus('disconnected');
  }, []);

  const sendAudio = useCallback((base64Data) => {
    if (
      wsRef.current &&
      wsRef.current.readyState === WebSocket.OPEN &&
      setupCompleteRef.current
    ) {
      wsRef.current.send(JSON.stringify({
        type: 'audio',
        data: base64Data,
      }));
    }
  }, []);

  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  return {
    connectionStatus,
    connect,
    disconnect,
    sendAudio,
  };
}
