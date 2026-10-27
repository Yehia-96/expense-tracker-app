// The phone app: capture and view. Screens are rebuilt from the synced rows on every change;
// the money rules live in calc.js and are the desktop's, checked against it by the tests.
import * as api from './api.js';
import * as store from './store.js';
import {
  buildModel, netPosition, groupTotals, peopleLedgers, remaining, paidSoFar, isSettled, perKg,
  Currencies, GroupKind, Direction, Period,
} from './calc.js';
import {
  addExpense, addMoneyIn, addRepayment, addLoan, updateExpense, deleteExpense, hashOf, LOAN_PAYMENT_GROUP,
  addShoppingItem, updateShoppingItem, deleteShoppingItem, buyShoppingItem, unbuyShoppingItem, startNextTrip,
} from './writes.js';

const app = document.getElementById('app');
const state = { model: null, syncing: false, syncError: null, lastSync: null, pending: 0, sheet: null };

// ?demo: the test fixture in memory instead of an account, for looking at the screens while
// developing. Nothing is stored or sent. The published site has no fixture, so it cannot run there.
const DEMO = new URLSearchParams(location.search).has('demo');
let demoRows = [];

// ---------- Small helpers ----------

const ICONS = {
  plus: 'M12 5v14M5 12h14', back: 'M15 6l-6 6 6 6', chev: 'M9 6l6 6-6 6',
  cloud: 'M7 18h10.5a4.5 4.5 0 0 0 .6-8.96A6 6 0 0 0 6.3 8.6 4.75 4.75 0 0 0 7 18z',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6', loan: 'M7 7h13M16 3l4 4-4 4M17 17H4M8 13l-4 4 4 4',
  conversion: 'M4 9h13l-4-4M20 15H7l4 4',
  people: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1M16 3.5a4 4 0 0 1 0 7.5M22 21v-1a6 6 0 0 0-4-5.6',
  clip: 'M20 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8',
  in: 'M17 7L7 17M7 9v8h8', out: 'M7 17L17 7M9 7h8v8', check: 'M5 12.5l4.5 4.5L19 7',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18zM12 7v5l3 2', warn: 'M12 3l10 18H2zM12 10v4M12 17.5h.01',
  close: 'M6 6l12 12M18 6L6 18', refresh: 'M20 11a8 8 0 0 0-14.6-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16M20 20v-4h-4',
  signout: 'M15 4h4v16h-4M10 17l5-5-5-5M15 12H3', brand: 'M7 8h10M7 12h10M7 16h6', camera: 'M4 7h3l2-2h6l2 2h3v12H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  money: 'M12 15V4M8 8l4-4 4 4M4 15v5h16v-5',
  pencil: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  cart: 'M3 4h2.5l2.2 10.5h10.6L20.5 7H6.6M9.5 19a1 1 0 1 0 0 .01M17 19a1 1 0 1 0 0 .01',
  scale: 'M12 4v16M5 8h14M5 8l-3 7a3 3 0 0 0 6 0zM19 8l-3 7a3 3 0 0 0 6 0zM8 20h8',
  key: 'M14 10a4 4 0 1 0-3.5 4L4 20.5V23h3v-2h2v-2h2l1.5-1.5A4 4 0 0 0 14 10zM15.5 8.5h.01',
};
const icon = (name, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24"><path d="${ICONS[name]}"/></svg>`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SYMBOL = ['€', 'E£'];
const CODE = ['EUR', 'EGP'];
const CASH_NAME = ['euro', 'pound'];

/** "€1,240.50", "−E£800.00": the desktop's CurrencyInfo.Format. */
function money(cents, currency) {
  const sign = cents < 0 ? '−' : '';
  const text = (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}${SYMBOL[currency] ?? ''}${text}`;
}

/** The amount with its decimals faded, as on the desktop's large figures. */
function moneyHtml(cents, currency, cls = '') {
  const [whole, dec] = money(cents, currency).split('.');
  return `<span class="amt ${cls}">${esc(whole)}<span class="dec">.${dec}</span></span>`;
}

const dayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const shortFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const monthFmt = new Intl.DateTimeFormat('en-GB', { month: 'long' });

function ago(iso) {
  if (!iso) return 'Not synced yet';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'Synced just now';
  if (s < 3600) return `Synced ${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `Synced ${Math.floor(s / 3600)} h ago`;
  return `Synced ${shortFmt.format(new Date(iso))}`;
}

const PALETTE = ['#6D8FFF', '#35D0A5', '#F0B429', '#FF6B6B', '#B884FF', '#4FC3F7'];

/** The desktop's GroupColors.SlotFor: the nearest of six theme-aware colours. */
function slot(hex) {
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return 'var(--g1)';
  const [r, g, b] = rgb(hex);
  let best = 0; let bestD = Infinity;
  PALETTE.forEach((p, i) => {
    const [pr, pg, pb] = rgb(p);
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  });
  return `var(--g${best + 1})`;
}

const initials = (name) => {
  const words = (name || '?').trim().split(/\s+/);
  return (words.length > 1 ? words[0][0] + words[words.length - 1][0] : words[0][0]).toUpperCase();
};

function parseAmount(text) {
  const n = Number(String(text || '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
}

/** A picked calendar day as a moment: today keeps the time, so it sorts after this morning. */
function dayToMs(value) {
  const [y, m, d] = value.split('-').map(Number);
  const picked = new Date(y, m - 1, d);
  const today = new Date();
  return picked.toDateString() === today.toDateString() ? Date.now() : picked.getTime();
}

const todayValue = () => {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};

let toastTimer = null;
function toast(message, bad = false) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = `toast${bad ? ' bad' : ''}`;
  el.textContent = message;
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), bad ? 6000 : 3000);
}

// ---------- Data ----------

async function reload() {
  const rows = DEMO ? demoRows : await store.allRows();
  state.model = Object.assign(buildModel(rows), {
    rawTags: rows.filter((r) => r.tbl === 'Tags').map((r) => r.data),
  });
  if (!DEMO) {
    state.pending = await store.pendingCount();
    state.lastSync = await store.lastSync();
  }
  render();
}

async function syncNow({ quiet = false } = {}) {
  if (DEMO || !api.isSignedIn() || state.syncing) return;
  state.syncing = true;
  renderTopbar();
  try {
    const pulled = await store.sync();
    state.syncError = null;
    await reload();
    if (pulled && !quiet) toast(pulled === 1 ? '1 change came in.' : `${pulled} changes came in.`);
  } catch (e) {
    state.syncError = e.message || String(e);
    if (!quiet) toast(`Could not sync: ${state.syncError}`, true);
  } finally {
    state.syncing = false;
    state.pending = await store.pendingCount().catch(() => state.pending);
    renderTopbar();
  }
}

/** Saves rows made here, shows them at once, and sends them. */
async function save(changes, message) {
  if (DEMO) {
    demoRows = [...demoRows.filter((r) => !changes.some((c) => c.tbl === r.tbl && c.id === r.id)), ...changes.filter((c) => c.data)];
  } else {
    await store.write(changes);
  }
  closeSheet();
  await reload();
  toast(message);
  syncNow({ quiet: true });
}

const m = () => state.model;
const activeProjects = () => [...m().projects.values()].filter((p) => !p.archived).sort((a, b) => a.sortOrder - b.sortOrder);
const groupsOf = (projectId) => [...m().groups.values()].filter((g) => g.projectId === projectId && !g.archived).sort((a, b) => a.sortOrder - b.sortOrder);
const isRepaymentGroup = (g) => g.name === LOAN_PAYMENT_GROUP.name;
const attachmentsOf = (entryId) => m().attachments.filter((a) => a.entryId === entryId);
const openLoans = () => m().loans.filter((l) => !isSettled(l) && l.group?.project && !l.group.project.archived);

// ---------- Routing and frame ----------

function route() {
  const [, kind, id] = (location.hash || '#/').split('/');
  return { kind: kind || 'home', id };
}

function renderTopbar() {
  const bar = document.querySelector('.topbar .side.end');
  if (bar) bar.innerHTML = syncButton();
}

function syncButton() {
  const label = DEMO ? 'Demo' : state.syncing ? 'Syncing…' : state.syncError ? 'Sync failed' : state.pending ? `${state.pending} to send` : ago(state.lastSync);
  return `<button class="iconbtn" data-act="account" aria-label="Sync and account">
    <span class="syncdot ${state.syncError ? 'bad' : ''}">${esc(label)}</span>
    ${icon(state.syncError ? 'warn' : state.syncing ? 'refresh' : 'cloud', state.syncing ? 'spin' : '')}</button>`;
}

function frame(title, body, { back = null, fab = false } = {}) {
  app.innerHTML = `
    <header class="topbar">
      <div class="side">${back ? `<button class="iconbtn back" data-go="${back}">${icon('back')}Back</button>` : ''}</div>
      <h1>${esc(title)}</h1>
      <div class="side end">${syncButton()}</div>
    </header>
    <main>${body}</main>
    ${fab ? `<button class="fab" data-act="add" aria-label="Add">${icon('plus')}</button>` : ''}`;
}

function render() {
  if (!DEMO && !api.isSignedIn()) return renderSignIn();
  if (!state.model) return;
  const r = route();
  if (r.kind === 'p' && m().projects.has(r.id)) return renderProject(m().projects.get(r.id));
  if (r.kind === 'g' && m().groups.has(r.id)) return renderGroup(m().groups.get(r.id));
  if (r.kind === 'people') return renderPeople();
  if (r.kind === 'shortcut') return renderShortcut();
  if (r.kind === 'shopping') return renderShopping();
  return renderHome();
}

// ---------- Screens ----------

function renderSignIn(error = '') {
  app.innerHTML = `
    <form class="signin" data-form="signin">
      <div class="brand">${icon('brand')}</div>
      <h1>Expense Tracker</h1>
      <p>Sign in with the same account as on your PC. Your data stays in your own private space in it.</p>
      ${error ? `<div class="problem">${esc(error)}</div>` : ''}
      <div class="field"><label for="email">Email</label>
        <input class="input" id="email" name="email" type="email" autocomplete="username" required></div>
      <div class="field"><label for="password">Password</label>
        <input class="input" id="password" name="password" type="password" autocomplete="current-password" required></div>
      <button class="btn primary wide" type="submit">Sign in</button>
      <button class="btn wide" type="button" data-act="forgot" style="margin-top:10px;border:0;background:none;color:var(--accent)">Forgot your password?</button>
    </form>`;
}

function renderForgot(message = '', error = '') {
  app.innerHTML = `
    <form class="signin" data-form="forgot">
      <div class="brand">${icon('brand')}</div>
      <h1>Reset your password</h1>
      <p>We will email you a link. Open it on this iPhone and it brings you back here to choose a new password. It is the same account as Work Tracker, so the new password works there too.</p>
      ${error ? `<div class="problem">${esc(error)}</div>` : ''}
      ${message ? `<div class="problem" style="background:var(--positive-soft);color:var(--positive)">${esc(message)}</div>` : ''}
      <div class="field"><label for="email">Email</label>
        <input class="input" id="email" name="email" type="email" autocomplete="username" required></div>
      <button class="btn primary wide" type="submit">Email me a link</button>
      <button class="btn wide" type="button" data-act="tosignin" style="margin-top:10px;border:0;background:none;color:var(--accent)">Back to sign in</button>
    </form>`;
}

function renderNewPassword(error = '') {
  app.innerHTML = `
    <form class="signin" data-form="newpassword">
      <div class="brand">${icon('brand')}</div>
      <h1>Choose a new password</h1>
      <p>For ${esc(api.userEmail() ?? 'your account')}. Use it on the PC and in Work Tracker too.</p>
      ${error ? `<div class="problem">${esc(error)}</div>` : ''}
      <div class="field"><label for="password">New password</label>
        <input class="input" id="password" name="password" type="password" autocomplete="new-password" minlength="6" required></div>
      <div class="field"><label for="again">Type it again</label>
        <input class="input" id="again" name="again" type="password" autocomplete="new-password" required></div>
      <button class="btn primary wide" type="submit">Save new password</button>
    </form>`;
}

function balanceCard(currency) {
  const p = netPosition(m(), currency);
  const kv = (label, cents, cls = '') => `<div class="kv"><span>${label}</span>${moneyHtml(cents, currency, cls)}</div>`;
  return `<section class="card pad balance">
    <div class="head"><span class="code">${CODE[currency]}</span>Net position</div>
    <div style="margin:6px 0 8px">${moneyHtml(p.net, currency, `big ${p.net < 0 ? 'neg' : ''}`)}</div>
    ${kv('Cash on hand', p.cashOnHand, p.cashOnHand < 0 ? 'neg' : '')}
    ${kv('Spent so far', p.spentSoFar)}
    ${p.outstandingBorrowed ? kv('You owe', p.outstandingBorrowed, 'bor') : ''}
    ${p.outstandingLent ? kv('Owed to you', p.outstandingLent, 'lent') : ''}
  </section>`;
}

function renderHome() {
  const projects = activeProjects();
  const people = peopleLedgers(m()).filter((l) => l.openCount > 0);
  frame('Expense Tracker', `
    <div class="balances">${Currencies.map(balanceCard).join('')}</div>
    <div class="section"><span>Projects</span><span>${projects.length}</span></div>
    <div class="card list">${projects.map((p) => `
      <button class="row" data-go="#/p/${p.id}">
        <span class="avatar" style="background:${slot(p.colorHex)}">${esc(initials(p.name))}</span>
        <span class="main"><span class="title">${esc(p.name)}</span><span class="sub">${groupsOf(p.id).length} groups</span></span>
        <span class="code">${CODE[p.currency]}</span>${icon('chev', 'chev s14')}
      </button>`).join('') || '<div class="empty">No projects yet. Make one on your PC.</div>'}
    </div>
    <div class="section"><span>Shopping</span></div>
    <div class="card list">
      <button class="row" data-go="#/shopping">
        <span class="glyph">${icon('cart')}</span>
        <span class="main"><span class="title">Shopping list</span>
          <span class="sub">${esc(shoppingSummary())}</span></span>
        ${icon('chev', 'chev s14')}
      </button>
    </div>
    <div class="section"><span>Loans</span></div>
    <div class="card list">
      <button class="row" data-go="#/people">
        <span class="glyph">${icon('people')}</span>
        <span class="main"><span class="title">People</span>
          <span class="sub">${people.length ? `${people.length} with open loans` : 'Who you owe and who owes you'}</span></span>
        ${icon('chev', 'chev s14')}
      </button>
    </div>`, { fab: true });
}

function spentInProject(projectId) {
  return m().expenses
    .filter((e) => e.group?.projectId === projectId && e.loanPaymentId === null && e.group.kind !== GroupKind.Conversion)
    .reduce((s, e) => s + e.amount, 0);
}

function budgetLine(group, t, currency) {
  if (group.budget === null) return t.entryCount === 1 ? '1 entry' : `${t.entryCount} entries`;
  const when = { [Period.Week]: 'this week', [Period.Month]: 'this month', [Period.Year]: 'this year' }[group.period] ?? '';
  return `of ${money(group.budget, currency)}${when ? ` ${when}` : ''}`;
}

function bar(spent, budget) {
  if (!budget) return '';
  const pct = Math.min(100, Math.round((spent / budget) * 100));
  const cls = spent > budget ? 'over' : spent >= budget * 0.8 ? 'warn' : '';
  return `<div class="bar ${cls}"><i style="width:${pct}%"></i></div>`;
}

function renderProject(project) {
  const c = project.currency;
  const rows = groupsOf(project.id).map((g) => {
    if (g.kind === GroupKind.Loan) {
      const loans = m().loans.filter((l) => l.groupId === g.id);
      const owe = loans.filter((l) => l.direction === Direction.Borrowed && !isSettled(l)).reduce((s, l) => s + remaining(l), 0);
      const owed = loans.filter((l) => l.direction === Direction.Lent && !isSettled(l)).reduce((s, l) => s + remaining(l), 0);
      return `<button class="row" data-go="#/g/${g.id}">
        <span class="glyph">${icon('loan')}</span>
        <span class="main"><span class="title">${esc(g.name)}</span><span class="sub">${loans.length} loans${owed ? ` · owed to you ${money(owed, c)}` : ''}</span></span>
        <span class="end">${moneyHtml(owe, c, 'row-amt')}<div class="sub muted" style="font-size:12px">you still owe</div></span>
      </button>`;
    }
    const t = groupTotals(m(), g);
    const conversion = g.kind === GroupKind.Conversion;
    return `<button class="row" data-go="#/g/${g.id}" style="flex-wrap:wrap">
      ${conversion ? `<span class="glyph">${icon('conversion')}</span>` : isRepaymentGroup(g) ? `<span class="glyph">${icon('receipt')}</span>` : `<span class="dot" style="background:${slot(g.colorHex)}"></span>`}
      <span class="main"><span class="title">${esc(g.name)}</span>
        <span class="sub">${conversion ? `${t.entryCount} conversions` : isRepaymentGroup(g) ? 'Filled in from loan repayments' : esc(budgetLine(g, t, c))}</span>
        ${conversion || isRepaymentGroup(g) ? '' : bar(t.measuredSpend, g.budget)}</span>
      <span class="end">${moneyHtml(g.budget !== null ? t.measuredSpend : t.total, c, `row-amt ${g.budget !== null && t.measuredSpend > g.budget ? 'neg' : ''}`)}</span>
    </button>`;
  }).join('');

  frame(project.name, `
    <section class="card pad">
      <div class="sec" style="font-size:13px">Spent in this project</div>
      ${moneyHtml(spentInProject(project.id), c, 'big')}
    </section>
    <div class="section"><span>Groups</span></div>
    <div class="card list">${rows || '<div class="empty">No groups yet.</div>'}</div>`, { back: '#/', fab: true });
}

function windowLabel(group, t) {
  if (!t.window) return 'All time';
  if (group.period === Period.Week) return `${shortFmt.format(new Date(t.window.start))} – ${shortFmt.format(new Date(t.window.end - 1))}`;
  if (group.period === Period.Month) return monthFmt.format(new Date(t.window.start));
  return String(new Date(t.window.start).getFullYear());
}

function entryRows(entries, currency) {
  const byDay = new Map();
  for (const e of [...entries].sort((a, b) => b.occurredOn - a.occurredOn)) {
    const key = new Date(e.occurredOn).toDateString();
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(e);
  }
  return [...byDay.values()].map((day) => `
    <div class="day">${dayFmt.format(new Date(day[0].occurredOn))}</div>
    <div class="card list">${day.map((e) => {
      const files = attachmentsOf(e.id).length;
      const sub = [e.payee, e.tags.map((t) => `#${t}`).join(' ')].filter(Boolean).join(' · ');
      return `<button class="row" data-act="entry" data-id="${e.id}">
        <span class="main"><span class="title">${esc(e.title)}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</span>
        ${files ? icon('clip', 's14 muted') : ''}
        <span class="end">${moneyHtml(e.amount, currency, 'row-amt')}</span>
      </button>`;
    }).join('')}</div>`).join('');
}

function renderGroup(group) {
  const c = group.project?.currency ?? 0;
  const back = `#/p/${group.projectId}`;

  if (group.kind === GroupKind.Loan) {
    const loans = m().loans.filter((l) => l.groupId === group.id).sort((a, b) => isSettled(a) - isSettled(b) || b.occurredOn - a.occurredOn);
    return frame(group.name, `<div style="margin-bottom:12px"><button class="btn primary wide" data-act="newloan" data-group="${group.id}">${icon('plus')}New loan</button></div>
      <div class="card list">${loans.map((l) => {
      const settled = isSettled(l);
      const overdue = !settled && l.dueDate && l.dueDate < Date.now();
      const borrowed = l.direction === Direction.Borrowed;
      return `<button class="row" data-act="loan" data-id="${l.id}" style="flex-wrap:wrap">
        <span class="main">
          <span class="title">${esc(l.title)}</span>
          <span class="sub">${borrowed ? 'Borrowed from' : 'Lent to'} ${esc(l.counterparty)}${l.dueDate && !settled ? ` · due ${shortFmt.format(new Date(l.dueDate))}` : ''}</span>
          <span style="display:flex;gap:6px;margin-top:6px">
            <span class="badge ${borrowed ? 'bor' : 'lent'}">${icon(borrowed ? 'in' : 'out')}${borrowed ? 'You owe' : 'Owed to you'}</span>
            ${overdue ? `<span class="badge neg">${icon('clock')}Overdue</span>` : ''}
            ${!l.movesCash ? '<span class="badge neu">Not in cash</span>' : ''}
            ${settled ? `<span class="badge pos">${icon('check')}Settled</span>` : ''}
          </span>
          ${bar(paidSoFar(l), l.amount).replace('class="bar ', `class="bar ${settled ? 'done ' : ''}`)}
        </span>
        <span class="end">${moneyHtml(remaining(l), c, `row-amt ${settled ? 'muted' : ''}`)}<div class="sub muted amt" style="font-size:12px">of ${money(l.amount, c)}</div></span>
      </button>`;
    }).join('') || '<div class="empty">No loans in this group.</div>'}</div>`, { back, fab: true });
  }

  const entries = m().expenses.filter((e) => e.groupId === group.id);

  if (group.kind === GroupKind.Conversion) {
    const rows = [...entries].sort((a, b) => b.occurredOn - a.occurredOn).map((e) => `
      <div class="row">
        <span class="main"><span class="title">${esc(e.title)}</span>
          <span class="sub">${shortFmt.format(new Date(e.occurredOn))}${e.payee ? ` · with ${esc(e.payee)}` : ''}</span></span>
        <span class="end"><span class="amt row-amt">−${esc(money(e.amount, c))}</span>
          <div class="amt pos" style="font-size:13px">${e.exchangedAmount !== null ? `+${esc(money(e.exchangedAmount, e.exchangedCurrency))}` : ''}</div>
          ${e.exchangedAmount ? `<div class="sub muted" style="font-size:12px">${(e.exchangedAmount / e.amount).toFixed(2)} ${SYMBOL[e.exchangedCurrency]} per ${SYMBOL[c]}</div>` : ''}</span>
      </div>`).join('');
    return frame(group.name, `<div class="card list">${rows || '<div class="empty">No conversions yet.</div>'}</div>
      <p class="hint" style="margin:12px 4px">Conversions are recorded on the PC.</p>`, { back, fab: true });
  }

  const t = groupTotals(m(), group);
  const repayments = isRepaymentGroup(group);
  const head = `<section class="card pad">
    <div class="sec" style="font-size:13px">${esc(group.budget !== null ? windowLabel(group, t) : 'Spent')}</div>
    <div>${moneyHtml(group.budget !== null ? t.measuredSpend : t.total, c, 'big')}
      ${group.budget !== null ? `<span class="amt muted"> of ${esc(money(group.budget, c))}</span>` : ''}</div>
    ${group.budget !== null ? bar(t.measuredSpend, group.budget) + `<div class="hint">${
      t.measuredSpend > group.budget ? `Over by ${money(t.measuredSpend - group.budget, c)}` : `${money(group.budget - t.measuredSpend, c)} left`}</div>` : ''}
  </section>`;

  frame(group.name, `${head}
    ${repayments ? '<p class="hint" style="margin:12px 4px">Filled in from loan repayments. Record one from its loan.</p>'
      : `<div style="margin-top:12px"><button class="btn primary wide" data-act="expense" data-group="${group.id}">${icon('plus')}Add expense</button></div>`}
    ${entryRows(entries, c) || '<div class="empty">Nothing here yet.</div>'}`, { back, fab: !repayments });
}

