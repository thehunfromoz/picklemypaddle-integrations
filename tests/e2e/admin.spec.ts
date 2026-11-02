/**
 * SCRUM-72 e2e: walk an order from Submitted to Completed through the admin, as Attila would on
 * staging; the customer's card payment goes through a faked Stripe (SCRUM-82). Runs on a desktop and a
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

test('walks an order from Submitted to Completed', async ({ page, request }) => {
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
  // SCRUM-81: the calculated postage is filled in; changing it needs a reason.
  await moveTo(page, 'Accepted', async (p) => {
    await expect(p.getByLabel(/Return postage \(A\$\)/)).toHaveValue('18.00');
    await p.getByLabel(/Return postage \(A\$\)/).fill('15');
    await p.getByLabel(/Reason, only if you change the postage/).fill('Both paddles fit the smaller bag');
  });
  await expect(page.getByText('Price (fixed at Accept)')).toBeVisible();
  await expect(page.getByText('Postage overridden (calculated A$18): Both paddles fit the smaller bag')).toBeVisible();

  // SCRUM-82: no "Mark paid (test)"; the customer pays through (faked) Stripe Checkout.
  await expect(page.getByText('Mark paid (test)')).toHaveCount(0);
  await expect(page.getByText('Waiting for the customer to pay: Stripe sets Paid when they do.')).toBeVisible();
  const paid = await request.post(`http://127.0.0.1:${process.env.E2E_HOOK_PORT ?? 4412}/pay/${reference}`);
  expect(paid.status()).toBe(200);
  await page.reload();
  await expect(page.locator('h1 .badge').last()).toHaveText('Paid');
  await expect(page.getByRole('heading', { name: 'Payment' })).toBeVisible();
  await expect(page.getByText('Open in Stripe')).toBeVisible();

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

// SCRUM-63: discount codes, as Attila makes them when someone emails for the launch offer.
test('creates a shared code and generates a one-person code', async ({ page }) => {
  await page.goto('/admin/orders');
  await page.getByRole('link', { name: 'Discount codes' }).click();
  await expect(page.locator('h1')).toHaveText('Discount codes');

  await summary(page, 'Create a code').click();
  const create = page.locator('form', { has: page.getByRole('button', { name: 'Create code' }) });
  const shared = `E2E${Date.now().toString(36).toUpperCase()}`;
  await create.getByLabel(/^Code/).fill(shared.toLowerCase());
  await create.getByLabel('What it gives').selectOption('free');
  await create.getByLabel(/^How much/).fill('1');
  await create.getByLabel('Total uses').fill('10');
  await create.getByRole('button', { name: 'Create code' }).click();
  await expect(page.getByRole('status')).toHaveText('Code created. Copy it from the heading.');
  await expect(page.locator('h1 .ref')).toHaveText(shared);

  await page.getByRole('link', { name: '← Discount codes' }).click();
  const batch = `E2E launch ${Date.now().toString(36)}`;
  await page.getByLabel(/^How many codes/).fill('2');
  await page.getByLabel(/^Note \(optional/).first().fill(batch);
  await page.getByRole('button', { name: 'Generate codes' }).click();
  await expect(page.getByRole('status')).toHaveText('Codes generated: they’re at the top of the list.');
  const generated = page.locator('ul.orders a', { hasText: batch });
  await expect(generated).toHaveCount(2);
  await generated.first().click();
  await expect(page.locator('h1 .ref')).toHaveText(/^FREE-[A-Z2-9]{8}$/);
  await expect(page.getByText('Free re-grit for 1 paddle · 0 of 1 used')).toBeVisible();
  await page.getByLabel(/^Note \(only you see it\)/).fill('E2E player');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(page.getByRole('status')).toHaveText('Note saved.');

  await page.getByRole('button', { name: 'Deactivate' }).click();
  await expect(page.getByRole('status')).toHaveText('Deactivated: new orders can’t use it.');
  await expect(page.locator('h1 .badge')).toHaveText('Inactive');
});
