from google.adk.models.lite_llm import LiteLlm
import os
# from dotenv import load_dotenv
from typing import Optional

def get_model(model: Optional[str] = None,):
    model_name = os.getenv("IBMI_AGENT_MODEL", 'gemini-2.5-flash-lite')
    
    # Gemini models can be used directly as strings
    if "gemini" in model_name:
        return model_name
    
    # Other models need LiteLlm wrapper
    return LiteLlm(model=model_name)
