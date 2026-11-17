import { DOC_CLASS_LABEL, EXPECTED_SIDE, type Side } from '../parse/doc-class';
import { descriptionKeys, digitCore, formatCents, isMangledText, nameKey, textTokens, txnKey } from '../parse/values';
import { byDate, clamp, corroborate, describeDifference, sideOf, tierOf } from './evidence';
import { findSubsets } from './subset';
import type {
  CleanProgress,
  CleanResult,
  CleanSettings,
  ContactSummary,
  GroupKind,
  LedgerException,
  LedgerRow,
  MatchGroup,
} from './types';

/** Max lines in a reference-linked component for the exhaustive zero-sum check. */
const COMPONENT_ENUM_LIMIT = 14;
/** Max lines that may share a Reference value for it to count as a link (else it is generic). */
const SHARED_REF_LIMIT = 8;
/** Alternatives kept per ambiguous combination target. */
const MAX_ALTERNATIVES = 4;

type DraftGroup = Omit<MatchGroup, 'id'>;

/** Default explanation of each kind's starting score. */
const BASIS: Record<GroupKind, string> = {
  zero: 'The line is zero: nothing to settle',
  'same-id': 'Lines share one Transaction Id and net to zero',
  linked: 'Lines are linked by document references',
  partial: 'Lines are linked, but do not fully net',
  pair: 'Exact equal-and-opposite amounts',
  'fifo-pair': 'Identical amounts on both sides, paired oldest-first: which pair is assumed',
  combo: 'Several lines add up exactly to one line',
  nil: 'Everything left nets to exactly zero',
  near: 'Amounts are close but not equal',
  fifo: 'Allocation is assumed (balance-forward), not evidenced',
};

/**
 * Clean a contact ledger. Every contact is worked independently, in the
 * order a careful accountant would:
 *
 *   0. zero-value lines
 *   1. lines sharing a Transaction Id (reversals, settlements under one id, duplicates)
 *   2. lines linked by Reference/Description citing another line's Transaction Id
 *      (full settlements, settlements completed by amount, partial settlements)
 *   3. exact amounts without a link: unique pairs, identical amounts FIFO, combinations
 *   4. contacts whose remaining lines net to zero
 *   5. near misses within tolerance / withholding rates       (never suggested)
 *   6. balance-forward FIFO allocation of what is left        (never suggested)
 *
 * Suggested groups are mutually exclusive by construction (a line is consumed
 * the moment a suggested group takes it). Alternatives, near misses and
 * balance-forward proposals may overlap; the reviewer chooses.
 */
