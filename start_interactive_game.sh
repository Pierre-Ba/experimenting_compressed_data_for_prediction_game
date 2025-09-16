#!/bin/bash

# Start Interactive Game Question Generation System
# This script starts all services and runs the simulator in the foreground for user interaction

# Game configuration
GAME_ID="barcelona-alaves-18-08-18"
GAME_FILE="barcelona-alaves-18-08-18.json"

echo "🎮 Starting Interactive Game Question Generation System"
echo "======================================================"
echo "🎯 Game: $GAME_ID"
echo "📁 File: $GAME_FILE"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to check if a port is in use
check_port() {
    if lsof -Pi :$1 -sTCP:LISTEN -t >/dev/null ; then
        echo -e "${RED}❌ Port $1 is already in use${NC}"
        return 1
    else
        echo -e "${GREEN}✅ Port $1 is available${NC}"
        return 0
    fi
}

# Function to wait for a service to be ready
wait_for_service() {
    local url=$1
    local name=$2
    local max_attempts=30
    local attempt=1
    
    echo -e "${YELLOW}⏳ Waiting for $name to be ready...${NC}"
    
    while [ $attempt -le $max_attempts ]; do
        if curl -s "$url" > /dev/null 2>&1; then
            echo -e "${GREEN}✅ $name is ready!${NC}"
            return 0
        fi
        echo -n "."
        sleep 1
        attempt=$((attempt + 1))
    done
    
    echo -e "${RED}❌ $name failed to start after $max_attempts seconds${NC}"
    return 1
}

# Check if we're in the right directory
if [ ! -f "sb-replay-server.js" ]; then
    echo -e "${RED}❌ Please run this script from the project root directory${NC}"
    exit 1
fi

# Check if Supabase is running
echo -e "${BLUE}🔍 Checking Supabase...${NC}"
if ! curl -s http://localhost:54321/health > /dev/null 2>&1; then
    echo -e "${YELLOW}⚠️  Supabase is not running. Starting it...${NC}"
    supabase start
    if [ $? -ne 0 ]; then
        echo -e "${RED}❌ Failed to start Supabase${NC}"
        exit 1
    fi
else
    echo -e "${GREEN}✅ Supabase is already running${NC}"
fi

# Check ports
echo -e "${BLUE}🔍 Checking ports...${NC}"
check_port 7070 || exit 1
check_port 4000 || exit 1
check_port 8080 || exit 1

# Start Enhanced Snapshot Service
echo -e "${BLUE}🚀 Starting Enhanced Snapshot Service...${NC}"
cd enhanced_snapshot_service
npm start &
ENHANCED_PID=$!
cd ..

# Wait for Enhanced Service to be ready
wait_for_service "http://localhost:7070/health" "Enhanced Snapshot Service"
if [ $? -ne 0 ]; then
    kill $ENHANCED_PID 2>/dev/null
    exit 1
fi

# Start Facet Server
echo -e "${BLUE}🚀 Starting Facet Server...${NC}"
cd llm-facets
node facet_server.js &
FACET_PID=$!
cd ..

# Wait for Facet Server to be ready
wait_for_service "http://localhost:8080/get_facet" "Facet Server"
if [ $? -ne 0 ]; then
    kill $ENHANCED_PID $FACET_PID 2>/dev/null
    exit 1
fi

# Start Bridge Service
echo -e "${BLUE}🚀 Starting Bridge Service...${NC}"
GAME_ID=$GAME_ID node snapshot_writer_service/bridge_sse_to_snapshot.js &
BRIDGE_PID=$!

# Give bridge a moment to start
sleep 2

# Start Replay Server (this triggers everything)
echo -e "${BLUE}🚀 Starting Replay Server (this will trigger the game)...${NC}"
echo -e "${YELLOW}🎯 Game will start streaming in 3 seconds...${NC}"
sleep 3

node sb-replay-server.js $GAME_FILE &
REPLAY_PID=$!

echo ""
echo -e "${GREEN}🎉 All services started successfully!${NC}"
echo -e "${GREEN}🎮 Live game question generation is now running!${NC}"
echo ""
echo -e "${BLUE}📊 Services running:${NC}"
echo -e "  • Enhanced Snapshot Service (PID: $ENHANCED_PID)"
echo -e "  • Facet Server (PID: $FACET_PID)"
echo -e "  • Bridge Service (PID: $BRIDGE_PID)"
echo -e "  • Replay Server (PID: $REPLAY_PID)"
echo ""
echo -e "${YELLOW}💡 Starting interactive simulator...${NC}"
echo -e "${YELLOW}💡 You can now interact with questions as they appear!${NC}"
echo ""

# Start Turn-Based Simulator in the FOREGROUND (this allows user interaction)
cd enhanced_snapshot_service
npm run simulator $GAME_ID
cd ..

# Cleanup function
cleanup() {
    echo -e "\n${YELLOW}🛑 Stopping all services...${NC}"
    kill $ENHANCED_PID $FACET_PID $BRIDGE_PID $REPLAY_PID 2>/dev/null
    echo -e "${GREEN}✅ All services stopped${NC}"
    exit 0
}

# Set up signal handlers
trap cleanup SIGINT SIGTERM

# Keep script running
wait
