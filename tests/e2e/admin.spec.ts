/**
 * SCRUM-72 e2e: walk an order from Submitted to Completed through the admin, as Attila would on
 * staging, using the "Mark paid (test)" shortcut in place of Stripe. Runs on a desktop and a
 * phone-sized screen (AC8).
 */
import { expect, test, type Page } from '@playwright/test';

/** A <summary> (the button inside its <details> has the same words). */
const summary = (page: Page, text: string) => page.locator('summary', { hasText: new RegExp(`^${text.replace(/[()]/g, '\\$&')}$`) });

async function moveTo(page: Page, label: string, fill?: (page: Page) => Promise<void>) {
  await summary(page, `Move to ${label}`).click(); // opens the <details>
  if (fill) await fill(page);
  await page.getByRole('button', { name: `Move to ${label}` }).click();
  await expect(page.getByRole('status')).toHaveText('Done. The order has moved on.');
  await expect(page.locator('h1 .badge').last()).toHaveText(label);
}

test('walks an order from Submitted to Completed', async ({ page }) => {
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/admin\/orders$/);
  await expect(page.getByText('Signed in through Tailscale as E2E Admin')).toBeVisible();

  await page.goto('/admin/orders?status=submitted');
  const first = page.locator('ul.orders a').first();
  const reference = (await first.locator('.ref').textContent())!.trim();
  expect(reference).toMatch(/^PMP-[A-Z0-9]{5}$/);
  await expect(first.locator('.badge.test')).toHaveText('TEST');
  await first.click();
  await expect(page.locator('h1')).toContainText(reference);

  // The photos load through the admin's own route.
  const photo = page.locator('.paddle img').first();
  await expect(photo).toBeVisible();
  expect(await photo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

  await moveTo(page, 'Questions');
  await moveTo(page, 'Accepted', (p) => p.getByLabel(/Amount/).fill('110'));

  await summary(page, 'Mark paid (test)').click();
  await page.getByRole('button', { name: 'Mark paid (test)' }).click();
  await expect(page.locator('h1 .badge').last()).toHaveText('Paid');

  await moveTo(page, 'In queue'); // the arrival date defaults to today
  await moveTo(page, 'Re-gritted');
  await moveTo(page, 'Posted back', (p) => p.getByLabel(/Tracking number/).fill('AP 0000 1111'));
  await moveTo(page, 'Completed');

  await expect(page.getByText('This order is closed.')).toBeVisible();
  const history = page.locator('ol.history li strong');
  await expect(history).toHaveText(['Submitted', 'Questions', 'Accepted', 'Paid', 'In queue', 'Re-gritted', 'Posted back', 'Completed']);
  // The key-moment emails were queued (they are suppressed here: no email provider).
  for (const template of ['accepted', 'in_queue', 'posted_back']) {
    await expect(page.locator('ul.outbox li', { hasText: template })).toHaveCount(1);
  }

  // Nothing on the page is wider than the screen (Attila works orders from his phone).
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('refuses a rejection without a reason, in the browser and on the server', async ({ page }) => {
  await page.goto('/admin/orders?status=submitted');
  await page.locator('ul.orders a').first().click();
  await summary(page, 'Move to Rejected').click();
  // The browser's own check stops an empty reason ...
  await page.getByRole('button', { name: 'Move to Rejected' }).click();
  await expect(page.getByLabel(/Reason, sent to the customer/)).toBeFocused();
  // ... and the server refuses a blank one too.
  await page.getByLabel(/Reason, sent to the customer/).fill('   ');
  await page.getByRole('button', { name: 'Move to Rejected' }).click();
  await expect(page.getByRole('alert')).toContainText('Give the customer a reason');
});
