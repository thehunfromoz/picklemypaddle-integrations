import type { AgreementVersion } from '../agreement-versions.js';

/**
 * Club partner agreement, version 0.3, dated 10 November 2026 (SCRUM-94/102, from Attila's UAT of
 * 0.2). Drafted by Claude for Attila's approval; NOT yet approved or legally reviewed. `approvedOn`
 * stays null until Attila approves this exact text: production only ever sends an approved version,
 * and refuses to start while the live one still has a `[To confirm: …]`. Once a version has been
 * sent (0.2 went to a staging test club) it is never edited: a change is a new version.
 *
 * Changes from 0.2: 3.2 dead-spot wording and tournament-standard rule (no brand list); 4.0 the
 * local pickup area (map and suburb list on the Clubs page; post by agreement); 4.1 three business
 * days; 4.2 service area and at least 5 paddles; 5.2 box size, 8 to 10 paddles; 5.3 the club pays
 * postage and we take the standard cost off the invoice for 6+; 5.4 two business days; 6.3 and 6.6
 * second-hand value up to A$100 a paddle; 7.1 price to members up to A$66; 7.3 payment before the
 * batch goes back (and 2.2, 4.4, 5.5, 7.4, 9.3 follow it; the invoice carries the postage allowance of
 * 5.3 as its own line); 7.5 five business days unpaid; 7.7 ten business days.
 */
