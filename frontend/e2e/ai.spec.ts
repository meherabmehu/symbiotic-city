import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/**
 * P4: the five AI features as users reach them. The e2e backend runs with
 * no GROQ key, so every test below exercises the honest rule-based path and
 * asserts the provider label says so — the same label the LLM path swaps in
 * when a key exists (that swap is covered by mocked backend tests).
 */

test.describe("AI features", () => {
  test("city copilot answers with a rule-based reply and live citations", async ({ page }) => {
    await login(page, "operator");
    await page.goto("/dashboard");

    const copilot = page.locator('[data-testid="city-copilot"]');
    await expect(copilot).toBeVisible();
    await copilot.getByLabel("Question for the City Copilot").fill("What is PS-01?");
    await copilot.getByRole("button", { name: "Ask the copilot" }).click();

    const reply = copilot.locator('[data-testid="ai-reply"]');
    await expect(reply).toBeVisible({ timeout: 20_000 });
    // No key in this environment -> the label must admit it.
    await expect(reply.locator('[data-testid="ai-provider"]')).toContainText(/rule-based/i);
    await expect(reply).toContainText("PS-01");
    // Citations are links to the entities that were supplied to the model.
    const citations = reply.locator('ul[aria-label="Cited entities"] a');
    expect(await citations.count()).toBeGreaterThan(0);
    await expect(citations.first()).toHaveAttribute("href", /^\/(infrastructure|incidents|tasks|optimization)\//);
  });

  test("incident explanation is permission-gated text, provider-labelled", async ({ page }) => {
    await login(page, "operator");
    await page.goto("/incidents");
    const firstIncident = page.locator('main a[href^="/incidents/"]').first();
    await firstIncident.click();
    await expect(page).toHaveURL(/\/incidents\/\d+/);

    const card = page.locator('[data-testid="incident-explain"]');
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Explain this incident" }).click();
    const reply = card.locator('[data-testid="ai-reply"]');
    await expect(reply).toBeVisible({ timeout: 20_000 });
    await expect(reply.locator('[data-testid="ai-provider"]')).toContainText(/rule-based|LLM/i);
    await expect(reply.locator("p")).not.toBeEmpty();
  });

  test("what-if extraction validates, creates, and refuses bad definitions", async ({ page }) => {
    await login(page, "operator");
    await page.goto("/simulation");

    const extract = page.locator('[data-testid="whatif-extract"]');
    await expect(extract).toBeVisible();

    // Invalid: an asset code that does not exist -> nothing is persisted.
    await extract.getByLabel("Scenario description").fill("What if ZZ-99 fails completely?");
    await extract.getByRole("button", { name: "Extract and run scenario" }).click();
    const problems = page.locator('[data-testid="extract-problems"]');
    await expect(problems).toBeVisible({ timeout: 20_000 });
    await expect(problems).toContainText(/Nothing was created/i);
    await expect(problems).toContainText(/ZZ-99/);

    // Valid: a known pair of assets -> scenario recorded and explained.
    await extract.getByLabel("Scenario description").fill(
      "What if TX-01 and SS-02 fail at once? Threshold 0.6, depth 5, seed 99",
    );
    await extract.getByRole("button", { name: "Extract and run scenario" }).click();
    const reply = page.locator('[data-testid="whatif-extract"] [data-testid="ai-reply"]');
    await expect(reply).toBeVisible({ timeout: 30_000 });
    await expect(reply).toContainText(/Scenario #\d+ recorded/i);
    await expect(reply.locator('[data-testid="ai-provider"]')).toContainText(/rule-based|LLM/i);
  });

  test("resilience report is computed by the platform and labelled", async ({ page }) => {
    await login(page, "operator");
    await page.goto("/resilience");

    const card = page.locator('[data-testid="resilience-report"]');
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Generate report" }).click();
    const reply = card.locator('[data-testid="ai-reply"]');
    await expect(reply).toBeVisible({ timeout: 20_000 });
    await expect(reply.locator('[data-testid="ai-provider"]')).toContainText(/rule-based|LLM/i);
    await expect(reply.locator("p")).not.toBeEmpty();
  });
});
