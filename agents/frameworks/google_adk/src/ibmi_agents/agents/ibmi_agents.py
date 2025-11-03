"""
IBM i Agent Definitions using Google ADK Framework

This module defines four specialized IBM i system agents:
- Performance Agent: System performance monitoring and analysis
- System Administration Discovery Agent: High-level system discovery and summarization
- System Administration Browse Agent: Detailed system browsing and exploration
- System Administration Search Agent: System search and lookup capabilities

Each agent uses Google ADK abstractions for LLMs, MCP tools, and reasoning.

Dependencies:
- google-adk: Google Agent Development Kit
- ibmi-agent-sdk: IBM i Agent SDK with Google ADK integration
- python-dotenv: For loading environment variables
- fastapi: For OpenAPI models

Installation:
    Using uv (recommended):
        uv pip install google-adk ibmi-agent-sdk python-dotenv fastapi
    
    Using pip:
        pip install google-adk ibmi-agent-sdk python-dotenv fastapi
"""
import os
import asyncio
import logging
import sys
# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

# Import Google ADK dependencies
from google.adk.agents.llm_agent import LlmAgent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types
from google.adk.models.lite_llm import LiteLlm
# from google.adk.planners import PlanReActPlanner
from dotenv import load_dotenv
from ibmi_agent_sdk.google_adk import load_toolset_tools
# Handle both direct execution and module import
try:
    from .instructions import STATIC_INSTRUCTION, DYNAMIC_INSTRUCTION, GLOBAL_INSTRUCTION, COORDINATOR_STATIC, COORDINATOR_INSTRUCTION
except ImportError:
    from instructions import STATIC_INSTRUCTION, DYNAMIC_INSTRUCTION, GLOBAL_INSTRUCTION, COORDINATOR_STATIC, COORDINATOR_INSTRUCTION

# Enable LiteLLM debug mode for development
# import litellm
# litellm._turn_on_debug()

# Define available agent types
AVAILABLE_AGENTS = [
    "performance",
    "sysadmin_discovery",
    "sysadmin_browse",
    "sysadmin_search"
]

# Get model from environment or use default
def get_model():
    """
    Get the model from environment variables or use default.
    
    Supports:
    - Gemini models: "gemini-2.0-flash", "gemini-2.0-pro-exp", etc.
    - Ollama models: "ollama_chat/gpt-oss:20b", "ollama_chat/granite4:tiny-h", etc.
    - Watsonx models: "watsonx/meta-llama/llama-3-3-70b-instruct", etc.
    - Any other LiteLLM-compatible model

    Returns:
        str or LiteLlm: Model identifier or LiteLlm instance
    """
    model_name = os.getenv("IBMI_AGENT_MODEL", "gemini-2.0-flash")
    
    # Gemini models can be used directly as strings
    if "gemini" in model_name:
        return model_name
    
    # Other models need LiteLlm wrapper
    return LiteLlm(model=model_name)

# ============================================================
#  HELPER FUNCTIONS
# ============================================================

def build_toolset_kwargs(debug_filtering: bool = False) -> dict:
    """
    Build kwargs for load_toolset_tools based on transport type from environment.
    
    Args:
        debug_filtering: Enable debug output for tool filtering
        
    Returns:
        dict: Kwargs to pass to load_toolset_tools
        
    Raises:
        ValueError: If HTTP transport is selected but token is missing
    """
    # Get transport type from environment
    transport = os.getenv("MCP_TRANSPORT_TYPE", "stdio")
    
    # Build base kwargs
    toolset_kwargs = {
        "debug": debug_filtering,
        "transport": transport
    }
    
    if transport == "stdio":
        env = {
            "DB2i_HOST": os.getenv("DB2i_HOST", ""),
            "DB2i_USER": os.getenv("DB2i_USER", ""),
            "DB2i_PASSWORD": os.getenv("DB2i_PASSWORD", ""),
            "DB2i_PORT": os.getenv("DB2i_PORT", "8076"),
            "MCP_TRANSPORT_TYPE": transport,
            "TOOLS_YAML_PATH": os.getenv("TOOLS_YAML_PATH", "tools"),
            "NODE_OPTIONS": os.getenv("NODE_OPTIONS", "--no-deprecation"),
        }
        toolset_kwargs.update({
            "command": "npx",
            "args": ["ibmi-mcp-server"],
            "env": env
        })
    elif transport == "http":
        token = os.getenv("IBMI_MCP_ACCESS_TOKEN")
        if not token:
            raise ValueError("IBMI_MCP_ACCESS_TOKEN is required for HTTP transport")
        toolset_kwargs["token"] = token
        toolset_kwargs["transport"] = "streamable_http"
    
    return toolset_kwargs