function renderPeople() {
  const ledgers = peopleLedgers(m()).sort((a, b) => (b.openCount > 0) - (a.openCount > 0));
  const lines = (fn, cls) => Currencies.map((c) => fn(c) ? `<div class="amt row-amt ${cls}">${esc(money(fn(c), c))}</div>` : '').join('');
  frame('People', `<div class="card list">${ledgers.map((l) => `
    <button class="row" data-act="person" data-id="${l.person.id}">
      <span class="avatar round" style="background:${slot(PALETTE[[...l.person.name].reduce((s, ch) => s + ch.charCodeAt(0), 0) % 6])}">${esc(initials(l.person.name))}</span>
      <span class="main"><span class="title">${esc(l.person.name)}</span>
        <span class="sub">${l.loans.length === 1 ? '1 loan' : `${l.loans.length} loans`}${l.openCount ? `, ${l.openCount} open` : ', settled'}</span></span>
      <span class="end">${lines(l.youOwe, 'bor')}${lines(l.owedToYou, 'lent')}</span>
    </button>`).join('') || '<div class="empty">Nobody yet. People are added when loans name them.</div>'}</div>
    <p class="hint" style="margin:12px 4px">Purple is what you owe them; teal is what they owe you.</p>`, { back: '#/' });
}

// ---------- Sheets ----------

