#!/usr/bin/env bash
set -e

# Color codes for output
BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Default values
DEFAULT_REMOTE_PATH="~/mcp_server_test"
DEFAULT_SSH_PORT=22
APP_DIR_NAME="ibmi-mcp-server"  # Clean app directory name inside tgz

# Default behaviors (note: INCLUDE_MODULES is TRUE by default)
INCLUDE_MODULES=true
SKIP_VALIDATION=false
SKIP_BUILD=false
TEST_NPX=false

show_help() {
  cat << EOF
Debug Deploy Script - Build and deploy MCP server to IBM i for testing

Usage: ./scripts/debug-deploy.sh [OPTIONS]

Options:
  --host <hostname>       IBM i hostname (default: from .env DB2i_HOST)
  --user <username>       SSH username (default: from .env DB2i_USER)
  --port <port>           SSH port (default: 22)
  --path <remote-path>    Remote deployment path (default: ~/mcp_server_test)
  --skip-modules          Run npm ci on IBM i instead of packaging Mac node_modules
                          (Use for platform-specific binaries)
  --skip-validation       Skip running tests and typecheck before deploy
  --skip-build            Skip build step, use existing dist/ directory
  --test-npx              Create npm package tarball for testing with npx
                          (Lightweight: just copies tarball, no full deployment)
  --help                  Show this help message

Default Behavior:
  - Builds the project (unless --skip-build)
  - Runs tests and typecheck (unless --skip-validation)
  - Packages Mac node_modules (unless --skip-modules)
  - Creates clean app directory: ${APP_DIR_NAME}/
  - Extracts to: <remote-path>/${APP_DIR_NAME}/

Examples:
  # Standard deploy (fast, includes Mac node_modules)
  ./scripts/debug-deploy.sh

  # Safe deploy (install modules on IBM i, platform-correct)
  ./scripts/debug-deploy.sh --skip-modules

  # Ultra-fast re-deploy (skip everything, reuse build)
  ./scripts/debug-deploy.sh --skip-validation --skip-build

  # Test npx execution (reproduce 500 error scenario)
  ./scripts/debug-deploy.sh --test-npx

  # Deploy to specific host with custom path
  ./scripts/debug-deploy.sh --host my-ibmi.com --path /home/user/test

Package Structure (after extraction on IBM i):
  ${DEFAULT_REMOTE_PATH}/${APP_DIR_NAME}/
    ├── dist/               ← Compiled TypeScript
    ├── node_modules/       ← Dependencies (if not --skip-modules)
    ├── package.json
    ├── package-lock.json
    └── .env.example

NPX Testing Mode (--test-npx):
  Lightweight mode that only copies npm package tarball for npx testing.
  Use this to reproduce and test the npx-specific 500 error scenario.

  Flow: npm pack → copy to IBM i → test with npx <tarball>

  Perfect for testing:
    - npx execution path (vs direct node execution)
    - Transport readiness check timing on IBM i PASE
    - Comparing npx behavior to direct node execution

EOF
  exit 0
}

# Parse command-line arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --host)
      IBMI_HOST="$2"
      shift 2
      ;;
    --user)
      IBMI_USER="$2"
      shift 2
      ;;
    --port)
      SSH_PORT="$2"
      shift 2
      ;;
    --path)
      REMOTE_PATH="$2"
      shift 2
      ;;
    --skip-modules)
      INCLUDE_MODULES=false
      shift
      ;;
    --skip-validation)
      SKIP_VALIDATION=true
      shift
      ;;
    --skip-build)
      SKIP_BUILD=true
      shift
      ;;
    --test-npx)
      TEST_NPX=true
      shift
      ;;
    --help)
      show_help
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      echo "Run with --help for usage information"
      exit 1
      ;;
  esac
done

# Load .env file from repository root
ENV_FILE="$(cd "$(dirname "$0")/../.." && pwd)/.env"
if [[ -f "$ENV_FILE" ]]; then
  echo -e "${BLUE}Loading configuration from .env${NC}"
  source "$ENV_FILE"
fi

# Apply defaults from .env if not overridden by CLI
IBMI_HOST="${IBMI_HOST:-$DB2i_HOST}"
IBMI_USER="${IBMI_USER:-$DB2i_USER}"
SSH_PORT="${SSH_PORT:-$DEFAULT_SSH_PORT}"
REMOTE_PATH="${REMOTE_PATH:-$DEFAULT_REMOTE_PATH}"

