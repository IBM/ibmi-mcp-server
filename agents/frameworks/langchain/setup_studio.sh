#!/bin/bash
# LangGraph Studio Quick Setup Script

set -e

echo "🚀 LangGraph Studio Setup for IBM i Agents"
echo "=========================================="

# Check if we're in the right directory
if [ ! -f "langgraph.json" ]; then
    echo "❌ Error: langgraph.json not found"
    echo "   Please run this script from agents/frameworks/langchain/"
    exit 1
fi

echo ""
echo "📦 Step 1: Setting up Python environment..."

# Check if virtual environment exists
if [ ! -d ".venv" ] && [ ! -d "venv" ]; then
    echo "   Creating virtual environment..."
    uv venv
    echo "   ✅ Virtual environment created"
fi

echo "   Installing dependencies..."
uv pip install langgraph langchain langchain-core langchain-openai langchain-community
uv pip install langchain-mcp-adapters
uv pip install langgraph-checkpoint-sqlite
uv pip install "langgraph-cli[inmem]"
uv pip install langchain-ollama
echo "✅ Dependencies installed"

echo ""
echo "📁 Step 2: Creating directories..."
mkdir -p tmp
mkdir -p src/ibmi_agents/agents
echo "✅ Directories created"

echo ""
echo "⚙️  Step 3: Environment setup..."
if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        cp .env.example .env
        echo "✅ Created .env from .env.example"
        echo "⚠️  IMPORTANT: Edit .env and add your OPENAI_API_KEY"
    else
        echo "⚠️  Warning: .env.example not found"
    fi
else
    echo "✅ .env already exists"
fi

echo ""
echo "🔍 Step 4: Checking IBM i MCP Server..."
if curl -s -f http://127.0.0.1:3010/healthz > /dev/null 2>&1; then
    echo "✅ IBM i MCP Server is running"
else
    echo "⚠️  IBM i MCP Server not detected at http://127.0.0.1:3010"
    echo "   Start it with: npm run dev (from project root)"
fi

echo ""
echo "✅ Setup Complete!"
echo ""
echo "📋 Next Steps:"
echo "   1. Edit .env and add your OPENAI_API_KEY"
echo "      nano .env"
echo ""
echo "   2. Ensure IBM i MCP Server is running:"
echo "      cd /path/to/ibmi-mcp-server && npm run dev"
echo ""
echo "   3. Start LangGraph Studio:"
echo "      langgraph dev"
echo ""
echo "🎯 Quick Commands:"
echo "   langgraph dev              # Start Studio"
echo "   langgraph dev --debug      # Start with debug logging"
echo "   langgraph dev --port 8080  # Use custom port"
echo ""
echo "📚 Documentation: See LANGGRAPH_STUDIO.md for details"
