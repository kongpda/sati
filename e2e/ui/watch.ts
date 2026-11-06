import type { Page } from "@playwright/test";

/** Records CSP violations and page errors, so a spec can assert there were none. */
export async function watch(page: Page): Promise<() => Promise<string[]>> {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  await page.addInitScript(() => {
    const seen: string[] = [];
    Object.defineProperty(window, "__csp", { value: seen });
    document.addEventListener("securitypolicyviolation", (e) => {
      seen.push(`csp: ${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  return async () => [
    ...errors,
    ...(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)),
  ];
}