# Validate required parameters
if [[ -z "$IBMI_HOST" ]]; then
  echo -e "${RED}Error: IBM i hostname not specified${NC}"
  echo "Provide via --host flag or set DB2i_HOST in .env"
  exit 1
fi

if [[ -z "$IBMI_USER" ]]; then
  echo -e "${RED}Error: SSH username not specified${NC}"
  echo "Provide via --user flag or set DB2i_USER in .env"
  exit 1
fi

# Test SSH connectivity
echo -e "${BLUE}Testing SSH connectivity to ${IBMI_USER}@${IBMI_HOST}:${SSH_PORT}...${NC}"
if ! ssh -p "$SSH_PORT" -o ConnectTimeout=5 -o BatchMode=yes "${IBMI_USER}@${IBMI_HOST}" exit 2>/dev/null; then
  echo -e "${YELLOW}Warning: Could not verify SSH connectivity${NC}"
  echo "Make sure SSH keys are configured or you'll be prompted for password"
  read -p "Continue anyway? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

# NPX Testing Mode - Lightweight tarball copy for npx testing
if [[ "$TEST_NPX" == true ]]; then
  echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
  echo -e "${BLUE}NPX Testing Mode${NC}"
  echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
  echo "Creating npm package tarball for npx testing..."
  echo ""

  # Build if needed
  if [[ ! -d "dist" ]]; then
    echo "Building project (dist/ not found)..."
    if ! npm run build; then
      echo -e "${RED}Error: Build failed${NC}"
      exit 1
    fi
  fi

  # Create npm package tarball
  echo "Running npm pack..."
  if ! npm pack; then
    echo -e "${RED}Error: npm pack failed${NC}"
    exit 1
  fi

  # Find the created tarball
  TARBALL=$(ls -t ibm-ibmi-mcp-server-*.tgz 2>/dev/null | head -1)
  if [[ -z "$TARBALL" ]]; then
    echo -e "${RED}Error: Could not find created tarball${NC}"
    exit 1
  fi

  TARBALL_SIZE=$(du -h "$TARBALL" | cut -f1)
  echo -e "${GREEN}✓ Package created: ${TARBALL} (${TARBALL_SIZE})${NC}"

  # Ensure remote directory exists
  echo ""
  echo "Ensuring remote directory exists..."
  ssh -p "$SSH_PORT" "${IBMI_USER}@${IBMI_HOST}" "mkdir -p ${REMOTE_PATH}"

  # Copy to IBM i
  echo "Copying tarball to IBM i..."
  REMOTE_TARBALL="${REMOTE_PATH}/$(basename "$TARBALL")"

  if ! scp -P "$SSH_PORT" "$TARBALL" "${IBMI_USER}@${IBMI_HOST}:${REMOTE_TARBALL}"; then
    echo -e "${RED}Error: Failed to copy tarball to IBM i${NC}"
    exit 1
  fi

  echo -e "${GREEN}✓ Tarball copied to IBM i${NC}"

  # Clean up local tarball
  rm -f "$TARBALL"

  # Print instructions
  echo ""
  echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
  echo -e "${GREEN}NPX Testing Ready!${NC}"
  echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
  echo ""
  echo "Tarball Location: ${REMOTE_TARBALL}"
  echo ""
  echo "Next Steps:"
  echo "  1. SSH to IBM i:"
  echo "     ssh -p ${SSH_PORT} ${IBMI_USER}@${IBMI_HOST}"
  echo ""
  echo "  2. Install package globally from tarball:"
  echo "     npm install -g ${REMOTE_TARBALL}"
  echo ""
  echo "  3. Test with npx (reproduces 500 error scenario):"
  echo "     MCP_LOG_LEVEL=debug npx @ibm/ibmi-mcp-server --transport http"
  echo ""
  echo "  4. Monitor logs for transport readiness:"
  echo "     Look for:"
  echo "       - 'Transport ready after setImmediate' (fast path)"
  echo "       - 'Transport ready after X polling attempts' (slow path)"
  echo ""
  echo "  5. Test with curl (from another terminal):"
  echo "     curl -X POST http://localhost:3010/mcp \\"
  echo "       -H 'Content-Type: application/json' \\"
  echo "       -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}'"
  echo ""
  echo -e "${BLUE}💡 Compare npx vs direct node execution:${NC}"
  echo "  Direct node (baseline - should work):"
  echo "    cd ~/mcp_server_test"
  echo "    tar -xzf $(basename "$TARBALL")"
  echo "    cd package"
  echo "    npm ci --production"
  echo "    MCP_LOG_LEVEL=debug node dist/index.js --transport http"
  echo ""
  echo "  If npx triggers polling but node doesn't, confirms npx-specific timing!"
  echo ""

  exit 0
