/**
 * Renders every email template with sample data (SCRUM-69), for reviewing the wording:
 *
 *   pnpm preview:emails            # staging versions ([TEST] subjects and banner)
 *   pnpm preview:emails --production
 *
 * Writes one .html and one .txt per template, plus index.html, to ./.email-previews (git-ignored).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { escapeHtml, render, sampleContext, TEMPLATES } from '../src/email/templates.js';

const production = process.argv.includes('--production');
const out = path.resolve('.email-previews');
await mkdir(out, { recursive: true });

const rows: string[] = [];
for (const name of TEMPLATES) {
  const e = render(name, sampleContext(name, !production));
  await writeFile(path.join(out, `${name}.html`), e.html);
  await writeFile(path.join(out, `${name}.txt`), `Subject: ${e.subject}\n\n${e.text}`);
  rows.push(`<li><a href="${name}.html">${escapeHtml(e.subject)}</a> (<a href="${name}.txt">text</a>)</li>`);
  console.log(`${name}: ${e.subject}`);
}
await writeFile(path.join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Email previews</title><ul>${rows.join('')}</ul>`);
console.log(`\nWritten to ${out}`);
