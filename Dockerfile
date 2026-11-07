# Backend container for Google Cloud Run (Firebase Hosting forwards /api/** here).
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend backend
COPY frontend frontend
RUN mkdir -p data
ENV PYTHONUNBUFFERED=1
CMD exec uvicorn backend.app:app --host 0.0.0.0 --port ${PORT:-8080}
