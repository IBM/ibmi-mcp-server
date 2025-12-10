#!/usr/bin/env python3
"""
Test script for IBM i agents using Google ADK framework.

This script tests individual agent implementations to ensure they work correctly.
It can be used to verify that agents are properly configured and can connect
to the MCP server.

Usage:
  python test_agents.py --test-all
  python test_agents.py --test-agent performance
  python test_agents.py --test-chat "Show me system CPU usage"
"""

import os
import sys
import asyncio
import argparse
import logging
from dotenv import load_dotenv

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler()]
)
logger = logging.getLogger("ibmi_agent_test")

# Import agent creation functions
try:
    from src.ibmi_agents.agents.ibmi_agents import (
        create_agent,
        chat_with_agent,
        AVAILABLE_AGENTS
    )
except ImportError as e:
    logger.error(f"Import error: {str(e)}")
    logger.error("Make sure all required dependencies are installed:")
    logger.error("uv pip install google-adk ibmi-agent-sdk python-dotenv fastapi")
    sys.exit(1)

async def test_agent_creation(agent_type):
    """Test creating an agent of the specified type."""
    logger.info(f"Testing {agent_type} agent creation...")
    
    try:
        # Use the unified create_agent function
        agent, toolset = create_agent(agent_type)
        
        logger.info(f"✅ Successfully created {agent.name}")
        
        # Clean up toolset
        await toolset.close()
        return True
    except ValueError as e:
        logger.error(f"❌ Invalid agent type '{agent_type}': {str(e)}")
        logger.info(f"Available agent types: {', '.join(AVAILABLE_AGENTS.keys())}")
        return False
    except Exception as e:
        logger.error(f"❌ Failed to create {agent_type} agent: {str(e)}")
        return False

async def test_chat(query, agent_type="performance"):
    """Test chatting with an agent."""
    logger.info(f"Testing chat with {agent_type} agent using query: {query}")
    
    try:
        agent, toolset = create_agent(agent_type)
        logger.info(f"✅ Successfully created {agent_type} agent")
        
        logger.info(f"Sending query to agent...")
        response = await chat_with_agent(agent, query, agent_type)
        
        logger.info(f"✅ Got response:")
        print("\n" + "="*50)
        print(response)
        print("="*50 + "\n")
        
        # Clean up toolset
        await toolset.close()
        return True
    except Exception as e:
        logger.error(f"❌ Chat test failed: {str(e)}")
        return False

async def main():
    """Main entry point for the test script."""
    parser = argparse.ArgumentParser(
        description="Test IBM i agents",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=f"""
Available agent types: {', '.join(AVAILABLE_AGENTS.keys())}

Examples:
  %(prog)s --test-all
  %(prog)s --test-agent performance
  %(prog)s --test-chat "Show me system CPU usage"
  %(prog)s --test-chat "Check security" --chat-agent security
        """
    )
    parser.add_argument("--test-all", action="store_true", help="Test all agent types")
    parser.add_argument("--test-agent", help=f"Test a specific agent type: {', '.join(AVAILABLE_AGENTS.keys())}")
    parser.add_argument("--test-chat", help="Test chatting with a query")
    parser.add_argument("--chat-agent", default="performance", help="Agent type to use for chat test (default: performance)")
    parser.add_argument("--verbose", action="store_true", help="Enable verbose output")
    
    args = parser.parse_args()
    
    # Set up logging
    if args.verbose:
        logger.setLevel(logging.DEBUG)
    
    # Load environment variables
    load_dotenv()
    
    # Check for required environment variables
    if not os.getenv("IBMI_MCP_ACCESS_TOKEN"):
        logger.error("Missing IBMI_MCP_ACCESS_TOKEN in environment variables")
        sys.exit(1)
    
    # Run tests
    success = True
    
    if args.test_all:
        logger.info("Testing all agent types...")
        for agent_type in AVAILABLE_AGENTS.keys():
            if not await test_agent_creation(agent_type):
                success = False
    
    if args.test_agent:
        if not await test_agent_creation(args.test_agent):
            success = False
    
    if args.test_chat:
        if not await test_chat(args.test_chat, args.chat_agent):
            success = False
    
    if not (args.test_all or args.test_agent or args.test_chat):
        parser.print_help()
    
    if success:
        logger.info("✅ All tests completed successfully")
    else:
        logger.error("❌ Some tests failed")
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(main())
