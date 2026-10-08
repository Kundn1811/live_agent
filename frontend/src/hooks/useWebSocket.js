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
  onConnectLatency,
  onRtt,
}) {
  const [connectionStatus, setConnectionStatus] = useState('disconnected');
  const wsRef = useRef(null);
  // Periodic RTT probe timer (see ping/pong below); cleared on close/unmount.
  const pingTimerRef = useRef(null);
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
    // Step-2 metric: time the client<->backend WebSocket open handshake. This is
    // a different leg from the server-side pool-checkout "setup handshake".
    const tConnectStart = performance.now();
    const ws = new WebSocket(config.wsUrl);
    wsRef.current = ws;

    // RTT probe: stamp a client clock into a ping and let the backend echo it
    // back. RTT = now - t0; subtracting the server's hold time isolates the wire.
    const sendPing = () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping', t0: performance.now() }));
      }
    };

    ws.onopen = () => {
      setConnectionStatus('connected');
      onConnectLatency?.(Math.round(performance.now() - tConnectStart));
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
          // Begin probing RTT now that the session is live. One immediate sample
          // (so a value exists by first-audio) plus a periodic refresh.
          sendPing();
          if (pingTimerRef.current) clearInterval(pingTimerRef.current);
          pingTimerRef.current = setInterval(sendPing, 2000);
          break;
        case 'pong':
          if (typeof msg.client_t0 === 'number') {
            const rtt = performance.now() - msg.client_t0;
            const hold = typeof msg.server_hold_ms === 'number' ? msg.server_hold_ms : 0;
            onRtt?.(Math.round((rtt - hold) * 10) / 10);
          }
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
      if (pingTimerRef.current) {
        clearInterval(pingTimerRef.current);
        pingTimerRef.current = null;
      }
      wsRef.current = null;
    };

    ws.onerror = () => {
      setConnectionStatus('disconnected');
    };

    return ws;
  }, [onAudioOutput, onInputTranscript, onOutputTranscript, onTurnComplete, onInterrupted, onError, onSetupComplete, onServerFirstAudio, onConnectLatency, onRtt]);

  const disconnect = useCallback(() => {
    if (pingTimerRef.current) {
      clearInterval(pingTimerRef.current);
      pingTimerRef.current = null;
    }
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

  // Ship a consolidated per-session metrics record to the backend for later
  // comparison (backend appends it to metrics.jsonl). Sent mid-session at
  // first-audio, so the socket is healthy and delivery is reliable.
  const sendMetrics = useCallback((metrics) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'metrics', ...metrics }));
    }
  }, []);

  useEffect(() => {
    return () => {
      if (pingTimerRef.current) {
        clearInterval(pingTimerRef.current);
        pingTimerRef.current = null;
      }
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
    sendMetrics,
  };
}
