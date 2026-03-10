FROM python:3.12-slim

# curl cần cho bootstrap_service.py
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies trước (tận dụng Docker layer cache)
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

# Copy toàn bộ project
COPY backend/ ./backend/
COPY frontend/ ./frontend/

# Tạo thư mục sessions (file-based session store)
RUN mkdir -p ./backend/sessions

EXPOSE ${PORT:-8080}

# Railway inject $PORT động — dùng shell form để expand biến
CMD python -m uvicorn backend.main:app --host 0.0.0.0 --port ${PORT:-8080}
