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
    // Dynamic import so it works whether the package is CJS or ESM.
    const mod: any = await import('playwright-aws-lambda');

    // Support both APIs:
    // 1) mod.launchChromium()  OR
    // 2) mod.chromium.{executablePath,args}
    if (typeof mod.launchChromium === 'function') {
      // Easiest path if available
      return await mod.launchChromium({
        headless: true,
        // You can pass userDataDir, defaultViewport, etc. if you want
      });
    }

    const awsChromium = mod.chromium || mod.default?.chromium;
    if (!awsChromium) {
      throw new Error(
        'playwright-aws-lambda did not export chromium helpers. ' +
        'Check that the package is installed and not tree-shaken.'
      );
    }

    const executablePath = await awsChromium.executablePath();
    return await playwright.chromium.launch({
      headless: true,
      executablePath,
      args: awsChromium.args,
      chromiumSandbox: false,
    });
  }

  // Local dev: use regular Playwright (ensure `npx playwright install` has run)
  return await playwright.chromium.launch({ headless: true });
}
