// Rows the phone creates, written exactly as the desktop stores them: every column present,
// ids as upper-case GUIDs, money in cents, dates as .NET ticks (strings), flags as 0/1.
// test/writes.test.mjs checks the column sets against rows the desktop wrote.
import { msToTicks, GroupKind, Direction } from './calc.js';

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

  return [
    { tbl: 'Entries', id: entry.id, data: null },
    ...(model.entryTagRows ?? []).filter((et) => et.EntryId === entry.id)
      .map((et) => ({ tbl: 'EntryTags', id: `${entry.id}:${et.TagId}`, data: null })),
    ...model.attachments.filter((a) => a.entryId === entry.id).map((a) => ({ tbl: 'Attachments', id: a.id, data: null })),
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
 * A repayment against a loan. Paying back money you borrowed is also filed as an expense in
 * the project's "Loan payments" group, made here if the project has none yet, as the desktop's
 * LoanService does. Being paid back is cash arriving, and files no expense.
 */
export function addRepayment(model, { loan, amount, paidOn, note }) {
  const paymentId = newId();
  const amountCents = toCents(amount);
  const changes = [{
    tbl: 'LoanPayments', id: paymentId, data: {
      Id: paymentId, LoanEntryId: loan.id, Amount: amountCents, PaidOn: msToTicks(paidOn),
      Note: note?.trim() ? note.trim() : null, CreatedAt: nowTicks(),
    },
  }];

  if (loan.direction !== Direction.Borrowed) return changes;

  const projectId = loan.group.projectId;
  let group = [...model.groups.values()].find((g) => g.projectId === projectId && g.name === LOAN_PAYMENT_GROUP.name);

  if (!group) {
    const groupId = newId();
    const nextOrder = Math.max(-1, ...[...model.groups.values()].filter((g) => g.projectId === projectId).map((g) => g.sortOrder)) + 1;
    changes.push({
      tbl: 'Groups', id: groupId, data: {
        Id: groupId, ProjectId: projectId, Name: LOAN_PAYMENT_GROUP.name, Kind: GroupKind.Expense,
        Icon: LOAN_PAYMENT_GROUP.icon, ColorHex: LOAN_PAYMENT_GROUP.colorHex, Budget: null, SortOrder: nextOrder,
        IsArchived: 0, CreatedAt: nowTicks(), BudgetPeriod: 0, SubBudget: null, SubBudgetPeriod: 0,
      },
    });
    group = { id: groupId };
  }

  const entryId = newId();
  changes.push({
    tbl: 'Entries', id: entryId, data: expenseRow({
      id: entryId, groupId: group.id, title: `Repaid: ${loan.title}`, amountCents, occurredOn: paidOn,
      payee: loan.counterparty, note, loanPaymentId: paymentId,
    }),
  });

  return changes;
}

/** A name as the desktop matches people: spaces squeezed, upper case ("  uncle  ayman" is "UNCLE AYMAN"). */
export const normalizeName = (name) => (name || '').split(/\s+/).filter(Boolean).join(' ').toUpperCase();

/**
 * A new loan, borrowed or lent. Its person is the one already going by that name, or a new
 * one, as the desktop's PeopleService does, so their loans add up on the People page.
 * `movesCash`: the money went through your cash (borrowed adds to it, lent takes from it).
 */
export function addLoan(model, { groupId, title, counterparty, direction, amount, occurredOn, dueDate = null, note, movesCash = true }) {
  const changes = [];
  const name = (counterparty || '').split(/\s+/).filter(Boolean).join(' ');
  const normalized = normalizeName(name);
  let person = normalized ? [...model.people.values()].find((p) => normalizeName(p.name) === normalized) : null;

  if (normalized && !person) {
    person = { id: newId(), name };
    changes.push({
      tbl: 'People', id: person.id, data: { Id: person.id, Name: name, NormalizedName: normalized, Note: null, CreatedAt: nowTicks() },
    });
  }

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
