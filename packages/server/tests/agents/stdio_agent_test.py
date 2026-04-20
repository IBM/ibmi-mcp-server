#!/usr/bin/env python3
"""
Agent test for IBM i MCP Server using stdio transport.

This test demonstrates how to use Agno to connect to the MCP server via stdio,
test tool functionality, and validate responses. It's designed to run as both
an automated test and an interactive demonstration.

Usage:
    python stdio_agent_test.py --test-mode       # Run automated tests
    python stdio_agent_test.py --interactive     # Interactive mode
    python stdio_agent_test.py --validate-tools  # Just validate tool availability
"""

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Dict, List, Optional, Any
from dataclasses import dataclass
import argparse

try:
    from agno.agent import Agent
    from agno.models.openai import OpenAIChat
    from agno.tools.mcp import MCPTools
    from dotenv import load_dotenv
except ImportError as e:
    print(f"Error importing required packages: {e}")
    print("Please install required packages:")
    print("pip install agno python-dotenv")
    sys.exit(1)

# Load environment variables
load_dotenv(override=True)

@dataclass
class TestResult:
    """Represents the result of a test case."""
    test_name: str
    success: bool
    message: str
    duration: float
    tool_calls: List[str] = None
    error_details: str = None

class StdioMcpServerTest:
    """Test suite for MCP server via stdio transport."""
    
    def __init__(self, server_script_path: str = None):
        self.server_script_path = server_script_path or self._find_server_script()
        self.results: List[TestResult] = []
        self.server_process: Optional[subprocess.Popen] = None
        
    def _find_server_script(self) -> str:
        """Find the server startup script."""
        # Look for the server script relative to this test file
        test_dir = Path(__file__).parent
        project_root = test_dir.parent.parent
        
        # Try different possible locations
        candidates = [
            project_root / "dist" / "index.js",
            project_root / "src" / "index.ts",
            project_root / "index.js",
        ]
        
        for candidate in candidates:
            if candidate.exists():
                return str(candidate)
                
        raise FileNotFoundError(
            f"Could not find server script. Tried: {[str(c) for c in candidates]}"
        )
    
    async def setup_test_environment(self) -> Dict[str, str]:
        """Set up test environment variables and configuration."""
        test_env = os.environ.copy()
        
        # Configure for stdio mode
        test_env.update({
            "MCP_TRANSPORT_TYPE": "stdio",
            "MCP_LOG_LEVEL": "info",
            "NODE_ENV": "test",
            # Add test-specific YAML tools if available
            "TOOLS_YAML_PATH": str(Path(__file__).parent.parent / "fixtures" / "complete.yaml"),
        })
        
        # Create temporary log directory
        log_dir = tempfile.mkdtemp(prefix="mcp_test_")
        test_env["LOGS_DIR"] = log_dir
        
        return test_env
    
    async def test_server_startup(self) -> TestResult:
        """Test that the server starts successfully via stdio."""
        start_time = time.time()
        test_name = "server_startup"
        
        try:
            env = await self.setup_test_environment()
            
            # Start server process
            cmd = ["node", self.server_script_path]
            self.server_process = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
                text=True,
                bufsize=0
            )
            
            # Give server time to start
            await asyncio.sleep(2)
            
            # Check if process is still running
            if self.server_process.poll() is None:
                duration = time.time() - start_time
                return TestResult(
                    test_name=test_name,
                    success=True,
                    message="Server started successfully via stdio",
                    duration=duration
                )
            else:
                stderr_output = self.server_process.stderr.read()
                return TestResult(
                    test_name=test_name,
                    success=False,
                    message="Server failed to start",
                    duration=time.time() - start_time,
                    error_details=stderr_output
                )
                
        except Exception as e:
            return TestResult(
                test_name=test_name,
                success=False,
                message=f"Exception during server startup: {str(e)}",
                duration=time.time() - start_time,
                error_details=str(e)
            )
    
    async def test_mcp_connection(self) -> TestResult:
        """Test MCP connection via stdio."""
        start_time = time.time()
        test_name = "mcp_connection"
        
        try:
            # Connect via MCPTools using stdio transport (spawn new process)
            env = await self.setup_test_environment()
            
            print(f"    Connecting to server: node {self.server_script_path}")
            print(f"    Environment: MCP_TRANSPORT_TYPE={env.get('MCP_TRANSPORT_TYPE')}")
            
            async with MCPTools(
                command=f"node {self.server_script_path}",
                transport="stdio",
                env=env
            ) as tools:
                
                # Test basic connection by listing tools
                result = await tools.session.list_tools()
                tools_list = result.tools
                
                duration = time.time() - start_time
                return TestResult(
                    test_name=test_name,
                    success=True,
                    message=f"Connected successfully, found {len(tools_list)} tools",
                    duration=duration,
                    tool_calls=[tool.name for tool in tools_list]
                )
                
        except Exception as e:
            return TestResult(
                test_name=test_name,
                success=False,
                message=f"MCP connection failed: {str(e)}",
                duration=time.time() - start_time,
                error_details=str(e)
            )
    
    async def test_yaml_tools_loading(self) -> TestResult:
        """Test that YAML tools are loaded correctly."""
        start_time = time.time()
        test_name = "yaml_tools_loading"
        
        try:
            env = await self.setup_test_environment()
            
            async with MCPTools(
                command=f"node {self.server_script_path}",
                transport="stdio",
                env=env
            ) as tools:
                
                result = await tools.session.list_tools()
                tools_list = result.tools
                print(tools_list)
                
                # Look for YAML tools (those with toolsets annotation)
                yaml_tools = []
                for tool in tools_list:
                    try:
                        if tool.annotations and hasattr(tool.annotations, 'toolsets'):
                            yaml_tools.append(tool)
                    except AttributeError:
                        continue
                
                duration = time.time() - start_time
                
                if len(yaml_tools) > 0:
                    return TestResult(
                        test_name=test_name,
                        success=True,
                        message=f"Found {len(yaml_tools)} YAML tools loaded",
                        duration=duration,
                        tool_calls=[tool.name for tool in yaml_tools]
                    )
                else:
                    return TestResult(
                        test_name=test_name,
                        success=False,
                        message="No YAML tools found - check TOOLS_YAML_PATH configuration",
                        duration=duration,
                        tool_calls=[tool.name for tool in tools_list]
                    )
                
        except Exception as e:
            return TestResult(
                test_name=test_name,
                success=False,
                message=f"YAML tools test failed: {str(e)}",
                duration=time.time() - start_time,
                error_details=str(e)
            )
    
    async def test_agent_interaction(self) -> TestResult:
        """Test agent interaction with the MCP server."""
        start_time = time.time()
        test_name = "agent_interaction"
        
        # Skip if no OpenAI API key
        if not os.getenv("OPENAI_API_KEY"):
            return TestResult(
                test_name=test_name,
                success=False,
                message="Skipped - no OPENAI_API_KEY found",
                duration=0
            )
        
        try:
            env = await self.setup_test_environment()
            
            async with MCPTools(
                command=f"node {self.server_script_path}",
                transport="stdio",
                env=env
            ) as tools:
                
                # Create agent
                agent = Agent(
                    model=OpenAIChat(model="gpt-3.5-turbo"),
                    tools=[tools],
                    name="test-agent",
                    description="Test agent for MCP server validation",
                    show_tool_calls=True,
                    debug_mode=False
                )
                
                # Test simple echo interaction
                response = await agent.run("Please echo the message 'test successful' in uppercase")
                
                duration = time.time() - start_time
                
                if response and "TEST SUCCESSFUL" in response.content:
                    return TestResult(
                        test_name=test_name,
                        success=True,
                        message="Agent interaction successful",
                        duration=duration
                    )
                else:
                    return TestResult(
                        test_name=test_name,
                        success=False,
                        message="Agent interaction failed - unexpected response",
                        duration=duration,
                        error_details=f"Response: {response}"
                    )
                
        except Exception as e:
            return TestResult(
                test_name=test_name,
                success=False,
                message=f"Agent interaction test failed: {str(e)}",
                duration=time.time() - start_time,
                error_details=str(e)
            )
    
    async def run_all_tests(self) -> List[TestResult]:
        """Run all test cases."""
        print("🧪 Starting MCP Server Stdio Test Suite")
        print("=" * 50)
        
        # List of test methods to run
        test_methods = [
            self.test_mcp_connection,
            self.test_yaml_tools_loading
        ]
        
        results = []
        
        for i, test_method in enumerate(test_methods, 1):
            test_name = test_method.__name__.replace("test_", "")
            print(f"\n[{i}/{len(test_methods)}] Running {test_name}...")
            
            result = await test_method()
            results.append(result)
            
            # Print immediate result
            status = "✅ PASS" if result.success else "❌ FAIL"
            print(f"    {status} - {result.message} ({result.duration:.2f}s)")
            
            if not result.success and result.error_details:
                print(f"    Error: {result.error_details}")
        
        self.results = results
        return results
    
    def cleanup(self):
        """Clean up test resources."""
        if self.server_process:
            try:
                self.server_process.terminate()
                self.server_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.server_process.kill()
            except Exception:
                pass
    
    def print_summary(self):
        """Print test summary."""
        if not self.results:
            print("No test results to summarize")
            return
        
        passed = sum(1 for r in self.results if r.success)
        total = len(self.results)
        
        print("\n" + "=" * 50)
        print("📊 TEST SUMMARY")
        print("=" * 50)
        print(f"Total Tests: {total}")
        print(f"Passed: {passed}")
        print(f"Failed: {total - passed}")
        print(f"Success Rate: {(passed/total)*100:.1f}%")
        
        # Show failed tests
        failed_tests = [r for r in self.results if not r.success]
        if failed_tests:
            print(f"\n❌ Failed Tests:")
            for test in failed_tests:
                print(f"  - {test.test_name}: {test.message}")
        
        # Show tool coverage
        all_tool_calls = []
        for result in self.results:
            if result.tool_calls:
                all_tool_calls.extend(result.tool_calls)
        
        unique_tools = set(all_tool_calls)
        if unique_tools:
            print(f"\n🔧 Tools Tested: {len(unique_tools)}")
            for tool in sorted(unique_tools):
                print(f"  - {tool}")


