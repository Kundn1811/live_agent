# Agent worker image, built by LiveKit Cloud (`lk agent deploy`). Not used for the token server
# (see Dockerfile.token). LiveKit injects LIVEKIT_URL/API_KEY/API_SECRET; never set them here.
FROM python:3.12-slim AS build
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc g++ python3-dev \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN python -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

FROM python:3.12-slim
ENV PATH="/opt/venv/bin:$PATH" PYTHONUNBUFFERED=1
WORKDIR /app
# agent.py writes agent.log next to itself, so the app user must own /app.
RUN useradd --create-home --uid 10001 appuser && chown appuser:appuser /app
COPY --from=build /opt/venv /opt/venv
COPY --chown=appuser:appuser . .
USER appuser
CMD ["python", "agent.py", "start"]
