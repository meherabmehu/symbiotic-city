"""Groq chat provider -- backend-only, key never leaves the server.

Design notes:

- The key comes from backend settings (``GROQ_API_KEY`` via .env or the
  environment). No frontend module imports this package, no route returns
  configuration, and the key is a SecretStr so repr/log paths mask it.
- One key, one client: rate limits are surfaced as :class:`AiRateLimited`
  with the provider's retry hint. There is deliberately no key rotation or
  fan-out -- bypassing a free-tier limit with multiple keys is prohibited.
- Every failure becomes a safe :class:`AiError` whose message is built from
  our own strings, so a URL or response body can never leak the key.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Iterable, Mapping

import httpx

from app.core.config import settings

logger = logging.getLogger("symbiotic.ai")

DEFAULT_MODEL = "llama-3.3-70b-versatile"
DEFAULT_BASE_URL = "https://api.groq.com/openai/v1"


class AiError(Exception):
    """Any provider failure, safe to show a user (never contains the key)."""


class AiRateLimited(AiError):
    """The provider asked us to slow down; carries its retry hint."""

    def __init__(self, message: str, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


@dataclass(frozen=True)
class AiReply:
    text: str
    model: str
    provider: str  # "groq" -- features label model output with this


Message = Mapping[str, str]


class GroqProvider:
    """Minimal chat-completions client for Groq's OpenAI-compatible API."""

    def __init__(
        self,
        *,
        api_key: str,
        model: str | None = None,
        base_url: str | None = None,
        timeout: float | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if not api_key:
            raise AiError("GROQ_API_KEY is not configured")
        self._key = api_key
        self._model = model or settings.groq_model or DEFAULT_MODEL
        self._base = (base_url or settings.groq_base_url or DEFAULT_BASE_URL).rstrip("/")
        self._timeout = timeout or settings.groq_timeout_seconds
        self._transport = transport

    async def chat(
        self,
        messages: Iterable[Message],
        *,
        temperature: float = 0.2,
        max_tokens: int = 700,
    ) -> AiReply:
        payload = {
            "model": self._model,
            "messages": list(messages),
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        request = httpx.Request(
            "POST",
            f"{self._base}/chat/completions",
            headers={
                "Authorization": f"Bearer {self._key}",
                "Content-Type": "application/json",
            },
            json=payload,
        )
        try:
            async with httpx.AsyncClient(
                timeout=self._timeout,
                transport=self._transport,
            ) as client:
                response = await client.send(request)
        except httpx.TimeoutException as exc:
            raise AiError("The AI provider timed out") from exc
        except httpx.HTTPError as exc:
            # Built from our own text only -- httpx errors can embed URLs,
            # which must never include credentials (they do not, by design,
            # but the message is ours either way).
            raise AiError("Could not reach the AI provider") from exc

        if response.status_code == 429:
            retry_after: float | None = None
            header = response.headers.get("retry-after")
            if header:
                try:
                    retry_after = float(header)
                except ValueError:
                    retry_after = None
            raise AiRateLimited(
                "The AI provider is rate limiting this key; wait before retrying",
                retry_after=retry_after,
            )
        if response.status_code in (401, 403):
            raise AiError("The AI provider rejected the configured credentials")
        if response.status_code >= 400:
            logger.warning("groq request failed with status %s", response.status_code)
            raise AiError(f"The AI provider returned an error ({response.status_code})")

        try:
            body: dict[str, Any] = response.json()
            content = body["choices"][0]["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise AiError("The AI provider returned an unreadable response") from exc
        if not isinstance(content, str) or not content.strip():
            raise AiError("The AI provider returned an empty response")

        return AiReply(text=content.strip(), model=str(body.get("model") or self._model), provider="groq")


def get_provider() -> GroqProvider | None:
    """The live provider, or None when no key is configured.

    None is not an error: every feature falls back to its deterministic,
    clearly-labelled rule-based path (see docs/AI_INTEGRATION.md).
    """
    key = settings.groq_api_key
    value = key.get_secret_value() if key is not None else None
    if not value:
        return None
    return GroqProvider(api_key=value)


def provider_label(has_key: bool) -> str:
    """What a feature must print next to generated text, honestly."""
    return "LLM (Groq)" if has_key else "rule-based (no LLM key configured)"
