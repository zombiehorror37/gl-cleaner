'use client';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useStore } from '@/lib/store';
import { applyDecisions, isBlocked, lockedLines } from '@/lib/engine/apply';
import { EXCEPTION_LABEL, type ExceptionKind, type GroupKind, type MatchGroup, type Tier } from '@/lib/engine/types';
import { formatCents } from '@/lib/parse/values';
import {
  FAMILY,
  FAMILY_ORDER,
  KIND_META,
  KIND_ORDER,
  STATUS_ORDER,
  TIER_ORDER,
  type Family,
  type ReviewStatus,
} from '@/lib/review-meta';
import { MatchRow, type MatchActions, type MatchFilters } from '@/components/review/MatchRow';
import { FamilyDot, KindTag, StatusTag, Tag, TierTag } from '@/components/review/Tags';
import { Button, Card, cx, inputClass, Stat } from '@/components/ui';

const PAGE = 100;
const CONTACT_PAGE = 200;

type Item = { kind: 'single'; group: MatchGroup } | { kind: 'alts'; key: string; groups: MatchGroup[] };

const toggle = <T,>(set: Set<T>, v: T): Set<T> => {
  const n = new Set(set);
  if (n.has(v)) n.delete(v);
  else n.add(v);
  return n;
};

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
  const restored = useStore((s) => s.restored);
  const dismissRestored = useStore((s) => s.dismissRestored);

  const [tab, setTab] = useState<'matches' | 'exceptions'>('matches');
  const [contact, setContact] = useState<string | null>(null);
  const [contactQuery, setContactQuery] = useState('');
  const [contactFilter, setContactFilter] = useState<'all' | 'proposals' | 'open' | 'exceptions'>('all');
  const [kinds, setKinds] = useState<Set<GroupKind>>(new Set());
  const [tiers, setTiers] = useState<Set<Tier>>(new Set());
  const [statuses, setStatuses] = useState<Set<ReviewStatus>>(new Set());
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);
  const [contactsShown, setContactsShown] = useState(CONTACT_PAGE);
  const [exKinds, setExKinds] = useState<Set<ExceptionKind>>(new Set());
  const [help, setHelp] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const p = result.settings.precision;
  const fmt = useCallback((c: number) => formatCents(c, p), [p]);
  const rows = validation.rows;
  const rowsById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const groups = result.groups;
  const groupById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);
  const contactsByKey = useMemo(() => new Map(result.contacts.map((c) => [c.key, c])), [result.contacts]);
  const single = result.contacts.length === 1;

  const actions = useMemo<MatchActions>(() => ({ approve, unapprove, dismiss, undismiss }), [approve, unapprove, dismiss, undismiss]);

  const locked = useMemo(() => lockedLines(groups, approved), [groups, approved]);
  const status = useMemo(() => {
    const m = new Map<string, ReviewStatus>();
    for (const g of groups) {
      m.set(
        g.id,
        approved.has(g.id) ? 'approved' : dismissed.has(g.id) ? 'dismissed' : isBlocked(g, locked) ? 'blocked' : g.suggested && !g.individualOnly ? 'suggested' : 'review',
      );
    }
    return m;
  }, [groups, approved, dismissed, locked]);
  const blockedBy = (g: MatchGroup) => g.memberIds.map((id) => locked.get(id)).find((o) => o && o !== g.id);

  const outcome = useMemo(() => applyDecisions(rows, groups, approved, p), [rows, groups, approved, p]);

  /** Greedy approval that never creates a conflict. Judgement calls and alternatives are left for one-by-one review. */
  const bulkPlan = useCallback(
    /** suggestedOnly: skip "To review" proposals (they need a look before a bulk approval). */
    (candidates: MatchGroup[], suggestedOnly: boolean) => {
      const lockedNow = new Map(locked);
      const ids: string[] = [];
      for (const g of candidates) {
        const st = status.get(g.id);
        if (st !== 'suggested' && st !== 'review') continue;
        if (g.individualOnly || g.altKey || (suggestedOnly && st !== 'suggested')) continue;
        if (isBlocked(g, lockedNow)) continue;
        ids.push(g.id);
        for (const id of g.memberIds) lockedNow.set(id, g.id);
      }
      return ids;
    },
    [locked, status],
  );

  const allSuggested = useMemo(() => bulkPlan(groups, true), [bulkPlan, groups]);

  // ---- contacts ------------------------------------------------------------------
  const perContact = useMemo(() => {
    const m = new Map<string, { review: number; approved: number; notes: number; open: number; openNet: number }>();
    for (const c of result.contacts) m.set(c.key, { review: 0, approved: 0, notes: 0, open: 0, openNet: 0 });
    for (const g of groups) {
      const e = m.get(g.contactKey)!;
      const st = status.get(g.id);
      if (st === 'suggested' || st === 'review') e.review++;
      if (st === 'approved') e.approved++;
    }
    for (const x of result.exceptions) if (x.contactKey) m.get(x.contactKey)!.notes++;
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
      if (contactFilter === 'proposals' && e.review === 0) return false;
      if (contactFilter === 'open' && e.open === 0) return false;
      if (contactFilter === 'exceptions' && e.notes === 0) return false;
      return !q || c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q);
    });
  }, [result.contacts, perContact, contactQuery, contactFilter]);

  // ---- filtering -------------------------------------------------------------------
  const needle = search.trim().toLowerCase();
  const scoped = useMemo(
    () =>
      groups.filter((g) => {
        if (contact && g.contactKey !== contact) return false;
        if (!needle) return true;
        if (g.id.toLowerCase().includes(needle)) return true;
        return g.memberIds.some((id) => {
          const r = rowsById.get(id)!;
          return `${r.transactionId} ${r.reference ?? ''} ${r.description ?? ''} ${fmt(r.net)} ${r.contactCode} ${r.contactName}`.toLowerCase().includes(needle);
        });
      }),
    [groups, contact, needle, rowsById, fmt],
  );
  const pass = useCallback(
    (g: MatchGroup, skip?: 'kind' | 'tier' | 'status') =>
      (skip === 'kind' || !kinds.size || kinds.has(g.kind)) &&
      (skip === 'tier' || !tiers.size || tiers.has(g.tier)) &&
      (skip === 'status' || !statuses.size || statuses.has(status.get(g.id)!)),
    [kinds, tiers, statuses, status],
  );
  // Facet counts: each facet counts within the other active filters.
  const counts = useMemo(() => {
    const kind = new Map<GroupKind, number>();
    const tier = new Map<Tier, number>();
    const st = new Map<ReviewStatus, number>();
    for (const g of scoped) {
      if (pass(g, 'kind')) kind.set(g.kind, (kind.get(g.kind) ?? 0) + 1);
      if (pass(g, 'tier')) tier.set(g.tier, (tier.get(g.tier) ?? 0) + 1);
      if (pass(g, 'status')) st.set(status.get(g.id)!, (st.get(status.get(g.id)!) ?? 0) + 1);
    }
    return { kind, tier, st };
  }, [scoped, pass, status]);
  const filtered = useMemo(() => scoped.filter((g) => pass(g)), [scoped, pass]);
  // "To review" items join a bulk approval only when the reviewer filtered to them on purpose.
  const shownPlan = useMemo(() => bulkPlan(filtered, !statuses.has('review')), [bulkPlan, filtered, statuses]);

  const items = useMemo<Item[]>(() => {
    const code = (g: MatchGroup) => contactsByKey.get(g.contactKey)!.code;
    const rank: Record<ReviewStatus, number> = { suggested: 0, review: 1, approved: 2, blocked: 3, dismissed: 4 };
    const ordered = [...filtered].sort(
      (a, b) => (code(a) < code(b) ? -1 : code(a) > code(b) ? 1 : 0) || rank[status.get(a.id)!] - rank[status.get(b.id)!] || a.id.localeCompare(b.id),
    );
    const out: Item[] = [];
    const alts = new Map<string, Item & { kind: 'alts' }>();
    for (const g of ordered) {
      if (!g.altKey) {
        out.push({ kind: 'single', group: g });
        continue;
      }
      const ex = alts.get(g.altKey);
      if (ex) ex.groups.push(g);
      else {
        const it = { kind: 'alts' as const, key: g.altKey, groups: [g] };
        alts.set(g.altKey, it);
        out.push(it);
      }
    }
    return out;
  }, [filtered, status, contactsByKey]);

  const visible = items.slice(0, shown);
  const visibleIds = useMemo(() => visible.flatMap((it) => (it.kind === 'single' ? [it.group.id] : it.groups.map((g) => g.id))), [visible]);

  const filters = useMemo<MatchFilters>(
    () => ({
      kind: (k) => setKinds((s) => toggle(s, k)),
      tier: (t) => setTiers((s) => toggle(s, t)),
      status: (st) => setStatuses((s) => toggle(s, st)),
      contact: (key) => setContact(key),
    }),
    [],
  );
  const toggleFamily = (f: Family) => {
    const members = KIND_ORDER.filter((k) => KIND_META[k].family === f);
    setKinds((s) => {
      const all = members.every((k) => s.has(k));
      const n = new Set(s);
      for (const k of members) {
        if (all) n.delete(k);
        else n.add(k);
      }
      return n;
    });
  };
  const anyFilter = kinds.size + tiers.size + statuses.size > 0 || needle !== '';
  const clearFilters = () => {
    setKinds(new Set());
    setTiers(new Set());
    setStatuses(new Set());
    setSearch('');
  };
  const onToggle = useCallback((id: string) => setExpanded((s) => toggle(s, id)), []);

  // ---- keyboard ------------------------------------------------------------------------
  const kb = useRef({ visibleIds, focusedId, status, onToggle, actions, tab });
  useEffect(() => {
    kb.current = { visibleIds, focusedId, status, onToggle, actions, tab };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || t.closest('input, textarea, select')) return;
      const { visibleIds: vis, focusedId: fid, status: st, onToggle: tog, actions: act, tab: tb } = kb.current;
      if (e.key === '?') {
        setHelp((h) => !h);
        return;
      }
      if (e.key === 'Escape') {
        setHelp(false);
        return;
      }
      if (tb !== 'matches') return;
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      const idx = fid ? vis.indexOf(fid) : -1;
      const move = (d: number) => {
        e.preventDefault();
        const next = vis[Math.max(0, Math.min(vis.length - 1, idx + d))];
        if (!next) return;
        setFocusedId(next);
        document.getElementById(`match-${next}`)?.scrollIntoView({ block: 'nearest' });
      };
      if (e.key === 'j' || e.key === 'ArrowDown') return move(1);
      if (e.key === 'k' || e.key === 'ArrowUp') return move(-1);
      if (!fid) return;
      const s = st.get(fid);
      if (e.key === 'Enter' || e.key === 'o' || e.key === ' ') {
        e.preventDefault();
        tog(fid);
      } else if (e.key === 'a' && (s === 'suggested' || s === 'review')) act.approve([fid]);
      else if (e.key === 'd' && (s === 'suggested' || s === 'review')) act.dismiss(fid);
      else if (e.key === 'u' && s === 'approved') act.unapprove(fid);
      else if (e.key === 'u' && s === 'dismissed') act.undismiss(fid);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- exceptions -------------------------------------------------------------------------
  const concerns = (x: (typeof result.exceptions)[number]) =>
    !contact || x.contactKey === contact || (x.contactKey === null && (x.rowIds.length === 0 || x.rowIds.some((id) => rowsById.get(id)!.contactKey === contact)));
  const exScoped = result.exceptions.filter(concerns);
  const exCounts = new Map<ExceptionKind, number>();
  for (const x of exScoped) exCounts.set(x.kind, (exCounts.get(x.kind) ?? 0) + 1);
  const exShown = exScoped.filter((x) => !exKinds.size || exKinds.has(x.kind));

  const selected = contact ? contactsByKey.get(contact)! : null;
  const t = outcome.totals;
  const kindsInScope = KIND_ORDER.filter((k) => (counts.kind.get(k) ?? 0) > 0 || kinds.has(k));

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="sticky top-[104px] z-10 flex flex-wrap items-center gap-2 rounded-xl border border-black/10 bg-white/90 p-2 backdrop-blur dark:border-white/10 dark:bg-zinc-950/90">
        <Stat label="Approved" value={approved.size} hint={`of ${groups.length} proposals`} />
        <Stat label="Lines cleared" value={`${t.clearedRows} / ${t.originalRows}`} hint={`${t.residualLines} residual line(s)`} />
        <Stat label="Open items" value={t.openRows} />
        <Stat label="Open balance" value={fmt(t.openNet)} tone={t.openNet === t.originalNet ? 'good' : 'bad'} hint={t.openNet === t.originalNet ? '= original ✓' : 'does not reconcile'} />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button variant="good" disabled={!allSuggested.length} onClick={() => approve(allSuggested)} title="Near misses, balance-forward and alternatives are never included">
            Approve all suggested ({allSuggested.length})
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

      {restored && (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-sky-500/30 bg-sky-500/[0.06] px-4 py-2.5 text-sm">
          <span>
            Picked up where you left off: <b>{restored.approved}</b> approval(s) and <b>{restored.dismissed}</b> dismissal(s) restored from {new Date(restored.savedAt).toLocaleString()}.
            {restored.missing > 0 && ` ${restored.missing} earlier decision(s) no longer match a proposal (the settings changed what is proposed).`}
          </span>
          <span className="ml-auto flex gap-2">
            <Button size="sm" variant="ghost" onClick={clearDecisions}>
              Start fresh
            </Button>
            <Button size="sm" variant="ghost" onClick={dismissRestored}>
              OK
            </Button>
          </span>
        </div>
      )}

      <div className={cx('grid gap-4', !single && 'lg:grid-cols-[16rem_1fr]')}>
        {/* Contacts */}
        {!single && (
          <Card className="flex max-h-[calc(100vh-14rem)] flex-col overflow-hidden lg:sticky lg:top-[200px]">
            <div className="space-y-2 border-b border-black/10 p-2 dark:border-white/10">
              <input className={inputClass} placeholder="Search contacts…" value={contactQuery} onChange={(e) => setContactQuery(e.target.value)} />
              <div className="flex flex-wrap gap-1">
                {(
                  [
                    ['all', 'All'],
                    ['proposals', 'To review'],
                    ['open', 'Open items'],
                    ['exceptions', 'Notes'],
                  ] as const
                ).map(([k, label]) => (
                  <Tag key={k} onClick={() => setContactFilter(k)} active={contactFilter === k}>
                    {label}
                  </Tag>
                ))}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              <button
                onClick={() => {
                  setContact(null);
                  setShown(PAGE);
                }}
                className={cx('block w-full border-b border-black/5 px-3 py-2 text-left text-sm dark:border-white/5', !contact ? 'bg-indigo-600/10 font-semibold' : 'hover:bg-black/5 dark:hover:bg-white/5')}
              >
                All contacts <span className="font-normal opacity-60">({result.contacts.length})</span>
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
                    <ContactCounters e={e} />
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
        )}

        {/* Detail */}
        <div className="min-w-0 space-y-3">
          {(selected || single) && (
            <ContactHeader
              code={(selected ?? result.contacts[0]).code}
              name={(selected ?? result.contacts[0]).name}
              lines={(selected ?? result.contacts[0]).rowIds.length}
              balance={fmt((selected ?? result.contacts[0]).balance)}
              open={perContact.get((selected ?? result.contacts[0]).key)!}
              fmt={fmt}
            />
          )}

          <div className="flex flex-wrap items-center gap-2 border-b border-black/10 dark:border-white/10">
            {(['matches', 'exceptions'] as const).map((k) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={cx('-mb-px border-b-2 px-3 py-2 text-sm font-medium', tab === k ? 'border-indigo-600 text-indigo-700 dark:text-indigo-300' : 'border-transparent opacity-70 hover:opacity-100')}
              >
                {k === 'matches' ? `Matches (${scoped.length})` : `Notes & exceptions (${exScoped.length})`}
              </button>
            ))}
            <button onClick={() => setHelp((h) => !h)} className="ml-auto rounded-md px-2 py-1 text-xs opacity-60 hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10" aria-expanded={help}>
              Keyboard & legend (?)
            </button>
          </div>

          {help && <HelpPanel />}

          {tab === 'matches' && (
            <>
              {/* Facets */}
              <Card className="space-y-2.5 p-3">
                <FacetRow label="Type">
                  {FAMILY_ORDER.map((f) => {
                    const ks = kindsInScope.filter((k) => KIND_META[k].family === f);
                    if (!ks.length) return null;
                    const allOn = ks.every((k) => kinds.has(k));
                    return (
                      <span key={f} className="inline-flex flex-wrap items-center gap-1.5 rounded-lg bg-black/[0.03] py-1 pl-2 pr-1 dark:bg-white/[0.04]">
                        <button
                          type="button"
                          onClick={() => toggleFamily(f)}
                          aria-pressed={allOn}
                          title={`${FAMILY[f].description} Click to filter the whole family.`}
                          className={cx('inline-flex items-center gap-1.5 rounded px-1 text-xs font-semibold hover:underline', allOn && 'text-indigo-700 dark:text-indigo-300')}
                        >
                          <FamilyDot family={f} />
                          {FAMILY[f].label}
                        </button>
                        {ks.map((k) => (
                          <KindTag key={k} kind={k} count={counts.kind.get(k) ?? 0} active={kinds.has(k)} onClick={() => filters.kind(k)} />
                        ))}
                      </span>
                    );
                  })}
                </FacetRow>
                <div className="flex flex-wrap gap-x-6 gap-y-2.5">
                  <FacetRow label="Confidence">
                    {TIER_ORDER.map((tr) => (
                      <TierTag key={tr} tier={tr} count={counts.tier.get(tr) ?? 0} active={tiers.has(tr)} onClick={() => filters.tier(tr)} />
                    ))}
                  </FacetRow>
                  <FacetRow label="Status">
                    {STATUS_ORDER.filter((s) => (counts.st.get(s) ?? 0) > 0 || statuses.has(s)).map((s) => (
                      <StatusTag key={s} status={s} count={counts.st.get(s) ?? 0} active={statuses.has(s)} onClick={() => filters.status(s)} />
                    ))}
                  </FacetRow>
                </div>
                <div className="flex flex-wrap items-center gap-2 border-t border-black/5 pt-2.5 dark:border-white/5">
                  <input ref={searchRef} className={cx(inputClass, 'w-72')} placeholder="Search id, reference, description, amount… ( / )" value={search} onChange={(e) => setSearch(e.target.value)} />
                  <span className="text-sm opacity-60">
                    {filtered.length} of {scoped.length} shown
                  </span>
                  {anyFilter && (
                    <button type="button" onClick={clearFilters} className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                      Clear filters
                    </button>
                  )}
                  <div className="ml-auto flex gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setExpanded(expanded.size ? new Set() : new Set(visibleIds))}>
                      {expanded.size ? 'Collapse all' : 'Expand all'}
                    </Button>
                    <Button
                      size="sm"
                      variant="good"
                      disabled={!shownPlan.length}
                      onClick={() => approve(shownPlan)}
                      title="Approves the suggested matches in the current view that don't conflict. 'To review' items are included only when you filter Status to To review. Near misses, balance-forward and alternatives are always approved one by one."
                    >
                      Approve {shownPlan.length} shown
                    </Button>
                  </div>
                </div>
              </Card>

              {items.length === 0 && (
                <Card className="p-6 text-center text-sm opacity-70">
                  Nothing matches these filters.{' '}
                  {anyFilter && (
                    <button className="font-medium text-indigo-600 hover:underline" onClick={clearFilters}>
                      Clear filters
                    </button>
                  )}
                </Card>
              )}

              <div className="space-y-1.5">
                {visible.map((it) => {
                  const row = (g: MatchGroup) => (
                    <MatchRow
                      key={g.id}
                      group={g}
                      rowsById={rowsById}
                      status={status.get(g.id)!}
                      precision={p}
                      expanded={expanded.has(g.id)}
                      focused={focusedId === g.id}
                      onToggle={onToggle}
                      onFocus={setFocusedId}
                      actions={actions}
                      filters={filters}
                      activeKind={kinds.has(g.kind)}
                      activeTier={tiers.has(g.tier)}
                      contactLabel={contact || single ? undefined : `${contactsByKey.get(g.contactKey)!.code} · ${contactsByKey.get(g.contactKey)!.name}`}
                      blockedBy={blockedBy(g)}
                    />
                  );
                  if (it.kind === 'single') return row(it.group);
                  const anchor = groupById.get(it.groups[0].id)!;
                  const target = rowsById.get(Number(anchor.altKey!.slice(4)));
                  return (
                    <div key={it.key} className="space-y-1.5 rounded-xl border border-dashed border-amber-500/60 bg-amber-500/[0.03] p-1.5">
                      <div className="px-1.5 text-xs font-medium text-amber-800 dark:text-amber-300">
                        {it.groups.length} alternative ways to clear {target ? `${target.transactionId} (${fmt(target.net)})` : 'the same line'}. Approve at most one.
                      </div>
                      {it.groups.map(row)}
                    </div>
                  );
                })}
              </div>
              {items.length > shown && (
                <div className="text-center">
                  <Button onClick={() => setShown((n) => n + PAGE)}>Show more ({items.length - shown})</Button>
                </div>
              )}

              {(selected || single) && (
                <Card className="p-3">
                  <h3 className="mb-2 text-sm font-semibold">Open items after your approvals</h3>
                  <OpenTable items={outcome.openItems.filter((o) => o.row.contactKey === (selected ?? result.contacts[0]).key)} fmt={fmt} />
                </Card>
              )}
            </>
          )}

          {tab === 'exceptions' && (
            <>
              <div className="flex flex-wrap items-center gap-1.5">
                {[...exCounts].map(([k, n]) => (
                  <Tag key={k} count={n} active={exKinds.has(k)} onClick={() => setExKinds((s) => toggle(s, k))}>
                    {EXCEPTION_LABEL[k]}
                  </Tag>
                ))}
                {exKinds.size > 0 && (
                  <button className="ml-1 text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400" onClick={() => setExKinds(new Set())}>
                    Clear
                  </button>
                )}
              </div>
              <Card className="divide-y divide-black/5 dark:divide-white/5">
                {exShown.length === 0 && <p className="p-4 text-sm opacity-60">Nothing to flag.</p>}
                {exShown.slice(0, 500).map((x) => (
                  <div key={x.id} className="flex gap-3 px-3 py-2.5 text-sm">
                    <span
                      className={cx('mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-bold', x.severity === 'warning' ? 'bg-amber-500/20 text-amber-800 dark:text-amber-300' : 'bg-sky-500/15 text-sky-800 dark:text-sky-300')}
                      title={x.severity === 'warning' ? 'Warning' : 'Note'}
                    >
                      {x.severity === 'warning' ? '!' : 'i'}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex flex-wrap items-center gap-1.5">
                        <Tag active={exKinds.has(x.kind)} onClick={() => setExKinds((s) => toggle(s, x.kind))}>
                          {EXCEPTION_LABEL[x.kind]}
                        </Tag>
                        {x.contactKey && !contact && !single && (
                          <button className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400" onClick={() => setContact(x.contactKey)}>
                            {contactsByKey.get(x.contactKey)!.code} · {contactsByKey.get(x.contactKey)!.name}
                          </button>
                        )}
                      </div>
                      <div>{x.message}</div>
                      {x.rowIds.length > 0 && (
                        <div className="mt-0.5 text-xs opacity-60">
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

function FacetRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-20 shrink-0 text-xs font-semibold uppercase tracking-wide opacity-50">{label}</span>
      {children}
    </div>
  );
}

function ContactCounters({ e }: { e: { review: number; approved: number; notes: number; open: number } }) {
  const parts: [string, string][] = [];
  if (e.review) parts.push(['bg-sky-500', `${e.review} to review`]);
  if (e.approved) parts.push(['bg-emerald-500', `${e.approved} approved`]);
  if (e.notes) parts.push(['bg-amber-500', `${e.notes} note${e.notes > 1 ? 's' : ''}`]);
  if (!e.open) parts.push(['bg-emerald-500', 'fully cleared']);
  if (!parts.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-x-2.5 gap-y-0.5 text-[11px] opacity-75">
      {parts.map(([dot, label]) => (
        <span key={label} className="inline-flex items-center gap-1">
          <span className={cx('h-1.5 w-1.5 rounded-full', dot)} />
          {label}
        </span>
      ))}
    </div>
  );
}

function ContactHeader({
  code,
  name,
  lines,
  balance,
  open,
  fmt,
}: {
  code: string;
  name: string;
  lines: number;
  balance: string;
  open: { open: number; openNet: number };
  fmt: (c: number) => string;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 className="text-lg font-semibold">
        {code} · {name}
      </h2>
      <span className="text-sm opacity-70">
        {lines} lines · balance {balance} · open after approvals {fmt(open.openNet)} in {open.open} line(s)
      </span>
    </div>
  );
}

function HelpPanel() {
  const keys: [string, string][] = [
    ['j / ↓', 'next match'],
    ['k / ↑', 'previous match'],
    ['Enter', 'expand / collapse'],
    ['a', 'approve'],
    ['d', 'dismiss'],
    ['u', 'undo'],
    ['/', 'search'],
    ['?', 'this panel'],
  ];
  return (
    <Card className="grid gap-4 p-4 text-sm md:grid-cols-2">
      <div>
        <h3 className="mb-2 font-semibold">Keyboard</h3>
        <dl className="grid grid-cols-[5rem_1fr] gap-y-1">
          {keys.map(([k, v]) => (
            <div key={k} className="contents">
              <dt>
                <kbd className="rounded border border-black/20 px-1.5 py-0.5 font-mono text-xs dark:border-white/20">{k}</kbd>
              </dt>
              <dd className="opacity-80">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-xs opacity-60">Click a match first, or press j to start.</p>
      </div>
      <div>
        <h3 className="mb-2 font-semibold">Match types</h3>
        <ul className="space-y-2">
          {FAMILY_ORDER.map((f) => (
            <li key={f}>
              <div className="flex items-center gap-1.5 font-medium">
                <FamilyDot family={f} />
                {FAMILY[f].label}
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {KIND_ORDER.filter((k) => KIND_META[k].family === f).map((k) => (
                  <KindTag key={k} kind={k} />
                ))}
              </div>
              <p className="mt-0.5 text-xs opacity-60">{FAMILY[f].description}</p>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs opacity-60">Hover any tag for its meaning; click it to filter.</p>
      </div>
    </Card>
  );
}

function OpenTable({ items, fmt }: { items: ReturnType<typeof applyDecisions>['openItems']; fmt: (c: number) => string }) {
  if (!items.length) return <p className="text-sm text-emerald-600 dark:text-emerald-400">Nothing open: fully cleared.</p>;
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
              {o.kind === 'residual' && <span className="mr-1 rounded bg-amber-500/20 px-1 text-[10px] font-semibold uppercase text-amber-800 dark:text-amber-300">residual</span>}
              {o.row.description}
            </td>
            <td className={cx('py-1 text-right font-mono tabular-nums', o.row.net < 0 && 'text-red-600 dark:text-red-400')}>{fmt(o.row.net)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
