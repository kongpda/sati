import type { Page } from "@playwright/test";

/** One kind on the Knowledge page, where Notes, Decisions and Memory went (review 2.4). */
export async function openKnowledge(page: Page, kind: "Notes" | "Decisions" | "File cards") {
  await page.getByRole("link", { name: "Knowledge", exact: true }).click();
  await page.getByRole("tab", { name: kind, exact: true }).click();
}
