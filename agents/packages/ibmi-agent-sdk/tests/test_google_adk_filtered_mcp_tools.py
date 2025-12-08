"""
Unit tests for Google ADK filtered MCP tools module.

Tests annotation filtering, predicate creation, and both streamable_http
and stdio transport configurations.
"""

import pytest
from unittest.mock import Mock, AsyncMock, patch, MagicMock
from typing import Dict, Any

# Import the module to test
from ibmi_agent_sdk.google_adk.filtered_mcp_tools import (
    _get_annotation_value,
    _annotation_matches_filter,
    toolset_filter_predicate,
    annotation_filter_predicate,
    load_filtered_mcp_tools,
    load_toolset_tools,
    load_readonly_tools,
    load_non_destructive_tools,
    load_closed_world_tools,
    load_safe_tools,
    load_mcp_tools,
)


# ============================================================
# Fixtures
# ============================================================

@pytest.fixture
def mock_tool():
    """Create a mock Google ADK BaseTool with annotations."""
    tool = Mock()
    tool.name = "test_tool"
    tool.description = "Test tool description"
    
    # Mock the raw_mcp_tool with annotations
    mock_annotations = Mock()
    mock_annotations.model_dump.return_value = {
        "toolsets": ["performance", "sys_admin"],
        "readOnlyHint": True,
        "destructiveHint": False,
        "openWorldHint": False,
    }
    
    tool.raw_mcp_tool = Mock()
    tool.raw_mcp_tool.annotations = mock_annotations
    
    return tool


@pytest.fixture
def mock_tool_no_annotations():
    """Create a mock tool without annotations."""
    tool = Mock()
    tool.name = "tool_no_annotations"
    tool.raw_mcp_tool = Mock()
    tool.raw_mcp_tool.annotations = None
    return tool


@pytest.fixture
def mock_readonly_tool():
    """Create a mock read-only tool."""
    tool = Mock()
    tool.name = "readonly_tool"
    
    mock_annotations = Mock()
    mock_annotations.model_dump.return_value = {
        "toolsets": ["performance"],
        "readOnlyHint": True,
        "destructiveHint": False,
    }
    
    tool.raw_mcp_tool = Mock()
    tool.raw_mcp_tool.annotations = mock_annotations
    
    return tool


# ============================================================
# Test Helper Functions
# ============================================================

class TestGetAnnotationValue:
    """Test _get_annotation_value helper function."""
    
    def test_get_existing_annotation(self, mock_tool):
        """Test extracting an existing annotation value."""
        result = _get_annotation_value(mock_tool, "toolsets")
        assert result == ["performance", "sys_admin"]
    
    def test_get_nonexistent_annotation(self, mock_tool):
        """Test extracting a non-existent annotation."""
        result = _get_annotation_value(mock_tool, "nonexistent")
        assert result is None
    
    def test_get_annotation_no_annotations(self, mock_tool_no_annotations):
        """Test extracting annotation when tool has no annotations."""
        result = _get_annotation_value(mock_tool_no_annotations, "toolsets")
        assert result is None
    
    def test_get_annotation_exception_handling(self):
        """Test exception handling in annotation extraction."""
        tool = Mock()
        tool.raw_mcp_tool = None  # Will cause AttributeError
        result = _get_annotation_value(tool, "toolsets")
        assert result is None


class TestAnnotationMatchesFilter:
    """Test _annotation_matches_filter helper function."""
    
    def test_primitive_exact_match(self):
        """Test exact match with primitive values."""
        assert _annotation_matches_filter(True, True)
        assert _annotation_matches_filter("performance", "performance")
        assert not _annotation_matches_filter(True, False)
        assert not _annotation_matches_filter("performance", "sys_admin")
    
    def test_list_filter_with_single_annotation(self):
        """Test list filter with single annotation value."""
        assert _annotation_matches_filter("performance", ["performance", "sys_admin"])
        assert not _annotation_matches_filter("other", ["performance", "sys_admin"])
    
    def test_list_filter_with_list_annotation(self):
        """Test list filter with list annotation (intersection)."""
        assert _annotation_matches_filter(
            ["performance", "monitoring"],
            ["performance", "sys_admin"]
        )
        assert not _annotation_matches_filter(
            ["monitoring", "logging"],
            ["performance", "sys_admin"]
        )
    
    def test_callable_filter(self):
        """Test callable filter function."""
        filter_func = lambda x: x and len(x) > 0
        assert _annotation_matches_filter(["performance"], filter_func)
        assert not _annotation_matches_filter([], filter_func)
    
    def test_callable_filter_exception(self):
        """Test callable filter with exception."""
        filter_func = lambda x: x["invalid_key"]  # Will raise exception
        assert not _annotation_matches_filter({"key": "value"}, filter_func)


