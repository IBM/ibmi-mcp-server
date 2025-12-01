from typing import Any, Dict, List
from agno.models.ibm import WatsonX


class MyWatsonx(WatsonX):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        # Custom initialization if needed

    # Override base method
    @staticmethod
    def parse_tool_calls(tool_calls_data: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Build tool calls from streamed tool call data.

        Args:
            tool_calls_data (List[ChoiceDeltaToolCall]): The tool call data to build from.

        Returns:
            List[Dict[str, Any]]: The built tool calls.
        """
        tool_calls: List[Dict[str, Any]] = []
        for _tool_call in tool_calls_data:
            _index = _tool_call.get("index", 0)
            _tool_call_id = _tool_call.get("id")
            _tool_call_type = _tool_call.get("type")
            _function_name = _tool_call.get("function", {}).get("name")
            _function_arguments = _tool_call.get("function", {}).get("arguments", None)

            if len(tool_calls) <= _index:
                tool_calls.extend([{}] * (_index - len(tool_calls) + 1))
            tool_call_entry = tool_calls[_index]
            if not tool_call_entry:
                tool_call_entry["id"] = _tool_call_id
                tool_call_entry["type"] = _tool_call_type
                tool_call_entry["function"] = {
                    "name": _function_name or "",
                    "arguments": _function_arguments or "{}",
                }
            else:
                if _function_name:
                    tool_call_entry["function"]["name"] += _function_name
                if _tool_call_id:
                    tool_call_entry["id"] = _tool_call_id
                if _tool_call_type:
                    tool_call_entry["type"] = _tool_call_type
                # Append arguments if they exist
                if tool_call_entry["function"]["arguments"] == "{}":
                    tool_call_entry["function"]["arguments"] = _function_arguments
                else:
                    tool_call_entry["function"]["arguments"] += _function_arguments
        return tool_calls