# ============================================================
#  PERFORMANCE AGENT
# ============================================================

async def create_performance_agent(debug_filtering: bool = False):
    """
    Create a performance monitoring agent for IBM i systems.
    
    Args:
        debug_filtering: Enable debug output for tool filtering
        
    Returns:
        tuple: (LlmAgent, toolset) - The configured agent and its toolset
        
    Raises:
        ValueError: If configuration is invalid
        ConnectionError: If MCP server connection fails
    """
    logger.info("Creating performance agent...")
    try:
        # Build toolset kwargs based on transport type
        toolset_kwargs = build_toolset_kwargs(debug_filtering)
        toolset = await load_toolset_tools("performance", **toolset_kwargs)

        performance_instruction = """
            You are an IBM i performance optimization assistant.
            You specialize in analyzing performance data and providing actionable tuning recommendations.

            ### Tool Focus
            You have access to performance-focused MCP tools such as:
            - `system_status`, `system_activity`, and `active_job_info` for workload summaries
            - `memory_pools`, `temp_storage_buckets`, and `unnamed_temp_storage` for memory diagnostics
            - `http_server` for HTTP performance
            - `collection_services` and `collection_categories` for system monitoring insights
            - `system_values` for performance-related configuration parameters

            Use these tools to analyze CPU, memory, I/O, and subsystem performance.
            Provide insights on bottlenecks, workload trends, and safe optimization recommendations.
            """ + DYNAMIC_INSTRUCTION

        return LlmAgent(
            name="performance_agent",
            model=get_model(),
            static_instruction=STATIC_INSTRUCTION,
            instruction=performance_instruction,
            global_instruction=GLOBAL_INSTRUCTION,
            description="Analyzes IBM i performance metrics and suggests optimizations.",
            tools=[toolset],
            # output_key="initial_result"
        ), toolset

    except ValueError as e:
        logger.error(f"Configuration error: {e}")
        raise
    except Exception as e:
        logger.error(f"Failed to create performance agent: {e}")
        raise ConnectionError(f"Failed to connect to MCP server: {e}")


# ============================================================
#  SYSTEM ADMIN DISCOVERY AGENT
# ============================================================

async def create_sysadmin_discovery_agent(debug_filtering: bool = False):
    """
    Create a system administration discovery agent for IBM i systems.
    
    Args:
        debug_filtering: Enable debug output for tool filtering
        
    Returns:
        tuple: (LlmAgent, toolset) - The configured agent and its toolset
        
    Raises:
        ValueError: If configuration is invalid
        ConnectionError: If MCP server connection fails
    """
    logger.info("Creating system admin discovery agent...")
    try:
        # Build toolset kwargs based on transport type
        toolset_kwargs = build_toolset_kwargs(debug_filtering)
        toolset = await load_toolset_tools("sysadmin_discovery", **toolset_kwargs)

        discovery_instruction = """
            You are an IBM i system administration discovery assistant.
            You help administrators explore and summarize the organization of their IBM i environment.

            ### Tool Focus
            You can use discovery-oriented MCP tools such as:
            - `list_service_categories` and `count_services_by_schema` to understand service distribution
            - `count_services_by_sql_object_type` and `list_categories_for_schema` for structural mapping
            - `describe_sql_object` for object introspection and SQL DDL extraction

            Your purpose is to give administrators a clear overview of system composition,
            schemas, service categories, and object structures for informed navigation.
            """ + DYNAMIC_INSTRUCTION

        return LlmAgent(
            name="sysadmin_discovery_agent",
            model=get_model(),
            static_instruction=STATIC_INSTRUCTION,
            instruction=discovery_instruction,
            global_instruction=GLOBAL_INSTRUCTION,
            description="Discovers IBM i services, schemas, and system structure.",
            tools=[toolset],
        ), toolset

    except ValueError as e:
        logger.error(f"Configuration error: {e}")
        raise
    except Exception as e:
        logger.error(f"Failed to create sysadmin discovery agent: {e}")
        raise ConnectionError(f"Failed to connect to MCP server: {e}")


# ============================================================
#  SYSTEM ADMIN BROWSE AGENT
# ============================================================

