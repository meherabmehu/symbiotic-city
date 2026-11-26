"""Optional LIVE Groq round-trip -- never part of the normal suite.

Skipped unless both are set:

    RUN_LIVE_AI_TESTS=1   opt in explicitly
    GROQ_API_KEY=...      a key the operator supplied for this machine

Even when enabled it performs one small chat call, honours the provider's
rate limit (a single attempt), and asserts only that the reply is text. The
sandbox used for CI cannot reach api.groq.com, so the default state here is
a documented skip and the mock-based suite carries the verification.
"""

from __future__ import annotations

import asyncio
import os

import pytest

from app.services.ai import get_provider

pytestmark = pytest.mark.skipif(
    os.getenv("RUN_LIVE_AI_TESTS") != "1" or not os.getenv("GROQ_API_KEY"),
    reason="live Groq test is opt-in: set RUN_LIVE_AI_TESTS=1 and supply GROQ_API_KEY yourself",
)


def test_live_single_chat_roundtrip():
    provider = get_provider()
    assert provider is not None, "GROQ_API_KEY should be present when the live test is enabled"
    reply = asyncio.run(provider.chat(
        [
            {"role": "system", "content": "Answer with one short sentence."},
            {"role": "user", "content": "Name the city this console is about. Reply with the name only."},
        ],
        max_tokens=20,
    ))
    assert reply.provider == "groq"
    assert reply.text
