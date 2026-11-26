import { describe, expect, it } from "vitest";
import { replyText, type AiReplyPayload } from "@/components/ai/ai-block";

describe("AI reply payloads", () => {
  it("prefers reply, falls back to the report string, never renders undefined", () => {
    const withReply: AiReplyPayload = { reply: "Hello", provider: "LLM (Groq)" };
    const withReport: AiReplyPayload = { report: "Situation brief…", provider: "rule-based (no LLM key configured)" };
    const neither: AiReplyPayload = { provider: "rule-based (no LLM key configured)" };

    expect(replyText(withReply)).toBe("Hello");
    expect(replyText(withReport)).toBe("Situation brief…");
    expect(replyText(neither)).toBe("");
  });

  it("treats an explicit null reply as missing (the report endpoint sends null)", () => {
    const payload: AiReplyPayload = { reply: null, report: "B", provider: "x" };
    expect(replyText(payload)).toBe("B");
  });
});
