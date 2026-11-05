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

  // SCRUM-84: Paid issued the receipt; it opens as a printable page that fits a phone.
  await expect(page.getByRole('heading', { name: 'Receipts and credit notes' })).toBeVisible();
  await page.locator('table.list a', { hasText: /^PMP-INV-\d{4}$/ }).first().click();
  await expect(page.locator('article.doc h1')).toHaveText('Invoice: paid');
  await expect(page.getByText('No GST has been charged')).toBeVisible();
  await expect(page.locator('article.doc')).toContainText('Total');
  await expect(page.locator('article.doc')).toContainText('Return postage1A$15.00A$15.00');
  const docOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(docOverflow).toBeLessThanOrEqual(0);
  // Printed, the admin's header and links are hidden: only the document is on paper.
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('header.bar')).toBeHidden();
  await page.emulateMedia({ media: 'screen' });
  await page.getByRole('link', { name: '← Documents' }).click();
  await expect(page.getByRole('heading', { name: 'Receipts, invoices and credit notes' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.locator('table.list a', { hasText: reference }).first().click();

  await moveTo(page, 'In queue'); // the arrival date defaults to today
  await moveTo(page, 'Re-gritted');
  await moveTo(page, 'Posted back', (p) => p.getByLabel(/Tracking number/).fill('AP 0000 1111'));
  await moveTo(page, 'Completed');

  await expect(page.getByText('This order is closed.')).toBeVisible();
  const history = page.locator('ol.history li strong');
  await expect(history).toHaveText(['Submitted', 'Questions', 'Accepted', 'Paid', 'In queue', 'Re-gritted', 'Posted back', 'Completed']);
  // The key-moment emails were queued (they are suppressed here: no email provider).
  for (const template of ['accepted', 'payment_received', 'in_queue', 'posted_back']) {
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

// SCRUM-63 (one form, decided 3 Nov 2026): a shared code, then a batch of one-per-person codes.
test('creates a shared code and a batch of one-per-person codes, then filters the list', async ({ page }) => {
  await page.goto('/admin/orders');
  await page.getByRole('link', { name: 'Discount codes' }).click();
  await expect(page.locator('h1')).toHaveText('Discount codes');
  const run = Date.now().toString(36).toUpperCase().slice(-6);
  const create = page.locator('form', { has: page.getByRole('button', { name: 'Create codes' }) });

  // Only the fields for the kind chosen show (3 Nov): one per person first, by default.
  await expect(create.getByLabel(/^How many codes/)).toBeVisible();
  await expect(create.getByLabel(/^Total uses/)).toBeHidden();
  await expect(create.getByRole('checkbox', { name: /Once per email/ })).toBeHidden();
  const radio = create.getByRole('radio', { name: /One per person/ });
  const box = await radio.boundingBox();
  const legend = await create.locator('legend').boundingBox();
  expect(Math.abs(box!.x - legend!.x)).toBeLessThan(8); // left-aligned with its heading
  await create.getByRole('radio', { name: /Shared: one code/ }).check();
  await expect(create.getByLabel(/^How many codes/)).toBeHidden();
  await expect(create.getByLabel(/^Total uses/)).toBeVisible();
  await create.getByLabel(/^Prefix/).fill(`e2e${run}`);
  await create.getByLabel('What it gives').selectOption('amount');
  await create.getByLabel(/^How much/).fill('10');
  await create.getByLabel(/^Total uses/).fill('25');
  await page.getByRole('button', { name: 'Create codes' }).click();
  await expect(page.getByRole('status')).toHaveText('Code created. Copy it from the heading.');
  await expect(page.locator('h1 .ref')).toHaveText(`E2E${run}`);
  await expect(page.getByText('A$10 off the re-grit · 0 of 25 used · once per email')).toBeVisible();

  await page.getByRole('link', { name: '← Discount codes' }).click();
  await create.getByRole('radio', { name: /One per person/ }).check();
  await create.getByLabel(/^Prefix/).fill(`P${run}`);
  await create.getByLabel(/^How many codes/).fill('3');
  await create.getByLabel('What it gives').selectOption('percent');
  await create.getByLabel(/^How much/).fill('20');
  await create.getByLabel(/^Note/).fill('E2E batch');
  await page.getByRole('button', { name: 'Create codes' }).click();
  await expect(page.getByRole('status')).toHaveText('Codes created: the list shows just this prefix.');
  const listed = page.locator('ul.orders a');
  await expect(listed).toHaveCount(3);
  await expect(listed.first().locator('.ref')).toHaveText(new RegExp(`^P${run}-[A-Z2-9]{8}$`));
  await expect(listed.first()).toContainText('20% off the re-grit · 0 of 1 used');

  await listed.first().click();
  await page.getByLabel(/^Note \(only you see it\)/).fill('E2E player');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(page.getByRole('status')).toHaveText('Note saved.');
  await page.getByRole('button', { name: 'Deactivate' }).click();
  await expect(page.locator('h1 .badge')).toHaveText('Inactive');

  await page.goto(`/admin/codes?prefix=P${run}&state=inactive`);
  await expect(page.locator('ul.orders a')).toHaveCount(1);
});

// SCRUM-85: a club and its batch, returned and invoiced, as Attila would on staging.
test('adds a club, records a batch, returns it and opens its invoice', async ({ page }, testInfo) => {
  const name = `E2E Club ${testInfo.project.name} ${Date.now()}`;
  await page.goto('/admin/clubs');
  await summary(page, 'Add a club').click();
  await page.getByLabel('Club name').fill(name);
  await page.getByLabel('Billing contact’s name').fill('Jo Treasurer');
  await page.getByLabel('Billing email (invoices go here)').fill('jo@test.picklemypaddle.com');
  await page.getByLabel('Billing address').fill('1 Court St\nNewtown NSW 2042');
  await page.getByRole('button', { name: 'Add club' }).click();
  await expect(page.getByRole('status')).toHaveText('Club added.');
  await expect(page.locator('h1')).toContainText(name);

  await summary(page, 'Record a batch collected').click();
  await page.getByLabel(/Number of paddles/).fill('6');
  await page.getByRole('button', { name: 'Record batch' }).click();
  await expect(page.getByRole('status')).toHaveText('Batch recorded.');
  await expect(page.locator('h1 .badge')).toHaveText('Collected');

  await page.getByLabel(/Paddles returned unchanged/).fill('1');
  await page.getByRole('button', { name: 'Return and invoice' }).click();
  await expect(page.getByRole('status')).toHaveText('Returned: the invoice is issued and its email goes out within a minute.');
  await expect(page.locator('h1 .badge')).toHaveText('Invoiced');
  await expect(page.getByText('Invoice email')).toBeVisible();

  // 5 re-gritted × A$54, not GST-registered: "Invoice", the club as buyer, due date.
  await page.locator('dl.facts a', { hasText: /^PMP-INV-\d{4}$/ }).click();
  await expect(page.locator('article.doc h1')).toHaveText('Invoice');
  await expect(page.locator('.doc-buyer')).toContainText(name);
  await expect(page.locator('.doc-lines .total')).toContainText('A$270.00');
  await expect(page.locator('.doc-meta')).toContainText('Club batch');
  await expect(page.getByText('No GST has been charged')).toBeVisible();

  // A part payment by PayID, then the rest in cash: the batch is Paid and the invoice says so.
  await page.goBack();
  await summary(page, 'Record a PayID or cash payment').click();
  await page.getByLabel('Amount received (A$)').fill('100');
  await page.getByLabel(/Reference/).fill('TX-E2E-1');
  await page.getByRole('button', { name: 'Record payment' }).click();
  await expect(page.getByRole('status')).toHaveText('Payment recorded.');
  await expect(page.getByText('Still owing: A$170')).toBeVisible();
  await summary(page, 'Record a PayID or cash payment').click();
  await page.getByLabel('Cash').check();
  await page.getByRole('button', { name: 'Record payment' }).click();
  await expect(page.getByRole('status')).toHaveText('Payment recorded: the invoice is paid in full and the batch is Paid.');
  await expect(page.locator('h1 .badge').first()).toHaveText('Paid');
  await page.locator('dl.facts a', { hasText: /^PMP-INV-\d{4}$/ }).click();
  await expect(page.locator('article.doc h1')).toHaveText('Invoice: paid');
  await expect(page.locator('.doc-paid')).toContainText('Paid in full by PayID and cash');
});
