FROM python:3.11-slim

# Install system dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg curl && \
    rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy requirements first for better caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download rembg model (~176MB) to speed up first run
# This is optional but recommended for production
RUN python -c "from rembg import remove; import requests; from PIL import Image; import io; \
    r = requests.get('https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/240px-Cat03.jpg'); \
    remove(Image.open(io.BytesIO(r.content)))" || echo "Model pre-download failed, will download on first use"

# Copy application code
COPY . .

# Create temp directories
RUN mkdir -p /tmp/video-rebrander/uploads /tmp/video-rebrander/outputs

# Expose port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# Run the application
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