async def interactive_mode():
    """Run in interactive mode with an agent."""
    print("🤖 Interactive MCP Agent Mode")
    print("Type 'quit' to exit\n")
    
    if not os.getenv("OPENAI_API_KEY"):
        print("❌ No OPENAI_API_KEY found. Please set it in your .env file.")
        return
    
    test_suite = StdioMcpServerTest()
    
    try:
        env = await test_suite.setup_test_environment()
        
        async with MCPTools(
            command=f"node {test_suite.server_script_path}",
            transport="stdio",
            env=env
        ) as tools:
            
            # Show available tools
            result = await tools.session.list_tools()
            tools_list = result.tools
            print(f"📋 Available tools: {len(tools_list)}")
            for tool in tools_list[:5]:  # Show first 5
                print(f"  - {tool.name}: {tool.description}")
            if len(tools_list) > 5:
                print(f"  ... and {len(tools_list) - 5} more")
            
            # Create agent
            agent = Agent(
                model=OpenAIChat(model="gpt-3.5-turbo"),
                tools=[tools],
                name="interactive-mcp-agent",
                description="Interactive agent for testing MCP server",
                show_tool_calls=True,
                debug_mode=True
            )
            
            print("\n💬 Chat with your MCP server:")
            
            while True:
                try:
                    user_input = input("\n> ").strip()
                    
                    if user_input.lower() in ['quit', 'exit', 'q']:
                        break
                    
                    if not user_input:
                        continue
                    
                    print("\n🤔 Agent thinking...")
                    await agent.aprint_response(user_input, stream=True)
                    
                except KeyboardInterrupt:
                    print("\n👋 Goodbye!")
                    break
                except Exception as e:
                    print(f"❌ Error: {e}")
    
    finally:
        test_suite.cleanup()