export const v0_3: AgreementVersion = {
  version: 3,
  label: '0.3',
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
        { p: '1.5 Each version has a number and a date (this is version 0.3, dated 10 November 2026). Our website’s terms of service also apply. Where they differ, this agreement wins for club batches.' },
      ],
    },
    {
      heading: '2. The service',
      blocks: [
        { p: '2.1 We re-grit both faces of each paddle. This restores surface grip; it doesn’t repair cracks, core damage or edge guards.' },
        { p: '2.2 We re-grit a batch and email the club its invoice within [To confirm: number] business days of picking it up or receiving it by post, unless we tell the club about a delay before then. We return the batch once the invoice is paid (7.3).' },
        { p: '2.3 Tournament use. Re-gritted paddles are not approved for sanctioned tournaments, because the surface no longer matches the paddle’s certification. The service is for social, club and practice play. The club tells its members this before taking their paddles.' },
        { p: '2.4 If we find a paddle unsuitable on arrival (see 3.2), we don’t re-grit it. We return it unchanged in the same batch, and it isn’t charged.' },
      ],
    },
    {
      heading: '3. What the club does',
      blocks: [
        { p: '3.1 The club collects paddles from its members, tells them the terms that affect them (2.3, 6.4 and the price), and takes their payment. The club sets its own price to members, within the limit in 7.1.' },
        { p: '3.2 Vetting. Before a paddle goes in a batch, the club checks it against these guidelines and leaves out any that fail:' },
        {
          list: [
            'no cracks, splits, delamination or soft or crushed areas in the core;',
            'the edge guard is intact and firmly attached;',
            'the handle and grip are sound;',
            'no dead spots: when a ball is bounced on it or it is knocked with a hard object such as a coin or the handle of another paddle, the sound made is consistent with the sound an undamaged paddle makes, louder in the centre, tapering off towards the sides in a consistent way;',
            'it is a paddle that was once usable in sanctioned tournament play, which is the standard we expect for it to be suitable to re-grit.',
          ],
        },
        { p: 'If the club has any doubt about a paddle, it asks us before including it in a shipment.' },
        { p: '3.3 Member records stay with the club. The club keeps its own record of which member owns each paddle. It doesn’t give us members’ names or contact details, and we don’t ask for them.' },
        { p: '3.4 Tags. The club tags each paddle so that every paddle in a batch can be matched to its owner on return. The tagging method is agreed with us before the first pickup and recorded in the Schedule. [To confirm: tagging method, to be agreed with the first clubs.]' },
        { p: '3.5 The club names a contact for pickups and a billing contact (they can be the same person) and tells us if either changes.' },
      ],
    },
    {
      heading: '4. Pickups and returns (for clubs we can visit)',
      blocks: [
        { p: '4.0 This section applies to a club whose venue is inside our local pickup and drop-off area, where the Schedule records pickup. The area is the one shown on the map, with its list of suburbs, on the Clubs page of our website; the Schedule records which version of the list was used. A club outside that area can use post instead (section 5), and a club inside it can too by agreement with PickleMyPaddle.' },
        { p: '4.1 When. By default, the club requests a pickup when a batch is ready, from its private link, at least 3 business days ahead. We confirm a date by email. If the Schedule records a recurring schedule instead, we collect on those dates without a request.' },
        { p: '4.2 Where. We pick up from and return to the location in the Schedule, within the local pickup and drop-off area (4.0). A batch has at least 5 paddles, to justify a pickup, unless we agree otherwise.' },
        { p: '4.3 Handover. At pickup, the club’s contact and we count the paddles and note their tags together. We leave a pickup receipt with the count and tag numbers, and the batch appears on the club’s private link.' },
        { p: '4.4 Return. Once the invoice is paid (7.3), we return the batch. At return, we count and check tags against the pickup receipt in the same way. The club’s contact confirms the batch is complete. Any paddle returned unchanged (2.4) is noted on the return receipt.' },
      ],
    },
    {
      heading: '5. Pickups and returns by post',
      blocks: [
        { p: '5.1 Choosing. The Schedule records whether the club uses pickup (section 4), post (this section), or both. A club that uses pickup can still post a batch to us if we agree.' },
        { p: '5.2 The box. We supply a cardboard box for the club’s use (typically 430 mm × 300 mm × 300 mm, which holds 8 to 10 paddles) [To confirm: how the box reaches the club]. The club packs the vetted paddles (3.2) with a list showing the number of paddles and their tags (3.4), and posts the box to our business address [To confirm: business address, shown on the email we send]. The club emails us the tracking number when it posts.' },
        { p: '5.3 Postage. The club pays for postage [To confirm: to us only, or back to the club too]. For a batch of 6 or more paddles, we take the standard cost of the postage off the club’s invoice, as its own line. The standard cost is the Australia Post price for posting that batch to the club’s venue postcode on the invoice date; if the club’s postage costs more, the club bears the difference. For a batch of fewer than 6 paddles, no postage is taken off. Postage is never part of the club’s share (7.1).' },
        { p: '5.4 Receipt. When the box arrives we count the paddles and check their tags against the club’s list, and email the pickup contact the count. If it doesn’t match the list, or a paddle is unsuitable (2.4), we say so in that email. The club tells us of any difference within 2 business days of the return delivery.' },
        { p: '5.5 Return. Once the invoice is paid (7.3), we post the batch back to the return address in the Schedule, tracked, and email the club the return tracking number. The club’s contact checks the count and tags on arrival and confirms the batch is complete.' },
      ],
    },
    {
      heading: '6. Custody, damage and loss',
      blocks: [
        { p: '6.1 Who holds the paddles when (pickups; for post see 6.6). We are responsible for the paddles from the moment we sign the pickup receipt until the club’s contact confirms the return. Before pickup and after return, the club is responsible for them.' },
        { p: '6.2 While the paddles are with us, we keep them secure and take reasonable care of them.' },
        { p: '6.3 If a paddle is lost or damaged while it is with us, we pay its reasonable second-hand value, up to A$100 a paddle. The club tells us of any problem within 2 business days of the return.' },
        { p: '6.4 What isn’t damage. Re-gritting changes the paddle’s surface; that is the service, not damage. We aren’t responsible for faults the paddle already had, including ones found during vetting or on arrival.' },
        { p: '6.5 Nothing in this agreement excludes or limits any right the club or its members have under the Australian Consumer Law.' },
        { p: '6.6 Paddles in the post. For a postal batch, we are responsible from the moment we count the paddles on arrival (5.4) until we post them back (5.5). The risk of loss or damage in the post, in each direction, is covered by our insurance up to a second-hand value of A$100 a paddle.' },
      ],
    },
    {
      heading: '7. Price, the club’s share and payment',
      blocks: [
        { p: '7.1 Our price for a paddle is A$60 (both faces). The club’s share is 10% of that, A$6 a paddle, taken off what the club pays us. So the club pays A$54 for each paddle re-gritted, before any GST (7.2). Paddles returned unchanged (2.4) aren’t charged. No postage is charged on a pickup batch; postal batches are covered by 5.3. The club may choose to pass on any GST to its members or not, but shouldn’t charge a member more than A$66 a paddle. If it does, it gives that member the option of sending the paddle directly to us.' },
        { p: '7.2 GST. Until we are registered for GST, no GST is charged. From our registration date, GST is added on top of the A$54 a paddle, at the current rate (10%, so A$5.40 a paddle). Our invoices and receipts are then tax invoices that show our ABN, the amount before GST, the GST and the total as separate lines. A registered club can usually claim that GST back. The invoice’s issue date decides which rule applies.' },
        { p: '7.3 Invoice and payment. When a batch is re-gritted, we email the billing contact a numbered invoice for the paddles re-gritted, with any postage allowance (5.3) as its own line. The club pays the invoice in full before we drop the batch off or post it back, and we return the batch once we have the payment.' },
        { p: '7.4 How to pay:' },
        {
          list: [
            'PayID or bank transfer to [To confirm: PayID], with the invoice number as the reference;',
            'by card, through the “Pay by card” link on the invoice;',
            'in cash, by arrangement with us before the batch is returned.',
          ],
        },
        { p: 'Payment is in full for each invoice. Part payments aren’t accepted.' },
        { p: '7.5 If an invoice is still unpaid 5 business days after we send it, we may pause pickups until it is paid.' },
        { p: '7.6 Discount and promotional codes don’t apply to club batches.' },
        { p: '7.7 We give the club at least 10 business days’ notice of any price change, by email. Batches picked up before the change keep the old price.' },
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
        { p: '9.3 When it ends, we finish any batch we hold (re-gritted if the work has started), invoice it under this agreement, and return it once the invoice is paid (7.3). Invoices already issued remain payable.' },
        { p: '9.4 General. This agreement and our website’s terms are the whole arrangement for club batches. The club can’t transfer it to anyone else without our agreement. It is governed by the law of New South Wales.' },
        { p: '9.5 Contact. Attila Madarasz, attila@picklemypaddle.com. Notices under this agreement are sent by email to the addresses in the Schedule.' },
      ],
    },
  ],
};
