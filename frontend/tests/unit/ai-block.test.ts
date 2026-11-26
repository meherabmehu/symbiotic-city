import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  AiCitations,
  AiMarkdown,
  AiReplyCard,
  ProviderChip,
  replyText,
  type AiReplyPayload,
} from "@/components/ai/ai-block";

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

describe("provider labels", () => {
  it("shows LLM (Groq) only for a genuine model label", () => {
    const html = renderToStaticMarkup(createElement(ProviderChip, { provider: "LLM (Groq)" }));
    expect(html).toContain("LLM (Groq)");
  });

  it("shows a rule-based label verbatim, including the reason", () => {
    const truncated = renderToStaticMarkup(
      createElement(ProviderChip, { provider: "rule-based (incomplete AI response discarded)" }),
    );
    expect(truncated).toContain("rule-based (incomplete AI response discarded)");
    expect(truncated).not.toContain("LLM (Groq)");
  });
});

describe("shared AI presentation", () => {
  it("keeps repeated assignment citations without duplicate-key warnings", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const citations = ["GEN-02", "GEN-03", "GEN-04"].map((resource, index) => ({
      entity_type: "asset",
      entity_id: 7,
      label: "HO-01 — Aurora Central Hospital",
      snippet: `assignment ${index + 1}: ${[55, 30, 5][index]} from ${resource}`,
    }));
    const html = renderToStaticMarkup(createElement(AiCitations, { citations }));

    // All three assignments stay visible -- nothing is deduplicated away.
    expect(html.match(/Aurora Central Hospital/g)).toHaveLength(3);
    expect(html).toContain("1 of 3");
    expect(html).toContain("3 of 3");
    expect(html).toContain("GEN-04");
    const messages = error.mock.calls.flat().join(" ");
    expect(messages).not.toMatch(/same key|unique "?key/i);
    error.mockRestore();
  });

  it("links citations to the entity's own page and nowhere else", () => {
    const html = renderToStaticMarkup(
      createElement(AiCitations, {
        citations: [
          { entity_type: "asset", entity_id: 7, label: "HO-01 — Aurora Central Hospital" },
          { entity_type: "mystery", entity_id: 9, label: "Unknown record" },
        ],
      }),
    );
    expect(html).toContain('href="/infrastructure/7"');
    expect(html).not.toContain('href="/mystery');
  });

  it("renders GFM, Bangla, lists, tables and literal br safely", () => {
    const markdown =
      "### সারাংশ<br>**গুরুত্বপূর্ণ**\n\n- এক\n- দুই\n\n| সম্পদ | অবস্থা |\n|---|---|\n| `SS-01` | সচল |";
    const html = renderToStaticMarkup(createElement(AiMarkdown, null, markdown));
    expect(html).toContain("<h4");
    expect(html).toContain("<strong>গুরুত্বপূর্ণ</strong>");
    expect(html).toContain("<table");
    expect(html).toContain("<code");
    expect(html).not.toContain("<br>");
  });

  it("renders headings, rules, ordered lists and fenced code", () => {
    const markdown = "## Overview\n\n---\n\n1. first\n2. second\n\n```\nPS-01 = 42\n```";
    const html = renderToStaticMarkup(createElement(AiMarkdown, null, markdown));
    expect(html).toContain("<h3");
    expect(html).toContain("<hr");
    expect(html).toContain("<ol");
    expect(html).toContain("<pre");
    expect(html).toContain("PS-01 = 42");
  });

  it("drops raw HTML, unsafe link protocols and remote images", () => {
    const markdown =
      '<script>alert(1)</script>\n\n[bad](javascript:alert(2)) [good](/incidents/5) [ext](https://example.org/a)\n\n![tracker](https://evil.example/pixel.png)';
    const html = renderToStaticMarkup(createElement(AiMarkdown, null, markdown));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="/incidents/5"');
    expect(html).toContain('rel="noreferrer noopener nofollow"');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("evil.example/pixel.png");
  });

  it("surfaces a truncation notice instead of pretending the answer is complete", () => {
    const html = renderToStaticMarkup(
      createElement(AiReplyCard, {
        reply: "Rule-based read-out of solver plan PLAN-0001: …",
        provider: "rule-based (incomplete AI response discarded)",
        notice: "The model hit its output-token limit, so its partial answer was discarded.",
      }),
    );
    expect(html).toContain('data-testid="ai-notice"');
    expect(html).toContain("output-token limit");
    expect(html).toContain("rule-based (incomplete AI response discarded)");
  });

  it("omits the notice element when there is nothing to disclose", () => {
    const html = renderToStaticMarkup(
      createElement(AiReplyCard, { reply: "All good.", provider: "LLM (Groq)" }),
    );
    expect(html).not.toContain('data-testid="ai-notice"');
  });
});