async def validate_tools_only():
    """Just validate that tools are available."""
    print("🔍 Validating MCP Server Tools")
    
    test_suite = StdioMcpServerTest()
    
    try:
        env = await test_suite.setup_test_environment()
        
        async with MCPTools(
            command=f"node {test_suite.server_script_path}",
            transport="stdio",
            env=env
        ) as tools:
            
            result = await tools.session.list_tools()
            tools_list = result.tools
            
            print(f"\n✅ Found {len(tools_list)} tools:")
            
            for tool in tools_list:
                annotations = ""
                try:
                    if tool.annotations and hasattr(tool.annotations, 'toolsets'):
                        toolsets = getattr(tool.annotations, 'toolsets', [])
                        if toolsets:
                            annotations = f" [toolsets: {', '.join(toolsets)}]"
                except AttributeError:
                    pass
                
                print(f"  📦 {tool.name}: {tool.description}{annotations}")
    
    except Exception as e:
        print(f"❌ Error validating tools: {e}")
    
    finally:
        test_suite.cleanup()


async def main():
    parser = argparse.ArgumentParser(description="MCP Server Stdio Agent Test")
    parser.add_argument("--test-mode", action="store_true", help="Run automated tests")
    parser.add_argument("--interactive", action="store_true", help="Run in interactive mode")
    parser.add_argument("--validate-tools", action="store_true", help="Just validate tool availability")
    parser.add_argument("--server-script", type=str, help="Path to server script")
    
    args = parser.parse_args()
    
    # Default to test mode if no specific mode chosen
    if not any([args.test_mode, args.interactive, args.validate_tools]):
        args.test_mode = True
    
    if args.validate_tools:
        await validate_tools_only()
    elif args.interactive:
        await interactive_mode()
    elif args.test_mode:
        test_suite = StdioMcpServerTest(args.server_script)
        
        try:
            await test_suite.run_all_tests()
            test_suite.print_summary()
            
            # Exit with non-zero if any tests failed
            failed_count = sum(1 for r in test_suite.results if not r.success)
            sys.exit(failed_count)
            
        finally:
            test_suite.cleanup()


if __name__ == "__main__":
    asyncio.run(main())