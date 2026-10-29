/**
 * The admin's stylesheet, served from /admin/admin.css so the CSP can forbid inline styles.
 * Mobile first: Attila works orders from his phone (SCRUM-72 AC8). Brand C3b colours.
 */
export const ADMIN_CSS = `
:root {
  --blue: #4565A6; --green: #3F6B3E; --ink: #1E2E52; --bg: #FBFAF6; --line: #d9dce4;
  --muted: #5a6478; --warn-bg: #fff4e0; --warn: #8a4b00; --bad-bg: #fde8e8; --bad: #9b1c1c;
  --ok-bg: #e8f3e6; --test-bg: #efe6ff; --test: #5b2c9f;
  color-scheme: light;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
a { color: var(--blue); }
header.bar { background: var(--ink); color: #fff; padding: .6rem 1rem; display: flex; flex-wrap: wrap; gap: .25rem 1rem; align-items: baseline; justify-content: space-between; }
header.bar a { color: #fff; font-weight: 600; text-decoration: none; }
header.bar .who { font-size: .85rem; opacity: .85; }
main { max-width: 60rem; margin: 0 auto; padding: 1rem; }
h1 { font-size: 1.4rem; margin: .25rem 0 1rem; }
h2 { font-size: 1.1rem; margin: 1.75rem 0 .5rem; border-bottom: 1px solid var(--line); padding-bottom: .25rem; }
.filters { display: flex; flex-wrap: wrap; gap: .4rem; margin: 0 0 1rem; padding: 0; list-style: none; }
.filters a { display: inline-block; padding: .3rem .7rem; border: 1px solid var(--line); border-radius: 999px; text-decoration: none; background: #fff; font-size: .9rem; }
.filters a[aria-current="page"] { background: var(--blue); border-color: var(--blue); color: #fff; }
ul.orders { list-style: none; margin: 0; padding: 0; display: grid; gap: .5rem; }
ul.orders a { display: grid; grid-template-columns: 1fr auto; gap: .15rem .75rem; padding: .7rem .9rem; background: #fff; border: 1px solid var(--line); border-radius: .5rem; text-decoration: none; color: inherit; }
ul.orders .ref { font-weight: 700; color: var(--blue); }
ul.orders .meta { color: var(--muted); font-size: .9rem; grid-column: 1 / -1; }
.badge { display: inline-block; font-size: .75rem; font-weight: 700; letter-spacing: .02em; padding: .05rem .45rem; border-radius: .3rem; background: #eef1f7; vertical-align: middle; }
.badge.test { background: var(--test-bg); color: var(--test); }
.badge.overdue { background: var(--bad-bg); color: var(--bad); }
.badge.failed { background: var(--bad-bg); color: var(--bad); }
.badge.sent { background: var(--ok-bg); color: var(--green); }
.badge.pending, .badge.sending { background: var(--warn-bg); color: var(--warn); }
.empty { color: var(--muted); }
dl.facts { display: grid; grid-template-columns: max-content 1fr; gap: .25rem 1rem; margin: 0; }
dl.facts dt { color: var(--muted); }
dl.facts dd { margin: 0; overflow-wrap: anywhere; }
.paddles { display: grid; gap: 1rem; }
.paddle figure { margin: 0; }
.paddle .photos { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem; }
.paddle img { width: 100%; height: auto; border-radius: .4rem; border: 1px solid var(--line); background: #fff; }
.paddle figcaption { font-size: .85rem; color: var(--muted); }
ol.history, ul.notes, ul.outbox { list-style: none; margin: 0; padding: 0; display: grid; gap: .4rem; }
ol.history li, ul.notes li, ul.outbox li { background: #fff; border: 1px solid var(--line); border-radius: .4rem; padding: .5rem .7rem; }
.small { font-size: .85rem; color: var(--muted); }
.pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.flash { padding: .7rem .9rem; border-radius: .4rem; margin: 0 0 1rem; }
.flash.error { background: var(--bad-bg); color: var(--bad); }
.flash.done { background: var(--ok-bg); color: var(--green); }
.flash.warn { background: var(--warn-bg); color: var(--warn); }
details.action { background: #fff; border: 1px solid var(--line); border-radius: .5rem; margin: 0 0 .5rem; }
details.action summary { cursor: pointer; padding: .7rem .9rem; font-weight: 600; }
details.action form { padding: 0 .9rem .9rem; display: grid; gap: .6rem; }
label { display: grid; gap: .2rem; font-size: .95rem; }
input, textarea, select { font: inherit; padding: .5rem .6rem; border: 1px solid #b8bfcc; border-radius: .35rem; width: 100%; background: #fff; color: inherit; }
textarea { min-height: 5rem; }
button { font: inherit; font-weight: 600; padding: .6rem 1rem; border: 0; border-radius: .4rem; background: var(--blue); color: #fff; cursor: pointer; justify-self: start; min-height: 2.75rem; }
button.danger { background: var(--bad); }
button.secondary { background: #fff; color: var(--blue); border: 1px solid var(--blue); min-height: 2.25rem; padding: .3rem .8rem; }
form.inline { display: inline; }
.test-note { background: var(--test-bg); color: var(--test); padding: .5rem .8rem; border-radius: .4rem; font-size: .9rem; }
@media (min-width: 48rem) {
  .paddles { grid-template-columns: 1fr 1fr; }
}
`;