fi

# Pre-deployment validation
if [[ "$SKIP_VALIDATION" == false ]]; then
  echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
  echo -e "${BLUE}Step 1: Running pre-deployment validation${NC}"
  echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"

  echo "Running type checking..."
  if ! npm run typecheck; then
    echo -e "${RED}Error: Type checking failed${NC}"
    exit 1
  fi
  echo -e "${GREEN}✓ Type checking passed${NC}"

  echo "Running tests..."
  if ! npm test; then
    echo -e "${RED}Error: Tests failed${NC}"
    exit 1
  fi
  echo -e "${GREEN}✓ Tests passed${NC}"
else
  echo -e "${YELLOW}Skipping validation (--skip-validation flag set)${NC}"
fi

# Build
if [[ "$SKIP_BUILD" == false ]]; then
  echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
  echo -e "${BLUE}Step 2: Building project${NC}"
  echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"

  if ! npm run build; then
    echo -e "${RED}Error: Build failed${NC}"
    exit 1
  fi
  echo -e "${GREEN}✓ Build completed successfully${NC}"
else
  echo -e "${YELLOW}Skipping build (--skip-build flag set)${NC}"

  # Verify dist exists
  if [[ ! -d "dist" ]]; then
    echo -e "${RED}Error: dist/ directory not found. Cannot skip build.${NC}"
    exit 1
  fi
fi

# Create package with clean directory structure
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}Step 3: Creating deployment package${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
TGZ_NAME="mcp-server-debug-${TIMESTAMP}.tgz"
TGZ_PATH="/tmp/${TGZ_NAME}"
STAGING_DIR="/tmp/mcp-staging-${TIMESTAMP}"

echo "Package name: ${TGZ_NAME}"
echo "App directory: ${APP_DIR_NAME}/"
echo "Staging in: ${STAGING_DIR}"

# Create staging directory with clean app structure
mkdir -p "${STAGING_DIR}/${APP_DIR_NAME}"

# Copy files into clean app directory
echo "Copying dist/..."
cp -r dist "${STAGING_DIR}/${APP_DIR_NAME}/"

echo "Copying package files..."
cp package.json package-lock.json "${STAGING_DIR}/${APP_DIR_NAME}/"

# Copy .env.example if it exists (useful reference)
if [[ -f ".env.example" ]]; then
  cp .env.example "${STAGING_DIR}/${APP_DIR_NAME}/"
fi

# Handle node_modules based on flag
if [[ "$INCLUDE_MODULES" == true ]]; then
  echo -e "${GREEN}Including node_modules from Mac (default behavior)${NC}"
  echo "  Size: $(du -sh node_modules | cut -f1)"
  echo "  Note: Use --skip-modules if platform binaries cause issues"

  # Verify node_modules exists
  if [[ ! -d "node_modules" ]]; then
    echo -e "${RED}Error: node_modules/ not found. Run 'npm install' first.${NC}"
    rm -rf "$STAGING_DIR"
    exit 1
  fi

  cp -r node_modules "${STAGING_DIR}/${APP_DIR_NAME}/"
else
  echo -e "${YELLOW}Skipping node_modules packaging (--skip-modules set)${NC}"
  echo "Will run 'npm ci' on IBM i after extraction (safer for platform binaries)"
fi

# Create tarball from staging directory
echo "Creating tarball with clean directory structure..."
cd "$STAGING_DIR"
# Disable macOS extended attributes to avoid warnings on IBM i
if ! COPYFILE_DISABLE=1 tar --no-xattrs -czf "$TGZ_PATH" "${APP_DIR_NAME}" 2>/dev/null; then
  echo -e "${RED}Error: Failed to create tarball${NC}"
  cd - > /dev/null
  rm -rf "$STAGING_DIR"
  exit 1
fi
cd - > /dev/null

# Clean up staging directory
rm -rf "$STAGING_DIR"

TGZ_SIZE=$(du -h "$TGZ_PATH" | cut -f1)
echo -e "${GREEN}✓ Package created successfully${NC}"
echo "  Size: ${TGZ_SIZE}"
echo "  Structure: ${APP_DIR_NAME}/ (clean app directory)"

# Copy to IBM i
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}Step 4: Copying package to IBM i${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"

echo "Destination: ${IBMI_USER}@${IBMI_HOST}:/tmp/"
echo "Copying ${TGZ_NAME} (${TGZ_SIZE})..."

if ! scp -P "$SSH_PORT" "$TGZ_PATH" "${IBMI_USER}@${IBMI_HOST}:/tmp/${TGZ_NAME}"; then
  echo -e "${RED}Error: Failed to copy package to IBM i${NC}"
  rm -f "$TGZ_PATH"
  exit 1
fi

echo -e "${GREEN}✓ Package copied successfully${NC}"

# Clean up local tarball
rm -f "$TGZ_PATH"

echo -e "${GREEN}✓ Package copied to IBM i successfully${NC}"

# Summary & Next Steps
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}Deployment Complete!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"