# ============================================================
# Test Predicate Functions
# ============================================================

class TestToolsetFilterPredicate:
    """Test toolset_filter_predicate function."""
    
    def test_matching_toolset(self, mock_tool):
        """Test predicate with matching toolset."""
        predicate = toolset_filter_predicate(["performance"])
        assert predicate(mock_tool) is True
    
    def test_non_matching_toolset(self, mock_tool):
        """Test predicate with non-matching toolset."""
        predicate = toolset_filter_predicate(["monitoring"])
        assert predicate(mock_tool) is False
    
    def test_multiple_allowed_toolsets(self, mock_tool):
        """Test predicate with multiple allowed toolsets."""
        predicate = toolset_filter_predicate(["performance", "monitoring"])
        assert predicate(mock_tool) is True
    
    def test_no_annotations(self, mock_tool_no_annotations):
        """Test predicate with tool that has no annotations."""
        predicate = toolset_filter_predicate(["performance"])
        assert predicate(mock_tool_no_annotations) is False
    
    def test_debug_mode(self, mock_tool, capsys):
        """Test predicate with debug mode enabled."""
        predicate = toolset_filter_predicate(["performance"], debug=True)
        predicate(mock_tool)
        captured = capsys.readouterr()
        assert "test_tool" in captured.out


class TestAnnotationFilterPredicate:
    """Test annotation_filter_predicate function."""
    
    def test_single_annotation_filter(self, mock_tool):
        """Test predicate with single annotation filter."""
        predicate = annotation_filter_predicate({"readOnlyHint": True})
        assert predicate(mock_tool) is True
    
    def test_multiple_annotation_filters_and_logic(self, mock_tool):
        """Test predicate with multiple filters (AND logic)."""
        predicate = annotation_filter_predicate({
            "readOnlyHint": True,
            "destructiveHint": False,
        })
        assert predicate(mock_tool) is True
    
    def test_failing_one_filter(self, mock_tool):
        """Test predicate when one filter fails."""
        predicate = annotation_filter_predicate({
            "readOnlyHint": True,
            "destructiveHint": True,  # This will fail
        })
        assert predicate(mock_tool) is False
    
    def test_list_annotation_filter(self, mock_tool):
        """Test predicate with list annotation filter."""
        predicate = annotation_filter_predicate({
            "toolsets": ["performance", "monitoring"]
        })
        assert predicate(mock_tool) is True


# ============================================================
# Test Main Loading Functions
# ============================================================