function openSheet(html) {
  closeSheet();
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.innerHTML = `<div class="sheet" role="dialog"><div class="grip"></div>${html}</div>`;
  scrim.addEventListener('click', (e) => { if (e.target === scrim) closeSheet(); });
  document.body.append(scrim);
  state.sheet = scrim;
  return scrim;
}

function closeSheet() {
  state.sheet?.remove();
  state.sheet = null;
}

function sheetProblem(form, message) {
  form.querySelector('.problem')?.remove();
  form.insertAdjacentHTML('afterbegin', `<div class="problem">${esc(message)}</div>`);
  form.closest('.sheet').scrollTop = 0;
}

function openAdd() {
  const route_ = route();
  const group = route_.kind === 'g' ? m().groups.get(route_.id) : null;
  openSheet(`<h2>Add</h2><div class="subtitle">What happened?</div>
    <div class="choices">
      <button class="choice" data-act="expense" data-group="${group && group.kind === GroupKind.Expense && !isRepaymentGroup(group) ? group.id : ''}">
        <span class="glyph">${icon('receipt')}</span><span><b>An expense</b><span>Something paid for, with a receipt photo if you like</span></span></button>
      <button class="choice" data-act="moneyin"><span class="glyph">${icon('in')}</span><span><b>Money in</b><span>Salary, a transfer, cash you were given</span></span></button>
      <button class="choice" data-act="newloan" data-group="${group && group.kind === GroupKind.Loan ? group.id : ''}">
        <span class="glyph">${icon('loan')}</span><span><b>A loan</b><span>Money you borrowed, or lent to someone</span></span></button>
      <button class="choice" data-act="repay">
        <span class="glyph">${icon('check')}</span><span><b>A repayment</b><span>Paying back a loan, or being paid back</span></span></button>
    </div>`);
}

