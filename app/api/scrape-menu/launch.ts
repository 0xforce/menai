import type { Browser } from 'playwright-core';
import playwright from 'playwright-core';

// @ts-ignore - ESM/CJS interop varies, this import form works in Next API routes
import { chromium as awsChromium } from 'playwright-aws-lambda';

const isServerless = !!(process.env.AWS_REGION || process.env.VERCEL);

export async function launchChromium(): Promise<Browser> {
  if (isServerless) {
    const executablePath = await awsChromium.executablePath();
    return await playwright.chromium.launch({
      headless: true,
      executablePath,
      args: awsChromium.args,       // required flags for Lambda
      chromiumSandbox: false,       // safer on Lambda
    });
  }

  // Local dev: use full Playwright (you'll have browsers installed locally)
  // If you only have playwright-core locally, install `playwright` dev dep & run `npx playwright install`
  return await playwright.chromium.launch({ headless: true });
}
