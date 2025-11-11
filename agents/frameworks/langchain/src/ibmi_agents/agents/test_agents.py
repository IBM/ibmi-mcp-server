"""
Test script for IBM i Specialized Agents (LangGraph Implementation)

This script tests all four specialized agents with Ollama gpt-oss:20b model.

Usage:
    uv run test_specialized_agents.py
    uv run test_specialized_agents.py --agent performance
    uv run test_specialized_agents.py --interactive
"""

import asyncio
import sys
import os
from typing import Optional

# Disable LangSmith tracing for tests
os.environ["LANGCHAIN_TRACING_V2"] = "false"

from ibmi_agents import (
    create_ibmi_agent,
    list_available_agents,
    chat_with_agent,
    AVAILABLE_AGENTS,
    set_verbose_logging,
    get_verbose_logging,
)

# Test queries for each agent type
TEST_QUERIES = {
    "performance": "What is my system status? Give me CPU and memory metrics.",
    "discovery": "Give me an overview of available system services.",
    "browse": "Show me services in the QSYS2 schema.",
    "search": "Search for services related to system status.",
    "security": "Check for user profiles vulnerable to impersonation attacks."
}

async def test_single_agent(agent_type: str, model_id: str = "gpt-oss:20b", category: Optional[str] = None):
    """Test a single agent with a sample query."""
    print(f"\n{'='*80}")
    print(f"Testing {agent_type.upper()} Agent")
    if category:
        print(f"Category Filter: {category}")
    print(f"{'='*80}\n")
    
    try:
        # Create agent context
        print(f"🔧 Creating {agent_type} agent with model {model_id}...")
        if category:
            print(f"   Filtering by category: {category}")
        
        # Pass category parameter if provided (only for security agent)
        kwargs = {"model_id": model_id}
        if category and agent_type == "security":
            kwargs["category"] = category
        
        ctx = await create_ibmi_agent(agent_type, **kwargs)
        
        async with ctx as (agent, session):
            print(f"✅ Agent created: {agent.name}\n")
            
            # Get test query
            query = TEST_QUERIES.get(agent_type, "What can you help me with?")
            print(f"📝 Test Query: {query}\n")
            print(f"{'─'*80}\n")
            
            # Send query and get response (session is active here)
            print("🤖 Agent processing...\n")
            response = await chat_with_agent(
                agent,
                query,
                thread_id=f"test-{agent_type}-1"
            )
            
            print(f"{'─'*80}")
            print(f"✅ Response:\n")
            print(response)
            print(f"\n{'─'*80}")
        
        return True
        
    except Exception as e:
        print(f"\n❌ Error testing {agent_type} agent: {e}")
        import traceback
        traceback.print_exc()
        return False

async def test_all_agents(model_id: str = "gpt-oss:20b"):
    """Test all available agents."""
    print("\n" + "="*80)
    print("IBM i Specialized Agents - Full Test Suite")
    print("="*80)
    print(f"Model: {model_id}")
    print(f"Agents: {len(AVAILABLE_AGENTS)}")
    print("="*80)
    
    # List available agents
    agents_info = list_available_agents()
    print("\nAvailable Agents:")
    for agent_type, description in agents_info.items():
        print(f"  • {agent_type}: {description}")
    
    # Test each agent
    results = {}
    for agent_type in AVAILABLE_AGENTS.keys():
        success = await test_single_agent(agent_type, model_id)
        results[agent_type] = success
    
    # Summary
    print(f"\n{'='*80}")
    print("Test Summary")
    print(f"{'='*80}\n")
    
    for agent_type, success in results.items():
        status = "✅ PASS" if success else "❌ FAIL"
        print(f"  {status} - {agent_type}")
    
    total_passed = sum(results.values())
    total_tests = len(results)
    print(f"\n{'─'*80}")
    print(f"Total: {total_passed}/{total_tests} agents passed")
    print(f"{'='*80}\n")
    
    return all(results.values())

async def interactive_mode(agent_type: str, model_id: str = "gpt-oss:20b", category: Optional[str] = None):
    """Interactive chat mode with a specific agent."""
    print(f"\n{'='*80}")
    print(f"Interactive Mode - {agent_type.upper()} Agent")
    if category:
        print(f"Category Filter: {category}")
    print(f"{'='*80}\n")
    
    try:
        # Create agent context
        print(f"🔧 Initializing {agent_type} agent with {model_id}...")
        if category:
            print(f"   Filtering by category: {category}")
        print()
        
        # Pass category parameter if provided (only for security agent)
        kwargs = {"model_id": model_id}
        if category and agent_type == "security":
            kwargs["category"] = category
        
        ctx = await create_ibmi_agent(agent_type, **kwargs)
        
        async with ctx as (agent, session):
            print(f"✅ {agent.name} ready!\n")
            
            # Show agent info
            agents_info = list_available_agents()
            print(f"📋 Agent Purpose: {agents_info[agent_type]}\n")
            print(f"{'─'*80}")
            print("💬 Interactive mode active. Type 'quit', 'exit', or 'q' to stop.\n")
            
            thread_id = f"interactive-{agent_type}"
            message_count = 0
            
            while True:
                try:
                    # Get user input
                    user_input = input("👤 You: ").strip()
                    
                    # Check for exit commands
                    if user_input.lower() in ['quit', 'exit', 'q']:
                        print("\n👋 Goodbye!")
                        break
                    
                    # Skip empty input
                    if not user_input:
                        continue
                    
                    message_count += 1
                    print()
                    
                    # Get agent response (session is active)
                    response = await chat_with_agent(agent, user_input, thread_id)
                    
                    print(f"🤖 {agent.name}:\n")
                    print(response)
                    print(f"\n{'─'*80}\n")
                    
                except KeyboardInterrupt:
                    print("\n\n👋 Interrupted. Goodbye!")
                    break
                except Exception as e:
                    print(f"\n❌ Error: {e}\n")
            
            print(f"\n📊 Session stats: {message_count} messages exchanged")
        
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()

