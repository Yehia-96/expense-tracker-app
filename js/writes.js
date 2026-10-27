// Rows the phone creates, written exactly as the desktop stores them: every column present,
// ids as upper-case GUIDs, money in cents, dates as .NET ticks (strings), flags as 0/1.
// test/writes.test.mjs checks the column sets against rows the desktop wrote.
import { msToTicks, GroupKind, Direction, money, remaining, previousSalary, salaryChange } from './calc.js';

export const LOAN_PAYMENT_GROUP = Object.freeze({ name: 'Loan payments', icon: 'Receipt', colorHex: '#F0A868' });

export const newId = () => crypto.randomUUID().toUpperCase();
export const toCents = (amount) => Math.round(Number(amount) * 100);

const nowTicks = () => msToTicks(Date.now());

/** Splits "food, coffee #treat" into tag names the way the desktop does: lower case, no '#'. */
export function parseTags(text) {
  return [...new Set((text || '').split(/[\s,;]+/).map((t) => t.replace(/^#+/, '').toLowerCase()).filter(Boolean))];
}

function expenseRow({ id, groupId, title, amountCents, occurredOn, payee, note, loanPaymentId = null }) {
  return {
    Id: id,
    Amount: amountCents,
    Counterparty: null,
    CreatedAt: nowTicks(),
    Direction: null,
    DueDate: null,
    EntryType: 'Expense',
    ExchangedAmount: null,
    ExchangedCurrency: null,
    GroupId: groupId,
    IsClosed: null,
    LoanPaymentId: loanPaymentId,
    MovesCash: null,
    Note: note?.trim() ? note.trim() : null,
    OccurredOn: msToTicks(occurredOn),
    Payee: payee?.trim() ? payee.trim() : null,
    PersonId: null,
    QuotedRate: null,
    RecurringRuleId: null,
    Title: title.trim(),
    UpdatedAt: null,
  };
}

/**
 * A new expense, with its tags and any receipts already stored on the phone.
 * `files`: [{ hash, fileName, mediaType, size, isImage }].
 */
export function addExpense(model, { groupId, title, amount, occurredOn, payee, note, tags, files = [] }) {
  const id = newId();
  const changes = [{ tbl: 'Entries', id, data: expenseRow({ id, groupId, title, amountCents: toCents(amount), occurredOn, payee, note }) }];

  changes.push(...tagChanges(model, id, parseTags(tags)));
  changes.push(...attachmentRows(id, files));
  return changes;
}

/**
 * Brings an entry's tags to `names`: links the ones it lacks (making a tag the first time a
 * name is used, as the desktop does) and unlinks the ones it no longer has.
 */
function tagChanges(model, entryId, names) {
  const changes = [];
  const byName = new Map((model.rawTags ?? []).map((t) => [t.Name, t.Id]));
  const linked = (model.entryTagRows ?? []).filter((et) => et.EntryId === entryId);
  const wanted = new Set();

  for (const name of names) {
    let tagId = byName.get(name);
    if (!tagId) {
      tagId = newId();
      byName.set(name, tagId);
      changes.push({ tbl: 'Tags', id: tagId, data: { Id: tagId, Name: name, ColorHex: '#8B93A7' } });
    }
    wanted.add(tagId);
    if (!linked.some((et) => et.TagId === tagId)) {
      changes.push({ tbl: 'EntryTags', id: `${entryId}:${tagId}`, data: { EntryId: entryId, TagId: tagId } });
    }
  }

  for (const et of linked.filter((x) => !wanted.has(x.TagId))) {
    changes.push({ tbl: 'EntryTags', id: `${entryId}:${et.TagId}`, data: null });
  }

  return changes;
}

function attachmentRows(entryId, files) {
  const changes = [];
  for (const f of files) {
    const attachmentId = newId();
    changes.push({
      tbl: 'Attachments', id: attachmentId, data: {
        Id: attachmentId, EntryId: entryId, FileName: f.fileName, ContentHash: f.hash, MediaType: f.mediaType,
        SizeBytes: f.size, IsImage: f.isImage ? 1 : 0, AddedAt: nowTicks(),
      },
    });
  }
  return changes;
}

/**
 * An edited expense. Starts from the row as stored, so columns the phone does not show (a
 * conversion's amounts, anything a later desktop version adds) come through untouched.
 * `removeAttachments`: ids of receipts to drop; `files`: new receipts already on the phone.
 */
export function updateExpense(model, entry, {
  groupId, title, amount, occurredOn, payee, note, tags, files = [], removeAttachments = [],
}) {
  if (entry.loanPaymentId) throw new Error('A repayment entry follows its loan; change the repayment instead.');

  const data = {
    ...entry.raw,
    GroupId: groupId,
    Title: title.trim(),
    Amount: toCents(amount),
    OccurredOn: msToTicks(occurredOn),
    Payee: payee?.trim() ? payee.trim() : null,
    Note: note?.trim() ? note.trim() : null,
    UpdatedAt: nowTicks(),
  };

  return [
    { tbl: 'Entries', id: entry.id, data },
    ...tagChanges(model, entry.id, parseTags(tags)),
    ...attachmentRows(entry.id, files),
    ...removeAttachments.map((id) => ({ tbl: 'Attachments', id, data: null })),
  ];
}

/**
 * Deletes an expense with its tag links and receipts. The desktop would remove those by
 * cascade anyway; saying so outright keeps the phone's own copy right before the next sync.
 */
export function deleteExpense(model, entry) {
  if (entry.loanPaymentId) throw new Error('A repayment entry follows its loan; delete the repayment instead.');
  return removeEntry(model, entry.id);
}

/** An entry with its tag links and receipts, which the desktop removes with it by cascade. */
function removeEntry(model, entryId) {
  return [
    { tbl: 'Entries', id: entryId, data: null },
    ...(model.entryTagRows ?? []).filter((et) => et.EntryId === entryId)
      .map((et) => ({ tbl: 'EntryTags', id: `${entryId}:${et.TagId}`, data: null })),
    ...model.attachments.filter((a) => a.entryId === entryId).map((a) => ({ tbl: 'Attachments', id: a.id, data: null })),
  ];
}

/** Money arriving, filed in the cash ledger as Received. */
export function addMoneyIn({ currency, amount, description, occurredOn }) {
  const id = newId();
  return [{
    tbl: 'CashTransactions', id, data: {
      Id: id, Currency: currency, Amount: toCents(amount), Description: description.trim(),
      OccurredOn: msToTicks(occurredOn), CreatedAt: nowTicks(), Kind: 0,
    },
  }];
}

/**
 * The project's "Loan payments" group: one made earlier in `changes`, the one it has (brought
 * back if archived, as the desktop does), or a new one added to `changes`.
 */
function repaymentGroupId(model, projectId, changes) {
  const isIt = (projectOf, name) => projectOf === projectId && name === LOAN_PAYMENT_GROUP.name;
  const made = changes.find((c) => c.tbl === 'Groups' && c.data && isIt(c.data.ProjectId, c.data.Name));
  if (made) return made.id;

  const existing = [...model.groups.values()].find((g) => isIt(g.projectId, g.name));
  if (existing) {
    if (existing.archived) changes.push({ tbl: 'Groups', id: existing.id, data: { ...existing.raw, IsArchived: 0 } });
    return existing.id;
  }

  const groupId = newId();
  const nextOrder = Math.max(-1, ...[...model.groups.values()].filter((g) => g.projectId === projectId).map((g) => g.sortOrder)) + 1;
  changes.push({
    tbl: 'Groups', id: groupId, data: {
      Id: groupId, ProjectId: projectId, Name: LOAN_PAYMENT_GROUP.name, Kind: GroupKind.Expense,
      Icon: LOAN_PAYMENT_GROUP.icon, ColorHex: LOAN_PAYMENT_GROUP.colorHex, Budget: null, SortOrder: nextOrder,
      IsArchived: 0, CreatedAt: nowTicks(), BudgetPeriod: 0, SubBudget: null, SubBudgetPeriod: 0,
    },
  });
  return groupId;
}

/** The expense entry that files a repayment of borrowed money as spending (the desktop's mirror). */
function repaymentEntry(model, { projectId, title, counterparty }, payment, changes) {
  const entryId = newId();
  return {
    tbl: 'Entries', id: entryId, data: expenseRow({
      id: entryId, groupId: repaymentGroupId(model, projectId, changes), title: `Repaid: ${title}`,
      amountCents: payment.amount, occurredOn: payment.paidOn, payee: counterparty, note: payment.note,
      loanPaymentId: payment.id,
    }),
  };
}

const mirrorOf = (model, paymentId) => model.expenses.find((e) => e.loanPaymentId === paymentId) ?? null;
const loanFacts = (loan) => ({ projectId: loan.group.projectId, title: loan.title, counterparty: loan.counterparty });

/**
 * A repayment against a loan. Paying back money you borrowed is also filed as an expense in
 * the project's "Loan payments" group, made here if the project has none yet, as the desktop's
 * LoanService does. Being paid back is cash arriving, and files no expense.
 */
export function addRepayment(model, { loan, amount, paidOn, note }) {
  const payment = { id: newId(), amount: toCents(amount), paidOn, note: note?.trim() ? note.trim() : null };
  const changes = [{
    tbl: 'LoanPayments', id: payment.id, data: {
      Id: payment.id, LoanEntryId: loan.id, Amount: payment.amount, PaidOn: msToTicks(paidOn),
      Note: payment.note, CreatedAt: nowTicks(),
    },
  }];

  if (loan.direction === Direction.Borrowed) changes.push(repaymentEntry(model, loanFacts(loan), payment, changes));
  return changes;
}

/** Settles a loan in one step: a repayment of exactly what is left, as the desktop's Settle does. */
export function settleLoan(model, loan, paidOn = Date.now()) {
  const left = remaining(loan);
  if (left <= 0) return [];
  return addRepayment(model, { loan, amount: left / 100, paidOn, note: 'Settled in full' });
}

/** A repayment changed, and the entry filed for it with it, so loan, group and cash move together. */
export function updateRepayment(model, payment, { amount, paidOn, note }) {
  const tidyNote = note?.trim() ? note.trim() : null;
  const changes = [{
    tbl: 'LoanPayments', id: payment.id, data: { ...payment.raw, Amount: toCents(amount), PaidOn: msToTicks(paidOn), Note: tidyNote },
  }];
  const mirror = mirrorOf(model, payment.id);
  if (mirror) {
    changes.push({
      tbl: 'Entries', id: mirror.id, data: {
        ...mirror.raw, Amount: toCents(amount), OccurredOn: msToTicks(paidOn), Note: tidyNote, UpdatedAt: nowTicks(),
      },
    });
  }
  return changes;
}

/** A repayment taken back: the loan has that much outstanding again, and its entry goes too. */
export function deleteRepayment(model, payment) {
  const mirror = mirrorOf(model, payment.id);
  return [{ tbl: 'LoanPayments', id: payment.id, data: null }, ...(mirror ? removeEntry(model, mirror.id) : [])];
}

/** A loan deleted with every repayment against it and their entries, as the desktop's cascade does. */
export function deleteLoan(model, loan) {
  return [
    ...removeEntry(model, loan.id),
    ...loan.payments.flatMap((p) => deleteRepayment(model, p)),
  ];
}

/**
 * An edited loan. Its repayment entries follow it, as the desktop's ReconcileRepaymentEntriesAsync
 * has them: renamed with it; gone if it is no longer money you borrowed; made if it now is.
 */
export function updateLoan(model, loan, { title, counterparty, direction, amount, occurredOn, dueDate = null, note, movesCash }) {
  const changes = [];
  const person = resolvePerson(model, counterparty, changes);
  const facts = { projectId: loan.group.projectId, title: title.trim(), counterparty: person?.name ?? '' };

  changes.push({
    tbl: 'Entries', id: loan.id, data: {
      ...loan.raw,
      Title: facts.title,
      Counterparty: facts.counterparty,
      PersonId: person?.id ?? null,
      Direction: direction,
      Amount: toCents(amount),
      OccurredOn: msToTicks(occurredOn),
      DueDate: dueDate === null ? null : msToTicks(dueDate),
      Note: note?.trim() ? note.trim() : null,
      MovesCash: movesCash ? 1 : 0,
      UpdatedAt: nowTicks(),
    },
  });

  for (const payment of loan.payments) {
    const mirror = mirrorOf(model, payment.id);
    if (direction !== Direction.Borrowed) {
      if (mirror) changes.push(...removeEntry(model, mirror.id));
    } else if (mirror) {
      changes.push({ tbl: 'Entries', id: mirror.id, data: { ...mirror.raw, Title: `Repaid: ${facts.title}`, Payee: facts.counterparty || null } });
    } else {
      changes.push(repaymentEntry(model, facts, payment, changes));
    }
  }
  return changes;
}

/** A name as the desktop matches people: spaces squeezed, upper case ("  uncle  ayman" is "UNCLE AYMAN"). */
export const normalizeName = (name) => (name || '').split(/\s+/).filter(Boolean).join(' ').toUpperCase();

/** Someone added to People by hand, as on the PC: a name is needed, and nobody twice. */
export function addPerson(model, { name, note }) {
  const tidy = (name || '').split(/\s+/).filter(Boolean).join(' ');
  const normalized = normalizeName(tidy);
  if (!normalized) throw new Error('A person needs a name.');
  const known = [...model.people.values()].find((p) => normalizeName(p.name) === normalized);
  if (known) throw new Error(`${known.name} is already on the list.`);

  const id = newId();
  return [{ tbl: 'People', id, data: { Id: id, Name: tidy, NormalizedName: normalized, Note: note?.trim() ? note.trim() : null, CreatedAt: nowTicks() } }];
}

/** The person going by `name` (spaces and case aside), or a new one added to `changes`; none for no name. */
function resolvePerson(model, name, changes) {
  const tidy = (name || '').split(/\s+/).filter(Boolean).join(' ');
  const normalized = normalizeName(tidy);
  if (!normalized) return null;

  const known = [...model.people.values()].find((p) => normalizeName(p.name) === normalized);
  if (known) return known;

  const person = { id: newId(), name: tidy };
  changes.push({ tbl: 'People', id: person.id, data: { Id: person.id, Name: tidy, NormalizedName: normalized, Note: null, CreatedAt: nowTicks() } });
  return person;
}

/**
 * A new loan, borrowed or lent. Its person is the one already going by that name, or a new
 * one, as the desktop's PeopleService does, so their loans add up on the People page.
 * `movesCash`: the money went through your cash (borrowed adds to it, lent takes from it).
 */
export function addLoan(model, { groupId, title, counterparty, direction, amount, occurredOn, dueDate = null, note, movesCash = true }) {
  const changes = [];
  const person = resolvePerson(model, counterparty, changes);
  const id = newId();
  changes.push({
    tbl: 'Entries', id, data: {
      Id: id,
      Amount: toCents(amount),
      Counterparty: person?.name ?? '',
      CreatedAt: nowTicks(),
      Direction: direction,
      DueDate: dueDate === null ? null : msToTicks(dueDate),
      EntryType: 'Loan',
      ExchangedAmount: null,
      ExchangedCurrency: null,
      GroupId: groupId,
      IsClosed: 0,
      LoanPaymentId: null,
      MovesCash: movesCash ? 1 : 0,
      Note: note?.trim() ? note.trim() : null,
      OccurredOn: msToTicks(occurredOn),
      Payee: null,
      PersonId: person?.id ?? null,
      QuotedRate: null,
      RecurringRuleId: null,
      Title: title.trim(),
      UpdatedAt: null,
    },
  });
  return changes;
}

// ---------- Shopping list (phone only; the desktop skips these tables) ----------

const itemRow = (item, changes) => ({ tbl: 'ShoppingItems', id: item.id, data: { ...item.raw, ...changes } });

/** Adds an item to one list: `currency` 0 is the euro list (Germany), 1 the pound one (Egypt). */
export function addShoppingItem(model, { name, byWeight, currency = 0 }) {
  const id = newId();
  const last = Math.max(-1, ...model.shopping.items.filter((i) => i.currency === currency).map((i) => i.position));
  return [{
    tbl: 'ShoppingItems', id, data: {
      Id: id, Name: name.trim(), ByWeight: byWeight ? 1 : 0, Currency: currency, Position: last + 1,
      CurrentPurchaseId: null, CreatedAt: Date.now(),
    },
  }];
}

export function updateShoppingItem(item, { name, byWeight }) {
  return [itemRow(item, { Name: name.trim(), ByWeight: byWeight ? 1 : 0 })];
}

/** Takes an item off the list, with what it cost before. */
export function deleteShoppingItem(item) {
  return [
    { tbl: 'ShoppingItems', id: item.id, data: null },
    ...item.history.map((p) => ({ tbl: 'ShoppingPurchases', id: p.id, data: null })),
  ];
}

/** Puts an item in the basket at a price; grams only for things sold by weight. */
/** Puts an item in the basket at a price, in its list's currency. */
export function buyShoppingItem(item, { price, grams, note }) {
  const id = newId();
  return [
    {
      tbl: 'ShoppingPurchases', id, data: {
        Id: id, ItemId: item.id, Price: toCents(price), Currency: item.currency,
        Grams: item.byWeight && Number(grams) > 0 ? Math.round(Number(grams)) : null,
        Note: note?.trim() ? note.trim() : null, BoughtAt: Date.now(),
      },
    },
    itemRow(item, { CurrentPurchaseId: id }),
  ];
}

/** Takes an item back out of the basket: the price goes, as if it was never bought. */
export function unbuyShoppingItem(item) {
  return [
    ...(item.current ? [{ tbl: 'ShoppingPurchases', id: item.current.id, data: null }] : []),
    itemRow(item, { CurrentPurchaseId: null }),
  ];
}

/** Empties the basket for the next trip. What was paid stays, as each item's last price. */
export function startNextTrip(model, currency) {
  return model.shopping.items.filter((i) => i.current && i.currency === currency)
    .map((i) => itemRow(i, { CurrentPurchaseId: null }));
}

/** SHA-256 of a file as lower-case hex: its name in the store, on the phone and the PC alike. */
export async function hashOf(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- Salary (phone only; each payment also files money in, which the desktop sees) ----------

const monthDate = (month) => new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1);
/** "October 2026" */
export const monthLabel = (month) => monthDate(month).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
const shortMonth = (month, than) => monthDate(month).toLocaleDateString('en-GB',
  month.slice(0, 4) === than.slice(0, 4) ? { month: 'long' } : { month: 'long', year: 'numeric' });

/**
 * The side note on a salary: how it compares with the one before, and for a job that tracks
 * hours, how many and what that came to an hour. "up €40.00 (+7.7%) from September · 38 h, €14.21/h"
 */
export function salaryNote(job, month, amount, hours) {
  const parts = [];
  const previous = previousSalary(job, month);
  const change = salaryChange(previous, amount);
  if (change) {
    const from = shortMonth(previous.month, month);
    const pct = change.percent === null ? '' : ` (${change.diff > 0 ? '+' : '−'}${Math.abs(change.percent).toFixed(1)}%)`;
    parts.push(change.diff === 0 ? `same as ${from}`
      : `${change.diff > 0 ? 'up' : 'down'} ${money(Math.abs(change.diff), job.currency)}${pct} from ${from}`);
  }
  if (hours > 0) parts.push(`${String(hours)} h, ${money(Math.round(amount / hours), job.currency)}/h`);
  return parts.join(' · ');
}

/** The money in's description, worded exactly as the PC's SalaryService.Description. */
export const salaryDescription = (job, month, amount, hours) =>
  [`Salary · ${job.name}, ${monthLabel(month)}`, salaryNote(job, month, amount, hours)].filter(Boolean).join(' · ');

export function addSalaryJob(model, { name, currency, payday, tracksHours }) {
  const id = newId();
  const last = Math.max(-1, ...model.salary.jobs.map((j) => j.position));
  return [{
    tbl: 'SalaryJobs', id, data: {
      Id: id, Name: name.trim(), Currency: currency, Payday: payday, TracksHours: tracksHours ? 1 : 0,
      Position: last + 1, CreatedAt: nowTicks(),
    },
  }];
}

export function updateSalaryJob(job, { name, currency, payday, tracksHours }) {
  return [{ tbl: 'SalaryJobs', id: job.id, data: { ...job.raw, Name: name.trim(), Currency: currency, Payday: payday, TracksHours: tracksHours ? 1 : 0 } }];
}

/** Removes a job and its salary list. The money it paid stays in the cash: it did arrive. */
export function deleteSalaryJob(job) {
  return [{ tbl: 'SalaryJobs', id: job.id, data: null }, ...job.payments.map((p) => ({ tbl: 'SalaryPayments', id: p.id, data: null }))];
}

/** A month's salary: kept with its job, and filed as money in so it reaches the cash on both devices. */
export function addSalary(job, { month, amount, hours = null, paidOn }) {
  const cents = toCents(amount);
  const hoursValue = job.tracksHours && Number(hours) > 0 ? Number(hours) : null;
  const [cash] = addMoneyIn({ currency: job.currency, amount, description: salaryDescription(job, month, cents, hoursValue), occurredOn: paidOn });
  const id = newId();
  return [cash, {
    tbl: 'SalaryPayments', id, data: {
      Id: id, JobId: job.id, Month: month, Amount: cents, Hours: hoursValue, CashTransactionId: cash.id,
      PaidOn: msToTicks(paidOn), CreatedAt: nowTicks(),
    },
  }];
}

/** A salary corrected: its money in changes with it, side note recalculated. */
export function updateSalary(model, job, payment, { amount, hours = null }) {
  const cents = toCents(amount);
  const hoursValue = job.tracksHours && Number(hours) > 0 ? Number(hours) : null;
  const changes = [{ tbl: 'SalaryPayments', id: payment.id, data: { ...payment.raw, Amount: cents, Hours: hoursValue } }];
  const cash = model.transactions.find((t) => t.id === payment.cashId);
  if (cash) {
    changes.push({ tbl: 'CashTransactions', id: cash.id, data: { ...cash.raw, Amount: cents, Description: salaryDescription(job, payment.month, cents, hoursValue) } });
  }
  return changes;
}

/** A salary filed by mistake: gone from the list and from the cash. */
export function deleteSalary(payment) {
  return [
    { tbl: 'SalaryPayments', id: payment.id, data: null },
    ...(payment.cashId ? [{ tbl: 'CashTransactions', id: payment.cashId, data: null }] : []),
  ];
}
