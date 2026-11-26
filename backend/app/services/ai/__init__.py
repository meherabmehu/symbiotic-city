"""Server-side AI layer.

The package owns the Groq provider, the prompt guards that keep retrieved
database text untrusted, and the mock provider the test suite runs against.
Feature modules (copilot, explanations, advisors) build on these primitives;
nothing here can be imported by frontend code -- the provider reads its key
from backend settings only.
"""

from .prompts import SYSTEM_GUARD, untrusted
from .provider import (
    AiError,
    AiRateLimited,
    AiReply,
    GroqProvider,
    get_provider,
    provider_label,
)

__all__ = [
    "SYSTEM_GUARD",
    "untrusted",
    "AiError",
    "AiRateLimited",
    "AiReply",
    "GroqProvider",
    "get_provider",
    "provider_label",
]
