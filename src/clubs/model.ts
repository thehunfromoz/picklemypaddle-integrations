/** Club and batch statuses (SCRUM-85), with no imports, so any module can use them at load time. */
export const CLUB_STATUSES = ['lead', 'meeting', 'agreement_sent', 'active', 'inactive'] as const;
export type ClubStatus = (typeof CLUB_STATUSES)[number];

/** The club pipeline in words (SCRUM-93), for the admin and for HubSpot's "Club stage". */
export const STATUS_LABELS: Record<ClubStatus, string> = {
  lead: 'Lead',
  meeting: 'Meeting arranged',
  agreement_sent: 'Agreement sent',
  active: 'Active',
  inactive: 'Inactive',
};

export const BATCH_STATUSES = ['collected', 'returned', 'invoiced', 'paid', 'cancelled'] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

/** The meeting in words, for the admin and HubSpot (SCRUM-93 UAT): "Fri 14 Nov 2026, 18:30, 60 min". Empty if none. */
export function meetingText(c: { meetingOn: string | null; meetingTime: string | null; meetingMinutes: number | null }): string {
  if (!c.meetingOn) return '';
  const d = new Date(`${c.meetingOn}T00:00:00Z`).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return [d.replace(/,/g, ''), c.meetingTime, c.meetingMinutes ? `${c.meetingMinutes} min` : null].filter(Boolean).join(', ');
}