export function cleanLedger(
  rows: LedgerRow[],
  settings: CleanSettings,
  onProgress?: (p: CleanProgress) => void,
): CleanResult {
  const t0 = Date.now();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const sign = settings.invoiceSign;
  const side = (r: LedgerRow): Side => sideOf(r, sign);
  const fmt = (c: number) => formatCents(c, settings.precision);
  const label = (r: LedgerRow) => `${r.transactionId} (${fmt(r.net)})`;
  const gl = settings.glAccount;
  /** Vocabulary: customer/supplier ledgers speak of charges and settlements, GL accounts of debits and credits. */
  const W = gl
    ? { charge: 'debit', charges: 'debits', settlement: 'credit', settlements: 'credits' }
    : { charge: 'charge', charges: 'charges', settlement: 'settlement', settlements: 'settlements' };

  const drafts: DraftGroup[] = [];
  const exceptions: Omit<LedgerException, 'id'>[] = [];
  let comboBudgetLeft = settings.totalComboBudgetMs;

  // ---- contacts --------------------------------------------------------------
  const contactRows = new Map<string, LedgerRow[]>();
  for (const r of rows) {
    let list = contactRows.get(r.contactKey);
    if (!list) contactRows.set(r.contactKey, (list = []));
    list.push(r);
  }
  const contactKeys = [...contactRows.keys()].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const contacts: ContactSummary[] = contactKeys.map((key) => {
    const list = contactRows.get(key)!;
    return {
      key,
      code: list[0].contactCode,
      name: list[0].contactName,
      rowIds: list.map((r) => r.id),
      balance: list.reduce((s, r) => s + r.net, 0),
      charges: list.filter((r) => r.net !== 0 && side(r) === 'charge').length,
      settlements: list.filter((r) => r.net !== 0 && side(r) === 'settlement').length,
    };
  });

  /** Which contacts each Transaction Id appears on (to spot lines citing another contact's document). */
  const idOwners = new Map<string, Set<string>>();
  for (const r of rows) {
    let s = idOwners.get(r.txnKey);
    if (!s) idOwners.set(r.txnKey, (s = new Set()));
    s.add(r.contactKey);
  }

  /** Lines still unmatched by a suggested group, per contact (shared with the global pass). */
  const freeByContact = new Map<string, Set<number>>();

  contactKeys.forEach((key, ci) => {
    onProgress?.({ contactsDone: ci, contactsTotal: contactKeys.length, contact: contacts[ci].code });
    const list = contactRows.get(key)!;
    const free = new Set<number>();
    freeByContact.set(key, free);

    const sum = (ids: Iterable<number>) => {
      let s = 0;
      for (const id of ids) s += byId.get(id)!.net;
      return s;
    };
    const freeRows = () => list.filter((r) => free.has(r.id));
    /**
     * A line whose Reference/Description cites a document that exists only on
     * another contact says it belongs there. It is held back from amount-only
     * matching here (and reported as a possible misposting).
     */
    const held = new Set<number>();
    for (const r of list) {
      for (const t of new Set([...textTokens(r.reference), ...textTokens(r.description)])) {
        const owners = t.length >= 4 && t !== r.txnKey ? idOwners.get(t) : undefined;
        if (owners && !owners.has(key)) {
          held.add(r.id);
          break;
        }
      }
    }
    const amountRows = () => list.filter((r) => free.has(r.id) && !held.has(r.id));
    const bothSides = (rs: LedgerRow[]) => rs.some((r) => side(r) === 'charge') && rs.some((r) => side(r) === 'settlement');

    const emit = (
      kind: GroupKind,
      members: LedgerRow[],
      base: number,
      reasons: string[],
      opts: {
        suggested: boolean;
        individualOnly?: boolean;
        altKey?: string | null;
        residualFromId?: number | null;
        maxConfidence?: number;
        /** Why the starting score is what it is (shown when hovering the score). */
        basis?: string;
      },
    ): DraftGroup => {
      const ev = kind === 'zero' ? null : corroborate(members, sign, gl);
      const residual = members.reduce((s, m) => s + m.net, 0);
      let residualFromId: number | null = null;
      if (residual !== 0) {
        residualFromId =
          opts.residualFromId ??
          [...members]
            .filter((m) => Math.sign(m.net) === Math.sign(residual))
            .sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || byDate(a, b))[0].id;
      }
      const cap = opts.maxConfidence ?? 100;
      const raw = base + (ev?.points ?? 0);
      const confidence = clamp(raw, 0, cap);
      const g: DraftGroup = {
        contactKey: key,
        kind,
        memberIds: [...members].sort(byDate).map((m) => m.id),
        residual,
        residualFromId,
        confidence,
        tier: tierOf(confidence),
        score: { basis: opts.basis ?? BASIS[kind], base, parts: ev?.parts ?? [], cap: raw > cap ? cap : null },
        reasons: [...reasons, ...(ev?.reasons ?? [])],
        suggested: opts.suggested,
        individualOnly: opts.individualOnly ?? false,
        altKey: opts.altKey ?? null,
      };
      drafts.push(g);
      if (opts.suggested) for (const m of members) free.delete(m.id);
      return g;
    };

    // ---- 0. zero-value lines ------------------------------------------------
    for (const r of list) {
      if (r.net === 0) emit('zero', [r], 100, ['Net is zero'], { suggested: true });
      else free.add(r.id);
    }

    // ---- 1. same Transaction Id ---------------------------------------------
    const byTxn = new Map<string, LedgerRow[]>();
    for (const r of freeRows()) {
      let b = byTxn.get(r.txnKey);
      if (!b) byTxn.set(r.txnKey, (b = []));
      b.push(r);
    }
    for (const [, bucket] of byTxn) {
      if (bucket.length < 2) continue;
      const id = bucket[0].transactionId;

      // Same id, same sign, same amount, more than once: a classic double posting.
      const dupKey = new Map<number, LedgerRow[]>();
      for (const r of bucket) {
        let l = dupKey.get(r.net);
        if (!l) dupKey.set(r.net, (l = []));
        l.push(r);
      }
      for (const [net, l] of dupKey) {
        if (l.length < 2) continue;
        exceptions.push({
          kind: 'duplicate',
          severity: 'warning',
          contactKey: key,
          rowIds: l.map((r) => r.id),
          message: `Transaction Id "${id}" is posted ${l.length} times for the same amount ${fmt(net)}. One of them may be a duplicate posting.`,
        });
      }

      if (bucket.reduce((s, r) => s + r.net, 0) === 0 && bothSides(bucket)) {
        const reversal = bucket.length === 2;
        emit('same-id', bucket, 88, [reversal ? `posted and reversed under the same Transaction Id "${id}"` : `all ${bucket.length} lines under Transaction Id "${id}" net to zero`], {
          suggested: true,
        });
        continue;
      }
      // Equal-and-opposite pairs inside the id (e.g. a reversal next to a re-posting).
      const charges = bucket.filter((r) => side(r) === 'charge').sort(byDate);
      const settles = bucket.filter((r) => side(r) === 'settlement').sort(byDate);
      for (const c of charges) {
        const s = settles.find((x) => free.has(x.id) && x.net === -c.net);
        if (s && free.has(c.id)) emit('same-id', [c, s], 85, [`equal and opposite under the same Transaction Id "${id}"`], { suggested: true, basis: 'Equal and opposite lines under the same Transaction Id' });
      }
      const rest = bucket.filter((r) => free.has(r.id));
      if (rest.length >= 2 && bothSides(rest)) {
        buildPartial(rest, [`settled under the same Transaction Id "${id}"`], 72);
      }
    }

    // ---- 2. reference links --------------------------------------------------
    {
      const fr = freeRows();
      const byKey = new Map<string, LedgerRow[]>();
      const keysByCore = new Map<string, Set<string>>();
      for (const r of fr) {
        let l = byKey.get(r.txnKey);
        if (!l) byKey.set(r.txnKey, (l = []));
        l.push(r);
        const core = digitCore(r.transactionId);
        if (core) {
          let s = keysByCore.get(core);
          if (!s) keysByCore.set(core, (s = new Set()));
          s.add(r.txnKey);
        }
      }
      const parent = new Map<number, number>(fr.map((r) => [r.id, r.id]));
      const find = (x: number): number => {
        while (parent.get(x) !== x) {
          parent.set(x, parent.get(parent.get(x)!)!);
          x = parent.get(x)!;
        }
        return x;
      };
      const linkReason = new Map<number, Set<string>>();
      /** 2 = cites the Transaction Id, 1 = number / shared Reference, 0.5 = description keys only. */
      const strength = new Map<number, number>();
      const link = (a: LedgerRow, b: LedgerRow, why: string, level: 2 | 1 | 0.5) => {
        const ra = find(a.id);
        const rb = find(b.id);
        if (ra !== rb) parent.set(ra, rb);
        for (const x of [a.id, b.id]) {
          let s = linkReason.get(x);
          if (!s) linkReason.set(x, (s = new Set()));
          s.add(why);
          strength.set(x, Math.max(strength.get(x) ?? 0, level));
        }
      };

      for (const r of fr) {
        const tokens = new Set([...textTokens(r.reference), ...textTokens(r.description)]);
        tokens.delete(r.txnKey);
        tokens.delete(key);
        // Exact id citations first; a bare number only counts when it adds a new link.
        const cited = new Set<number>();
        for (const t of tokens) {
          for (const o of byKey.get(t) ?? []) {
            if (o.id !== r.id && Math.sign(o.net) !== Math.sign(r.net)) {
              link(r, o, `${r.transactionId} cites ${o.transactionId}`, 2);
              cited.add(o.id);
            }
          }
        }
        for (const t of tokens) {
          if (byKey.has(t)) continue;
          const core = digitCore(t);
          const keys = core ? keysByCore.get(core) : undefined;
          if (keys && keys.size === 1) {
            const k = [...keys][0];
            if (k === r.txnKey) continue;
            for (const o of byKey.get(k) ?? []) {
              if (o.id !== r.id && !cited.has(o.id) && Math.sign(o.net) !== Math.sign(r.net)) {
                link(r, o, `${r.transactionId} mentions number ${core} (${o.transactionId})`, 1);
              }
            }
          }
        }
      }
      // Lines sharing an uncommon Reference value (PO number, contract, cheque no.).
      const byRef = new Map<string, LedgerRow[]>();
      for (const r of fr) {
        const k = r.reference ? txnKey(r.reference) : '';
        if (k.length < 3 || k === key) continue;
        let l = byRef.get(k);
        if (!l) byRef.set(k, (l = []));
        l.push(r);
      }
      for (const [, l] of byRef) {
        if (l.length < 2 || l.length > SHARED_REF_LIMIT || !bothSides(l)) continue;
        for (let i = 1; i < l.length; i++) link(l[0], l[i], `same Reference "${l[0].reference}"`, 1);
      }

      // Lines whose descriptions carry the same identifier keys (e.g. meter E7 + period 01/2025):
      // an accrual and its reversal, a recurring charge and its true-up.
      const byDescKey = new Map<string, LedgerRow[]>();
      for (const r of fr) {
        const keys = descriptionKeys(r.description);
        if (keys.length < 2 || keys.every((k) => k.startsWith('P'))) continue;
        const sig = keys.join(' · ');
        let l = byDescKey.get(sig);
        if (!l) byDescKey.set(sig, (l = []));
        l.push(r);
      }
      for (const [sig, l] of byDescKey) {
        if (l.length < 2 || l.length > 6 || !bothSides(l)) continue;
        const why = `same description keys (${sig.replace(/P(\d{4})-(\d{2})/g, '$2/$1')})`;
        for (let i = 1; i < l.length; i++) link(l[0], l[i], why, 0.5);
      }

      const comps = new Map<number, LedgerRow[]>();
      for (const r of fr) {
        if (!linkReason.has(r.id)) continue;
        const root = find(r.id);
        let l = comps.get(root);
        if (!l) comps.set(root, (l = []));
        l.push(r);
      }
      const ordered = [...comps.values()].sort((a, b) => byDate([...a].sort(byDate)[0], [...b].sort(byDate)[0]));
      for (const comp of ordered) {
        if (comp.length < 2 || !bothSides(comp) || comp.some((r) => !free.has(r.id))) continue;
        const reasons = [...new Set(comp.flatMap((r) => [...(linkReason.get(r.id) ?? [])]))].slice(0, 4);
        const strong = comp.every((r) => (strength.get(r.id) ?? 0) === 2);
        const descOnly = comp.every((r) => (strength.get(r.id) ?? 0) === 0.5);
        const total = comp.reduce((s, r) => s + r.net, 0);
        if (total === 0) {
          emit('linked', comp, strong ? 85 : descOnly ? 70 : 72, reasons, {
            suggested: true,
            basis: strong
              ? 'A line cites the other line’s Transaction Id, and they net to zero'
              : descOnly
                ? 'Descriptions carry the same identifiers (e.g. meter + period), and they net to zero'
                : 'Linked by a number in the text or a shared Reference, and they net to zero',
          });
          continue;
        }
        // Remainder settled by an unlinked line (e.g. second instalment without a reference).
        const extSide = Math.sign(-total);
        const pool = (descOnly ? [] : freeRows()).filter((r) => !comp.includes(r) && !held.has(r.id) && Math.sign(r.net) === extSide);
        if (pool.length) {
          const res = findSubsets(
            pool.map((r) => ({ id: r.id, value: Math.abs(r.net) })),
            Math.abs(total),
            Math.min(3, settings.maxComboSize),
            2,
            settings.perTargetBudgetMs,
          );
          if (res.totalFound === 1 && res.exhausted) {
            const extra = res.combos[0].map((id) => byId.get(id)!);
            emit('linked', [...comp, ...extra], strong ? 70 : 60, [...reasons, `remaining ${fmt(Math.abs(total))} settled by ${extra.map(label).join(' + ')} (amount match)`], {
              suggested: true,
              maxConfidence: 90,
              basis: 'Linked lines, with the remainder settled by an unreferenced line of the exact amount',
            });
            continue;
          }
        }
        // A fully-netting subset inside the component (one line in it is unrelated).
        if (comp.length <= COMPONENT_ENUM_LIMIT) {
          const best = largestZeroSubset(comp, side);
          if (best && best.length >= 2) {
            emit('linked', best, strong ? 80 : 68, reasons, { suggested: true, basis: 'Part of a linked set that nets to zero (another linked line did not fit)' });
            const rest = comp.filter((r) => free.has(r.id));
            if (rest.length >= 2 && bothSides(rest)) buildPartial(rest, reasons, strong ? 68 : 58, !descOnly);
            continue;
          }
        }
        buildPartial(comp, reasons, strong ? 70 : descOnly ? 45 : 60, !descOnly);
      }
    }

    /**
     * Linked lines that don't fully net. Lines on the residual side that are
     * not touched at all (newest first) are dropped back to open; the residual
     * is carried by the one document that is genuinely part-settled (FIFO).
     */
    function buildPartial(members: LedgerRow[], reasons: string[], base: number, suggested = true) {
      let set = [...members];
      let residual = set.reduce((s, r) => s + r.net, 0);
      const rSign = Math.sign(residual);
      for (const r of [...set].filter((x) => Math.sign(x.net) === rSign).sort(byDate).reverse()) {
        if (Math.abs(r.net) <= Math.abs(residual) && set.length > 2) {
          set = set.filter((x) => x !== r);
          residual -= r.net;
        }
      }
      if (residual === 0) {
        if (bothSides(set)) emit('linked', set, base + 5, reasons, { suggested: true, basis: 'Linked lines that net to zero once untouched lines are left open' });
        return;
      }
      if (!bothSides(set)) return;
      const from = set.filter((x) => Math.sign(x.net) === Math.sign(residual)).sort(byDate).reverse()[0];
      const rSide = side(from);
      const diff = describeDifference(residual, Math.abs(from.net), rSide, settings);
      emit('partial', set, base, [...reasons, diff.label, `${from.transactionId} stays open for ${fmt(residual)}`, ...(suggested ? [] : ['linked by description only: amounts differ, review before approving'])], {
        suggested,
        basis: suggested ? 'Linked lines that do not fully net: the difference stays open' : 'Linked only by description keys, and the amounts differ',
        residualFromId: from.id,
        maxConfidence: 85,
      });
    }

    // ---- 3a. exact pairs -------------------------------------------------------
    {
      const byAbs = new Map<number, { c: LedgerRow[]; s: LedgerRow[] }>();
      for (const r of amountRows()) {
        const a = Math.abs(r.net);
        let e = byAbs.get(a);
        if (!e) byAbs.set(a, (e = { c: [], s: [] }));
        (side(r) === 'charge' ? e.c : e.s).push(r);
      }
      for (const [abs, { c, s }] of [...byAbs].sort((a, b) => b[0] - a[0])) {
        if (!c.length || !s.length) continue;
        // Opposite signs are guaranteed: same absolute value, different sides.
        if (c.length === 1 && s.length === 1) {
          emit('pair', [c[0], s[0]], 62, [`the only ${W.charge} and ${W.settlement} of ${fmt(abs)} on this ${gl ? 'account' : 'contact'}`], {
            suggested: true,
            maxConfidence: 92,
            basis: `The only ${W.charge} and ${W.settlement} of this exact amount (no document link)`,
          });
          continue;
        }
        // Several identical amounts. Documented pairs first, then oldest-to-oldest.
        const cs = [...c].sort(byDate);
        const ss = [...s].sort(byDate);
        const scored: { c: LedgerRow; s: LedgerRow; pts: number }[] = [];
        for (const x of cs) {
          for (const y of ss) {
            const ev = corroborate([x, y], sign, gl);
            if (ev.documentary > 0) scored.push({ c: x, s: y, pts: ev.points });
          }
        }
        scored.sort((a, b) => b.pts - a.pts || byDate(a.c, b.c));
        for (const p of scored) {
          if (free.has(p.c.id) && free.has(p.s.id)) {
            emit('pair', [p.c, p.s], 55, [`${c.length} ${W.charges} and ${s.length} ${W.settlements} of ${fmt(abs)}; this pair is documented`], {
              suggested: true,
              maxConfidence: 85,
              basis: 'One of several identical amounts, chosen because this pair is documented',
            });
          }
        }
        const rc = cs.filter((x) => free.has(x.id));
        const rs = ss.filter((x) => free.has(x.id));
        const n = Math.min(rc.length, rs.length);
        for (let i = 0; i < n; i++) {
          emit('fifo-pair', [rc[i], rs[i]], 50, [`${c.length} ${W.charges} and ${s.length} ${W.settlements} of ${fmt(abs)}; paired oldest-first (FIFO)`], {
            suggested: true,
            maxConfidence: 70,
          });
        }
      }
    }

    // ---- 3b. combinations ------------------------------------------------------
    {
      const targets = amountRows().sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || byDate(a, b));
      let limited = false;
      for (const t of targets) {
        if (!free.has(t.id)) continue;
        if (comboBudgetLeft <= 0) {
          limited = true;
          break;
        }
        const pool = amountRows().filter((r) => r.id !== t.id && Math.sign(r.net) !== Math.sign(t.net) && Math.abs(r.net) < Math.abs(t.net));
        if (pool.length < 2) continue;
        const ts = Date.now();
        const res = findSubsets(
          pool.map((r) => ({ id: r.id, value: Math.abs(r.net) })),
          Math.abs(t.net),
          settings.maxComboSize,
          16,
          Math.min(settings.perTargetBudgetMs, comboBudgetLeft),
        );
        comboBudgetLeft -= Date.now() - ts;
        if (res.timedOut) limited = true;
        const combos = res.combos.filter((c) => c.length >= 2);
        if (!combos.length) continue;

        const tSide = side(t);
        const ranked = combos
          .map((ids) => {
            const ms = ids.map((id) => byId.get(id)!);
            const ev = corroborate([t, ...ms], sign, gl);
            return { ms, ev, pts: ev.points - (ev.prepayment ? 4 : 0) - ms.length };
          })
          .sort((a, b) => b.pts - a.pts || a.ms.length - b.ms.length);
        const what = (n: number) =>
          gl
            ? `one ${tSide === 'charge' ? 'debit' : 'credit'} offset by ${n} ${tSide === 'charge' ? 'credits' : 'debits'}`
            : tSide === 'settlement'
              ? `one settlement covers ${n} charges`
              : `one charge settled in ${n} instalments`;

        const unique = res.totalFound === 1 && res.exhausted;
        const clearWinner = ranked.length > 1 && ranked[0].ev.documentary > 0 && ranked[0].pts - ranked[1].pts >= 10;
        if (unique || clearWinner) {
          const best = ranked[0];
          emit('combo', [t, ...best.ms], unique ? 58 : 50, [what(best.ms.length), unique ? 'the only combination that clears this amount' : `best-documented of ${res.totalFound} combinations`], {
            suggested: true,
            maxConfidence: 85,
            basis: unique ? 'The only combination of lines that adds up to this amount' : `The best-documented of ${res.totalFound} combinations that add up to this amount`,
          });
          continue;
        }
        const altKey = `alt:${t.id}`;
        for (const alt of ranked.slice(0, MAX_ALTERNATIVES)) {
          emit('combo', [t, ...alt.ms], 30, [what(alt.ms.length), `${res.exhausted ? res.totalFound : `${res.totalFound}+`} combinations clear ${fmt(Math.abs(t.net))}; pick the right one`], {
            suggested: false,
            altKey,
            maxConfidence: 45,
            basis: `One of ${res.exhausted ? res.totalFound : `${res.totalFound}+`} combinations that add up to this amount: nothing says which is right`,
          });
        }
        exceptions.push({
          kind: 'ambiguous',
          severity: 'info',
          contactKey: key,
          rowIds: [t.id],
          message: `${label(t)} can be cleared by ${res.exhausted ? res.totalFound : `more than ${res.totalFound}`} different combinations of lines. The best are offered as alternatives; nothing is suggested.`,
        });
      }
      if (limited) {
        exceptions.push({
          kind: 'search-limit',
          severity: 'info',
          contactKey: key,
          rowIds: [],
          message: 'The combination search hit its time limit on this contact; some multi-line matches may not have been found. Raise the limits in Settings to search longer.',
        });
      }
    }

    // ---- 4. whatever is left nets to zero ----------------------------------------
    {
      const fr = amountRows();
      if (fr.length >= 2 && bothSides(fr) && sum(fr.map((r) => r.id)) === 0) {
        emit('nil', fr, 82, [`the ${gl ? 'account' : 'contact'}'s remaining ${fr.length} lines net to exactly zero; nothing is outstanding`], { suggested: true });
      }
    }

    // ---- 5. near misses ------------------------------------------------------------
    {
      const fr = amountRows();
      const cands: { c: LedgerRow; s: LedgerRow; d: number; wht: boolean; label: string; days: number }[] = [];
      const charges = fr.filter((r) => side(r) === 'charge');
      const settles = fr.filter((r) => side(r) === 'settlement');
      if (charges.length * settles.length <= 250_000) {
        for (const c of charges) {
          for (const s of settles) {
            const d = c.net + s.net;
            if (d === 0) continue;
            // A "difference" must be small next to the amounts themselves (0.10 vs 0.50 is not a near miss).
            if (Math.abs(d) * 10 > Math.max(Math.abs(c.net), Math.abs(s.net))) continue;
            const rSide: Side = Math.sign(d) === sign ? 'charge' : 'settlement';
            const diff = describeDifference(d, Math.abs(c.net), rSide, settings);
            if (!diff.withinTolerance) continue;
            const cd = c.effectiveDate ?? c.dueDate;
            const sd = s.effectiveDate ?? s.dueDate;
            const days = cd && sd ? Math.abs(Date.parse(sd) - Date.parse(cd)) / 86_400_000 : 9999;
            cands.push({ c, s, d, wht: diff.withholding, label: diff.label, days });
          }
        }
      }
      cands.sort((a, b) => Number(b.wht) - Number(a.wht) || Math.abs(a.d) - Math.abs(b.d) || a.days - b.days || byDate(a.c, b.c));
      const used = new Set<number>();
      for (const k of cands) {
        if (used.has(k.c.id) || used.has(k.s.id)) continue;
        used.add(k.c.id);
        used.add(k.s.id);
        const rivals = cands.filter((x) => x !== k && (x.s === k.s || x.c === k.c) && Math.abs(x.d) === Math.abs(k.d)).length;
        emit('near', [k.c, k.s], 42, [k.label, ...(rivals ? [`${rivals} other line(s) differ by the same amount`] : [])], {
          suggested: false,
          individualOnly: true,
          residualFromId: Math.sign(k.d) === sign ? k.c.id : k.s.id,
          maxConfidence: 65,
        });
      }
    }

    // ---- 6. balance-forward FIFO ---------------------------------------------------
    if (settings.balanceForward && !gl) {
      const fr = amountRows();
      const net = fr.reduce((s, r) => s + r.net, 0);
      if (fr.length >= 2 && bothSides(fr) && net !== 0) {
        const domSign = Math.sign(net);
        const minority = fr.filter((r) => Math.sign(r.net) !== domSign);
        const dominant = fr.filter((r) => Math.sign(r.net) === domSign).sort(byDate);
        const target = Math.abs(minority.reduce((s, r) => s + r.net, 0));
        const taken: LedgerRow[] = [];
        let cum = 0;
        for (const r of dominant) {
          if (cum >= target) break;
          taken.push(r);
          cum += Math.abs(r.net);
        }
        const last = taken[taken.length - 1];
        const domSide = side(dominant[0]);
        const sig = [...minority, ...taken].map((r) => r.id).sort((a, b) => a - b).join(',');
        const duplicate = drafts.some((g) => g.contactKey === key && [...g.memberIds].sort((a, b) => a - b).join(',') === sig);
        const rest = cum - target;
        if (!duplicate) emit(
          'fifo',
          [...minority, ...taken],
          22,
          [
            domSide === 'charge'
              ? `applies all ${minority.length} unmatched settlement(s) (${fmt(target)}) to the oldest ${taken.length} charge(s)`
              : `applies all ${minority.length} unmatched charge(s) (${fmt(target)}) against the oldest ${taken.length} settlement(s)`,
            rest ? `${last.transactionId} stays open for ${fmt(domSign * rest)}` : 'clears exactly',
            'no document links: use when the contact is kept on balance-forward',
          ],
          { suggested: false, individualOnly: true, residualFromId: rest ? last.id : null, maxConfidence: 35 },
        );
      }
    }

    // ---- contact-level exceptions -----------------------------------------------------
    const wrongSign = list.filter((r) => {
      const exp = EXPECTED_SIDE[r.docClass];
      return r.net !== 0 && exp !== null && exp !== side(r);
    });
    if (wrongSign.length) {
      exceptions.push({
        kind: 'sign',
        severity: 'info',
        contactKey: key,
        rowIds: wrongSign.map((r) => r.id),
        message: `${wrongSign.length} line(s) carry the opposite sign to their document type: ${wrongSign
          .slice(0, 5)
          .map((r) => `${r.transactionId} (${DOC_CLASS_LABEL[r.docClass]}, ${fmt(r.net)})`)
          .join(', ')}${wrongSign.length > 5 ? '…' : ''}. A reversal, a cancellation, or a sign error?`,
      });
    }
    const seen = new Map<string, LedgerRow[]>();
    for (const r of list) {
      if (r.net === 0) continue;
      const k = `${r.net}|${r.effectiveDate ?? ''}|${(r.reference ?? r.description ?? '').toLowerCase()}`;
      if (!r.effectiveDate || !(r.reference || r.description)) continue;
      let l = seen.get(k);
      if (!l) seen.set(k, (l = []));
      l.push(r);
    }
    for (const [, l] of seen) {
      if (l.length < 2 || new Set(l.map((r) => r.txnKey)).size < 2) continue;
      exceptions.push({
        kind: 'possible-duplicate',
        severity: 'info',
        contactKey: key,
        rowIds: l.map((r) => r.id),
        message: `${l.length} lines have the same amount ${fmt(l[0].net)}, date and wording but different Transaction Ids (${l.map((r) => r.transactionId).join(', ')}). Possible duplicate entry.`,
      });
    }
  });

  // ---- cross-contact checks --------------------------------------------------------
  // Some systems number documents per contact (every customer has an invoice "1"),
  // so ids colliding across contacts are only suspicious when that is rare.
  const keyOwners = new Map<string, Set<string>>();
  for (const r of rows) {
    let s = keyOwners.get(r.txnKey);
    if (!s) keyOwners.set(r.txnKey, (s = new Set()));
    s.add(r.contactKey);
  }
  const contactByKey = new Map(contacts.map((c) => [c.key, c]));
  const shared = [...keyOwners].filter(([, o]) => o.size > 1);
  const idsAreGlobal = shared.length <= Math.max(3, keyOwners.size * 0.02);
  if (idsAreGlobal) {
    for (const [k, owners] of shared) {
      const ids = rows.filter((r) => r.txnKey === k).map((r) => r.id);
      exceptions.push({
        kind: 'shared-id',
        severity: 'warning',
        contactKey: null,
        rowIds: ids,
        message: `Transaction Id "${byId.get(ids[0])!.transactionId}" appears under ${owners.size} contacts (${[...owners].map((o) => contactByKey.get(o)!.code).join(', ')}). It may be booked to the wrong contact.`,
      });
    }
    // Open lines that cite a document still open on another contact.
    const openByTxn = new Map<string, LedgerRow[]>();
    for (const free of freeByContact.values()) {
      for (const id of free) {
        const r = byId.get(id)!;
        let l = openByTxn.get(r.txnKey);
        if (!l) openByTxn.set(r.txnKey, (l = []));
        l.push(r);
      }
    }
    for (const free of freeByContact.values()) {
      for (const id of free) {
        const r = byId.get(id)!;
        const tokens = new Set([...textTokens(r.reference), ...textTokens(r.description)]);
        tokens.delete(r.txnKey);
        for (const t of tokens) {
          if (t.length < 4) continue;
          const hits = (openByTxn.get(t) ?? []).filter((o) => o.contactKey !== r.contactKey && Math.sign(o.net) !== Math.sign(r.net));
          if (!hits.length) continue;
          const o = hits[0];
          exceptions.push({
            kind: 'misposting',
            severity: 'warning',
            contactKey: r.contactKey,
            rowIds: [r.id, ...hits.map((h) => h.id)],
            message: `${label(r)} on ${r.contactCode} cites ${o.transactionId}, which is open on ${o.contactCode} (${o.contactName}). Possibly booked to the wrong contact. Correct it in the source system; it is not cleared here.`,
          });
          break;
        }
      }
    }
  } else {
    exceptions.push({
      kind: 'shared-id',
      severity: 'info',
      contactKey: null,
      rowIds: [],
      message: `${shared.length} Transaction Ids are reused across contacts. Ids look numbered per contact, so cross-contact checks by Id were skipped.`,
    });
  }
  // Contacts with the same name: open amounts that settle each other across the two codes.
  const byName = new Map<string, string[]>();
  for (const c of contacts) {
    const nk = nameKey(c.name);
    if (!nk) continue;
    let l = byName.get(nk);
    if (!l) byName.set(nk, (l = []));
    l.push(c.key);
  }
  for (const [, keys] of byName) {
    if (keys.length < 2) continue;
    const open = keys.flatMap((k) => [...freeByContact.get(k)!].map((id) => byId.get(id)!));
    for (const r of open) {
      const m = open.find((o) => o.contactKey !== r.contactKey && o.net === -r.net && side(r) === 'settlement');
      if (m) {
        exceptions.push({
          kind: 'misposting',
          severity: 'warning',
          contactKey: r.contactKey,
          rowIds: [r.id, m.id],
          message: `${label(r)} on ${r.contactCode} exactly offsets ${label(m)} on ${m.contactCode}. Same contact name under two codes; possibly booked to the duplicate account.`,
        });
      }
    }
  }

  // ---- counterparts outside the file's period ------------------------------------------
  const months = rows.map((r) => r.effectiveDate ?? r.dueDate).filter((d): d is string => !!d).map((d) => d.slice(0, 7)).sort();
  if (months.length) {
    const first = months[0];
    const last = months[months.length - 1];
    for (const c of contacts) {
      const before: LedgerRow[] = [];
      const after: LedgerRow[] = [];
      for (const id of freeByContact.get(c.key)!) {
        const r = byId.get(id)!;
        const periods = descriptionKeys(r.description).filter((k) => k.startsWith('P')).map((k) => k.slice(1));
        if (periods.length !== 1) continue;
        if (periods[0] < first) before.push(r);
        else if (periods[0] === last && /acc|accru|استحقاق|مستحق/i.test(r.description ?? '')) after.push(r);
      }
      if (before.length) {
        exceptions.push({
          kind: 'other-period',
          severity: 'info',
          contactKey: c.key,
          rowIds: before.map((r) => r.id),
          message: `${before.length} open line(s) refer to a period before this file starts (${first}): ${before.slice(0, 4).map((r) => `"${r.description}"`).join(', ')}${before.length > 4 ? '…' : ''}. Their counterpart (e.g. the original accrual) is probably in the previous period's ledger.`,
        });
      }
      if (after.length) {
        exceptions.push({
          kind: 'other-period',
          severity: 'info',
          contactKey: c.key,
          rowIds: after.map((r) => r.id),
          message: `${after.length} open accrual line(s) for the file's last period (${last}): ${after.slice(0, 4).map((r) => `"${r.description}"`).join(', ')}${after.length > 4 ? '…' : ''}. Their reversal is probably posted after this file ends.`,
        });
      }
    }
  }
  const mangled = rows.filter((r) => isMangledText(r.description) || isMangledText(r.reference));
  if (mangled.length) {
    exceptions.push({
      kind: 'lost-text',
      severity: 'warning',
      contactKey: null,
      rowIds: mangled.map((r) => r.id),
      message: `${mangled.length} line(s) have a Description or Reference made of "#" characters (e.g. "${(isMangledText(mangled[0].description) ? mangled[0].description : mangled[0].reference) ?? ''}"). The export replaced non-Latin (Arabic) text with "#", so these lines could not be matched on their wording. Re-export as .xlsx directly (not through a text/code-page step) to keep it.`,
    });
  }

  // ---- unapplied / wrong-side balances (after suggested matches) ---------------------
  for (const c of gl ? [] : contacts) {
    const free = [...freeByContact.get(c.key)!].map((id) => byId.get(id)!);
    const open = free.filter((r) => side(r) === 'settlement');
    if (open.length) {
      exceptions.push({
        kind: 'unapplied',
        severity: 'info',
        contactKey: c.key,
        rowIds: open.map((r) => r.id),
        message: `${open.length} settlement line(s) totalling ${fmt(open.reduce((s, r) => s + r.net, 0))} are not matched to any charge (unapplied cash, on-account credit, or a missing invoice).`,
      });
    }
    if (c.balance !== 0 && Math.sign(c.balance) !== sign) {
      exceptions.push({
        kind: 'opposite-balance',
        severity: 'info',
        contactKey: c.key,
        rowIds: [],
        message: `${c.code} has a balance of ${fmt(c.balance)} on the settlement side (${sign === 1 ? 'a credit balance on a receivable' : 'a debit balance on a payable'}).`,
      });
    }
  }
  onProgress?.({ contactsDone: contactKeys.length, contactsTotal: contactKeys.length, contact: '' });

  // ---- ids ---------------------------------------------------------------------------
  const width = Math.max(5, String(drafts.length).length);
  const groups: MatchGroup[] = drafts.map((d, i) => ({ id: `M${String(i + 1).padStart(width, '0')}`, ...d }));
  const exWidth = Math.max(4, String(exceptions.length).length);
  return {
    groups,
    exceptions: exceptions.map((e, i) => ({ id: `X${String(i + 1).padStart(exWidth, '0')}`, ...e })),
    contacts,
    settings,
    elapsedMs: Date.now() - t0,
  };
}

/** Largest subset of a small component that nets to exactly zero with both sides present. */
function largestZeroSubset(comp: LedgerRow[], side: (r: LedgerRow) => Side): LedgerRow[] | null {
  const n = comp.length;
  let best = 0;
  let bestSize = 0;
  for (let mask = 1; mask < 1 << n; mask++) {
    let s = 0;
    let size = 0;
    let c = false;
    let st = false;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        s += comp[i].net;
        size++;
        if (side(comp[i]) === 'charge') c = true;
        else st = true;
      }
    }
    if (s === 0 && c && st && size > bestSize) {
      best = mask;
      bestSize = size;
    }
  }
  if (!bestSize) return null;
  return comp.filter((_, i) => best & (1 << i));
}
