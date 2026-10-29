/**
 * Leaves a GitHub annotation saying how many admin walk-through tests ran and passed, per browser
 * project, so a green "Checks" tick visibly includes the e2e run (job logs can't be read from the
 * build session; annotations can).
 */
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';

export default class NoticeReporter implements Reporter {
  private readonly counts = new Map<string, { passed: number; other: number }>();

  onTestEnd(test: TestCase, result: TestResult): void {
    const project = test.parent.project()?.name ?? 'default';
    const c = this.counts.get(project) ?? { passed: 0, other: 0 };
    if (result.status === 'passed') c.passed++;
    else c.other++;
    this.counts.set(project, c);
  }

  onEnd(result: FullResult): void {
    if (!process.env.GITHUB_ACTIONS) return;
    const parts = [...this.counts].map(([p, c]) => `${p} ${c.passed} passed${c.other ? `, ${c.other} not passed` : ''}`);
    const level = result.status === 'passed' ? 'notice' : 'error';
    console.log(`::${level} title=admin e2e (SCRUM-72)::${parts.join('; ') || 'no tests ran'} (Chromium, Submitted → Completed walk)`);
  }
}