async def create_sysadmin_browse_agent(debug_filtering: bool = False):
    """
    Create a system administration browse agent for IBM i systems.
    
    Args:
        debug_filtering: Enable debug output for tool filtering
        
    Returns:
        tuple: (LlmAgent, toolset) - The configured agent and its toolset
        
    Raises:
        ValueError: If configuration is invalid
        ConnectionError: If MCP server connection fails
    """
    logger.info("Creating system admin browse agent...")
    try:
        # Build toolset kwargs based on transport type
        toolset_kwargs = build_toolset_kwargs(debug_filtering)
        toolset = await load_toolset_tools("sysadmin_browse", **toolset_kwargs)

        browse_instruction = """
            You are an IBM i browsing assistant.
            You help administrators explore object libraries, schemas, and services in a structured manner.

            ### Tool Focus
            You use browsing tools such as:
            - `list_services_by_category` and `list_services_by_schema` to navigate system services
            - `list_services_by_sql_object_type` to understand service organization by object type
            - `describe_sql_object` to inspect object structures

            Provide users with hierarchical, intuitive views of IBM i system components and
            help them understand relationships between libraries, schemas, and services.
            """ + DYNAMIC_INSTRUCTION

        return LlmAgent(
            name="sysadmin_browse_agent",
            model=get_model(),
            static_instruction=STATIC_INSTRUCTION,
            instruction=browse_instruction,
            global_instruction=GLOBAL_INSTRUCTION,
            description="Explores and navigates IBM i system objects and libraries.",
            tools=[toolset],
        ), toolset

    except ValueError as e:
        logger.error(f"Configuration error: {e}")
        raise
    except Exception as e:
        logger.error(f"Failed to create sysadmin browse agent: {e}")
        raise ConnectionError(f"Failed to connect to MCP server: {e}")


# ============================================================
#  SYSTEM ADMIN SEARCH AGENT
# ============================================================

async def create_sysadmin_search_agent(debug_filtering: bool = False):
    """
    Create a system administration search agent for IBM i systems.
    
    Args:
        debug_filtering: Enable debug output for tool filtering
        
    Returns:
        tuple: (LlmAgent, toolset) - The configured agent and its toolset
        
    Raises:
        ValueError: If configuration is invalid
        ConnectionError: If MCP server connection fails
    """
    logger.info("Creating system admin search agent...")
    try:
        # Build toolset kwargs based on transport type
        toolset_kwargs = build_toolset_kwargs(debug_filtering)
        toolset = await load_toolset_tools("sysadmin_search", **toolset_kwargs)

        search_instruction = """
            You are an IBM i search and lookup assistant.
            You help administrators locate and describe IBM i system services, objects, and examples efficiently.

            ### Tool Focus
            You use search and metadata lookup tools such as:
            - `search_services_by_name` and `where_is_service` for locating services
            - `search_examples_for_keyword` and `get_service_example` to retrieve relevant code examples
            - `describe_sql_object` for detailed metadata inspection

            Your task is to provide fast, accurate search results with clear context about each service,
            its schema, and how it fits into the IBM i environment.
            """ + DYNAMIC_INSTRUCTION

        return LlmAgent(
            name="sysadmin_search_agent",
            model=get_model(),
            static_instruction=STATIC_INSTRUCTION,
            instruction=search_instruction,
            global_instruction=GLOBAL_INSTRUCTION,
            description="Searches for specific IBM i objects and provides quick lookups.",
            tools=[toolset],
        ), toolset

    except ValueError as e:
        logger.error(f"Configuration error: {e}")
        raise
    except Exception as e:
        logger.error(f"Failed to create sysadmin search agent: {e}")
        raise ConnectionError(f"Failed to connect to MCP server: {e}")


# ============================================================
#  AGENT CREATION FACTORY
# ============================================================

async def create_agent(agent_type: str, debug_filtering: bool = False):
    """
    Factory function to create an agent of the specified type.
    
    Args:
        agent_type: Type of agent to create (performance, sysadmin_discovery, etc.)
        debug_filtering: Whether to enable debug output for tool filtering
        
    Returns:
        LlmAgent: Configured agent of the specified type
        
    Raises:
        ValueError: If the agent type is unknown or MCP token is missing
        ConnectionError: If connection to MCP server fails
    """
    if agent_type not in AVAILABLE_AGENTS:
        raise ValueError(f"Unknown agent type: {agent_type}. Available types: {', '.join(AVAILABLE_AGENTS)}")
    
    if agent_type == "performance":
        return await create_performance_agent(debug_filtering)
    elif agent_type == "sysadmin_discovery":
        return await create_sysadmin_discovery_agent(debug_filtering)
    elif agent_type == "sysadmin_browse":
        return await create_sysadmin_browse_agent(debug_filtering)
    elif agent_type == "sysadmin_search":
        return await create_sysadmin_search_agent(debug_filtering)
    else:
        raise ValueError(f"Agent type {agent_type} is recognized but not implemented")


