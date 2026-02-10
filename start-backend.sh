#!/bin/bash
# Start ChamPDF Backend Server
# Usage: ./start-backend.sh

cd "$(dirname "$0")/backend"

echo "🚀 Starting ChamPDF Backend..."
echo "📍 Directory: $(pwd)"
echo ""

# Check if dependencies are installed
if ! python3 -c "import rembg" 2>/dev/null; then
    echo "📦 Installing dependencies..."
    pip3 install -r requirements.txt
    echo ""
fi

# Kill existing process on port 8000
if lsof -ti:8000 >/dev/null 2>&1; then
    echo "⚠️  Port 8000 in use, killing existing process..."
    lsof -ti:8000 | xargs kill -9
    sleep 2
fi

# Start server
echo "🎬 Starting Uvicorn server..."
python3 -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload &
SERVER_PID=$!

# Wait for server to start
sleep 3

# Health check
if curl -s http://localhost:8000/health | grep -q "healthy"; then
    echo ""
    echo "✅ Backend is running!"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "🌐 Health:              http://localhost:8000/health"
    echo "📋 API Docs:            http://localhost:8000/docs"
    echo "🎨 Remove Background:   POST /api/remove-background"
    echo "🎬 Process Video:       POST /api/process-video"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "📝 Logs: tail -f /tmp/backend.log"
    echo "🛑 Stop: kill $SERVER_PID"
    echo ""
else
    echo ""
    echo "❌ Backend failed to start"
    echo "Check logs for errors"
    exit 1
fi
