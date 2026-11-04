/** Club and batch statuses (SCRUM-85), with no imports, so any module can use them at load time. */
export const CLUB_STATUSES = ['lead', 'meeting', 'agreement_sent', 'active', 'inactive'] as const;
export type ClubStatus = (typeof CLUB_STATUSES)[number];

export const BATCH_STATUSES = ['collected', 'returned', 'invoiced', 'paid', 'cancelled'] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];
