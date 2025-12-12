# Deployment Guide

Deploy the IBM i MCP Server in containerized environments using Docker, Podman, or OpenShift.

## Table of Contents
- [Deployment Guide](#deployment-guide)
  - [Table of Contents](#table-of-contents)
  - [Docker \& Podman Deployment](#docker--podman-deployment)
    - [Prerequisites](#prerequisites)
      - [Docker](#docker)
      - [Podman (Alternative to Docker)](#podman-alternative-to-docker)
      - [Build MCP Gateway Image](#build-mcp-gateway-image)
      - [Configure MCP Environment](#configure-mcp-environment)
    - [Quick Start with Docker](#quick-start-with-docker)
    - [Quick Start with Podman](#quick-start-with-podman)
    - [Container Architecture](#container-architecture)
    - [Service Management](#service-management)
      - [Start Services](#start-services)
      - [Stop Services](#stop-services)
      - [View Logs](#view-logs)
      - [Rebuild Services](#rebuild-services)
    - [MCP Gateway UI](#mcp-gateway-ui)
  - [OpenShift Deployment](#openshift-deployment)
  - [Troubleshooting](#troubleshooting)
    - [Docker/Podman Issues](#dockerpodman-issues)
    - [OpenShift Issues](#openshift-issues)
  - [Production Considerations](#production-considerations)
    - [Security](#security)
    - [Performance](#performance)
    - [Monitoring](#monitoring)
    - [Backups](#backups)
  - [Resources](#resources)


---

## Docker & Podman Deployment

The project includes a comprehensive `docker-compose.yml` that sets up the complete MCP gateway with the IBM i MCP Server.

**MCP Context Forge Gateway** is a feature-rich gateway, proxy and MCP Registry that federates MCP and REST services - unifying discovery, auth, rate-limiting, observability, virtual servers, multi-transport protocols, and an optional Admin UI into one clean endpoint for your AI clients.

Read more about it [here](https://github.com/IBM/mcp-context-forge).

### Prerequisites

Choose one of the following container platforms:

#### Docker

- **Docker Desktop** (macOS/Windows): [Download here](https://www.docker.com/products/docker-desktop/)
- **Docker Engine** (Linux): [Installation guide](https://docs.docker.com/engine/install/)

#### Podman (Alternative to Docker)

- **Podman Desktop** (macOS/Windows): [Download here](https://podman-desktop.io/)
- **Podman CLI** (Linux): [Installation guide](https://podman.io/docs/installation)
- **podman-compose**: `pip install podman-compose`

#### Build MCP Gateway Image

The `docker-compose.yml` uses a local build of the MCP Gateway image. To build it, clone the MCP Gateway repository and build the image:

```bash
git clone https://github.com/IBM/mcp-context-forge.git
cd mcp-context-forge

# Build image using Docker
make docker-prod

# Or build image using Podman
make podman-prod
```

This will create a local image named `localhost/mcpgateway/mcpgateway` that the `docker-compose.yml` can use. More details on building the MCP Gateway image can be found in the [MCP Gateway Docs](https://ibm.github.io/mcp-context-forge/deployment/).

#### Configure MCP Environment

Create a `.env` file in the `ibmi-mcp-server` directory with your IBM i connection details:

```bash
cd ibmi-mcp-server/
cp .env.example .env
# Edit .env with your IBM i connection details
code .env
```

Make sure to set the following variables in your `.env` file:

```ini
# IBM i connection details
DB2i_HOST="your_host"
DB2i_USER="your_user"
DB2i_PASS="your_pass"

# MCP Auth mode
MCP_AUTH_MODE=ibmi

# IBM i HTTP authentication settings
IBMI_AUTH_KEY_ID=development
IBMI_AUTH_PRIVATE_KEY_PATH=secrets/private.pem
IBMI_AUTH_PUBLIC_KEY_PATH=secrets/public.pem

# Enable IBM i HTTP authentication endpoints (requires MCP_AUTH_MODE=ibmi)
IBMI_HTTP_AUTH_ENABLED=true

# Allow HTTP requests for authentication (development only, use HTTPS in production)
IBMI_AUTH_ALLOW_HTTP=true
```

> **Note:** You need to generate an RSA keypair for the server if you haven't already done so. See the [IBM i HTTP Authentication](../README.md#-ibm-i-http-authentication-beta) section in the main README for instructions.

Once you have your `.env` file configured, you can start the complete stack using Docker or Podman.

---

### Quick Start with Docker

1. **Start the complete stack:**

   ```bash
   # Start all services in background
   docker-compose -f deployment/mcpgateway/docker-compose.yml up -d

   # Or start specific services
   docker-compose -f deployment/mcpgateway/docker-compose.yml up -d gateway ibmi-mcp-server postgres redis
   ```

2. **Verify services are running:**
   ```bash
   docker-compose -f deployment/mcpgateway/docker-compose.yml ps
   ```

---

### Quick Start with Podman

1. **Start the complete stack:**

   ```bash
   # Start all services in background
   podman-compose -f deployment/mcpgateway/docker-compose.yml up -d

   # Or start specific services
   podman-compose -f deployment/mcpgateway/docker-compose.yml up -d gateway ibmi-mcp-server postgres redis
   ```

2. **Verify services are running:**
   ```bash
   podman-compose -f deployment/mcpgateway/docker-compose.yml ps
   ```

---

### Container Architecture

The docker-compose setup includes these services:

| Service             | Port | Description                    | Access URL             |
| ------------------- | ---- | ------------------------------ | ---------------------- |
| **gateway**         | 4444 | MCP Context Forge main API     | http://localhost:4444  |
| **ibmi-mcp-server** | 3010 | IBM i SQL tools MCP server     | http://localhost:3010  |
| **postgres**        | -    | PostgreSQL database (internal) | -                      |
| **redis**           | 6379 | Cache service                  | redis://localhost:6379 |
| **pgadmin**         | 5050 | Database admin UI              | http://localhost:5050  |
| **redis_insight**   | 5540 | Cache admin UI                 | http://localhost:5540  |

**Architecture Diagram:**

```
┌─────────────────────────────────────────────────────────────┐
│                  MCP Context Forge Gateway                   │
│                  (Port 4444 - Admin UI)                      │
│   • Tool federation & discovery                              │
│   • Authentication & rate limiting                           │
│   • Observability (traces, metrics)                          │
│   • Virtual server management                                │
└────────────┬────────────────────────────────────────────────┘
             │
             ├─── HTTP ───┐
             │            │
┌────────────▼───────────┐│  ┌─────────────────────────────────┐
│ IBM i MCP Server       ││  │ Other MCP Servers               │
│   (Port 3010)          ││  │ (Terraform, Fast Time, etc.)    │
│ • SQL tools execution  ││  │ [Optional - see compose file]   │
│ • IBM i auth           ││  │                                 │
│ • YAML tool configs    ││  │                                 │
└────────┬───────────────┘│  └─────────────────────────────────┘
         │                │
         ▼                │
    ┌────────────┐        │
    │ IBM i Db2  │        │
    │ (Mapepire) │        │
    └────────────┘        │
                          │
┌─────────────────────────▼────────┐
│   Supporting Services            │
│ • PostgreSQL - Gateway storage   │
│ • Redis - Session & cache        │
│ • pgAdmin - DB admin UI          │
│ • Redis Insight - Cache UI       │
└──────────────────────────────────┘
```

---

### Service Management

#### Start Services

```bash
# Docker
docker-compose -f deployment/mcpgateway/docker-compose.yml up -d                    # Start all services
docker-compose -f deployment/mcpgateway/docker-compose.yml up -d gateway            # Start specific service
docker-compose -f deployment/mcpgateway/docker-compose.yml up --no-deps gateway     # Start without dependencies

# Podman
podman-compose -f deployment/mcpgateway/docker-compose.yml up -d                    # Start all services
podman-compose -f deployment/mcpgateway/docker-compose.yml up -d gateway            # Start specific service
podman-compose -f deployment/mcpgateway/docker-compose.yml up --no-deps gateway     # Start without dependencies
```

#### Stop Services

```bash
# Docker
docker-compose -f deployment/mcpgateway/docker-compose.yml down                     # Stop all services
docker-compose -f deployment/mcpgateway/docker-compose.yml stop gateway             # Stop specific service

# Podman
podman-compose -f deployment/mcpgateway/docker-compose.yml down                     # Stop all services
podman-compose -f deployment/mcpgateway/docker-compose.yml stop gateway             # Stop specific service
```

#### View Logs

```bash
# Docker
docker-compose -f deployment/mcpgateway/docker-compose.yml logs -f gateway          # Follow gateway logs
docker-compose -f deployment/mcpgateway/docker-compose.yml logs --tail=100 ibmi-mcp-server

# Podman
podman-compose -f deployment/mcpgateway/docker-compose.yml logs -f gateway          # Follow gateway logs
podman-compose -f deployment/mcpgateway/docker-compose.yml logs --tail=100 ibmi-mcp-server
```

#### Rebuild Services

```bash
# Docker
docker-compose -f deployment/mcpgateway/docker-compose.yml build ibmi-mcp-server    # Rebuild specific service
docker-compose -f deployment/mcpgateway/docker-compose.yml up --build -d            # Rebuild and restart all

# Podman
podman-compose -f deployment/mcpgateway/docker-compose.yml build ibmi-mcp-server    # Rebuild specific service
podman-compose -f deployment/mcpgateway/docker-compose.yml up --build -d            # Rebuild and restart all
```

---

### MCP Gateway UI

After the containers are up and running, you can access the MCP Context Forge UI at **http://localhost:4444**

**Login Credentials (demo):**
- User: `admin`
- Password: `changeme`

**Configure IBM i MCP Server:**

1. Navigate to the **"Gateways/MCP Servers"** tab
2. Add the IBM i MCP server endpoint:
   - Endpoint: `http://ibmi-mcp-server:3010`
3. Click "Connect" to register the server

**Managing Tools:**

Once connected, you can:
- View all available SQL tools from the IBM i MCP Server
- Create virtual servers grouping specific tools
- Configure tool-level authentication
- Monitor tool usage and performance
- Set up rate limiting per tool

**Screenshots:**

![Gateway UI Dashboard](../docs/images/image.png)
*MCP Context Forge Gateway Dashboard*

![MCP Server Connection](../docs/images/image-1.png)
*Connecting to IBM i MCP Server*

![Tool Management](../docs/images/image-2.png)
*Managing SQL Tools*

---

## OpenShift Deployment

Deploy using Kustomize with source-to-image (S2I) builds for both IBM i MCP Server and MCP Context Forge Gateway.

**Full OpenShift Guide:** [`openshift/apps/openshift/README.md`](openshift/apps/openshift/README.md)

**Quick Start:**

```bash
cd deployment/openshift/apps/openshift

# Configure environment and namespace
# Edit kustomization.yaml and .env files

# Deploy both applications
kustomize build . | oc apply -f -

# Monitor builds
oc logs -f bc/ibmi-mcp-server
oc logs -f bc/mcp-context-forge

# Get routes
echo "IBM i MCP: https://$(oc get route ibmi-mcp-server -o jsonpath='{.spec.host}')"
echo "Gateway: https://$(oc get route mcp-context-forge -o jsonpath='{.spec.host}')"
```

---

## Troubleshooting

### Docker/Podman Issues

**Container won't start:**

```bash
# Check logs
docker logs ibmi-mcp-server
# or
podman logs ibmi-mcp-server

# Verify environment variables
docker exec ibmi-mcp-server env | grep DB2i

# Test connectivity
docker exec ibmi-mcp-server curl http://localhost:3010/healthz
```

**Port conflicts:**
- Change `MCP_HTTP_PORT` in `.env`
- Update port mappings in `deployment/mcpgateway/docker-compose.yml`

**Gateway can't connect to IBM i MCP Server:**
- Verify both containers are on the same network: `docker network inspect mcpgateway_mcpnet`
- Check IBM i MCP Server is healthy: `docker exec ibmi-mcp-server curl http://localhost:3010/healthz`
- Review gateway logs: `docker logs gateway`

**Database connection issues:**
- Verify IBM i credentials in `.env`
- Check Mapepire is running on IBM i: `sc status mapepire`
- Test connection from container: `docker exec ibmi-mcp-server nc -zv $DB2i_HOST 8076`

### OpenShift Issues

See the [OpenShift README](openshift/apps/openshift/README.md#troubleshooting) for deployment-specific troubleshooting.

---

## Production Considerations

### Security

- **Use HTTPS:** Configure reverse proxy (Nginx, Caddy) for TLS termination
- **Set `IBMI_AUTH_ALLOW_HTTP=false`** in production
- **Use secrets management:** Kubernetes secrets, Vault, or cloud provider solutions
- **Enable authentication:** Set `MCP_AUTH_MODE=ibmi` or `jwt`
- **Restrict CORS:** Set `MCP_ALLOWED_ORIGINS` to specific domains
- **Regular key rotation:** Rotate JWT keys and IBM i credentials periodically

### Performance

- **Resource limits:** Set memory/CPU limits in docker-compose.yml
- **Connection pooling:** Configure `IBMI_AUTH_MAX_CONCURRENT_SESSIONS`
- **Caching:** Redis is included for session and response caching
- **Horizontal scaling:** Use multiple replicas behind a load balancer

### Monitoring

- **Enable OpenTelemetry:** Set `OTEL_ENABLED=true` and configure endpoints
- **Health checks:** All services have built-in health endpoints
- **Log aggregation:** Use ELK stack or cloud logging services
- **Metrics collection:** Gateway provides Prometheus-compatible metrics

### Backups

- **PostgreSQL:** Regular backups of gateway metadata
  ```bash
  docker exec postgres pg_dump -U postgres mcp > backup.sql
  ```
- **Configuration:** Version control `.env` and YAML tool configs (excluding secrets)
- **Secrets:** Backup RSA keypairs securely

---

## Resources

- **Docker Compose File:** [`mcpgateway/docker-compose.yml`](mcpgateway/docker-compose.yml)
- **MCP Context Forge Docs:** https://ibm.github.io/mcp-context-forge/
- [**Main README**](../README.md)
- [**Tools Configuration**](../tools/README.md)
