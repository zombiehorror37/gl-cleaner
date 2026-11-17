'use client';
import { useMemo, useState } from 'react';
import { useStore } from '@/lib/store';
import { applyDecisions, isBlocked, lockedLines } from '@/lib/engine/apply';
import { EXCEPTION_LABEL, KIND_LABEL, type ExceptionKind, type GroupKind, type MatchGroup } from '@/lib/engine/types';
import { formatCents } from '@/lib/parse/values';
import { GroupCard, type GroupActions, type GroupStatus } from '@/components/review/GroupCard';
import { Badge, Button, Card, cx, inputClass, Stat } from '@/components/ui';

const PAGE = 40;
const CONTACT_PAGE = 200;

type Item = { kind: 'single'; group: MatchGroup } | { kind: 'alts'; key: string; groups: MatchGroup[] };

export default function ReviewStep() {
  const result = useStore((s) => s.result)!;
  const validation = useStore((s) => s.validation)!;
  const approved = useStore((s) => s.approved);
  const dismissed = useStore((s) => s.dismissed);
  const approve = useStore((s) => s.approve);
  const unapprove = useStore((s) => s.unapprove);
  const dismiss = useStore((s) => s.dismiss);
  const undismiss = useStore((s) => s.undismiss);
  const clearDecisions = useStore((s) => s.clearDecisions);
  const setStep = useStore((s) => s.setStep);

  const [tab, setTab] = useState<'matches' | 'exceptions'>('matches');
  const [contact, setContact] = useState<string | null>(null);
  const [contactQuery, setContactQuery] = useState('');
  const [contactFilter, setContactFilter] = useState<'all' | 'proposals' | 'open' | 'exceptions'>('proposals');
  const [kind, setKind] = useState<'all' | GroupKind>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | GroupStatus>('all');
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [contactsShown, setContactsShown] = useState(CONTACT_PAGE);
  const [exKind, setExKind] = useState<'all' | ExceptionKind>('all');

  const p = result.settings.precision;
  const fmt = (c: number) => formatCents(c, p);
  const rows = validation.rows;
  const rowsById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const groups = result.groups;
  const contactsByKey = useMemo(() => new Map(result.contacts.map((c) => [c.key, c])), [result.contacts]);

  const actions = useMemo<GroupActions>(() => ({ approve, unapprove, dismiss, undismiss }), [approve, unapprove, dismiss, undismiss]);

  const locked = useMemo(() => lockedLines(groups, approved), [groups, approved]);
  const status = useMemo(() => {
    const m = new Map<string, GroupStatus>();
    for (const g of groups) {
      m.set(g.id, approved.has(g.id) ? 'approved' : dismissed.has(g.id) ? 'dismissed' : isBlocked(g, locked) ? 'blocked' : 'pending');
    }
    return m;
  }, [groups, approved, dismissed, locked]);

  const outcome = useMemo(() => applyDecisions(rows, groups, approved, p), [rows, groups, approved, p]);

  /** Greedy: approve suggested, non-dismissed groups that don't collide with what's approved. */
  const approveSuggested = (candidates: MatchGroup[]) => {
    const lockedNow = new Map(locked);
    const ids: string[] = [];
    for (const g of candidates) {
      if (!g.suggested || g.individualOnly || approved.has(g.id) || dismissed.has(g.id) || isBlocked(g, lockedNow)) continue;
      ids.push(g.id);
      for (const id of g.memberIds) lockedNow.set(id, g.id);
    }
    approve(ids);
  };

  const pendingSuggested = groups.filter((g) => g.suggested && !g.individualOnly && status.get(g.id) === 'pending');

  // ---- contact list -----------------------------------------------------------
  const perContact = useMemo(() => {
    const m = new Map<string, { proposals: number; approved: number; exceptions: number; open: number; openNet: number }>();
    for (const c of result.contacts) m.set(c.key, { proposals: 0, approved: 0, exceptions: 0, open: 0, openNet: 0 });
    for (const g of groups) {
      const e = m.get(g.contactKey)!;
      const st = status.get(g.id);
      if (st === 'pending') e.proposals++;
      if (st === 'approved') e.approved++;
    }
    for (const x of result.exceptions) if (x.contactKey) m.get(x.contactKey)!.exceptions++;
    for (const it of outcome.openItems) {
      const e = m.get(it.row.contactKey)!;
      e.open++;
      e.openNet += it.row.net;
    }
    return m;
  }, [result, groups, status, outcome]);

  const contactList = useMemo(() => {
    const q = contactQuery.trim().toLowerCase();
    return result.contacts.filter((c) => {
      const e = perContact.get(c.key)!;
      if (contactFilter === 'proposals' && e.proposals === 0) return false;
      if (contactFilter === 'open' && e.open === 0) return false;
      if (contactFilter === 'exceptions' && e.exceptions === 0) return false;
      return !q || c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q);
    });
  }, [result.contacts, perContact, contactQuery, contactFilter]);

  // ---- group list ----------------------------------------------------------------
  const needle = search.trim().toLowerCase();
  const items = useMemo<Item[]>(() => {
    const matches = (g: MatchGroup) => {
      if (contact && g.contactKey !== contact) return false;
      if (kind !== 'all' && g.kind !== kind) return false;
      if (statusFilter !== 'all' && status.get(g.id) !== statusFilter) return false;
      if (needle) {
        const hay = g.memberIds
          .map((id) => {
            const r = rowsById.get(id)!;
            return `${r.transactionId} ${r.reference ?? ''} ${r.description ?? ''} ${fmt(r.net)} ${r.contactCode} ${r.contactName}`;
          })
          .join(' ')
          .toLowerCase();
        if (!hay.includes(needle) && !g.id.toLowerCase().includes(needle)) return false;
      }
      return true;
    };
    const out: Item[] = [];
    const altSeen = new Map<string, Item & { kind: 'alts' }>();
    const ordered = [...groups].sort(
      (a, b) =>
        Number(b.suggested) - Number(a.suggested) ||
        (contactsByKey.get(a.contactKey)!.code < contactsByKey.get(b.contactKey)!.code ? -1 : contactsByKey.get(a.contactKey)!.code > contactsByKey.get(b.contactKey)!.code ? 1 : 0) ||
        a.id.localeCompare(b.id),
    );
    for (const g of ordered) {
      if (!matches(g)) continue;
      if (g.altKey) {
        const ex = altSeen.get(g.altKey);
        if (ex) ex.groups.push(g);
        else {
          const it = { kind: 'alts' as const, key: g.altKey, groups: [g] };
          altSeen.set(g.altKey, it);
          out.push(it);
        }
      } else out.push({ kind: 'single', group: g });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, contact, kind, statusFilter, needle, status, rowsById, contactsByKey]);

  const kindsPresent = useMemo(() => [...new Set(groups.map((g) => g.kind))], [groups]);
  const exceptionsShown = result.exceptions.filter((x) => (exKind === 'all' || x.kind === exKind) && (!contact || x.contactKey === contact));
  const selected = contact ? contactsByKey.get(contact)! : null;
  const t = outcome.totals;

  return (
    <div className="space-y-4">
      <div className="sticky top-[104px] z-10 flex flex-wrap items-center gap-2 rounded-xl border border-black/10 bg-white/90 p-2 backdrop-blur dark:border-white/10 dark:bg-zinc-950/90">
        <Stat label="Approved matches" value={approved.size} hint={`${pendingSuggested.length} suggested pending`} />
        <Stat label="Lines cleared" value={`${t.clearedRows} / ${t.originalRows}`} hint={`${t.residualLines} residual line(s)`} />
        <Stat label="Open items" value={t.openRows} />
        <Stat
          label="Open balance"
          value={fmt(t.openNet)}
          tone={t.openNet === t.originalNet ? 'good' : 'bad'}
          hint={t.openNet === t.originalNet ? '= original balance ✓' : 'does not reconcile'}
        />
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="good" disabled={!pendingSuggested.length} onClick={() => approveSuggested(groups)} title="Near misses and balance-forward are never included">
            Approve all suggested ({pendingSuggested.length})
          </Button>
          {approved.size > 0 && (
            <Button variant="ghost" onClick={clearDecisions}>
              Clear decisions
            </Button>
          )}
          <Button variant="primary" onClick={() => setStep('export')} disabled={outcome.errors.length > 0}>
            Continue → Export
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[17rem_1fr]">
        {/* Contacts */}
        <Card className="flex max-h-[calc(100vh-14rem)] flex-col overflow-hidden lg:sticky lg:top-[200px]">
          <div className="space-y-2 border-b border-black/10 p-2 dark:border-white/10">
            <input className={inputClass} placeholder="Search contacts…" value={contactQuery} onChange={(e) => setContactQuery(e.target.value)} />
            <select className={inputClass} value={contactFilter} onChange={(e) => setContactFilter(e.target.value as typeof contactFilter)}>
              <option value="proposals">With pending proposals</option>
              <option value="open">With open items</option>
              <option value="exceptions">With exceptions</option>
              <option value="all">All contacts</option>
            </select>
          </div>
          <div className="flex-1 overflow-y-auto">
            <button
              onClick={() => {
                setContact(null);
                setShown(PAGE);
              }}
              className={cx('block w-full border-b border-black/5 px-3 py-2 text-left text-sm dark:border-white/5', !contact ? 'bg-indigo-600/10 font-semibold' : 'hover:bg-black/5 dark:hover:bg-white/5')}
            >
              All contacts <span className="opacity-60">({result.contacts.length})</span>
            </button>
            {contactList.slice(0, contactsShown).map((c) => {
              const e = perContact.get(c.key)!;
              return (
                <button
                  key={c.key}
                  onClick={() => {
                    setContact(c.key);
                    setShown(PAGE);
                  }}
                  className={cx('block w-full border-b border-black/5 px-3 py-2 text-left text-sm dark:border-white/5', contact === c.key ? 'bg-indigo-600/10' : 'hover:bg-black/5 dark:hover:bg-white/5')}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-medium">{c.code}</span>
                    <span className="font-mono text-xs tabular-nums opacity-70">{fmt(e.openNet)}</span>
                  </div>
                  <div className="truncate text-xs opacity-60">{c.name}</div>
                  <div className="mt-0.5 flex gap-1">
                    {e.proposals > 0 && <Badge tone="info">{e.proposals} to review</Badge>}
                    {e.approved > 0 && <Badge tone="good">{e.approved} ✓</Badge>}
                    {e.exceptions > 0 && <Badge tone="warn">{e.exceptions} !</Badge>}
                    {e.open === 0 && <Badge tone="good">clear</Badge>}
                  </div>
                </button>
              );
            })}
            {contactList.length > contactsShown && (
              <button className="w-full p-2 text-sm text-indigo-600" onClick={() => setContactsShown((n) => n + CONTACT_PAGE)}>
                Show more ({contactList.length - contactsShown})
              </button>
            )}
            {contactList.length === 0 && <p className="p-3 text-sm opacity-60">No contacts match.</p>}
          </div>
        </Card>

        {/* Detail */}
        <div className="min-w-0 space-y-3">
          {selected && (
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-lg font-semibold">
                {selected.code} · {selected.name}
              </h2>
              <span className="text-sm opacity-70">
                {selected.rowIds.length} lines · balance {fmt(selected.balance)} · open after approvals {fmt(perContact.get(selected.key)!.openNet)} in {perContact.get(selected.key)!.open} line(s)
              </span>
              {groups.some((g) => g.contactKey === selected.key && g.suggested && !g.individualOnly && status.get(g.id) === 'pending') && (
                <Button size="sm" variant="good" onClick={() => approveSuggested(groups.filter((g) => g.contactKey === selected.key))}>
                  Approve suggested for this contact
                </Button>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 border-b border-black/10 dark:border-white/10">
            {(['matches', 'exceptions'] as const).map((k) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={cx('-mb-px border-b-2 px-3 py-2 text-sm font-medium', tab === k ? 'border-indigo-600 text-indigo-700 dark:text-indigo-300' : 'border-transparent opacity-70 hover:opacity-100')}
              >
                {k === 'matches' ? 'Matches' : `Exceptions (${result.exceptions.filter((x) => !contact || x.contactKey === contact).length})`}
              </button>
            ))}
          </div>

          {tab === 'matches' && (
            <>
              <div className="flex flex-wrap gap-2">
                <select className={cx(inputClass, 'w-auto')} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                  <option value="all">All match types</option>
                  {kindsPresent.map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABEL[k]}
                    </option>
                  ))}
                </select>
                <select className={cx(inputClass, 'w-auto')} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}>
                  <option value="all">Any status</option>
                  <option value="pending">To review</option>
                  <option value="approved">Approved</option>
                  <option value="dismissed">Dismissed</option>
                  <option value="blocked">Blocked</option>
                </select>
                <input className={cx(inputClass, 'w-64')} placeholder="Search id, reference, amount…" value={search} onChange={(e) => setSearch(e.target.value)} />
                <span className="self-center text-sm opacity-60">{items.length} result(s)</span>
              </div>

              {items.length === 0 && <Card className="p-6 text-center text-sm opacity-70">Nothing to show with these filters.</Card>}
              <div className="space-y-3">
                {items.slice(0, shown).map((it) =>
                  it.kind === 'single' ? (
                    <GroupCard
                      key={it.group.id}
                      group={it.group}
                      rowsById={rowsById}
                      status={status.get(it.group.id)!}
                      precision={p}
                      actions={actions}
                      contactLabel={contact ? undefined : `${contactsByKey.get(it.group.contactKey)!.code} · ${contactsByKey.get(it.group.contactKey)!.name}`}
                    />
                  ) : (
                    <div key={it.key} className="space-y-2 rounded-xl border border-dashed border-amber-500/50 p-2">
                      <div className="px-1 text-sm font-medium text-amber-700 dark:text-amber-300">
                        {it.groups.length} alternative ways to clear the same line. Approve at most one.
                      </div>
                      {it.groups.map((g) => (
                        <GroupCard
                          key={g.id}
                          group={g}
                          rowsById={rowsById}
                          status={status.get(g.id)!}
                          precision={p}
                          actions={actions}
                          contactLabel={contact ? undefined : `${contactsByKey.get(g.contactKey)!.code} · ${contactsByKey.get(g.contactKey)!.name}`}
                        />
                      ))}
                    </div>
                  ),
                )}
              </div>
              {items.length > shown && (
                <div className="text-center">
                  <Button onClick={() => setShown((n) => n + PAGE)}>Show more ({items.length - shown})</Button>
                </div>
              )}

              {selected && (
                <Card className="p-3">
                  <h3 className="mb-2 text-sm font-semibold">Open items for {selected.code} after your approvals</h3>
                  <OpenTable items={outcome.openItems.filter((o) => o.row.contactKey === selected.key)} fmt={fmt} />
                </Card>
              )}
            </>
          )}

          {tab === 'exceptions' && (
            <>
              <select className={cx(inputClass, 'w-auto')} value={exKind} onChange={(e) => setExKind(e.target.value as typeof exKind)}>
                <option value="all">All exception types</option>
                {[...new Set(result.exceptions.map((x) => x.kind))].map((k) => (
                  <option key={k} value={k}>
                    {EXCEPTION_LABEL[k]}
                  </option>
                ))}
              </select>
              <Card className="divide-y divide-black/5 dark:divide-white/5">
                {exceptionsShown.length === 0 && <p className="p-4 text-sm opacity-60">No exceptions.</p>}
                {exceptionsShown.slice(0, 500).map((x) => (
                  <div key={x.id} className="flex gap-3 px-3 py-2 text-sm">
                    <div className="w-44 shrink-0 space-y-1">
                      <Badge tone={x.severity === 'warning' ? 'warn' : 'info'}>{EXCEPTION_LABEL[x.kind]}</Badge>
                      {x.contactKey && !contact && (
                        <button className="block text-xs text-indigo-600 hover:underline dark:text-indigo-400" onClick={() => setContact(x.contactKey)}>
                          {contactsByKey.get(x.contactKey)!.code}
                        </button>
                      )}
                    </div>
                    <div className="min-w-0">
                      <div>{x.message}</div>
                      {x.rowIds.length > 0 && (
                        <div className="text-xs opacity-60">
                          Rows {x.rowIds.slice(0, 20).map((id) => rowsById.get(id)!.sourceRow).join(', ')}
                          {x.rowIds.length > 20 && '…'}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function OpenTable({ items, fmt }: { items: ReturnType<typeof applyDecisions>['openItems']; fmt: (c: number) => string }) {
  if (!items.length) return <p className="text-sm text-emerald-600 dark:text-emerald-400">Nothing open: this contact is fully cleared.</p>;
  return (
    <table className="w-full text-left text-xs">
      <thead className="opacity-60">
        <tr>
          <th className="py-1 pr-3 font-medium">Row</th>
          <th className="py-1 pr-3 font-medium">Transaction Id</th>
          <th className="py-1 pr-3 font-medium">Type</th>
          <th className="py-1 pr-3 font-medium">Effective</th>
          <th className="py-1 pr-3 font-medium">Due</th>
          <th className="py-1 pr-3 font-medium">Description</th>
          <th className="py-1 text-right font-medium">Net</th>
        </tr>
      </thead>
      <tbody>
        {items.map((o) => (
          <tr key={`${o.kind}-${o.row.id}`} className={cx('border-t border-black/5 dark:border-white/5', o.kind === 'residual' && 'bg-amber-500/10')}>
            <td className="py-1 pr-3 tabular-nums opacity-60">{o.row.sourceRow}</td>
            <td className="py-1 pr-3 font-mono">{o.row.transactionId}</td>
            <td className="py-1 pr-3">{o.row.documentType}</td>
            <td className="py-1 pr-3 tabular-nums">{o.row.effectiveDate ?? o.row.effectiveDateText}</td>
            <td className="py-1 pr-3 tabular-nums">{o.row.dueDate ?? o.row.dueDateText}</td>
            <td className="max-w-80 truncate py-1 pr-3" title={o.row.description ?? ''}>
              {o.kind === 'residual' && <Badge tone="warn">residual</Badge>} {o.row.description}
            </td>
            <td className={cx('py-1 text-right font-mono tabular-nums', o.row.net < 0 && 'text-red-600 dark:text-red-400')}>{fmt(o.row.net)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
