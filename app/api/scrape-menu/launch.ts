// app/api/scrape-menu/launch.ts
import type { Browser } from 'playwright-core';
import playwright from 'playwright-core';

const isServerless =
  process.env.FORCE_SERVERLESS === '1' ||
  process.env.VERCEL === '1' ||
  !!process.env.AWS_LAMBDA_FUNCTION_NAME ||
  !!process.env.AWS_EXECUTION_ENV ||
  !!process.env.LAMBDA_TASK_ROOT ||
  !!process.env.AWS_REGION;

export async function launchChromium(): Promise<Browser> {
  if (isServerless) {
    // Dynamic import handles CJS/ESM variations on vercel
    const mod: any = await import('playwright-aws-lambda');

    // Prefer the newer helper if available:
    if (typeof mod.launchChromium === 'function') {
      return await mod.launchChromium({ headless: true });
    }

    const awsChromium = mod.chromium || mod.default?.chromium;
    if (!awsChromium) {
      throw new Error('playwright-aws-lambda export missing `chromium`/`launchChromium`');
    }

    const executablePath = await awsChromium.executablePath();
    return await playwright.chromium.launch({
      headless: true,
      executablePath,
      args: awsChromium.args,
      chromiumSandbox: false,
    });
  }

  // Local: standard Playwright (ensure you've run `npx playwright install`)
  return await playwright.chromium.launch({ headless: true });
}
