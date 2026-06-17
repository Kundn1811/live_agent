# Gemini Live Translator

A real-time voice translation assistant powered by Google's Gemini Live API (`gemini-live-2.5-flash-native-audio`) on Vertex AI. Speak in one language, hear and read the translation in another — instantly.

## Architecture

```
Browser (React + Vite)  <-- WebSocket -->  FastAPI Backend  <-- google-genai SDK -->  Gemini Live API (Vertex AI)
      16kHz PCM mic ---->                                                              (us-central1)
      24kHz PCM playback <----                                                         model: gemini-live-2.5-flash-native-audio
```

- **Frontend**: React app capturing 16kHz 16-bit PCM mono audio, encoding to base64, sending over WebSocket. Receives 24kHz PCM translated audio from the model and plays back using Web Audio API with buffer queue scheduling.
- **Backend**: FastAPI server bridging the frontend WebSocket to the Gemini Live API via the `google-genai` Python SDK. Handles session lifecycle and bidirectional audio forwarding.

## How It Works

1. Select a **source language** (what you speak) and a **target language** (what you want to hear).
2. Press **Start Translating** and speak naturally.
3. The model translates everything you say and responds with audio + text in the target language.
4. The model will **only translate** — it will not answer questions, have conversations, or respond to any other queries. If you speak in a language other than the selected source language, it will inform you that only translation between the configured pair is supported.

## Setup

### Prerequisites

- Python 3.10+
- Node.js 18+
- Google Cloud project with Vertex AI API enabled
- Application Default Credentials (ADC) configured

### Backend

```bash
cd backend
pip install -r requirements.txt
python main.py
```

The backend starts on `http://localhost:8000`.

**Environment variables:**

| Variable | Description | Default |
|---|---|---|
| `GOOGLE_CLOUD_PROJECT` | GCP project ID | `account-pocs` |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to service account key JSON | (none) |

The location is hardcoded to `us-central1` as required by the Gemini Live API.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

The frontend starts on `http://localhost:5173`.

## Supported Languages

English, Spanish, French, German, Italian, Portuguese, Japanese, Korean, Chinese (Mandarin), Hindi, Arabic, Russian, Dutch, Swedish, Turkish, Thai, Vietnamese, Indonesian, Tamil, Telugu, Kannada.

## UI Layout

Two-panel dark-themed interface:

| Panel | Purpose |
|---|---|
| **Left** | Language selectors (source/target with swap), session controls (start/stop/mute), connection status, translation status indicator |
| **Center** | Chat-style transcript with source text (right-aligned) and translated text (left-aligned), language labels on each bubble, live waveform indicators |

## Audio

| Direction | Sample Rate | Format | Encoding |
|---|---|---|---|
| User to Model | 16,000 Hz | 16-bit PCM | Little-endian, mono |
| Model to User | 24,000 Hz | 16-bit PCM | Little-endian, mono |

Audio capture uses `AudioContext` with `ScriptProcessorNode`. Playback uses a buffer queue with `AudioBufferSourceNode` scheduling for seamless output.

## Voice Activity Detection (VAD)

Server-side VAD is configured on the Gemini Live API session:

| Parameter | Value | Description |
|---|---|---|
| `start_of_speech_sensitivity` | `LOW` | Less sensitive to speech onset — reduces false triggers |
| `end_of_speech_sensitivity` | `HIGH` | More sensitive to speech end — detects pauses quickly |
| `prefix_padding_ms` | `300` | 300ms of audio buffered before detected speech start |
| `silence_duration_ms` | `800` | 800ms of silence before speech is considered ended |

## WebSocket Protocol

### Frontend to Backend

| Message | Fields | Description |
|---|---|---|
| `setup` | `source_language`, `target_language` | Sent once after WebSocket connects. Configures the Gemini session with the translation pair. |
| `audio` | `data` (base64) | 16kHz PCM audio chunk from the microphone. |
| `stop` | (none) | Client requests session termination. |

### Backend to Frontend

| Message | Fields | Description |
|---|---|---|
| `setup_complete` | (none) | Gemini session is ready. |
| `audio_output` | `data` (base64) | 24kHz PCM translated audio chunk from the model. |
| `input_transcript` | `text` | Transcription of user speech (source language). |
| `output_transcript` | `text` | Transcription of model speech (target language). |
| `turn_complete` | (none) | Model finished its translation turn. |
| `interrupted` | (none) | User interrupted the model. |
| `error` | `message` | Error message. |

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/ws` | WebSocket | Main translation session endpoint |
| `/health` | GET | Health check |
| `/languages` | GET | Returns list of supported languages |

## Project Structure

```
gemini-live-translator/
  backend/
    config.py           # Configuration constants and supported languages
    main.py             # FastAPI WebSocket server
    requirements.txt    # Python dependencies
  frontend/
    src/
      config.js         # Frontend configuration
      App.jsx           # Main app component and session management
      App.css           # Dark theme styles
      index.css         # CSS variables, fonts, animations
      main.jsx          # React entry point
      components/
        LeftPanel.jsx   # Language selectors, controls, status
        CenterPanel.jsx # Translation transcript display
      hooks/
        useWebSocket.js     # WebSocket connection and message routing
        useAudioCapture.js  # 16kHz mic capture, PCM encoding, speech detection
        useAudioPlayback.js # 24kHz buffered audio playback
    index.html
    package.json
    vite.config.js
```
