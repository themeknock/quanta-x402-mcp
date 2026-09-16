# Python 3.12: prebuilt wheels for x402, asyncpg, eth-account.
FROM python:3.12-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

EXPOSE 4021
# The host injects $PORT; default to 4021 locally.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-4021}"]
