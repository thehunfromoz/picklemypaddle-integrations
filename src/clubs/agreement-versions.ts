/**
 * The club partner agreement's versions (SCRUM-94). Each is a numbered, dated text kept in this
 * repo (`agreements/`), so what a club was sent can always be shown again.
 *
 *  - The live version is the newest one Attila has approved (`approvedOn`). Outside production the
 *    newest version is live even if unapproved, so a draft can be tried on staging (every email
 *    says TEST there). Production only ever sends an approved version.
 *  - A version is never edited once it has been sent: the service records a hash of the text at
 *    its first send, and refuses to send a changed one (and production refuses to start). A change
 *    is a new version, with the next number.
 *  - Production refuses to start while the live version still has a `[To confirm: …]`.
 */
import { createHash } from 'node:crypto';
import { v0_1 } from './agreements/v0.1.js';

export type AgreementBlock = { p: string } | { list: string[] };
export interface AgreementSection {
  heading: string;
  blocks: AgreementBlock[];
}
export interface AgreementVersion {
  /** 1, 2, 3 …: what the database stores. */
  version: number;
  /** What people read: 0.1, 0.2, 1.0 … */
  label: string;
  /** The text's date, YYYY-MM-DD. */
  dated: string;
  /** The day Attila approved this exact text (YYYY-MM-DD); null while a draft. */
  approvedOn: string | null;
  title: string;
  sections: AgreementSection[];
}

/** Oldest first. A new version is appended, with the next number. */
export const AGREEMENT_VERSIONS: readonly AgreementVersion[] = [v0_1];

export const versionByNumber = (n: number, versions: readonly AgreementVersion[] = AGREEMENT_VERSIONS) => versions.find((v) => v.version === n) ?? null;

/** The version a new send uses (see the header for the production rule). */
export function liveAgreement(isProduction: boolean, versions: readonly AgreementVersion[] = AGREEMENT_VERSIONS): AgreementVersion | null {
  const candidates = isProduction ? versions.filter((v) => v.approvedOn !== null) : [...versions];
  return candidates.reduce<AgreementVersion | null>((best, v) => (!best || v.version > best.version ? v : best), null);
}

/** Every line of the text, in order (headings, paragraphs, list items), for searching. */
export function agreementLines(v: AgreementVersion): string[] {
  return [v.title, ...v.sections.flatMap((s) => [s.heading, ...s.blocks.flatMap((b) => ('p' in b ? [b.p] : b.list))])];
}

/** The text's hash, kept at its first send: a changed text is a different hash. */
export function agreementSha(v: AgreementVersion): string {
  return createHash('sha256').update(JSON.stringify({ version: v.version, label: v.label, dated: v.dated, title: v.title, sections: v.sections })).digest('hex');
}

/** Every `[To confirm: …]` left in a version. */
export function placeholdersInAgreement(v: AgreementVersion): string[] {
  return agreementLines(v).flatMap((l) => [...l.matchAll(/\[To confirm:[^\]]*\]/g)].map((m) => m[0]));
}

/** What stops production starting: the live (approved) version still has wording to settle. */
export function agreementProblems(versions: readonly AgreementVersion[] = AGREEMENT_VERSIONS): string[] {
  const live = liveAgreement(true, versions);
  if (!live) return [];
  return placeholdersInAgreement(live).length ? [`club agreement ${live.label} still needs wording`] : [];
}
