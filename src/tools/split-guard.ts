/**
 * Validation for `entry_split`, run before anything is written.
 *
 * Toshl's native split is a sequence of plain entry creates, each carrying
 * `split.parent`. Toshl hides the parent as soon as the FIRST child exists, and it never
 * checks that the children add up to the parent. A split that stops short — or whose
 * parts were simply mis-added — silently removes money from the account, and nothing in
 * Toshl will say so. This guard is what stands in the way, and it is written to fail
 * CLOSED: an amount that cannot be read exactly is refused, never assumed.
 *
 * All sums are compared in integer cents. Floating-point totals drift (0.1 + 0.2 is not
 * 0.3), and a guard that compares floats either refuses correct splits or, with a
 * tolerance, waves through ones that are a cent off.
 *
 * What it does NOT protect against: the parent is read by one request and the children
 * are written by later ones, so an edit to the parent in between is not seen. And it
 * cannot make the creates atomic — `entry_split` handles a part that fails to save by
 * undoing the split, which is a separate request that can itself fail.
 */

/** Tolerance for floating-point noise when deciding whether an amount is whole cents. */
const CENT_EPSILON = 1e-6;

/**
 * Converts an amount to integer cents.
 *
 * Amounts finer than a cent are reported as unreadable rather than rounded: rounding
 * 1.234 to 123 cents would let a part that is 0.001 short pass the sum check. That
 * refuses entries in currencies with more than two decimals, which is the safe failure.
 *
 * @param amount Amount as it appears on an entry or in tool arguments
 * @returns Integer cents, or undefined if the amount is not a finite whole-cent number
 */
export const toCents = (amount: unknown): number | undefined => {
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
        return undefined;
    }

    const scaled = amount * 100;
    const cents = Math.round(scaled);
    if (Math.abs(scaled - cents) > CENT_EPSILON) {
        return undefined;
    }

    // Math.round(-0.4) is -0; normalize so callers never see a signed zero.
    return cents === 0 ? 0 : cents;
};

/** Why an entry cannot be split, or its amount in cents if it can. */
export type SplitParentVerdict =
    | { allowed: true; amountCents: number }
    | { allowed: false; reason: 'split-child'; parentId: string }
    | { allowed: false; reason: 'already-split' }
    | { allowed: false; reason: 'deleted' }
    | { allowed: false; reason: 'transfer' }
    | { allowed: false; reason: 'repeating' }
    | { allowed: false; reason: 'unknown-amount' };

/**
 * Decides whether an entry may be split.
 *
 * Split membership is checked before `deleted`, because a split parent is also deleted
 * and "already split" is the reason worth reporting.
 *
 * @param entry Entry payload from the API
 * @returns The verdict, carrying the amount in cents when the entry may be split
 */
export const evaluateSplitParent = (entry: unknown): SplitParentVerdict => {
    if (typeof entry !== 'object' || entry === null) {
        return { allowed: false, reason: 'unknown-amount' };
    }

    const { split, deleted, transaction, repeat, amount } = entry as {
        split?: { parent?: unknown; children?: unknown } | null;
        deleted?: unknown;
        transaction?: unknown;
        repeat?: unknown;
        amount?: unknown;
    };

    if (split?.parent !== undefined && split.parent !== null && split.parent !== '') {
        return { allowed: false, reason: 'split-child', parentId: String(split.parent) };
    }

    // Anything but an absent or empty children list counts as already split.
    const children = split?.children;
    if (children !== undefined && children !== null && !(Array.isArray(children) && children.length === 0)) {
        return { allowed: false, reason: 'already-split' };
    }

    if (deleted) {
        return { allowed: false, reason: 'deleted' };
    }

    if (transaction) {
        return { allowed: false, reason: 'transfer' };
    }

    if (repeat) {
        return { allowed: false, reason: 'repeating' };
    }

    const amountCents = toCents(amount);
    if (amountCents === undefined) {
        return { allowed: false, reason: 'unknown-amount' };
    }

    return { allowed: true, amountCents };
};

/** Why a set of parts was refused, or that it may be written. */
export type SplitPartsVerdict =
    | { allowed: true }
    | { allowed: false; reason: 'unknown-amount' }
    | { allowed: false; reason: 'too-few-parts'; count: number }
    | { allowed: false; reason: 'missing-category'; index: number }
    | { allowed: false; reason: 'invalid-field'; index: number; field: 'tags' | 'desc' }
    | { allowed: false; reason: 'invalid-amount'; index: number }
    | { allowed: false; reason: 'sign-mismatch'; index: number }
    | { allowed: false; reason: 'sum-mismatch'; parentCents: number; partsCents: number; differenceCents: number };

/**
 * Decides whether a set of parts is a valid split of an amount.
 *
 * @param parentAmount Amount of the entry being split
 * @param parts Parts as supplied in tool arguments
 * @returns The verdict; a sum mismatch carries both totals and parent minus parts
 */
export const evaluateSplitParts = (parentAmount: number, parts: unknown): SplitPartsVerdict => {
    const parentCents = toCents(parentAmount);
    if (parentCents === undefined) {
        return { allowed: false, reason: 'unknown-amount' };
    }

    if (!Array.isArray(parts) || parts.length < 2) {
        return { allowed: false, reason: 'too-few-parts', count: Array.isArray(parts) ? parts.length : 0 };
    }

    let partsCents = 0;
    for (let index = 0; index < parts.length; index++) {
        const part = parts[index] as { amount?: unknown; category?: unknown; tags?: unknown; desc?: unknown } | null;

        if (typeof part?.category !== 'string' || part.category === '') {
            return { allowed: false, reason: 'missing-category', index };
        }

        // Toshl would reject these, but only after the parts before this one are saved.
        if (part.tags !== undefined && !(Array.isArray(part.tags) && part.tags.every((tag) => typeof tag === 'string'))) {
            return { allowed: false, reason: 'invalid-field', index, field: 'tags' };
        }
        if (part.desc !== undefined && typeof part.desc !== 'string') {
            return { allowed: false, reason: 'invalid-field', index, field: 'desc' };
        }

        const cents = toCents(part.amount);
        if (cents === undefined || cents === 0) {
            return { allowed: false, reason: 'invalid-amount', index };
        }

        // Without this, -14 and +4 "add up" to -10 and part of an expense becomes income.
        if (Math.sign(cents) !== Math.sign(parentCents)) {
            return { allowed: false, reason: 'sign-mismatch', index };
        }

        partsCents += cents;
    }

    if (partsCents !== parentCents) {
        return {
            allowed: false,
            reason: 'sum-mismatch',
            parentCents,
            partsCents,
            differenceCents: parentCents - partsCents,
        };
    }

    return { allowed: true };
};