class TestLoadFilteredMCPTools:
    """Test load_filtered_mcp_tools function."""
    
    @patch('ibmi_agent_sdk.google_adk.filtered_mcp_tools.McpToolset')
    @patch.dict('os.environ', {'IBMI_MCP_ACCESS_TOKEN': 'test_token'})
    def test_streamable_http_transport(self, mock_mcptoolset):
        """Test loading with streamable_http transport."""
        mock_toolset_instance = Mock()
        mock_toolset_instance.get_tools = AsyncMock(return_value=[])
        mock_mcptoolset.return_value = mock_toolset_instance
        
        result = load_filtered_mcp_tools(
            transport="streamable_http",
            url="http://test.com/mcp"
        )
        
        assert result == mock_toolset_instance
        mock_mcptoolset.assert_called_once()
    
    @patch('ibmi_agent_sdk.google_adk.filtered_mcp_tools.McpToolset')
    def test_stdio_transport(self, mock_mcptoolset):
        """Test loading with stdio transport."""
        mock_toolset_instance = Mock()
        mock_toolset_instance.get_tools = AsyncMock(return_value=[])
        mock_mcptoolset.return_value = mock_toolset_instance
        
        result = load_filtered_mcp_tools(
            transport="stdio",
            command="npx",
            args=["ibmi-mcp-server"],
            env={"DB2i_HOST": "localhost"}
        )
        
        assert result == mock_toolset_instance
        mock_mcptoolset.assert_called_once()
    
    def test_missing_token_for_http(self):
        """Test error when token is missing for HTTP transport."""
        with pytest.raises(ValueError, match="Missing IBMI_MCP_ACCESS_TOKEN"):
            load_filtered_mcp_tools(transport="streamable_http")
    
    def test_missing_command_for_stdio(self):
        """Test error when command is missing for stdio transport."""
        with pytest.raises(ValueError, match="command parameter is required"):
            load_filtered_mcp_tools(transport="stdio")
    
    def test_invalid_transport(self):
        """Test error with invalid transport type."""
        with pytest.raises(ValueError, match="Unsupported transport type"):
            load_filtered_mcp_tools(transport="invalid")
    
    @patch('ibmi_agent_sdk.google_adk.filtered_mcp_tools.McpToolset')
    @patch.dict('os.environ', {'IBMI_MCP_ACCESS_TOKEN': 'test_token'})
    def test_with_annotation_filters(self, mock_mcptoolset):
        """Test loading with annotation filters."""
        mock_toolset_instance = Mock()
        mock_toolset_instance.get_tools = AsyncMock(return_value=[])
        mock_mcptoolset.return_value = mock_toolset_instance
        
        result = load_filtered_mcp_tools(
            annotation_filters={"toolsets": ["performance"]},
            transport="streamable_http"
        )
        
        assert result == mock_toolset_instance
        # Verify tool_filter was passed
        call_kwargs = mock_mcptoolset.call_args[1]
        assert call_kwargs['tool_filter'] is not None
    
    @patch('ibmi_agent_sdk.google_adk.filtered_mcp_tools.McpToolset')
    @patch.dict('os.environ', {'IBMI_MCP_ACCESS_TOKEN': 'test_token'})
    def test_with_custom_filter(self, mock_mcptoolset):
        """Test loading with custom filter function."""
        mock_toolset_instance = Mock()
        mock_toolset_instance.get_tools = AsyncMock(return_value=[])
        mock_mcptoolset.return_value = mock_toolset_instance
        
        custom_filter = lambda tool: "system" in tool.name.lower()
        
        result = load_filtered_mcp_tools(
            custom_filter=custom_filter,
            transport="streamable_http"
        )
        
        assert result == mock_toolset_instance


# ============================================================
# Test Convenience Functions
# ============================================================