async def quick_test(model_id: str = "gpt-oss:20b", category: Optional[str] = None, agent_filter: Optional[str] = None):
    """Quick test - just verify all agents can be created."""
    print("\n" + "="*80)
    print("Quick Agent Creation Test")
    print("="*80)
    print(f"Model: {model_id}")
    if category:
        print(f"Category Filter: {category}")
    print()
    
    results = {}
    
    # Filter to specific agent if requested
    agents_to_test = [agent_filter] if agent_filter else list(AVAILABLE_AGENTS.keys())
    
    for agent_type in agents_to_test:
        try:
            print(f"Creating {agent_type} agent...", end=" ")
            
            # Pass category parameter if provided (only for security agent)
            kwargs = {"model_id": model_id}
            if category and agent_type == "security":
                kwargs["category"] = category
                print(f"(category: {category})...", end=" ")
            
            ctx = await create_ibmi_agent(agent_type, **kwargs)
            async with ctx as (agent, session):
                print(f"✅ {agent.name}")
                results[agent_type] = True
            
        except Exception as e:
            print(f"❌ Error: {e}")
            results[agent_type] = False
    
    print(f"\n{'─'*80}")
    total_passed = sum(results.values())
    total_tests = len(results)
    print(f"Result: {total_passed}/{total_tests} agents created successfully")
    print(f"{'='*80}\n")
    
    return all(results.values())

def main():
    """Main entry point with argument parsing."""
    import argparse
    
    parser = argparse.ArgumentParser(
        description="Test IBM i Specialized Agents (LangGraph)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Test all agents with verbose output (default)
  uv run test_specialized_agents.py
  
  # Test specific agent
  uv run test_specialized_agents.py --agent performance
  
  # Test with quiet mode (only final responses)
  uv run test_specialized_agents.py --agent performance --quiet
  
  # Interactive mode with specific agent
  uv run test_specialized_agents.py --agent performance --interactive
  
  # Quick creation test
  uv run test_specialized_agents.py --quick
  
  # Use different model
  uv run test_specialized_agents.py --model gpt-4o
        """
    )
    
    parser.add_argument(
        "--agent",
        choices=list(AVAILABLE_AGENTS.keys()),
        help="Test specific agent type"
    )
    
    parser.add_argument(
        "--category",
        choices=["vulnerability-assessment", "audit", "remediation", "user-management"],
        help="Filter security agent tools by category (only applies to security agent)"
    )
    
    parser.add_argument(
        "--interactive",
        action="store_true",
        help="Run in interactive chat mode (requires --agent)"
    )
    
    parser.add_argument(
        "--model",
        default="gpt-oss:20b",
        help="Model to use (default: gpt-oss:20b)"
    )
    
    parser.add_argument(
        "--quick",
        action="store_true",
        help="Quick test - just verify agents can be created"
    )
    
    parser.add_argument(
        "--verbose",
        action="store_true",
        default=True,
        help="Enable verbose logging with tool calls and responses (default: True)"
    )
    
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Disable verbose logging (only show final responses)"
    )
    
    args = parser.parse_args()
    
    # Set verbose logging based on flags
    if args.quiet:
        set_verbose_logging(False)
    elif args.verbose:
        set_verbose_logging(True)
    
    # Validate arguments
    if args.interactive and not args.agent:
        parser.error("--interactive requires --agent to be specified")
    
    if args.category and not args.agent:
        parser.error("--category requires --agent to be specified")
    
    if args.category and args.agent != "security":
        parser.error("--category can only be used with --agent security")
    
    # Run appropriate test mode
    try:
        if args.quick:
            success = asyncio.run(quick_test(args.model, args.category, args.agent))
        elif args.interactive:
            asyncio.run(interactive_mode(args.agent, args.model, args.category))
            success = True
        elif args.agent:
            success = asyncio.run(test_single_agent(args.agent, args.model, args.category))
        else:
            success = asyncio.run(test_all_agents(args.model))
        
        # Exit with appropriate code
        sys.exit(0 if success else 1)
        
    except KeyboardInterrupt:
        print("\n\n⚠️  Test interrupted by user")
        sys.exit(130)
    except Exception as e:
        print(f"\n❌ Fatal error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    main()
