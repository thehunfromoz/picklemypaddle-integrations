import type { AgreementVersion } from '../agreement-versions.js';

/**
 * Club partner agreement, version 0.2, dated 10 November 2026 (SCRUM-94, postage option added after UAT). Drafted by Claude for
 * Attila's approval; NOT yet approved or legally reviewed. `approvedOn` stays null until Attila
 * approves this exact text: production only ever sends an approved version, and refuses to start
 * while the live one still has a `[To confirm: …]`. Once a version has been sent it is never
 * edited: a change is a new version (a new file and a new entry in agreement-versions.ts).
 *
 * Changes from 0.1 (never sent): 3.2 dead-spot check; section 4 now for clubs we can visit; new section 5 for post (box, postage, receipt, return); custody 6.6 for post; later sections renumbered (5→6 … 8→9); 2.2, 7.1 adjusted. Changes from the draft in the approval document (0.1): 1.5 states this version's number and date, and
 * 6.4 says payment is in full for each invoice (decided by Attila on 7 Nov 2026, SCRUM-85 UAT).
 */
export const v0_2: AgreementVersion = {
  version: 2,
  label: '0.2',
  dated: '2026-11-10',
  approvedOn: null,
  title: 'PickleMyPaddle club partner agreement',
  sections: [
    {
      heading: '1. Who this agreement is between, and how it is accepted',
      blocks: [
        { p: '1.1 This agreement is between PickleMyPaddle ([To confirm: legal name of the business owner], ABN [To confirm: ABN]), “we” or “us”, and the pickleball club named in the Schedule, “the club”.' },
        { p: '1.2 It sets out how we re-grit paddles that the club collects from its members, how batches are collected from the club or posted to us and returned, who is responsible for the paddles at each stage, and how the club is paid its share and pays us.' },
        { p: '1.3 Accepting it. We email this agreement to the club’s contact named in the Schedule. The club accepts it when that person replies to our email with the words “I agree”. By replying, they confirm they are authorised to accept it for the club. The agreement starts on the date of that reply.' },
        { p: '1.4 If the club doesn’t agree with any part, the contact replies saying which part. Nothing in this agreement applies until a version has been accepted.' },
        { p: '1.5 Each version has a number and a date (this is version 0.2, dated 10 November 2026). Our website’s terms of service also apply. Where they differ, this agreement wins for club batches.' },
      ],
    },
    {
      heading: '2. The service',
      blocks: [
        { p: '2.1 We re-grit both faces of each paddle. This restores surface grip; it doesn’t repair cracks, core damage or edge guards.' },
        { p: '2.2 We return a batch within [To confirm: number] business days of picking it up or receiving it by post, unless we tell the club about a delay before then.' },
        { p: '2.3 Tournament use. Re-gritted paddles are not approved for sanctioned tournaments, because the surface no longer matches the paddle’s certification. The service is for social, club and practice play. The club tells its members this before taking their paddles.' },
        { p: '2.4 If we find a paddle unsuitable on arrival (see 3.2), we don’t re-grit it. We return it unchanged in the same batch, and it isn’t charged.' },
      ],
    },
    {
      heading: '3. What the club does',
      blocks: [
        { p: '3.1 The club collects paddles from its members, tells them the terms that affect them (2.3, 6.4 and the price), and takes their payment. [To confirm: whether the club must charge members A$60 a paddle or may set its own price.]' },
        { p: '3.2 Vetting. Before a paddle goes in a batch, the club checks it against these guidelines and leaves out any that fail:' },
        {
          list: [
            'no cracks, splits, delamination or soft or crushed areas in the core;',
            'the edge guard is intact and firmly attached;',
            'the handle and grip are sound;',
            'no dead spots: the sound is the same across the whole of each face, front and back, when a ball is bounced on it or it is knocked with a hard object such as a coin or the handle of another paddle;',
            '[To confirm: any brands, surfaces or materials we don’t accept];',
            '[To confirm: anything else Attila checks for].',
          ],
        },
        { p: '3.3 Member records stay with the club. The club keeps its own record of which member owns each paddle. It doesn’t give us members’ names or contact details, and we don’t ask for them.' },
        { p: '3.4 Tags. The club tags each paddle so that every paddle in a batch can be matched to its owner on return. The tagging method is agreed with us before the first pickup and recorded in the Schedule. [To confirm: tagging method, to be agreed with the first clubs.]' },
        { p: '3.5 The club names a contact for pickups and a billing contact (they can be the same person) and tells us if either changes.' },
      ],
    },
    {
      heading: '4. Pickups and returns (for clubs we can visit)',
      blocks: [
        { p: '4.0 This section applies to a club we can visit within [To confirm: service area], where the Schedule records pickup. A club outside that area, or any club that prefers it, can use post instead (section 5).' },
        { p: '4.1 When. By default, the club requests a pickup when a batch is ready, from its private link, at least [To confirm: number] business days ahead. We confirm a date by email. If the Schedule records a recurring schedule instead, we collect on those dates without a request.' },
        { p: '4.2 Where. We pick up from and return to the location in the Schedule, within [To confirm: service area]. A batch has at least [To confirm: minimum number] paddles, unless we agree otherwise.' },
        { p: '4.3 Handover. At pickup, the club’s contact and we count the paddles and note their tags together. We leave a pickup receipt with the count and tag numbers, and the batch appears on the club’s private link.' },
        { p: '4.4 Return. At return, we count and check tags against the pickup receipt in the same way. The club’s contact confirms the batch is complete. Any paddle returned unchanged (2.4) is noted on the return receipt.' },
      ],
    },
    {
      heading: '5. Pickups and returns by post',
      blocks: [
        { p: '5.1 Choosing. The Schedule records whether the club uses pickup (section 4), post (this section), or both. A club that uses pickup can still post a batch to us if we agree.' },
        { p: '5.2 The box. We supply a cardboard box for the club’s use [To confirm: box size and how many paddles it holds, and how it reaches the club]. The club packs the vetted paddles (3.2) with a list showing the number of paddles and their tags (3.4), and posts the box to our business address [To confirm: business address, shown on the email we send]. The club emails us the tracking number when it posts.' },
        { p: '5.3 Postage. The club pays the cost of posting the box to us [To confirm: or we supply a prepaid label]. We pay the return postage for a batch of 6 or more paddles. For a batch of fewer than 6 paddles, [To confirm: how return postage is charged]. Postage is never part of the club’s share (7.1).' },
        { p: '5.4 Receipt. When the box arrives we count the paddles and check their tags against the club’s list, and email the pickup contact the count. If it doesn’t match the list, or a paddle is unsuitable (2.4), we say so in that email. The club tells us of any difference within [To confirm: number] business days.' },
        { p: '5.5 Return. We post the batch back to the return address in the Schedule, tracked, and email the club the return tracking number. The club’s contact checks the count and tags on arrival and confirms the batch is complete.' },
      ],
    },
    {
      heading: '6. Custody, damage and loss',
      blocks: [
        { p: '6.1 Who holds the paddles when (pickups; for post see 6.6). We are responsible for the paddles from the moment we sign the pickup receipt until the club’s contact confirms the return. Before pickup and after return, the club is responsible for them.' },
        { p: '6.2 While the paddles are with us, we keep them secure and take reasonable care of them.' },
        { p: '6.3 If a paddle is lost or damaged while it is with us, we [To confirm: repair it, replace it with an equivalent paddle, or pay its reasonable value, up to A$[To confirm: cap] a paddle]. The club tells us of any problem within [To confirm: number] days of the return.' },
        { p: '6.4 What isn’t damage. Re-gritting changes the paddle’s surface; that is the service, not damage. We aren’t responsible for faults the paddle already had, including ones found during vetting or on arrival.' },
        { p: '6.5 Nothing in this agreement excludes or limits any right the club or its members have under the Australian Consumer Law.' },
        { p: '6.6 Paddles in the post. For a postal batch, we are responsible from the moment we count the paddles on arrival (5.4) until we post them back (5.5). The risk of loss or damage in the post, in each direction, is [To confirm: who bears it, and how it is shared between us and the club, to be agreed with each club]. We keep insurance for paddles in our care [To confirm: details].' },
      ],
    },
    {
      heading: '7. Price, the club’s share and payment',
      blocks: [
        { p: '7.1 Our price for a paddle is A$60 (both faces). The club’s share is 10% of that, A$6 a paddle, taken off what the club pays us. So the club pays A$54 for each paddle re-gritted, before any GST (7.2). Paddles returned unchanged (2.4) aren’t charged. No postage is charged on a pickup batch; postal batches are covered by 5.3. The club sets what it charges its members [To confirm: or must charge A$60].' },
        { p: '7.2 GST. Until we are registered for GST, no GST is charged. From our registration date, GST is added on top of the A$54 a paddle, at the current rate (10%, so A$5.40 a paddle). Our invoices and receipts are then tax invoices that show our ABN, the amount before GST, the GST and the total as separate lines. A registered club can usually claim that GST back. The invoice’s issue date decides which rule applies.' },
        { p: '7.3 Invoice. When we return a batch, we email the billing contact a numbered invoice for the paddles re-gritted. It is due within [To confirm: number] days.' },
        { p: '7.4 How to pay:' },
        {
          list: [
            'PayID or bank transfer to [To confirm: PayID], with the invoice number as the reference;',
            'by card, through the “Pay by card” link on the invoice;',
            'in cash, on delivery of the batch.',
          ],
        },
        { p: 'Payment is in full for each invoice. Part payments aren’t accepted.' },
        { p: '7.5 If an invoice is more than [To confirm: number] days overdue, we may pause pickups until it is paid.' },
        { p: '7.6 Discount and promotional codes don’t apply to club batches.' },
        { p: '7.7 We give the club at least [To confirm: number] days’ notice of any price change, by email. Batches picked up before the change keep the old price.' },
      ],
    },
    {
      heading: '8. Privacy and the club’s private link',
      blocks: [
        { p: '8.1 We keep only what we need to work with the club:' },
        {
          list: [
            'the club’s name and ABN;',
            'its contacts’ names, emails and phone numbers;',
            'its billing and pickup addresses;',
            'its batches, receipts, invoices and payments;',
            'this agreement’s acceptance.',
          ],
        },
        { p: 'We handle them as our privacy policy describes. [To confirm: where club records are kept, once the CRM decision is made.]' },
        { p: '8.2 We give the club a private link where its contacts can request pickups and see batches, their status, upcoming visits and invoices. The link is the key: the club keeps it within its committee. If it may have been shared further, the club asks us and we replace it at once, and the old link stops working.' },
        { p: '8.3 We keep invoices and payment records for 5 years, as tax law requires. When the agreement ends, we delete the rest within [To confirm: period], unless the club asks us to delete it sooner.' },
      ],
    },
    {
      heading: '9. Changes, ending the agreement and general terms',
      blocks: [
        { p: '9.1 Changes. To change this agreement, we email the club a new version, saying what changed. It applies once the club’s contact replies “I agree”. Until then, the version already accepted continues to apply.' },
        { p: '9.2 Ending it. Either side can end this agreement at any time by email, with [To confirm: number] days’ notice. Either side can end it at once by email if the other seriously breaks it and doesn’t fix it within [To confirm: number] days of being asked.' },
        { p: '9.3 When it ends, we return any paddles we hold, re-gritted if the work has started. We invoice for those paddles under this agreement. Invoices already issued remain payable.' },
        { p: '9.4 General. This agreement and our website’s terms are the whole arrangement for club batches. The club can’t transfer it to anyone else without our agreement. It is governed by the law of New South Wales.' },
        { p: '9.5 Contact. Attila Madarasz, attila@picklemypaddle.com. Notices under this agreement are sent by email to the addresses in the Schedule.' },
      ],
    },
  ],
};
