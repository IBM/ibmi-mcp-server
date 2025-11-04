from agno.tools.mcp import MCPTools
from dotenv import load_dotenv
import json

load_dotenv(override=True)

url = "http://127.0.0.1:3010/mcp"

async def build_toolset_collection():
    mcp_tools = None
    try:
        print("Connecting to MCP server...")
        mcp_tools = MCPTools(url=url, transport="streamable-http")
        await mcp_tools.connect()
        mcp_session = mcp_tools.session

        print("Listing resources...")
        # Get resources list
        response = await mcp_session.list_resources()
        print(f"Response type: {type(response)}")
        
        # Extract resources from the response
        if hasattr(response, 'resources'):
            resources = response.resources
        elif isinstance(response, tuple) and len(response) >= 3:
            resources = response[2]
        else:
            print("Unable to extract resources from response")
            print(f"Response: {response}")
            return

        print(f"\n=== Found {len(resources)} Resources ===")
        
        for i, resource in enumerate(resources):
            print(f"{i+1}: {resource.name}")
            print(f"   URI: {resource.uri}")
            print(f"   Description: {resource.description}")
            print()
        
        # Test reading the first toolsets resource
        if resources:
            first_uri = str(resources[0].uri)
            print(f"=== Reading Resource: {first_uri} ===")
            try:
                result = await mcp_session.read_resource(uri=first_uri)
                print(f"Success! Resource content type: {type(result)}")
                
                # Pretty print the resource content
                if hasattr(result, 'contents') and result.contents:
                    for content in result.contents:
                        if hasattr(content, 'blob'):
                            # Decode base64 content
                            import base64
                            decoded = base64.b64decode(content.blob).decode('utf-8')
                            toolsets = json.loads(decoded)
                            return toolsets
                        elif hasattr(content, 'text'):
                            print(content.text)
                else:
                    print(f"Result: {result}")
                    
            except Exception as e:
                print(f"Error reading resource: {e}")
                import traceback
                traceback.print_exc()
        
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
    finally:
        if mcp_tools:
            try:
                await mcp_tools.close()
                print("Connection closed successfully.")
            except Exception as e:
                print(f"Note: Error during close (can be ignored): {e}")
                
async def main():
    collection = await build_toolset_collection()
    toolsets = collection.get('toolsets', [])
    print(json.dumps(toolsets, indent=2))


        
if __name__ == '__main__':
    import asyncio
    asyncio.run(main())