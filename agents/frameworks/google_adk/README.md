# IBM i Agents with Google ADK Framework

This directory contains the implementation of IBM i agents using the Google ADK framework. These agents provide specialized capabilities for interacting with IBM i systems.

## Quick Start

### For Google AI (Simplest - Recommended for Getting Started)

1. Get an API key from [Google AI Studio](https://aistudio.google.com/app/apikey)
2. Create a `.env` file:
   ```bash
   GOOGLE_API_KEY=your_api_key_here
   IBMI_AGENT_MODEL=gemini-2.0-flash
   IBMI_MCP_ACCESS_TOKEN=your_mcp_token
   IBMI_MCP_SERVER_URL=http://127.0.0.1:3010/mcp
   ```
3. Run: `uv run main.py --agent performance --query "Show me system CPU usage"`

### For Vertex AI (Enterprise)

1. Set up a [Google Cloud Project](https://console.cloud.google.com/)
2. Enable [Vertex AI API](https://console.cloud.google.com/apis/library/aiplatform.googleapis.com)
3. Create service account credentials
4. Configure `.env` with `GOOGLE_CLOUD_PROJECT`, `GOOGLE_APPLICATION_CREDENTIALS`, and `GOOGLE_GENAI_USE_VERTEXAI=TRUE`

See [detailed setup instructions](#google-cloud--vertex-ai-setup-for-gemini-models) below.

## Available Agents

- **Performance Agent**: Analyzes IBM i performance metrics and suggests optimizations
- **System Admin Discovery Agent**: Discovers IBM i services, schemas, and system structure
- **System Admin Browse Agent**: Explores and navigates IBM i system objects and libraries
- **System Admin Search Agent**: Searches for specific IBM i objects and provides quick lookups

## Prerequisites

- Python 3.13+
- Google ADK framework
- IBM i Agent SDK
- Access to an IBM i MCP server

## Installation

### Using uv (Recommended)

[uv](https://docs.astral.sh/uv/) is a fast Python package installer and resolver. It's the recommended way to manage dependencies for this project.

1. Install uv if you haven't already:

```bash
# On macOS and Linux
curl -LsSf https://astral.sh/uv/install.sh | sh

# On Windows
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"
```

2. Create a virtual environment and install dependencies:

```bash
# Navigate to the project directory
cd agents/frameworks/google_adk

# Create and activate virtual environment with uv
uv venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate

# Install dependencies
uv pip install google-adk ibmi-agent-sdk python-dotenv fastapi
```

### Using pip

Alternatively, you can use pip:

```bash
pip install google-adk ibmi-agent-sdk python-dotenv fastapi
```

### Environment Setup

#### Basic Configuration

Create a `.env` file in the `agents/frameworks/google_adk` directory with the following variables:

```bash
# IBM i MCP Server Configuration
IBMI_MCP_ACCESS_TOKEN=your_access_token
IBMI_MCP_SERVER_URL=http://127.0.0.1:3010/mcp
IBMI_AGENT_LOG_LEVEL=INFO
```

#### Google Cloud / Vertex AI Setup (for Gemini Models)

To use Google's Gemini models, you need to set up either Google AI or Vertex AI. Choose one of the following options:

##### Option 1: Using Google AI (Simpler, API Key Based)

1. **Get a Google API Key**:
   - Visit [Google AI Studio](https://aistudio.google.com/app/apikey)
   - Sign in with your Google account
   - Click "Create API Key"
   - Copy the generated API key

2. **Add to your `.env` file**:
   ```bash
   # Google AI Configuration
   GOOGLE_API_KEY=your_google_api_key_here
   IBMI_AGENT_MODEL=gemini-2.0-flash
   ```

##### Option 2: Using Gemini AI (Project-Based)

1. **Create a Google Cloud Project**:
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Sign in or create a new Google account
   - Click on the project selector at the top
   - Click "New Project"
   - Enter a project name and click "Create"
   - Note your project ID (e.g., `my-project-12345`)

2. **Generate an API key**:
   - Go to [APIs & Services > Credentials](https://console.cloud.google.com/apis/credentials)
   - Click on "+ Create credentials"
   - Click on "API key"
   - Enter a name and configure any restrictions (if required)
   - Click on "Create" button

3. **Add to your `.env` file**:
   ```bash
   # Google AI Configuration
   GOOGLE_API_KEY=your_google_cloud_api_key_here
   IBMI_AGENT_MODEL=gemini-2.0-flash
   ```

4. **Enable the Gemini AI API**:
   - Go to [APIs & Services > Library](https://console.cloud.google.com/apis/library)
   - Search for "Gemini API"
   - Click on "Gemini API"
   - Click "Enable"
   - Wait for the API to be enabled (may take a few minutes)

##### Option 3: Using Vertex AI (Enterprise, Project-Based)

1. **Create a Google Cloud Project**:
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Sign in or create a new Google account
   - Click on the project selector at the top
   - Click "New Project"
   - Enter a project name and click "Create"
   - Note your project ID (e.g., `my-project-12345`)

2. **Enable Billing**:
   - In the Google Cloud Console, go to [Billing](https://console.cloud.google.com/billing)
   - Link a billing account to your project
   - Note: Vertex AI requires an active billing account

3. **Enable the Vertex AI API**:
   - Go to [APIs & Services > Library](https://console.cloud.google.com/apis/library)
   - Search for "Vertex AI API"
   - Click on "Vertex AI API"
   - Click "Enable"
   - Wait for the API to be enabled (may take a few minutes)

4. **Create Service Account Credentials**:
   - Go to [IAM & Admin > Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts)
   - Click "Create Service Account"
   - Enter a name (e.g., `ibmi-agent-service`)
   - Click "Create and Continue"
   - Grant the role: "Vertex AI User" (`roles/aiplatform.user`)
   - Click "Continue" and then "Done"
   - Click on the created service account
   - Go to the "Keys" tab
   - Click "Add Key" > "Create new key"
   - Choose "JSON" format
   - Click "Create" - a JSON file will be downloaded
   - Save this file securely (e.g., `secrets/credentials.json`)

5. **Install Google Cloud CLI** (Optional but recommended):
   ```bash
   # macOS
   curl https://sdk.cloud.google.com | bash
   exec -l $SHELL
   
   # Initialize and authenticate
   gcloud init
   gcloud auth application-default login
   ```

6. **Add to your `.env` file**:
   ```bash
   # Vertex AI Configuration
   GOOGLE_CLOUD_PROJECT=your-project-id
   GOOGLE_APPLICATION_CREDENTIALS=secrets/credentials.json
   VERTEX_AI_LOCATION=us-central1
   GOOGLE_GENAI_USE_VERTEXAI=TRUE
   IBMI_AGENT_MODEL=gemini-2.0-flash
   ```

#### Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GOOGLE_CLOUD_PROJECT` | For Vertex AI | - | Your Google Cloud project ID |
| `GOOGLE_APPLICATION_CREDENTIALS` | For Vertex AI | - | Path to service account JSON credentials file |
| `VERTEX_AI_LOCATION` | No | `us-central1` | Vertex AI region (e.g., `us-central1`, `us-east1`, `europe-west1`) |
| `GOOGLE_GENAI_USE_VERTEXAI` | No | `FALSE` | Set to `TRUE` to use Vertex AI instead of Google AI |
| `GOOGLE_API_KEY` | For Google AI | - | Google AI API key (alternative to Vertex AI) |
| `CHAT_MODEL` | No | - | Alias for `IBMI_AGENT_MODEL` (deprecated, use `IBMI_AGENT_MODEL`) |

#### Supported Gemini Models

- `gemini-2.0-flash` - Fast, efficient model for most tasks
- `gemini-2.0-pro-exp` - Experimental pro model with enhanced capabilities
- `gemini-1.5-pro` - Previous generation pro model
- `gemini-1.5-flash` - Previous generation flash model

#### Complete `.env` Example

```bash
# IBM i MCP Server
IBMI_MCP_ACCESS_TOKEN=your_access_token
IBMI_MCP_SERVER_URL=http://127.0.0.1:3010/mcp

# Google Vertex AI (Option 1)
GOOGLE_CLOUD_PROJECT=my-project-12345
GOOGLE_APPLICATION_CREDENTIALS=secrets/credentials.json
VERTEX_AI_LOCATION=us-central1
GOOGLE_GENAI_USE_VERTEXAI=TRUE
IBMI_AGENT_MODEL=gemini-2.0-flash

# OR Google AI (Option 2 & 3 - simpler)
# GOOGLE_API_KEY=your_google_api_key_here
# IBMI_AGENT_MODEL=gemini-2.0-flash

# Logging
IBMI_AGENT_LOG_LEVEL=INFO
```

## Usage

### Command Line Interface

The `main.py` script provides a command-line interface for running the agents.

#### Using uv (Recommended)

```bash
# Run with uv
uv run main.py --agent performance --query "Show me system CPU usage"

# Or activate the virtual environment first
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
python main.py --agent performance --query "Show me system CPU usage"
```

#### Basic Examples

```bash
# Run a performance agent
uv run main.py --agent performance --query "Show me system CPU usage"

# Run a system admin discovery agent
uv run main.py --agent sysadmin_discovery --query "List available schemas"

# Run a system admin browse agent
uv run main.py --agent sysadmin_browse --query "Show me objects in QSYS2"

# Run a system admin search agent
uv run main.py --agent sysadmin_search --query "Find all tables with CUSTOMER in the name"

# List available agents
uv run main.py --list-agents
```

#### Advanced Options

```bash
# Enable verbose output with detailed logging
uv run main.py --agent performance --query "Show me system CPU usage" --verbose

# Quiet mode - only show final response without logs
uv run main.py --agent performance --query "Show me system CPU usage" --quiet

# Use a different LLM model
uv run main.py --agent performance --query "Show me system CPU usage" --model "gpt-4"

# Combine options (note: --verbose and --quiet are mutually exclusive)
uv run main.py --agent sysadmin_search --query "Find QSYS2" --model "gemini-2.0-flash"
```

### Programmatic Usage

You can also use the agents programmatically in your Python code:

```python
import asyncio
from dotenv import load_dotenv
from src.ibmi_agents.agents.ibmi_agents import create_performance_agent, chat_with_agent

async def main():
    # Load environment variables
    load_dotenv()
    
    # Create a performance agent
    agent = await create_performance_agent()
    
    # Chat with the agent
    response = await chat_with_agent(agent, "Show me system CPU usage")
    
    # Print the response
    print(response)

if __name__ == "__main__":
    asyncio.run(main())
```

### Advanced Usage with Google ADK Runner

For more advanced use cases, you can use the Google ADK Runner directly:

```python
import asyncio
from dotenv import load_dotenv
from google.adk.sessions import InMemorySessionService
from google.adk.runners import Runner
from google.genai import types
from src.ibmi_agents.agents.ibmi_agents import create_performance_agent

async def main():
    # Load environment variables
    load_dotenv()
    
    # Create a session
    session_service = InMemorySessionService()
    await session_service.create_session(app_name="my_app", user_id="user123", session_id="session456")
    
    # Create an agent
    agent, toolset = await create_performance_agent()
    
    # Create a runner
    runner = Runner(app_name="my_app", agent=agent, session_service=session_service)
    
    # Format the query
    query = "Show me system CPU usage"
    content = types.Content(role='user', parts=[types.Part(text=query)])
    
    # Run the agent and process events
    events = runner.run_async(user_id="user123", session_id="session456", new_message=content)
    async for event in events:
        if event.is_final_response():
            final_response = event.content.parts[0].text
            print(final_response)
    await toolset.close()

if __name__ == "__main__":
    asyncio.run(main())
```

## Development

### Mock Mode

The agents can run in a mock mode when the required dependencies are not available. This is useful for development and testing without an actual MCP server connection.

### Adding New Agents

To add a new agent:

1. Create a new agent creation function in `src/ibmi_agents/agents/ibmi_agents.py`
2. Add the agent to the `AVAILABLE_AGENTS` dictionary in `main.py`
3. Update the documentation to reflect the new agent

## Testing

A test script is provided to verify individual agent implementations.

### Using uv

```bash
# Test all agent types
uv run test_agents.py --test-all

# Test a specific agent type
uv run test_agents.py --test-agent performance
uv run test_agents.py --test-agent sysadmin_discovery
uv run test_agents.py --test-agent sysadmin_browse
uv run test_agents.py --test-agent sysadmin_search

# Test chatting with an agent
uv run test_agents.py --test-chat "Show me system CPU usage"

# Enable verbose output
uv run test_agents.py --test-all --verbose
```

### Using python directly

```bash
# Activate virtual environment first
source .venv/bin/activate  # On Windows: .venv\Scripts\activate

# Then run tests
python test_agents.py --test-all
python test_agents.py --test-agent performance
python test_agents.py --test-chat "Show me system CPU usage"
python test_agents.py --test-all --verbose
```

### What the Tests Cover

The test script validates:
- **Agent Creation**: Verifies that each agent type can be instantiated correctly
- **MCP Connection**: Confirms successful connection to the MCP server
- **Tool Loading**: Ensures the correct toolset is loaded for each agent
- **Chat Functionality**: Tests end-to-end query processing with the performance agent

Note: The test script focuses on individual agent testing. For multi-agent workflows, see the workflow examples in `src/ibmi_agents/workflows/`.

## Troubleshooting

### IBM i MCP Server Issues

- **Missing IBMI_MCP_ACCESS_TOKEN**: Ensure you have set the access token in your environment variables or .env file
- **Connection errors**: Verify that the MCP server is running and accessible at the specified URL
- **Import errors**: Make sure all required dependencies are installed

### Google Cloud / Gemini API Issues

#### Authentication Errors

**Error: "API key not valid"**
- Verify your `GOOGLE_API_KEY` is correct and hasn't expired
- Check that the API key is enabled in [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
- Ensure you've enabled the Gemini API for your project

**Error: "Could not automatically determine credentials"**
- For Vertex AI: Ensure `GOOGLE_APPLICATION_CREDENTIALS` points to a valid service account JSON file
- Check that the file path is correct and the file is readable
- Verify the service account has the "Vertex AI User" role

**Error: "Permission denied" or "403 Forbidden"**
- Verify your service account has the correct IAM roles:
  - `roles/aiplatform.user` (Vertex AI User)
- Check that billing is enabled for your Google Cloud project
- Ensure the Vertex AI API is enabled in your project

#### API Configuration Issues

**Error: "API [aiplatform.googleapis.com] not enabled"**
- Go to [APIs & Services > Library](https://console.cloud.google.com/apis/library)
- Search for "Vertex AI API" or "Gemini API"
- Click "Enable" and wait for activation (may take a few minutes)

**Error: "Project not found" or "Invalid project ID"**
- Verify `GOOGLE_CLOUD_PROJECT` matches your actual project ID (not project name)
- Check the project ID in [Google Cloud Console](https://console.cloud.google.com/)
- Ensure you have access to the project

**Error: "Location not supported"**
- Check that `VERTEX_AI_LOCATION` is a valid region (e.g., `us-central1`, `us-east1`, `europe-west1`)
- Some models may not be available in all regions
- Try using `us-central1` as it has the widest model availability

#### Model-Specific Issues

**Error: "Model not found" or "Invalid model name"**
- Verify the model name in `IBMI_AGENT_MODEL` is correct:
  - For Google AI: `gemini-2.0-flash`, `gemini-1.5-pro`
  - For Vertex AI: Same model names work
- Check [Google AI Studio](https://aistudio.google.com/) for available models
- Ensure you're using the correct model naming format

**Error: "Quota exceeded" or "Rate limit exceeded"**
- You've hit API rate limits or quota
- For Google AI: Check your [quota limits](https://aistudio.google.com/app/apikey)
- For Vertex AI: Review [quota settings](https://console.cloud.google.com/iam-admin/quotas)
- Consider upgrading your plan or requesting quota increases

#### Environment Variable Issues

**Error: "Environment variable not set"**
- Ensure your `.env` file is in the correct directory (`agents/frameworks/google_adk/`)
- Verify the `.env` file is being loaded (check with `--verbose` flag)
- Make sure variable names are spelled correctly (case-sensitive)

**Switching between Google AI and Vertex AI**
- To use Google AI (simpler):
  ```bash
  GOOGLE_API_KEY=your_key
  GOOGLE_GENAI_USE_VERTEXAI=FALSE  # or omit this line
  ```
- To use Vertex AI (enterprise):
  ```bash
  GOOGLE_CLOUD_PROJECT=your-project-id
  GOOGLE_APPLICATION_CREDENTIALS=path/to/credentials.json
  GOOGLE_GENAI_USE_VERTEXAI=TRUE
  ```

#### Debugging Tips

1. **Enable verbose logging**:
   ```bash
   uv run main.py --agent performance --query "test" --verbose
   ```

2. **Test your Google Cloud setup**:
   ```bash
   # Test gcloud CLI authentication
   gcloud auth application-default print-access-token
   
   # Verify project configuration
   gcloud config get-value project
   
   # List enabled APIs
   gcloud services list --enabled
   ```

3. **Verify credentials file**:
   ```bash
   # Check if file exists and is valid JSON
   cat secrets/credentials.json | python -m json.tool
   ```

4. **Test API access directly**:
   ```python
   # Test Google AI
   import google.generativeai as genai
   genai.configure(api_key="your_api_key")
   model = genai.GenerativeModel('gemini-2.0-flash')
   response = model.generate_content("Hello")
   print(response.text)
   ```

### General Issues

- **Google ADK errors**: Ensure you have the latest version of Google ADK installed:
  ```bash
  uv pip install --upgrade google-adk
  ```

- **Dependency conflicts**: Try creating a fresh virtual environment:
  ```bash
  rm -rf .venv
  uv venv
  source .venv/bin/activate
  uv pip install google-adk ibmi-agent-sdk python-dotenv fastapi
  ```

## License

This project is licensed under the MIT License - see the LICENSE file for details.