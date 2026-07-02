#!/bin/bash
# Build the Mercury agent container images
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

IMAGE_NAME="mercury-agent"

# Parse arguments
if [ $# -gt 0 ] && [ "$1" != "latest" ]; then
    echo "Usage: $0 [latest]"
    echo ""
    echo "Builds ${IMAGE_NAME}:latest — full devcontainer with Node, Python, Go, git (~2.8GB)."
    exit 1
fi

echo "Building ${IMAGE_NAME}:latest (full devcontainer)..."
docker build -f container/Dockerfile -t "${IMAGE_NAME}:latest" .
echo "✓ Built ${IMAGE_NAME}:latest"
echo ""
echo "Build complete!"
