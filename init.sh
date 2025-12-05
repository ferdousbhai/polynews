#!/bin/bash

# PolyNews Development Setup
# This script prepares the development environment

set -e

echo "🔮 Setting up PolyNews development environment..."

# Check for Python
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 is required but not found"
    exit 1
fi

# Check for uv (preferred package manager)
if command -v uv &> /dev/null; then
    echo "📦 Installing dependencies with uv..."
    uv sync
else
    echo "📦 uv not found. Install with: curl -LsSf https://astral.sh/uv/install.sh | sh"
    echo "   Or use: pip install -e ."
fi

# Create .env if it doesn't exist
if [ ! -f .env ]; then
    echo "📝 Creating .env template..."
    echo "GOOGLE_API_KEY=your_key_here" > .env
    echo "⚠️  Please add your GOOGLE_API_KEY to .env"
fi

# Start a simple HTTP server for the frontend
echo ""
echo "🚀 To start the development server:"
echo "   cd docs && python3 -m http.server 8000"
echo ""
echo "   Then open http://localhost:8000 in your browser"
echo ""
echo "📊 To fetch fresh market data:"
echo "   uv run python scripts/fetch_markets.py"
echo ""
echo "✅ Setup complete!"
