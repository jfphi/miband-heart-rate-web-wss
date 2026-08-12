FROM --platform=linux/amd64 python:3.12-slim-bookworm

COPY --from=ghcr.io/astral-sh/uv:0.8.4 /uv /usr/local/bin/uv

WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
COPY server ./server
COPY public ./public
COPY main.py ./

RUN uv sync --frozen --no-dev

ENV MIBAND_BACKEND=fastapi_wss

CMD ["uv", "run", "python", "main.py"]
