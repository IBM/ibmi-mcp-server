"""
Quick test script for model_selector utility.
"""

from agents.utils import get_model, get_model_by_alias, parse_model_spec


def test_model_selector():
    print("=== Testing Model Selector Utility ===\n")

    # Test parsing
    print("1. Testing parse_model_spec():")
    provider, model_id = parse_model_spec("openai:gpt-4o")
    print(f"   'openai:gpt-4o' -> provider='{provider}', model_id='{model_id}'")
    assert provider == "openai" and model_id == "gpt-4o", "Parse failed!"
    print("   ✓ Parsing works correctly\n")

    # Test OpenAI model creation
    print("2. Testing OpenAI model creation:")
    openai_model = get_model("openai:gpt-4o")
    print(f"   Model type: {type(openai_model).__name__}")
    print(f"   Model ID: {openai_model.id}")
    assert openai_model.id == "gpt-4o", "OpenAI model creation failed!"
    print("   ✓ OpenAI model created successfully\n")

    # Test watsonx model creation
    print("3. Testing watsonx model creation:")
    watsonx_model = get_model("watsonx:llama-3-3-70b-instruct")
    print(f"   Model type: {type(watsonx_model).__name__}")
    print(f"   Model ID: {watsonx_model.id}")
    assert watsonx_model.id == "llama-3-3-70b-instruct", "watsonx model creation failed!"
    print("   ✓ watsonx model created successfully\n")

    # Test alias resolution
    print("4. Testing alias resolution:")
    alias_model = get_model_by_alias("gpt-4o")
    print(f"   Alias 'gpt-4o' resolved to: {type(alias_model).__name__}")
    print(f"   Model ID: {alias_model.id}")
    assert alias_model.id == "gpt-4o", "Alias resolution failed!"
    print("   ✓ Alias resolution works correctly\n")

    # Test error handling
    print("5. Testing error handling:")
    try:
        get_model("invalid:model")
        print("   ✗ Should have raised ValueError for invalid provider")
    except ValueError as e:
        print(f"   ✓ Correctly raised ValueError: {str(e)[:50]}...\n")

    try:
        get_model("no-colon-format")
        print("   ✗ Should have raised ValueError for invalid format")
    except ValueError as e:
        print(f"   ✓ Correctly raised ValueError: {str(e)[:50]}...\n")

    print("=== All Tests Passed! ===")


if __name__ == "__main__":
    test_model_selector()
