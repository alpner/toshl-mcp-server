/**
 * Identifies the entry Toshl restored after a split was undone.
 *
 * Verified against a live account on 2026-10-06: undoing a split deletes the children and
 * restores the original as a NEW entry. The old id stays deleted, still carrying its stale
 * `split.children`, and the new entry has the same account, date, amount, currency,
 * description, category, tags and `created` timestamp. Nothing in the response links the
 * two, so the restored entry can only be recognised by matching what it has in common with
 * the original. This is written to fail CLOSED: an entry that cannot be matched on every
 * field is never reported, and two equally good matches are reported as ambiguous rather
 * than guessed between.
 *
 * What it does NOT protect against: an unrelated entry that is identical to the original in
 * every compared field (a genuine duplicate) cannot be told apart from the restored one. It
 * is then either the only candidate and gets reported, or one of several and the result is
 * ambiguous. Callers should present the match as what Toshl returned, not as proof.
 */

import { toCents } from './split-guard.js';
import { ToshlEntry } from '../utils/types.js';

/** The restored entry, the ids of several equally good candidates, or no candidate. */
export type RestoredEntryMatch =
    | { found: ToshlEntry }
    | { ambiguous: string[] }
    | { none: true };

/** Whether an entry stands alone: not a split child and not a split parent. */
const isUnsplit = (entry: ToshlEntry): boolean => {
    const { parent, children } = entry.split ?? {};
    if (parent !== undefined && parent !== null && parent !== '') {
        return false;
    }

    return children === undefined || children === null || (Array.isArray(children) && children.length === 0);
};

const isRestoredCopy = (original: ToshlEntry, candidate: ToshlEntry): boolean => {
    if (candidate.id === original.id || candidate.deleted || !isUnsplit(candidate)) {
        return false;
    }

    if (candidate.account !== original.account || candidate.date !== original.date) {
        return false;
    }

    // Integer cents, and an amount that cannot be read exactly never matches.
    const originalCents = toCents(original.amount);
    if (originalCents === undefined || originalCents !== toCents(candidate.amount)) {
        return false;
    }

    if (candidate.category !== original.category || (candidate.desc ?? '') !== (original.desc ?? '')) {
        return false;
    }

    // `created` is carried over by the restore, but split children carry it too, so it only
    // narrows the match; it does not make one.
    if (original.created && candidate.created && original.created !== candidate.created) {
        return false;
    }

    return true;
};

/**
 * Finds the entry Toshl restored in place of a split parent.
 *
 * @param original The split parent as read before the undo
 * @param candidates Entries listed for the original's account and date
 * @returns The restored entry, the candidate ids if more than one entry matches, or none
 */
export const matchRestoredEntry = (original: ToshlEntry, candidates: ToshlEntry[]): RestoredEntryMatch => {
    const matches = candidates.filter((candidate) => isRestoredCopy(original, candidate));

    if (matches.length === 1) {
        return { found: matches[0] };
    }

    if (matches.length > 1) {
        return { ambiguous: matches.map((match) => String(match.id)) };
    }

    return { none: true };
};
