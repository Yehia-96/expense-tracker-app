// The money rules, ported from the desktop app (BalanceService, EntryService.GetGroupTotalsAsync,
// BudgetWindow, PersonLedger). Pure functions over the synced rows, so they run the same in the
// browser and under `node --test`, where test/calc.test.mjs checks them against figures the
// desktop app computed from the same rows (test/fixture.json). Amounts are whole cents.

export const Currency = Object.freeze({ EUR: 0, EGP: 1 });
export const Currencies = [Currency.EUR, Currency.EGP];
export const SYMBOL = ['€', 'E£'];

/** "€1,240.50", "−E£800.00": the desktop's CurrencyInfo.Format. */
export function money(cents, currency) {
  const sign = cents < 0 ? '−' : '';
  const text = (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}${SYMBOL[currency] ?? ''}${text}`;
}
export const GroupKind = Object.freeze({ Expense: 0, Loan: 1, Conversion: 2 });
export const Direction = Object.freeze({ Borrowed: 0, Lent: 1 });
export const Period = Object.freeze({ Total: 0, Week: 1, Month: 2, Year: 3 });

const TICKS_AT_UNIX_EPOCH = 621355968000000000n;

/** .NET ticks (a number, or a string when too large for one) to epoch milliseconds. */
export function ticksToMs(value) {
  if (value === null || value === undefined) return null;
  return Number((BigInt(value) - TICKS_AT_UNIX_EPOCH) / 10000n);
}

/** Epoch milliseconds to .NET ticks, as a string so no precision is lost on the way. */
export function msToTicks(ms) {
  return (BigInt(Math.round(ms)) * 10000n + TICKS_AT_UNIX_EPOCH).toString();
}

const bool = (v) => v === 1 || v === true || v === '1';
const cents = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * Turns synced rows ({ tbl, id, data }) into plain objects with their links resolved.
 * Rows of unknown tables are ignored; deleted rows must already be filtered out.
 */
export function buildModel(rows) {
  const by = (tbl) => rows.filter((r) => r.tbl === tbl && r.data).map((r) => r.data);

  const projects = new Map(by('Projects').map((p) => [p.Id, {
    id: p.Id, name: p.Name, currency: Number(p.Currency), colorHex: p.ColorHex,
    archived: bool(p.IsArchived), sortOrder: Number(p.SortOrder ?? 0), description: p.Description,
  }]));

  const groups = new Map(by('Groups').map((g) => [g.Id, {
    id: g.Id, projectId: g.ProjectId, project: projects.get(g.ProjectId) ?? null, name: g.Name,
    kind: Number(g.Kind), colorHex: g.ColorHex, budget: cents(g.Budget), period: Number(g.BudgetPeriod ?? 0),
    subBudget: cents(g.SubBudget), subPeriod: Number(g.SubBudgetPeriod ?? 0),
    sortOrder: Number(g.SortOrder ?? 0), archived: bool(g.IsArchived), raw: g,
  }]));

  const people = new Map(by('People').map((p) => [p.Id, { id: p.Id, name: p.Name, note: p.Note }]));

  const entries = by('Entries').map((e) => ({
    id: e.Id, type: e.EntryType, groupId: e.GroupId, group: groups.get(e.GroupId) ?? null,
    title: e.Title, note: e.Note, amount: cents(e.Amount), occurredOn: ticksToMs(e.OccurredOn),
    payee: e.Payee, loanPaymentId: e.LoanPaymentId ?? null,
    exchangedAmount: cents(e.ExchangedAmount),
    exchangedCurrency: e.ExchangedCurrency === null || e.ExchangedCurrency === undefined ? null : Number(e.ExchangedCurrency),
    quotedRate: e.QuotedRate === null || e.QuotedRate === undefined ? null : Number(e.QuotedRate) / 1_000_000,
    // Loans only
    counterparty: e.Counterparty, direction: e.Direction === null || e.Direction === undefined ? null : Number(e.Direction),
    dueDate: ticksToMs(e.DueDate), isClosed: bool(e.IsClosed), movesCash: bool(e.MovesCash),
    personId: e.PersonId ?? null, payments: [],
    raw: e, // the row as stored, so an edit can keep every column it does not touch
  }));

  const entryById = new Map(entries.map((e) => [e.id, e]));
  const payments = by('LoanPayments').map((p) => ({
    id: p.Id, loanId: p.LoanEntryId, loan: entryById.get(p.LoanEntryId) ?? null,
    amount: cents(p.Amount), paidOn: ticksToMs(p.PaidOn), note: p.Note, raw: p,
  }));
  for (const p of payments) p.loan?.payments.push(p);

  const tags = new Map(by('Tags').map((t) => [t.Id, t.Name]));
  const tagRows = by('Tags');
  const entryTagRows = by('EntryTags');
  const tagsByEntry = new Map();
  for (const et of entryTagRows) {
    const name = tags.get(et.TagId);
    if (!name) continue;
    if (!tagsByEntry.has(et.EntryId)) tagsByEntry.set(et.EntryId, []);
    tagsByEntry.get(et.EntryId).push(name);
  }

  const attachments = by('Attachments').map((a) => ({
    id: a.Id, entryId: a.EntryId, fileName: a.FileName, hash: a.ContentHash, mediaType: a.MediaType,
    size: Number(a.SizeBytes ?? 0), isImage: bool(a.IsImage), addedAt: ticksToMs(a.AddedAt),
  }));

  const transactions = by('CashTransactions').map((t) => ({
    id: t.Id, currency: Number(t.Currency), amount: cents(t.Amount), description: t.Description,
    occurredOn: ticksToMs(t.OccurredOn), createdAt: ticksToMs(t.CreatedAt), kind: Number(t.Kind), raw: t,
  }));

  const expenses = entries.filter((e) => e.type === 'Expense');
  const loans = entries.filter((e) => e.type === 'Loan');
  for (const e of entries) e.tags = tagsByEntry.get(e.id) ?? [];

  return {
    projects, groups, people, entries, entryById, expenses, loans, payments, transactions, attachments,
    rawTags: tagRows, entryTagRows, shopping: shoppingList(rows), salary: salaryModel(rows),
  };
}

/**
 * The shopping list (phone only: the desktop has no such tables and skips these rows when it
 * syncs). Each item knows what is in the basket now and what it cost the times before.
 */
function shoppingList(rows) {
  const purchases = rows.filter((r) => r.tbl === 'ShoppingPurchases' && r.data).map((r) => ({
    id: r.data.Id, itemId: r.data.ItemId, price: Number(r.data.Price), currency: Number(r.data.Currency),
    grams: r.data.Grams === null || r.data.Grams === undefined ? null : Number(r.data.Grams),
    note: r.data.Note, boughtAt: Number(r.data.BoughtAt), raw: r.data,
  }));

  const items = rows.filter((r) => r.tbl === 'ShoppingItems' && r.data).map((r) => {
    const d = r.data;
    const history = purchases.filter((p) => p.itemId === d.Id).sort((a, b) => b.boughtAt - a.boughtAt);
    const current = history.find((p) => p.id === d.CurrentPurchaseId) ?? null;
    return {
      id: d.Id, name: d.Name, byWeight: bool(d.ByWeight), position: Number(d.Position ?? 0),
      // Which list: the euro one (Germany) or the pound one (Egypt). Items from before there
      // were two lists have no currency and belong to the euro one.
      currency: d.Currency === null || d.Currency === undefined ? Currency.EUR : Number(d.Currency),
      current, last: history.find((p) => p !== current) ?? null, history, raw: d,
    };
  }).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));

  return { items, purchases };
}

// ---------- Salary (phone only; each payment also files money in, which the desktop sees) ----------

/** "2026-10": the month a salary is for, by the phone's own calendar. */
export function monthKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function salaryModel(rows) {
  const payments = rows.filter((r) => r.tbl === 'SalaryPayments' && r.data).map((r) => ({
    id: r.data.Id, jobId: r.data.JobId, month: r.data.Month, amount: Number(r.data.Amount),
    hours: r.data.Hours === null || r.data.Hours === undefined ? null : Number(r.data.Hours),
    cashId: r.data.CashTransactionId, paidOn: Number(r.data.PaidOn), raw: r.data,
  }));

  const jobs = rows.filter((r) => r.tbl === 'SalaryJobs' && r.data).map((r) => {
    const d = r.data;
    return {
      id: d.Id, name: d.Name, currency: Number(d.Currency ?? Currency.EUR), payday: Number(d.Payday ?? 1),
      tracksHours: bool(d.TracksHours), position: Number(d.Position ?? 0), raw: d,
      payments: payments.filter((p) => p.jobId === d.Id).sort((a, b) => b.month.localeCompare(a.month)),
    };
  }).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));

  return { jobs, payments };
}

/** The jobs whose payday this month has come and that have no salary filed for it yet. */
export function salaryDue(model, now = Date.now()) {
  const d = new Date(now);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const month = monthKey(now);
  return model.salary.jobs.filter((j) => d.getDate() >= Math.min(j.payday, lastDay) && !j.payments.some((p) => p.month === month));
}

/** The salary before `month`: what a new one is compared with. */
export const previousSalary = (job, month) => job.payments.find((p) => p.month < month) ?? null;

/** How a salary compares with the one before: { diff, percent }, or null the first month. */
export function salaryChange(previous, amount) {
  if (!previous) return null;
  const diff = amount - previous.amount;
  return { diff, percent: previous.amount ? (diff / previous.amount) * 100 : null };
}

/** Cents per kilogram, for things sold by weight. */
export const perKg = (purchase) =>
  purchase?.grams > 0 ? Math.round((purchase.price * 1000) / purchase.grams) : null;

const currencyOf = (entry) => entry?.group?.project?.currency ?? null;

export const paidSoFar = (loan) => loan.payments.reduce((s, p) => s + p.amount, 0);
export const remaining = (loan) => Math.max(0, loan.amount - paidSoFar(loan));
export const isSettled = (loan) => loan.isClosed || remaining(loan) <= 0;

/** BalanceService.GetAllNetPositionsAsync, one currency. */
export function netPosition(model, currency) {
  const sum = (items, f) => items.reduce((s, x) => s + f(x), 0);

  const outgoing = model.expenses.filter((e) => e.loanPaymentId === null && currencyOf(e) === currency);
  const spentOnExpenses = sum(outgoing.filter((e) => e.group.kind !== GroupKind.Conversion), (e) => e.amount);
  const convertedOut = sum(outgoing.filter((e) => e.group.kind === GroupKind.Conversion), (e) => e.amount);

  const repaymentsHere = model.payments.filter((p) => p.loan && currencyOf(p.loan) === currency);
  const repaymentsMade = sum(repaymentsHere.filter((p) => p.loan.direction === Direction.Borrowed), (p) => p.amount);
  const repaymentsReceived = sum(repaymentsHere.filter((p) => p.loan.direction === Direction.Lent), (p) => p.amount);

  const convertedIn = sum(model.expenses.filter((e) =>
    e.group?.kind === GroupKind.Conversion && e.exchangedAmount !== null && e.exchangedCurrency === currency), (e) => e.exchangedAmount);

  const loansHere = model.loans.filter((l) => currencyOf(l) === currency);
  const moved = loansHere.filter((l) => l.movesCash);
  const loansTaken = sum(moved.filter((l) => l.direction === Direction.Borrowed), (l) => l.amount);
  const loansGiven = sum(moved.filter((l) => l.direction === Direction.Lent), (l) => l.amount);

  const open = loansHere.filter((l) => !l.isClosed);
  const outstandingBorrowed = sum(open.filter((l) => l.direction === Direction.Borrowed), remaining);
  const outstandingLent = sum(open.filter((l) => l.direction === Direction.Lent), remaining);

  const ledger = model.transactions.filter((t) => t.currency === currency);
  const received = sum(ledger, (t) => t.amount);

  const totalIn = received + repaymentsReceived + convertedIn + loansTaken;
  const totalOut = spentOnExpenses + repaymentsMade + loansGiven + convertedOut;
  const cashOnHand = totalIn - totalOut;

  return {
    currency, received, spentOnExpenses, repaymentsMade, repaymentsReceived, convertedIn, convertedOut,
    loansTaken, loansGiven, outstandingBorrowed, outstandingLent,
    cashOnHand, spentSoFar: totalOut - convertedOut, net: cashOnHand - outstandingBorrowed,
    netIncludingLent: cashOnHand - outstandingBorrowed + outstandingLent,
    cashUpdatedAt: ledger.length ? Math.max(...ledger.map((t) => t.createdAt)) : null,
  };
}

/**
 * BudgetWindow.Current: the [start, end) a period covers around a moment, worked out on the
 * calendar of the given UTC offset (the device's own by default). Weeks start on Monday.
 */
export function budgetWindow(period, atMs, offsetMinutes = -new Date(atMs).getTimezoneOffset()) {
  if (period === Period.Total) return null;
  const shift = offsetMinutes * 60000;
  const wall = new Date(atMs + shift); // read with UTC getters: the wall clock at that offset
  const y = wall.getUTCFullYear(); const m = wall.getUTCMonth(); const d = wall.getUTCDate();
  const at = (yy, mm, dd) => Date.UTC(yy, mm, dd) - shift;

  if (period === Period.Week) {
    const sinceMonday = (wall.getUTCDay() + 6) % 7;
    const start = at(y, m, d - sinceMonday);
    return { start, end: at(y, m, d - sinceMonday + 7) };
  }
  if (period === Period.Month) return { start: at(y, m, 1), end: at(y, m + 1, 1) };
  if (period === Period.Year) return { start: at(y, 0, 1), end: at(y + 1, 0, 1) };
  return null;
}

/** EntryService.GetGroupTotalsAsync, for one group. */
export function groupTotals(model, group, atMs = Date.now(), offsetMinutes) {
  const inGroup = model.entries.filter((e) => e.groupId === group.id);
  const total = inGroup.reduce((s, e) => s + e.amount, 0);
  const window = budgetWindow(group.period, atMs, offsetMinutes);
  const spentInPeriod = window
    ? inGroup.filter((e) => e.occurredOn >= window.start && e.occurredOn < window.end).reduce((s, e) => s + e.amount, 0)
    : 0;
  return {
    total, entryCount: inGroup.length, spentInPeriod, window,
    measuredSpend: group.period !== Period.Total ? spentInPeriod : total,
    firstOn: inGroup.length ? Math.min(...inGroup.map((e) => e.occurredOn)) : null,
  };
}

/** PeopleService.GetLedgersAsync: each person with their loans, totals per currency. */
export function peopleLedgers(model) {
  return [...model.people.values()]
    .map((person) => {
      const loans = model.loans.filter((l) => l.personId === person.id).sort((a, b) => b.occurredOn - a.occurredOn);
      const owed = (direction, currency) => loans
        .filter((l) => l.direction === direction && !isSettled(l) && currencyOf(l) === currency)
        .reduce((s, l) => s + remaining(l), 0);
      return {
        person, loans,
        openCount: loans.filter((l) => !isSettled(l)).length,
        youOwe: (c) => owed(Direction.Borrowed, c),
        owedToYou: (c) => owed(Direction.Lent, c),
      };
    })
    .sort((a, b) => a.person.name.localeCompare(b.person.name, undefined, { sensitivity: 'base' }));
}
