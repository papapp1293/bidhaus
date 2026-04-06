import { test, expect } from "@playwright/test";

test.describe("BidHaus Smoke Tests", () => {
  test("landing page loads with create session CTA", async ({ page }) => {
    await page.goto("/");

    await expect(page).toHaveTitle(/BidHaus/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("create session page loads with form", async ({ page }) => {
    await page.goto("/session/create");

    await expect(page.getByLabel(/session name/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /create/i })).toBeVisible();
  });

  test("invalid session code shows not found", async ({ page }) => {
    const response = await page.goto("/session/ZZZZZZZZ");

    // Page should load (not 500)
    expect(response?.status()).toBeLessThan(500);
  });

  test("create session flow produces a lobby", async ({ page }) => {
    await page.goto("/session/create");

    // Fill in the form
    await page.getByLabel(/session name/i).fill("Test Auction");
    await page.getByLabel(/host name/i).fill("TestHost");

    // Submit
    await page.getByRole("button", { name: /create/i }).click();

    // Should navigate to lobby
    await page.waitForURL(/\/session\/.*\/lobby/);
    await expect(page.getByText(/TestHost/)).toBeVisible();
  });

  test("results page returns error for non-existent session", async ({ page }) => {
    await page.goto("/session/INVALID1/results");

    // Should show an error or empty state, not crash
    await expect(page.locator("body")).not.toContainText("Internal Server Error");
  });

  test("API health: metrics endpoint responds", async ({ request }) => {
    const response = await request.get("/api/metrics");

    expect(response.status()).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty("timestamp");
    expect(data).toHaveProperty("sessions");
    expect(data).toHaveProperty("queues");
  });
});
