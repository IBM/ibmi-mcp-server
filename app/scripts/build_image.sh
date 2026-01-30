#!/bin/bash

############################################################################
# Script to build the container image using Podman.
#
# Instructions:
# 1. Set the IMAGE_NAME and IMAGE_TAG variables to the desired values.
# 2. Ensure Podman is installed.
# 3. Set PUSH=true if you want to push the image after building.
#
# This script builds a multi-platform container image for linux/amd64 and linux/arm64.
# The image is tagged and optionally pushed to the specified repository.
############################################################################

# Exit immediately if a command exits with a non-zero status.
set -e

CURR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OS_ROOT="$(dirname ${CURR_DIR})"
DOCKER_FILE="Dockerfile"
IMAGE_NAME="agent-infra-docker"
IMAGE_TAG="latest"
PUSH="${PUSH:-false}"

# Build for multiple platforms
echo "Building image for linux/amd64 and linux/arm64..."
podman build \
  --platform=linux/amd64,linux/arm64 \
  --manifest $IMAGE_NAME:$IMAGE_TAG \
  -f $DOCKER_FILE \
  $OS_ROOT

echo "Image built successfully: $IMAGE_NAME:$IMAGE_TAG"

# Optionally push the manifest
if [ "$PUSH" = "true" ]; then
  echo "Pushing manifest to registry..."
  podman manifest push $IMAGE_NAME:$IMAGE_TAG
  echo "Manifest pushed successfully"
fi
