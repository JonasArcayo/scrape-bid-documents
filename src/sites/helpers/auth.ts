import type { Page } from 'playwright';
import { AuthError } from '../../core/errors.js';

export interface FormLoginOptions {
  loginUrl: string;
  usernameSelector: string;
  passwordSelector: string;
  submitSelector: string;
  username: string;
  password: string;
  /** Selector that exists only when logged in (preferred), or... */
  loggedInSelector?: string;
  /** ...a URL pattern the page must leave (e.g. /login/i): login failed if still matching. */
  loginUrlPattern?: RegExp;
}

/** Fill and submit a standard login form; throws AuthError if success cannot be confirmed. */
export async function formLogin(page: Page, o: FormLoginOptions): Promise<void> {
  await page.goto(o.loginUrl, { waitUntil: 'domcontentloaded' });
  await page.locator(o.usernameSelector).first().fill(o.username);
  await page.locator(o.passwordSelector).first().fill(o.password);
  await Promise.all([
    page.waitForLoadState('domcontentloaded'),
    page.locator(o.submitSelector).first().click(),
  ]);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const ok = o.loggedInSelector
    ? await page
        .locator(o.loggedInSelector)
        .first()
        .isVisible()
        .catch(() => false)
    : o.loginUrlPattern
      ? !o.loginUrlPattern.test(page.url())
      : true;
  if (!ok) throw new AuthError(`Login failed for ${o.loginUrl} (still on ${page.url()})`);
}

/** True if the page appears to be a login page (session expired). */
export function isOnLoginPage(page: Page, loginUrlPattern: RegExp): boolean {
  return loginUrlPattern.test(page.url());
}

/** Read a credential from the environment or throw a helpful AuthError. */
export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const v = env[name];
  if (!v) throw new AuthError(`Missing required environment variable ${name}`);
  return v;
}