# ============================================================
#  CHAT WITH AGENT
# ============================================================

async def chat_with_agent(agent: LlmAgent, query: str) -> str:
    """
    Send a query to an agent and get the response.
    
    Args:
        agent: The LlmAgent to query
        query: The query string to send
        
    Returns:
        str: The agent's response text
        
    Raises:
        Exception: If the agent fails to process the query
    """
    try:
        logger.info(f"Sending query to agent: {query}")
        
        # Create a unique session ID
        import uuid
        session_id = str(uuid.uuid4())
        user_id = f"chat_user_{session_id[:8]}"
        app_name = f"ibmi_agent_chat"
        
        # Set up session service
        session_service = InMemorySessionService()
        await session_service.create_session(app_name=app_name, user_id=user_id, session_id=session_id)
        
        # Create runner
        runner = Runner(app_name=app_name, agent=agent, session_service=session_service)
        
        # Format query as Content
        content = types.Content(role='user', parts=[types.Part(text=query)])
        
        # Run the agent
        event_generator = runner.run_async(user_id=user_id, session_id=session_id, new_message=content)
        
        # Process events and get final response
        final_response = ""
        async for event in event_generator:
            if event.is_final_response():
                final_response = event.content.parts[0].text
                break
        
        return final_response
    except Exception as e:
        logger.error(f"Error in agent chat: {str(e)}")
        raise


# ============================================================
#  MAIN TEST RUNNER
# ============================================================

async def main():
    """Simple test runner for development purposes."""
    load_dotenv()
    
    print("🔄 Initializing IBM i Google ADK Agents...")

    try:
        # Initialize debug_filtering
        debug_filtering = False
        
        # Parse command line arguments
        if len(sys.argv) > 1 and sys.argv[1] == "--help":
            print("\nUsage:")
            print("  uv run ibmi_agents.py [--agent TYPE] [--debug] [query]")
            print("\nOptions:")
            print("  --agent TYPE  Agent type: performance, sysadmin_discovery, sysadmin_browse, sysadmin_search")
            print("  --debug       Enable debug logging")
            print("  --help        Show this help message")
            print("\nExamples:")
            print("  uv run ibmi_agents.py --agent performance \"Show me system CPU usage\"")
            print("  uv run ibmi_agents.py --agent sysadmin_search --debug \"Find library QSYS2\"")
            return
            
        # Set debug level if requested
        if "--debug" in sys.argv:
            logger.setLevel(logging.DEBUG)
            debug_filtering = True
            sys.argv.remove("--debug")
            
        # Determine agent type
        agent_type = "performance"  # Default agent type
        if "--agent" in sys.argv:
            idx = sys.argv.index("--agent")
            if idx + 1 < len(sys.argv):
                agent_type = sys.argv[idx + 1]
                sys.argv.remove("--agent")
                sys.argv.remove(agent_type)
        
        # Create the agent
        print(f"Creating {agent_type} agent...")
        agent, toolset = await create_agent(agent_type, debug_filtering)
        print(f"✅ Successfully created {agent.name}")
        
        # Process query if provided
        if len(sys.argv) > 1:
            query = " ".join(sys.argv[1:])
            print(f"🔍 Processing query: {query}")
            response = await chat_with_agent(agent, query)
            print(f"\n🤖 Response:\n{response}")
        else:
            print("\nNo query provided. Use --help for usage information.")
        
        # Clean up
        await toolset.close()
        
    except ValueError as e:
        print(f"❌ Configuration error: {str(e)}")
        print("Make sure you have set the IBMI_MCP_ACCESS_TOKEN environment variable.")
    except ConnectionError as e:
        print(f"❌ Connection error: {str(e)}")
        print("Make sure the MCP server is running and accessible.")
    except Exception as e:
        print(f"❌ Error: {str(e)}")
        if logger.level <= logging.DEBUG:
            import traceback
            traceback.print_exc()

# Standard way to run the main async function
if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        print(f"Error running main: {e}")