echo ""
echo "Deployment Summary:"
echo "  Target:          ${IBMI_USER}@${IBMI_HOST}"
echo "  Package copied:  /tmp/${TGZ_NAME} (${TGZ_SIZE})"
echo "  Extract to:      ${REMOTE_PATH}/"
echo "  App directory:   ${APP_DIR_NAME}"
if [[ "$INCLUDE_MODULES" == true ]]; then
  echo "  Dependencies:    Packaged from Mac (default)"
else
  echo "  Dependencies:    Need npm ci after extraction"
fi

echo ""
echo "Directory Structure (after extraction):"
echo "  ${REMOTE_PATH}/"
echo "    └── ${APP_DIR_NAME}/          ← Clean app directory"
echo "        ├── dist/"
echo "        ├── node_modules/"
echo "        ├── package.json"
echo "        ├── package-lock.json"
echo "        └── .env.example"

echo ""
echo "Next Steps:"
echo "  1. SSH to IBM i:"
echo "     ssh -p ${SSH_PORT} ${IBMI_USER}@${IBMI_HOST}"
echo ""
echo "  2. Create deployment directory and extract:"
echo "     mkdir -p ${REMOTE_PATH}"
echo "     cd ${REMOTE_PATH}"
echo "     tar -xzf /tmp/${TGZ_NAME} 2>/dev/null || tar -xzf /tmp/${TGZ_NAME}"
echo ""
echo "  3. Navigate to app directory:"
echo "     cd ${APP_DIR_NAME}"
echo ""
echo "  4. Install dependencies (if not packaged):"
if [[ "$INCLUDE_MODULES" == false ]]; then
  echo "     npm ci --production"
else
  echo "     # Dependencies already packaged, skip this step"
fi
echo ""
echo "  5. Copy and configure .env file:"
echo "     cp .env.example .env"
echo "     # Edit .env with your IBM i connection details"
echo ""
echo "  6. Make executable and start the server:"
echo "     chmod +x dist/index.js"
echo "     node dist/index.js"
echo "     # or with HTTP transport and debug logging:"
echo "     MCP_LOG_LEVEL=debug MCP_TRANSPORT_TYPE=http node dist/index.js"
echo ""
echo "  7. Test with curl (from another terminal):"
echo "     curl -X POST http://localhost:3010/mcp \\"
echo "       -H 'Content-Type: application/json' \\"
echo "       -H 'Accept: application/json, text/event-stream' \\"
echo "       -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}'"
echo ""
echo -e "${BLUE}💡 Pro Tips:${NC}"
echo "  • Use --skip-build --skip-validation for fastest re-deploys"
echo "  • Use --skip-modules if you encounter platform binary issues"
echo "  • Package location on IBM i: /tmp/${TGZ_NAME}"
echo "  • Clean directory structure: extraction creates ${APP_DIR_NAME}/ folder"
