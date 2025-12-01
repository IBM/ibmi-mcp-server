# IBM i MCP Agents

AI agents for IBM i system administration and monitoring using Model Context Protocol (MCP) tools. This directory contains multiple agent framework implementations, deployment infrastructure, and web interfaces for interacting with intelligent IBM i system agents.

## Agent Capabilities

All agent frameworks connect to the IBM i MCP server and can perform tasks such as:

- **System Performance Monitoring**
  - CPU and memory utilization analysis
  - Job queue monitoring
  - Resource bottleneck identification

- **System Administration**
  - Active job management
  - System configuration queries
  - Service status checks

- **Database Operations**
  - Table and schema exploration
  - Data retrieval and analysis


## Getting Started

### Prerequisites

- **Python 3.12+** (for agent frameworks)
- **uv** (Python package manager)
- **Node.js 20+** (for Agent UI)
- **MCP Server** running in HTTP mode

## Available Agent SDKs

The `frameworks/` directory provides different agent SDK implementations, allowing you to choose the best solution for your use case.

| SDK | Language | Status | Documentation |
|-----|----------|--------|---------------|
| [Agno](./frameworks/agno) | Python | ✅ Active | [frameworks/agno/README.md](frameworks/agno/README.md) |
| [LangChain](./frameworks/langchain) | Python | ✅ Active | [frameworks/langchain/README.md](frameworks/langchain/README.md) |
| [Google ADK](./frameworks/google_adk) | Python | ✅ Active | [frameworks/google_adk/README.md](frameworks/google_adk/README.md) |

## Deployment Infrastructure

Deploy IBM i agents using Agno AgentOS stack with Docker.

**Documentation:** See [docker/ibmi-agent-infra/README.md](docker/ibmi-agent-infra/README.md)  

**What's Included:**
- **AgentOS API**: RESTful API for agent interactions
- **IBM i MCP Server**: Automatically configured and running
- **PostgreSQL Database**: Session and memory persistence
- **Agent UI**: Optional web interface
- **Multi-provider LLM Support**: watsonx, OpenAI, Anthropic


## Resources

- **Agno Documentation:** https://docs.agno.com
- **LangChain Documentation:** https://docs.langchain.com
- **Model Context Protocol:** https://modelcontextprotocol.io
- **IBM i MCP Server:** [../README.md](../README.md)


For general IBM i MCP server issues, see the main project documentation.
