/**
 * SCRUM-102: the service area list and its check are owned by the site (src/lib/service-area.ts and
 * service-area-suburbs.json) and copied byte-for-byte here (src/clubs/). This checks the copies against
 * the site's `main`. CI always checks (it fails if GitHub can't be reached); elsewhere it is skipped
 * when offline. When the site changes them, copy them here in an integrations PR (after the site's merges).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const UPSTREAM = 'https://raw.githubusercontent.com/thehunfromoz/picklemypaddle-site/main/src/lib/';

describe('service area parity with the site', () => {
  for (const [name, local] of [['service-area.ts', '../src/clubs/service-area.ts'], ['service-area-suburbs.json', '../src/clubs/service-area-suburbs.json']] as const) {
    it(`${name} is byte-identical to the site's src/lib/${name} on main`, async () => {
      let upstream: string;
      try {
        const res = await fetch(UPSTREAM + name, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        upstream = await res.text();
      } catch (err) {
        if (process.env.CI) throw new Error(`couldn't fetch ${UPSTREAM + name}: ${(err as Error).message}`, { cause: err });
        console.warn(`parity check skipped (offline): ${(err as Error).message}`);
        return;
      }
      expect(readFileSync(new URL(local, import.meta.url), 'utf8'), `copy the site's src/lib/${name} to src/clubs/${name}`).toBe(upstream);
    });
  }
});