class TestConvenienceFunctions:
    """Test convenience factory functions."""
    
    @patch('ibmi_agent_sdk.google_adk.filtered_mcp_tools.load_filtered_mcp_tools')
    def test_load_toolset_tools_single(self, mock_load):
        """Test load_toolset_tools with single toolset."""
        mock_load.return_value = Mock()
        
        load_toolset_tools("performance")
        
        mock_load.assert_called_once()
        call_kwargs = mock_load.call_args[1]
        assert call_kwargs['annotation_filters'] == {"toolsets": ["performance"]}
    
    @patch('ibmi_agent_sdk.google_adk.filtered_mcp_tools.load_filtered_mcp_tools')
    def test_load_toolset_tools_multiple(self, mock_load):
        """Test load_toolset_tools with multiple toolsets."""
        mock_load.return_value = Mock()
        
        load_toolset_tools(["performance", "sys_admin"])
        
        call_kwargs = mock_load.call_args[1]
        assert call_kwargs['annotation_filters'] == {"toolsets": ["performance", "sys_admin"]}
    
    def test_load_toolset_tools_empty_list(self):
        """Test load_toolset_tools with empty list raises ValueError."""
        with pytest.raises(ValueError, match="Empty toolsets list provided"):
            load_toolset_tools([])
    
    @patch('ibmi_agent_sdk.google_adk.filtered_mcp_tools.load_filtered_mcp_tools')
    def test_load_readonly_tools(self, mock_load):
        """Test load_readonly_tools."""
        mock_load.return_value = Mock()
        
        load_readonly_tools()
        
        call_kwargs = mock_load.call_args[1]
        assert call_kwargs['annotation_filters'] == {"readOnlyHint": True}
    
    @patch('ibmi_agent_sdk.google_adk.filtered_mcp_tools.load_filtered_mcp_tools')
    def test_load_non_destructive_tools(self, mock_load):
        """Test load_non_destructive_tools."""
        mock_load.return_value = Mock()
        
        load_non_destructive_tools()
        
        call_kwargs = mock_load.call_args[1]
        assert call_kwargs['annotation_filters'] == {"destructiveHint": False}
    
    @patch('ibmi_agent_sdk.google_adk.filtered_mcp_tools.load_filtered_mcp_tools')
    def test_load_closed_world_tools(self, mock_load):
        """Test load_closed_world_tools."""
        mock_load.return_value = Mock()
        
        load_closed_world_tools()
        
        call_kwargs = mock_load.call_args[1]
        assert call_kwargs['annotation_filters'] == {"openWorldHint": False}
    
    @patch('ibmi_agent_sdk.google_adk.filtered_mcp_tools.load_filtered_mcp_tools')
    def test_load_safe_tools(self, mock_load):
        """Test load_safe_tools."""
        mock_load.return_value = Mock()
        
        load_safe_tools()
        
        call_kwargs = mock_load.call_args[1]
        assert call_kwargs['annotation_filters'] == {
            "readOnlyHint": True,
            "destructiveHint": False,
            "openWorldHint": False,
        }
    
    @patch('ibmi_agent_sdk.google_adk.filtered_mcp_tools.load_filtered_mcp_tools')
    def test_convenience_with_stdio_transport(self, mock_load):
        """Test convenience function with stdio transport."""
        mock_load.return_value = Mock()
        
        load_toolset_tools(
            "performance",
            transport="stdio",
            command="npx",
            args=["ibmi-mcp-server"]
        )
        
        call_kwargs = mock_load.call_args[1]
        assert call_kwargs['transport'] == "stdio"
        assert call_kwargs['command'] == "npx"


# ============================================================
# Test Legacy Compatibility
# ============================================================

class TestLegacyCompatibility:
    """Test legacy load_mcp_tools function."""
    
    @patch('ibmi_agent_sdk.google_adk.filtered_mcp_tools.load_toolset_tools')
    def test_load_mcp_tools_with_filter(self, mock_load_toolset):
        """Test legacy function with tool_filter parameter."""
        mock_load_toolset.return_value = Mock()
        
        load_mcp_tools(tool_filter="performance")
        
        mock_load_toolset.assert_called_once_with("performance")
    
    @patch('ibmi_agent_sdk.google_adk.filtered_mcp_tools.load_filtered_mcp_tools')
    def test_load_mcp_tools_without_filter(self, mock_load_filtered):
        """Test legacy function without tool_filter parameter."""
        mock_load_filtered.return_value = Mock()
        
        load_mcp_tools()
        
        mock_load_filtered.assert_called_once()


# ============================================================
# Integration Tests
# ============================================================

class TestIntegration:
    """Integration tests for complete workflows."""
    
    def test_predicate_with_real_tool_structure(self, mock_tool):
        """Test predicate with realistic tool structure."""
        # Create a predicate that filters for performance tools that are read-only
        predicate = annotation_filter_predicate({
            "toolsets": ["performance"],
            "readOnlyHint": True,
        })
        
        # Should match our mock_tool
        assert predicate(mock_tool) is True
        
        # Modify tool to not be read-only
        mock_tool.raw_mcp_tool.annotations.model_dump.return_value["readOnlyHint"] = False
        assert predicate(mock_tool) is False
    
    def test_multiple_predicates_combination(self, mock_tool, mock_readonly_tool):
        """Test combining multiple predicates."""
        # Create predicates
        toolset_pred = toolset_filter_predicate(["performance"])
        readonly_pred = annotation_filter_predicate({"readOnlyHint": True})
        
        # Both tools should pass toolset predicate
        assert toolset_pred(mock_tool) is True
        assert toolset_pred(mock_readonly_tool) is True
        
        # Both should pass readonly predicate
        assert readonly_pred(mock_tool) is True
        assert readonly_pred(mock_readonly_tool) is True