let pickedFiles = [];
let keptFiles = [];

const dateValue = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** The expense form, blank or (with `entryId`) filled in to edit that entry. */
function openExpense(groupId, entryId = null) {
  const editing = entryId ? m().entryById.get(entryId) : null;
  // An entry keeps its currency: its amount means nothing in the other one.
  const projects = activeProjects().filter((p) => !editing || p.currency === editing.group.project.currency);
  const remembered = localStorage.getItem('et.lastGroup');
  const expenseGroups = (pid) => groupsOf(pid).filter((g) => g.kind === GroupKind.Expense && !isRepaymentGroup(g));
  const start = editing?.group ?? m().groups.get(groupId) ?? m().groups.get(remembered) ?? expenseGroups(projects[0]?.id)[0];
  if (!start) return toast('Make an expense group on the PC first.', true);

  pickedFiles = [];
  keptFiles = editing ? attachmentsOf(editing.id) : [];
  const value = (v) => esc(v ?? '');
  const groupOptions = (pid, selected) => expenseGroups(pid).map((g) => `<option value="${g.id}" ${g.id === selected ? 'selected' : ''}>${esc(g.name)}</option>`).join('');

  const sheet = openSheet(`<form data-form="expense" ${editing ? `data-entry="${editing.id}"` : ''}>
    <h2>${editing ? 'Edit expense' : 'New expense'}</h2><div class="subtitle" data-role="context"></div>
    <div class="two">
      <div class="field"><label>Project</label><select class="input" name="project">${projects.map((p) =>
        `<option value="${p.id}" ${p.id === start.projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Group</label><select class="input" name="group">${groupOptions(start.projectId, start.id)}</select></div>
    </div>
    <div class="field"><label>What was it?</label><input class="input" name="title" required autocomplete="off" placeholder="Weekly shop" value="${value(editing?.title)}"></div>
    <div class="two">
      <div class="field"><label>Amount</label><input class="input amount" name="amount" inputmode="decimal" required placeholder="0.00"
        value="${editing ? (editing.amount / 100).toFixed(2) : ''}"></div>
      <div class="field"><label>Date</label><input class="input" name="date" type="date" value="${editing ? dateValue(editing.occurredOn) : todayValue()}" required></div>
    </div>
    <div class="field"><label>Paid to <span class="opt">(optional)</span></label><input class="input" name="payee" autocomplete="off" value="${value(editing?.payee)}"></div>
    <div class="field"><label>Tags <span class="opt">(optional)</span></label><input class="input" name="tags" autocomplete="off" placeholder="food, coffee" value="${value(editing?.tags.join(', '))}"></div>
    <div class="field"><label>Note <span class="opt">(optional)</span></label><textarea class="input" name="note">${value(editing?.note)}</textarea></div>
    <div class="field"><label>Receipts <span class="opt">(optional)</span></label>
      <label class="pick">${icon('camera')}Take a photo or choose a file
        <input type="file" name="files" accept="image/*,application/pdf" multiple hidden></label>
      <div class="thumbs" data-role="thumbs"></div></div>
    <div class="actions"><button type="button" class="btn" data-act="close">Cancel</button><button class="btn primary" type="submit">${editing ? 'Save changes' : 'Add expense'}</button></div>
  </form>`);

  const form = sheet.querySelector('form');
  drawThumbs(sheet);
  const context = () => {
    const p = m().projects.get(form.project.value);
    sheet.querySelector('[data-role=context]').textContent = p ? `Comes off your ${CASH_NAME[p.currency]} cash.` : '';
  };
  context();
  form.project.addEventListener('change', () => {
    form.group.innerHTML = groupOptions(form.project.value, null);
    context();
  });
  form.files.addEventListener('change', async () => {
    for (const file of form.files.files) pickedFiles.push(file);
    form.files.value = '';
    drawThumbs(sheet);
  });
}

function drawThumbs(sheet) {
  const box = sheet.querySelector('[data-role=thumbs]');
  // Receipts already filed (when editing) first, then ones picked now.
  box.innerHTML = keptFiles.map((f, i) => `<div class="thumb" data-kept="${f.hash}"><span>${esc(f.fileName.split('.').pop().toUpperCase())}</span>
      <button type="button" data-act="unkeep" data-index="${i}" aria-label="Remove ${esc(f.fileName)}">${icon('close', 's14')}</button></div>`).join('')
    + pickedFiles.map((f, i) => `<div class="thumb" ${f.type.startsWith('image/') ? `style="background-image:url(${URL.createObjectURL(f)})"` : ''}>
    ${f.type.startsWith('image/') ? '' : esc(f.name.split('.').pop().toUpperCase())}
    <button type="button" data-act="unpick" data-index="${i}" aria-label="Remove">${icon('close', 's14')}</button></div>`).join('');

  // Filed receipts show their picture once the phone has it.
  for (const f of keptFiles.filter((x) => x.isImage)) {
    store.getFile(f.hash).then((blob) => {
      const el = box.querySelector(`[data-kept="${f.hash}"]`);
      if (blob && el) {
        el.style.backgroundImage = `url(${URL.createObjectURL(blob)})`;
        el.querySelector('span').textContent = '';
      }
    }).catch(() => {});
  }
}

async function submitExpense(form) {
  if (DEMO) pickedFiles = []; // nowhere to keep them
  const amount = parseAmount(form.amount.value);
  if (!form.title.value.trim()) return sheetProblem(form, 'Give the expense a name.');
  if (!(amount > 0)) return sheetProblem(form, 'The amount has to be a number more than zero.');
  if (!form.group.value) return sheetProblem(form, 'Pick a group for it.');

  const files = [];
  for (const file of pickedFiles) {
    const hash = await hashOf(file);
    await store.addFile(hash, file, file.type || 'application/octet-stream');
    files.push({ hash, fileName: file.name || `Photo ${todayValue()}.jpg`, mediaType: file.type || 'application/octet-stream', size: file.size, isImage: file.type.startsWith('image/') });
  }

  const group = m().groups.get(form.group.value);
  const editing = form.dataset.entry ? m().entryById.get(form.dataset.entry) : null;

  if (editing) {
    // An unchanged date keeps its time, so the entry does not jump around within its day.
    const occurredOn = form.date.value === dateValue(editing.occurredOn) ? editing.occurredOn : dayToMs(form.date.value);
    const kept = new Set(keptFiles.map((f) => f.id));
    await save(updateExpense(m(), editing, {
      groupId: group.id, title: form.title.value, amount, occurredOn,
      payee: form.payee.value, note: form.note.value, tags: form.tags.value, files,
      removeAttachments: attachmentsOf(editing.id).filter((a) => !kept.has(a.id)).map((a) => a.id),
    }), `Saved ${form.title.value.trim()}.`);
    return;
  }

  localStorage.setItem('et.lastGroup', form.group.value);
  await save(addExpense(m(), {
    groupId: group.id, title: form.title.value, amount, occurredOn: dayToMs(form.date.value),
    payee: form.payee.value, note: form.note.value, tags: form.tags.value, files,
  }), `Added ${money(Math.round(amount * 100), group.project.currency)} to ${group.name}.`);
}

function openMoneyIn() {
  openSheet(`<form data-form="moneyin">
    <h2>Money in</h2><div class="subtitle">Added to your cash and filed under money in.</div>
    <div class="field"><label>Currency</label><select class="input" name="currency">
      ${Currencies.map((c) => `<option value="${c}">${CODE[c]} · ${SYMBOL[c]}</option>`).join('')}</select></div>
    <div class="two">
      <div class="field"><label>Amount</label><input class="input amount" name="amount" inputmode="decimal" required placeholder="0.00"></div>
      <div class="field"><label>Date</label><input class="input" name="date" type="date" value="${todayValue()}" required></div>
    </div>
    <div class="field"><label>Where did it come from?</label><input class="input" name="description" required placeholder="Salary, October"></div>
    <div class="actions"><button type="button" class="btn" data-act="close">Cancel</button><button class="btn primary" type="submit">Add it</button></div>
  </form>`);
}

async function submitMoneyIn(form) {
  const amount = parseAmount(form.amount.value);
  if (!(amount > 0)) return sheetProblem(form, 'Money received has to be more than zero.');
  if (!form.description.value.trim()) return sheetProblem(form, 'Say what this was, so the history makes sense later.');
  const currency = Number(form.currency.value);
  await save(addMoneyIn({ currency, amount, description: form.description.value, occurredOn: dayToMs(form.date.value) }),
    `Added ${money(Math.round(amount * 100), currency)} to your ${CASH_NAME[currency]} cash.`);
}

function openRepay(loanId) {
  const loans = openLoans();
  if (!loans.length) return toast('No open loans to repay.', true);
  const start = loans.find((l) => l.id === loanId) ?? loans[0];
  const label = (l) => `${l.title} · ${l.counterparty} (${money(remaining(l), l.group.project.currency)} left)`;

  const sheet = openSheet(`<form data-form="repay">
    <h2>Record a repayment</h2><div class="subtitle" data-role="context"></div>
    <div class="field"><label>Loan</label><select class="input" name="loan">${loans.map((l) =>
      `<option value="${l.id}" ${l.id === start.id ? 'selected' : ''}>${esc(label(l))}</option>`).join('')}</select></div>
    <div class="two">
      <div class="field"><label>Amount</label><input class="input amount" name="amount" inputmode="decimal" required></div>
      <div class="field"><label>Date</label><input class="input" name="date" type="date" value="${todayValue()}" required></div>
    </div>
    <div class="field"><label>Note <span class="opt">(optional)</span></label><input class="input" name="note" placeholder="Bank transfer"></div>
    <div class="actions"><button type="button" class="btn" data-act="close">Cancel</button><button class="btn primary" type="submit">Record it</button></div>
  </form>`);

  const form = sheet.querySelector('form');
  const update = () => {
    const l = m().entryById.get(form.loan.value);
    const c = l.group.project.currency;
    form.amount.value = (remaining(l) / 100).toFixed(2);
    sheet.querySelector('[data-role=context]').textContent = l.direction === Direction.Borrowed
      ? `Paying back ${l.counterparty}. Comes off your ${CASH_NAME[c]} cash.`
      : `${l.counterparty} paying you back. Goes onto your ${CASH_NAME[c]} cash.`;
  };
  update();
  form.loan.addEventListener('change', update);
}

async function submitRepay(form) {
  const loan = m().entryById.get(form.loan.value);
  const amount = parseAmount(form.amount.value);
  if (!(amount > 0)) return sheetProblem(form, 'A repayment has to be more than zero.');
  await save(addRepayment(m(), { loan, amount, paidOn: dayToMs(form.date.value), note: form.note.value }),
    `Recorded ${money(Math.round(amount * 100), loan.group.project.currency)} against ${loan.title}.`);
}

/** A new loan, in a loans group: from the + sheet, a loans group, or a person (filled in with them). */
function openNewLoan(groupId, personId) {
  const loanGroups = (pid) => groupsOf(pid).filter((g) => g.kind === GroupKind.Loan);
  const projects = activeProjects().filter((p) => loanGroups(p.id).length);
  const start = m().groups.get(groupId) ?? m().groups.get(localStorage.getItem('et.lastLoanGroup')) ?? loanGroups(projects[0]?.id)[0];
  if (!start || start.kind !== GroupKind.Loan) return toast('Make a loans group on the PC first.', true);

  const person = personId ? m().people.get(personId) : null;
  const groupOptions = (pid, selected) => loanGroups(pid).map((g) => `<option value="${g.id}" ${g.id === selected ? 'selected' : ''}>${esc(g.name)}</option>`).join('');

  const sheet = openSheet(`<form data-form="newloan">
    <h2>New loan</h2><div class="subtitle" data-role="context"></div>
    <div class="field"><label>Which way?</label><select class="input" name="direction">
      <option value="${Direction.Borrowed}">I borrowed it: I owe them</option>
      <option value="${Direction.Lent}">I lent it: they owe me</option></select></div>
    <div class="field"><label>Who</label><input class="input" name="who" required autocomplete="off" list="people-names" placeholder="Name" value="${esc(person?.name ?? '')}">
      <datalist id="people-names">${[...m().people.values()].map((p) => `<option value="${esc(p.name)}">`).join('')}</datalist></div>
    <div class="two">
      <div class="field"><label>Project</label><select class="input" name="project">${projects.map((p) =>
        `<option value="${p.id}" ${p.id === start.projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Group</label><select class="input" name="group">${groupOptions(start.projectId, start.id)}</select></div>
    </div>
    <div class="field"><label>What for?</label><input class="input" name="title" required autocomplete="off" placeholder="Rent deposit"></div>
    <div class="two">
      <div class="field"><label>Amount</label><input class="input amount" name="amount" inputmode="decimal" required placeholder="0.00"></div>
      <div class="field"><label>Date</label><input class="input" name="date" type="date" value="${todayValue()}" required></div>
    </div>
    <div class="field"><label>Due <span class="opt">(optional)</span></label><input class="input" name="due" type="date"></div>
    <div class="field"><label class="weigh"><input type="checkbox" name="movesCash" checked> The money went through my cash</label></div>
    <div class="field"><label>Note <span class="opt">(optional)</span></label><textarea class="input" name="note"></textarea></div>
    <div class="actions"><button type="button" class="btn" data-act="close">Cancel</button><button class="btn primary" type="submit">Add loan</button></div>
  </form>`);

  const form = sheet.querySelector('form');
  const context = () => {
    const p = m().projects.get(form.project.value);
    const borrowed = Number(form.direction.value) === Direction.Borrowed;
    sheet.querySelector('[data-role=context]').textContent = !p ? ''
      : !form.movesCash.checked ? `Kept out of your ${CASH_NAME[p.currency]} cash: it was paid straight to someone else.`
      : borrowed ? `Adds to your ${CASH_NAME[p.currency]} cash: the money came to you.`
      : `Comes off your ${CASH_NAME[p.currency]} cash: the money went to them.`;
  };
  context();
  form.project.addEventListener('change', () => { form.group.innerHTML = groupOptions(form.project.value, null); context(); });
  form.direction.addEventListener('change', context);
  form.movesCash.addEventListener('change', context);
}

async function submitNewLoan(form) {
  const amount = parseAmount(form.amount.value);
  if (!form.who.value.trim()) return sheetProblem(form, 'Say who the loan is with.');
  if (!form.title.value.trim()) return sheetProblem(form, 'Say what the loan was for.');
  if (!(amount > 0)) return sheetProblem(form, 'The amount has to be a number more than zero.');
  if (!form.group.value) return sheetProblem(form, 'Pick a loans group for it.');
  if (form.due.value && form.due.value < form.date.value) return sheetProblem(form, 'The due date is before the loan was made.');

  const group = m().groups.get(form.group.value);
  const direction = Number(form.direction.value);
  localStorage.setItem('et.lastLoanGroup', group.id);
  await save(addLoan(m(), {
    groupId: group.id, title: form.title.value, counterparty: form.who.value, direction, amount,
    occurredOn: dayToMs(form.date.value), dueDate: form.due.value ? dayToMs(form.due.value) : null,
    note: form.note.value, movesCash: form.movesCash.checked,
  }), `${direction === Direction.Borrowed ? 'Borrowed' : 'Lent'} ${money(Math.round(amount * 100), group.project.currency)}: ${form.who.value.trim().split(/\s+/).join(' ')}.`);
}

async function openEntry(id) {
  const e = m().entryById.get(id);
  if (!e) return;
  const c = e.group.project.currency;
  const files = attachmentsOf(id);
  const sheet = openSheet(`<h2>${esc(e.title)}</h2>
    <div class="subtitle">${esc(e.group.name)} · ${dateFmt.format(new Date(e.occurredOn))}</div>
    <div>${moneyHtml(e.amount, c, 'big')}</div>
    ${e.payee ? `<div class="kv"><span>Paid to</span><span>${esc(e.payee)}</span></div>` : ''}
    ${e.tags.length ? `<div class="kv"><span>Tags</span><span class="tagline">${esc(e.tags.map((t) => `#${t}`).join(' '))}</span></div>` : ''}
    ${e.note ? `<p class="sec" style="white-space:pre-wrap">${esc(e.note)}</p>` : ''}
    <div data-role="files">${files.map((f) => `<div class="hint" data-hash="${f.hash}">${icon('clip', 's14')} ${esc(f.fileName)} · loading…</div>`).join('')}</div>
    ${e.loanPaymentId
      ? '<p class="hint">A loan repayment. It changes with its loan: open the loan to change or remove it.</p><div class="actions"><button class="btn" data-act="close">Close</button></div>'
      : `<div class="actions">
          <button class="btn danger" data-act="delete-entry" data-id="${e.id}">${icon('close')}Delete</button>
          <button class="btn primary" data-act="edit-entry" data-id="${e.id}">${icon('pencil')}Edit</button>
        </div>`}`);

  for (const f of files) {
    const slotEl = sheet.querySelector(`[data-hash="${f.hash}"]`);
    try {
      const blob = await store.getFile(f.hash);
      if (!blob) { slotEl.textContent = `${f.fileName}: not on the server yet. It uploads when the PC next syncs.`; continue; }
      const url = URL.createObjectURL(blob);
      slotEl.outerHTML = f.isImage
        ? `<img class="receipt" src="${url}" alt="${esc(f.fileName)}">`
        : `<a class="btn wide" style="margin-top:10px" href="${url}" target="_blank" rel="noopener">${icon('clip')}Open ${esc(f.fileName)}</a>`;
    } catch (err) {
      slotEl.textContent = `${f.fileName}: could not load (${err.message}).`;
    }
  }
}

function openLoan(id) {
  const l = m().entryById.get(id);
  if (!l) return;
  const c = l.group.project.currency;
  const settled = isSettled(l);
  openSheet(`<h2>${esc(l.title)}</h2>
    <div class="subtitle">${l.direction === Direction.Borrowed ? 'Borrowed from' : 'Lent to'} ${esc(l.counterparty)} · ${dateFmt.format(new Date(l.occurredOn))}</div>
    <div>${moneyHtml(remaining(l), c, 'big')} <span class="amt muted">left of ${esc(money(l.amount, c))}</span></div>
    ${bar(paidSoFar(l), l.amount)}
    ${l.dueDate ? `<div class="kv"><span>Due</span><span>${dateFmt.format(new Date(l.dueDate))}</span></div>` : ''}
    ${l.note ? `<p class="sec">${esc(l.note)}</p>` : ''}
    <div class="section" style="margin-left:0"><span>${l.payments.length === 1 ? '1 repayment' : `${l.payments.length} repayments`}</span></div>
    <div class="card list">${[...l.payments].sort((a, b) => b.paidOn - a.paidOn).map((p) => `
      <div class="row"><span class="main"><span class="title">${dateFmt.format(new Date(p.paidOn))}</span>${p.note ? `<span class="sub">${esc(p.note)}</span>` : ''}</span>
        <span class="end">${moneyHtml(p.amount, c, 'row-amt')}</span></div>`).join('') || '<div class="empty">None yet.</div>'}</div>
    <div class="actions"><button class="btn" data-act="close">Close</button>
      ${settled ? '' : `<button class="btn primary" data-act="repay" data-loan="${l.id}">Record repayment</button>`}</div>`);
}

function openPerson(id) {
  const ledger = peopleLedgers(m()).find((l) => l.person.id === id);
  if (!ledger) return;
  openSheet(`<h2>${esc(ledger.person.name)}</h2>
    ${ledger.person.note ? `<div class="subtitle">${esc(ledger.person.note)}</div>` : '<div class="subtitle">Every loan with them</div>'}
    <div class="card list">${ledger.loans.map((l) => {
      const c = l.group.project.currency;
      const borrowed = l.direction === Direction.Borrowed;
      return `<button class="row" data-act="loan" data-id="${l.id}">
        <span class="main"><span class="title">${esc(l.title)}</span><span class="sub">${esc(l.group.project.name)} · ${borrowed ? 'you owe' : 'owed to you'}${isSettled(l) ? ' · settled' : ''}</span></span>
        <span class="end">${moneyHtml(remaining(l), c, `row-amt ${isSettled(l) ? 'muted' : borrowed ? 'bor' : 'lent'}`)}</span>
      </button>`;
    }).join('')}</div>
    <div class="actions"><button class="btn" data-act="close">Close</button>
      <button class="btn primary" data-act="newloan" data-person="${ledger.person.id}">${icon('plus')}New loan</button></div>`);
}

// ---------- Shopping list ----------

const SHOP_CURRENCY = 'et.shopCurrency';

const LIST_NAME = ['Germany', 'Egypt'];

/** Which list is open: the euro one (Germany) or the pound one (Egypt), as last left. */
function shopCurrency() {
  try { return Number(localStorage.getItem(SHOP_CURRENCY) ?? 0) || 0; } catch { return 0; }
}

/** "Germany: 3 of 12 in the basket · Egypt: 8 items" for the home screen. */
function shoppingSummary() {
  const lists = [0, 1].map((c) => {
    const items = m().shopping.items.filter((i) => i.currency === c);
    if (!items.length) return null;
    const inBasket = items.filter((i) => i.current);
    return `${LIST_NAME[c]}: ${inBasket.length ? `${inBasket.length} of ${items.length} in the basket` : `${items.length} items`}`;
  }).filter(Boolean);
  return lists.length ? lists.join(' · ') : 'One list for Germany, one for Egypt';
}

function basketTotal(inBasket) {
  const sums = new Map();
  for (const i of inBasket) sums.set(i.current.currency, (sums.get(i.current.currency) ?? 0) + i.current.price);
  return [...sums].map(([c, cents]) => money(cents, c)).join(' + ') || money(0, shopCurrency());
}

/** "€2.49 · 500 g · €4.98/kg", for what is in the basket or was paid last time. */
function purchaseLine(p) {
  if (!p) return '';
  const kg = perKg(p);
  return [money(p.price, p.currency), p.grams ? `${p.grams} g` : null, kg ? `${money(kg, p.currency)}/kg` : null]
    .filter(Boolean).join(' · ');
}

function shoppingRow(item) {
  const inBasket = !!item.current;
  const sub = inBasket
    ? `${purchaseLine(item.current)}${item.current.note ? ` · ${item.current.note}` : ''}`
    : item.last ? `Last time ${purchaseLine(item.last)}` : (item.byWeight ? 'Sold by weight' : '');
  return `<div class="row shop ${inBasket ? 'done' : ''}">
    <span class="tick">${inBasket ? icon('check', 's14') : ''}</span>
    <button class="main bare" data-act="shop-item" data-id="${item.id}">
      <span class="title">${esc(item.name)}${item.byWeight ? ` ${icon('scale', 's14 muted')}` : ''}</span>
      ${sub ? `<span class="sub">${esc(sub)}</span>` : ''}
    </button>
    ${inBasket
      ? `<button class="btn small" data-act="shop-undo" data-id="${item.id}">Undo</button>`
      : `<button class="btn small primary" data-act="shop-buy" data-id="${item.id}">Bought</button>`}
  </div>`;
}

function renderShopping() {
  const currency = shopCurrency();
  const items = m().shopping.items.filter((i) => i.currency === currency);
  const toBuy = items.filter((i) => !i.current);
  const inBasket = items.filter((i) => i.current);

  frame(`Shopping · ${LIST_NAME[currency]}`, `
    <section class="card pad">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
        <div>
          <div class="sec" style="font-size:13px">In the basket${items.length ? `, ${inBasket.length} of ${items.length}` : ''}</div>
          <div class="amt mid">${esc(basketTotal(inBasket))}</div>
        </div>
        <div class="seg" role="group" aria-label="Which list">
          ${[0, 1].map((c) => `<button class="${c === currency ? 'on' : ''}" data-act="shop-currency" data-currency="${c}"
            aria-label="${LIST_NAME[c]} list">${LIST_NAME[c]} ${SYMBOL[c]}</button>`).join('')}
        </div>
      </div>
    </section>

    <form class="card pad addrow" data-form="shop-add" style="margin-top:12px">
      <input class="input" name="name" placeholder="Add an item" autocomplete="off" required>
      <label class="weigh"><input type="checkbox" name="byWeight"> By weight</label>
      <button class="btn primary" type="submit" aria-label="Add">${icon('plus')}</button>
    </form>

    ${toBuy.length ? `<div class="section"><span>To buy</span><span>${toBuy.length}</span></div>
      <div class="card list">${toBuy.map(shoppingRow).join('')}</div>` : ''}
    ${inBasket.length ? `<div class="section"><span>In the basket</span><span>${inBasket.length}</span></div>
      <div class="card list">${inBasket.map(shoppingRow).join('')}</div>
      <button class="btn wide" style="margin-top:14px" data-act="shop-next">${icon('refresh')}Start the next trip</button>
      <p class="hint" style="margin:8px 4px 0">Empties the basket. Each item keeps what you paid, to show next time.</p>` : ''}
    ${items.length ? '' : `<div class="empty">Add the things you usually buy in ${LIST_NAME[currency]}, priced in ${SYMBOL[currency]}. Tick "By weight" for fruit, vegetables, cheese: those ask for grams too, and show the price per kg.</div>`}
  `, { back: '#/' });
}

function openBuy(id) {
  const item = m().shopping.items.find((i) => i.id === id);
  if (!item) return;
  const currency = item.currency;
  const sheet = openSheet(`<form data-form="shop-buy" data-id="${item.id}">
    <h2>${esc(item.name)}</h2>
    <div class="subtitle">${item.last ? `Last time ${esc(purchaseLine(item.last))}` : 'Into the basket'}</div>
    <div class="${item.byWeight ? 'two' : ''}">
      <div class="field"><label>Price (${SYMBOL[currency]})</label>
        <input class="input amount" name="price" inputmode="decimal" required placeholder="${item.last ? (item.last.price / 100).toFixed(2) : '0.00'}"></div>
      ${item.byWeight ? `<div class="field"><label>Weight (grams)</label>
        <input class="input amount" name="grams" inputmode="numeric" placeholder="${item.last?.grams ?? 500}"></div>` : ''}
    </div>
    ${item.byWeight ? '<p class="hint" data-role="perkg" style="margin-top:-6px">&nbsp;</p>' : ''}
    <div class="field"><label>Note <span class="opt">(optional)</span></label>
      <input class="input" name="note" autocomplete="off" placeholder="${item.byWeight ? 'Loose, on offer, organic…' : 'Brand, size, on offer…'}"></div>
    <div class="actions"><button type="button" class="btn" data-act="close">Cancel</button><button class="btn primary" type="submit">In the basket</button></div>
  </form>`);

  const form = sheet.querySelector('form');
  if (item.byWeight) {
    const show = () => {
      const price = Math.round(parseAmount(form.price.value) * 100);
      const grams = Number(form.grams.value);
      sheet.querySelector('[data-role=perkg]').textContent =
        price > 0 && grams > 0 ? `${money(Math.round((price * 1000) / grams), currency)} per kg` : '\u00a0';
    };
    form.price.addEventListener('input', show);
    form.grams.addEventListener('input', show);
  }
  form.price.focus();
}

async function submitBuy(form) {
  const item = m().shopping.items.find((i) => i.id === form.dataset.id);
  const price = parseAmount(form.price.value);
  if (!(price >= 0) || form.price.value.trim() === '') return sheetProblem(form, 'Type what it cost.');
  const grams = form.grams ? Number(form.grams.value) : null;
  if (form.grams && form.grams.value.trim() && !(grams > 0)) return sheetProblem(form, 'The weight has to be a number of grams.');
  await save(buyShoppingItem(item, { price, grams, note: form.note.value }),
    `${item.name} is in the basket.`);
}

function openShoppingItem(id) {
  const item = m().shopping.items.find((i) => i.id === id);
  if (!item) return;
  openSheet(`<form data-form="shop-edit" data-id="${item.id}">
    <h2>${esc(item.name)}</h2><div class="subtitle">${item.history.length === 1 ? 'Bought once' : `Bought ${item.history.length} times`}</div>
    <div class="field"><label>Name</label><input class="input" name="name" required value="${esc(item.name)}"></div>
    <label class="weigh" style="margin-bottom:14px"><input type="checkbox" name="byWeight" ${item.byWeight ? 'checked' : ''}> Sold by weight: ask for grams, show price per kg</label>
    ${item.history.length ? `<div class="flabel">What it cost</div><div class="card list">${item.history.map((p) => `
      <div class="row"><span class="main"><span class="title">${esc(purchaseLine(p))}</span>
        <span class="sub">${dateFmt.format(new Date(p.boughtAt))}${p.note ? ` · ${esc(p.note)}` : ''}</span></span></div>`).join('')}</div>` : ''}
    <div class="actions">
      <button type="button" class="btn danger" data-act="shop-delete" data-id="${item.id}">${icon('close')}Remove</button>
      <button class="btn primary" type="submit">Save</button>
    </div>
  </form>`);
}

// ---------- Apple Pay shortcut ----------

const CAPTURE_KEY = 'et.captureKey';

function copyRow(label, value, act) {
  return `<div class="field" style="margin-top:14px"><label>${esc(label)}</label>
    <div style="display:flex;gap:8px">
      <input class="input" readonly value="${esc(value)}" style="font-family:var(--mono);font-size:13px">
      <button class="btn" data-act="${act}" style="flex:none">Copy</button>
    </div></div>`;
}

function renderShortcut() {
  let key = null;
  try { key = localStorage.getItem(CAPTURE_KEY); } catch { /* private mode */ }
  const step = (n, html) => `<li style="margin-bottom:12px">${html}</li>`;
  const b = (t) => `<b>${esc(t)}</b>`;

  frame('Apple Pay shortcut', `
    <section class="card pad">
      <p style="margin-top:0">Pay with Apple Pay, and a list of your groups pops up straight away. Tap one and the payment is filed there, with the shop as its name. It reaches the PC on its next sync.</p>
      <p class="hint" style="margin-bottom:0">Only payments made with a card in Wallet trigger it. The usual group for a shop comes first.</p>
    </section>

    <div class="section"><span>1 · Your capture key</span></div>
    <section class="card pad">
      ${key
        ? `${copyRow('Capture key', key, 'copy-key')}
           <p class="hint">Like a password for this one job: it can add expenses and read your group names, nothing else. Making a new key stops the old one working.</p>
           <button class="btn wide" data-act="new-key">${icon('refresh')}Make a new key</button>`
        : `<p class="hint" style="margin-top:0">The shortcut uses it instead of your password.</p>
           <button class="btn primary wide" data-act="new-key">${icon('key')}Make a capture key</button>`}
      ${copyRow('Address', api.CAPTURE_URL, 'copy-url')}
    </section>

    <div class="section"><span>2 · Make the automation</span></div>
    <section class="card pad"><ol style="margin:0;padding-left:20px;line-height:1.5">
      ${step(1, `Open ${b('Shortcuts')} → ${b('Automation')} → ${b('+')} → ${b('Wallet')} (older iOS: ${b('Transaction')}). Pick the cards to watch and leave the categories and merchants on ${b('Any')}. Choose ${b('Run Immediately')}, then ${b('Next')} → ${b('New Blank Automation')}.`)}
      ${step(2, `Add ${b('Get Contents of URL')}. Paste the ${b('Address')}. Tap the arrow to show more: ${b('Method')} ${b('POST')}, ${b('Request Body')} ${b('JSON')}, and add three Text fields:
        <br>${b('key')} = paste your capture key
        <br>${b('amount')} = ${b('Shortcut Input')} → ${b('Amount')}
        <br>${b('merchant')} = ${b('Shortcut Input')} → ${b('Merchant')}`)}
      ${step(3, `Add ${b('Split Text')}, split ${b('Contents of URL')} by ${b('New Lines')}.`)}
      ${step(4, `Add ${b('Choose from List')} on the split text. Set its prompt to "Which group?" and leave ${b('Select Multiple')} off.`)}
      ${step(5, `Add another ${b('Get Contents of URL')}, set up exactly like step 2, with two more Text fields:
        <br>${b('choice')} = ${b('Selected Item')} from Choose from List (older iOS: ${b('Chosen Item')})
        <br>${b('card')} = ${b('Shortcut Input')} → ${b('Card or Pass')}`)}
      ${step(6, `Add ${b('Show Notification')} with the ${b('Contents of URL')} from step 5. It says what was filed.`)}
    </ol>
    <p class="hint" style="margin-bottom:0">Dismissing the list files nothing. If a payment does not show up, the notification says why.</p></section>`, { back: '#/' });
}

async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied.`);
  } catch {
    toast(`Could not copy. Press and hold the ${what.toLowerCase()} to copy it.`, true);
  }
}

function openAccount() {
  openSheet(`<h2>Sync</h2>
    <div class="subtitle">Signed in as ${esc(api.userEmail())}</div>
    ${state.syncError ? `<div class="problem">${esc(state.syncError)}</div>` : ''}
    <div class="kv"><span>Last sync</span><span>${esc(ago(state.lastSync))}</span></div>
    <div class="kv"><span>Waiting to be sent</span><span>${state.pending ? `${state.pending} changes` : 'Nothing'}</span></div>
    <p class="hint">It syncs when the app opens, after you add something, and every minute while it is open. The PC syncs on its own, too.</p>
    <div class="card list" style="margin-top:14px">
      <button class="row" data-go="#/shortcut"><span class="glyph">${icon('key')}</span>
        <span class="main"><span class="title">Apple Pay shortcut</span><span class="sub">File a payment the moment you pay</span></span>
        ${icon('chev', 'chev s14')}</button>
    </div>
    <div class="actions">
      <button class="btn danger" data-act="signout">${icon('signout')}Sign out</button>
      <button class="btn primary" data-act="syncnow">${icon('refresh')}Sync now</button>
    </div>`);
}

// ---------- Events ----------

document.addEventListener('click', async (event) => {
  const go = event.target.closest('[data-go]');
  if (go) { closeSheet(); location.hash = go.dataset.go; return; }

  const el = event.target.closest('[data-act]');
  if (!el) return;
  const { act } = el.dataset;
  const handlers = {
    add: openAdd,
    close: closeSheet,
    expense: () => openExpense(el.dataset.group),
    moneyin: openMoneyIn,
    repay: () => openRepay(el.dataset.loan),
    newloan: () => openNewLoan(el.dataset.group, el.dataset.person),
    entry: () => openEntry(el.dataset.id),
    loan: () => openLoan(el.dataset.id),
    person: () => openPerson(el.dataset.id),
    account: openAccount,
    forgot: () => renderForgot(),
    tosignin: () => renderSignIn(),
    syncnow: async () => { closeSheet(); await syncNow(); },
    unpick: () => { pickedFiles.splice(Number(el.dataset.index), 1); drawThumbs(el.closest('.sheet')); },
    unkeep: () => { keptFiles.splice(Number(el.dataset.index), 1); drawThumbs(el.closest('.sheet')); },
    'edit-entry': () => openExpense(null, el.dataset.id),
    'shop-buy': () => openBuy(el.dataset.id),
    'shop-item': () => openShoppingItem(el.dataset.id),
    'shop-undo': async () => {
      const item = m().shopping.items.find((i) => i.id === el.dataset.id);
      if (item) await save(unbuyShoppingItem(item), `${item.name} is back on the list.`);
    },
    'shop-next': async () => {
      if (!confirm('Start the next trip? The basket empties; what you paid is kept as each item\'s last price.')) return;
      await save(startNextTrip(m(), shopCurrency()), `Ready for the next trip in ${LIST_NAME[shopCurrency()]}.`);
    },
    'shop-delete': async () => {
      const item = m().shopping.items.find((i) => i.id === el.dataset.id);
      if (item && confirm(`Remove ${item.name} from the list, with its price history?`)) {
        await save(deleteShoppingItem(item), `Removed ${item.name}.`);
      }
    },
    'shop-currency': () => {
      try { localStorage.setItem(SHOP_CURRENCY, el.dataset.currency); } catch { /* private mode */ }
      render();
    },
    'copy-key': () => copy(localStorage.getItem(CAPTURE_KEY) ?? '', 'Capture key'),
    'copy-url': () => copy(api.CAPTURE_URL, 'Address'),
    'new-key': async () => {
      let had = null;
      try { had = localStorage.getItem(CAPTURE_KEY); } catch { /* private mode */ }
      if (had && !confirm('Make a new key? The shortcut stops working until you paste the new one into it.')) return;
      if (DEMO) return toast('Not in the demo.', true);
      try {
        const key = await api.createCaptureKey();
        localStorage.setItem(CAPTURE_KEY, key);
        render();
        toast('Capture key made. Copy it into the shortcut.');
      } catch (e) {
        toast(`Could not make a key: ${e.message}`, true);
      }
    },
    'delete-entry': async () => {
      const entry = m().entryById.get(el.dataset.id);
      if (!entry || !confirm(`Delete ${entry.title}? Its receipts go with it, on the PC too.`)) return;
      await save(deleteExpense(m(), entry), `Deleted ${entry.title}.`);
    },
    signout: async () => {
      if (state.pending && !confirm(`${state.pending} changes have not been sent yet and will be lost. Sign out anyway?`)) return;
      closeSheet();
      await api.signOut();
      await store.forgetEverything();
      state.model = null;
      render();
    },
  };
  await handlers[act]?.();
});

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();
  const button = form.querySelector('[type=submit]');
  button.disabled = true;
  try {
    if (form.dataset.form === 'signin') {
      try {
        await api.signIn(form.email.value, form.password.value);
      } catch (e) {
        return renderSignIn(e.message);
      }
      await store.useAccount(api.userId());
      await reload();
      await syncNow({ quiet: true });
      if (state.syncError) toast(`Could not sync: ${state.syncError}`, true);
      return;
    }
    if (form.dataset.form === 'forgot') {
      try {
        await api.requestPasswordReset(form.email.value);
        renderForgot(`If ${form.email.value.trim()} has an account, a link is on its way. Check your inbox, and your spam folder.`);
      } catch (e) {
        renderForgot('', e.message);
      }
      return;
    }
    if (form.dataset.form === 'newpassword') {
      if (form.password.value !== form.again.value) return renderNewPassword('The two passwords are not the same.');
      try {
        await api.setPassword(form.password.value);
      } catch (e) {
        return renderNewPassword(e.message);
      }
      await store.useAccount(api.userId());
      await reload();
      toast('Password changed. You are signed in.');
      syncNow({ quiet: true });
      return;
    }
    if (form.dataset.form === 'shop-add') {
      const name = form.name.value.trim();
      if (!name) return;
      await save(addShoppingItem(m(), { name, byWeight: form.byWeight.checked, currency: shopCurrency() }),
        `Added ${name} to the ${LIST_NAME[shopCurrency()]} list.`);
      document.querySelector('form[data-form=shop-add] input[name=name]')?.focus();
      return;
    }
    if (form.dataset.form === 'shop-buy') return await submitBuy(form);
    if (form.dataset.form === 'shop-edit') {
      const item = m().shopping.items.find((i) => i.id === form.dataset.id);
      if (!form.name.value.trim()) return sheetProblem(form, 'Give it a name.');
      await save(updateShoppingItem(item, { name: form.name.value, byWeight: form.byWeight.checked }), 'Saved.');
      return;
    }
    if (form.dataset.form === 'expense') await submitExpense(form);
    if (form.dataset.form === 'moneyin') await submitMoneyIn(form);
    if (form.dataset.form === 'repay') await submitRepay(form);
    if (form.dataset.form === 'newloan') await submitNewLoan(form);
  } catch (e) {
    sheetProblem(form, `Could not save that: ${e.message}`);
  } finally {
    if (button.isConnected) button.disabled = false;
  }
});

window.addEventListener('hashchange', () => { closeSheet(); render(); window.scrollTo(0, 0); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow({ quiet: true }); });
window.addEventListener('online', () => syncNow({ quiet: true }));
setInterval(() => { if (document.visibilityState === 'visible') syncNow({ quiet: true }); }, 60_000);

// ---------- Start ----------

(async () => {
  if (DEMO) {
    demoRows = (await (await fetch('test/fixture.json')).json()).rows;
    state.lastSync = new Date().toISOString();
    return reload();
  }
  if ('serviceWorker' in navigator) {
    // A new version took over while the app was open: reload once so every file is the new one.
    const hadWorker = Boolean(navigator.serviceWorker.controller);
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadWorker && !reloaded) { reloaded = true; location.reload(); }
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
  }

  // Arriving from a password reset email: signed in by the link, now choose the password.
  const recovery = api.acceptRecoveryLink(location.hash);
  if (recovery) {
    history.replaceState(null, '', location.pathname);
    if (recovery.error) return renderForgot('', `That link did not work: ${recovery.error}. Ask for a new one.`);
    return renderNewPassword();
  }

  if (!api.isSignedIn()) return renderSignIn();
  await store.useAccount(api.userId());
  await reload();
  syncNow({ quiet: true });
})();
