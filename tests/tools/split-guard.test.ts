import { toCents, evaluateSplitParent, evaluateSplitParts } from '../../src/tools/split-guard.js';

// Toshl does not check that split children add up to the parent: the parent is hidden as
// soon as the first child exists, so a short split silently drops money from the account.
// This guard is the only check standing in the way, and the tool description promises it,
// so the cases that matter most are the ones where it must refuse.

describe('toCents', () => {
    it('converts whole-cent amounts to integer cents', () => {
        expect(toCents(-61.05)).toBe(-6105);
        expect(toCents(12)).toBe(1200);
        expect(toCents(0)).toBe(0);
    });

    // 1.15 * 100 is 114.99999999999999 and -0.29 * 100 is -28.999999999999996.
    it('absorbs floating-point noise in a single amount', () => {
        expect(toCents(1.15)).toBe(115);
        expect(toCents(-0.29)).toBe(-29);
        expect(toCents(0.07)).toBe(7);
    });

    it('sums the verified real-world split exactly', () => {
        const parts = [-31.80, -10.82, -11.64, -6.79].map(toCents) as number[];
        expect(parts).toEqual([-3180, -1082, -1164, -679]);
        expect(parts.reduce((sum, cents) => sum + cents, 0)).toBe(toCents(-61.05));
    });

    it.each([
        ['a string', '-61.05'],
        ['null', null],
        ['undefined', undefined],
        ['NaN', NaN],
        ['Infinity', Infinity],
        ['-Infinity', -Infinity],
        ['an object', { amount: 1 }],
    ])('reports undefined for %s', (_label, value) => {
        expect(toCents(value)).toBeUndefined();
    });

    // Rounding 1.234 to 123 cents would let a part that is 0.001 short pass the sum check.
    it('reports undefined for amounts finer than a cent rather than rounding them away', () => {
        expect(toCents(1.234)).toBeUndefined();
        expect(toCents(-0.005)).toBeUndefined();
    });
});

describe('evaluateSplitParent', () => {
    const PLAIN = { id: '100', amount: -61.05, account: 'acc-1', category: 'cat-1' };

    it('allows a plain expense and reports its amount in cents', () => {
        expect(evaluateSplitParent(PLAIN)).toEqual({ allowed: true, amountCents: -6105 });
    });

    it('allows an income', () => {
        expect(evaluateSplitParent({ ...PLAIN, amount: 250 })).toEqual({ allowed: true, amountCents: 25000 });
    });

    it('allows an entry whose split object is empty', () => {
        expect(evaluateSplitParent({ ...PLAIN, split: { children: [] } })).toEqual({ allowed: true, amountCents: -6105 });
    });

    it('refuses a split child, so a part cannot be split again', () => {
        expect(evaluateSplitParent({ ...PLAIN, split: { parent: '99', children: ['100', '101'] } }))
            .toEqual({ allowed: false, reason: 'split-child', parentId: '99' });
    });

    // A split parent is also deleted; the more specific reason is the useful one.
    it('refuses an entry that is already a split parent', () => {
        expect(evaluateSplitParent({ ...PLAIN, deleted: true, split: { children: ['101', '102'] } }))
            .toEqual({ allowed: false, reason: 'already-split' });
    });

    it('refuses a deleted entry', () => {
        expect(evaluateSplitParent({ ...PLAIN, deleted: true })).toEqual({ allowed: false, reason: 'deleted' });
    });

    it('refuses a transfer', () => {
        expect(evaluateSplitParent({ ...PLAIN, transaction: { id: '7', account: 'acc-2', currency: { code: 'EUR' } } }))
            .toEqual({ allowed: false, reason: 'transfer' });
    });

    it('refuses a repeating entry', () => {
        expect(evaluateSplitParent({ ...PLAIN, repeat: { id: '8', frequency: 'monthly', interval: 1, start: '2026-01-01' } }))
            .toEqual({ allowed: false, reason: 'repeating' });
    });

    it.each([
        ['a missing amount', { ...PLAIN, amount: undefined }],
        ['a string amount', { ...PLAIN, amount: '-61.05' }],
        ['a sub-cent amount', { ...PLAIN, amount: -61.055 }],
        ['a null entry', null],
        ['an undefined entry', undefined],
    ])('fails closed on %s', (_label, entry) => {
        expect(evaluateSplitParent(entry)).toEqual({ allowed: false, reason: 'unknown-amount' });
    });
});

describe('evaluateSplitParts', () => {
    const part = (amount: unknown, category: unknown = 'cat-1') => ({ amount, category });

    it('allows parts that add up exactly, including the verified real-world split', () => {
        expect(evaluateSplitParts(-61.05, [part(-31.80), part(-10.82), part(-11.64), part(-6.79)]))
            .toEqual({ allowed: true });
    });

    // 0.1 + 0.2 !== 0.3 in floating point; in cents it is 10 + 20 === 30.
    it('compares in cents, so parts that only drift as floats still match', () => {
        expect(evaluateSplitParts(0.3, [part(0.1), part(0.2)])).toEqual({ allowed: true });
    });

    it('allows an income split into positive parts', () => {
        expect(evaluateSplitParts(100, [part(60), part(40)])).toEqual({ allowed: true });
    });

    it('refuses parts that are one cent short, and reports both totals', () => {
        expect(evaluateSplitParts(-10, [part(-6), part(-3.99)])).toEqual({
            allowed: false,
            reason: 'sum-mismatch',
            parentCents: -1000,
            partsCents: -999,
            differenceCents: -1,
        });
    });

    it('refuses parts that are one cent over', () => {
        expect(evaluateSplitParts(-10, [part(-6), part(-4.01)])).toMatchObject({
            allowed: false,
            reason: 'sum-mismatch',
            differenceCents: 1,
        });
    });

    it.each([
        ['no parts', []],
        ['one part', [part(-10)]],
    ])('refuses %s', (_label, parts) => {
        expect(evaluateSplitParts(-10, parts)).toEqual({ allowed: false, reason: 'too-few-parts', count: parts.length });
    });

    it('refuses a parts value that is not an array', () => {
        expect(evaluateSplitParts(-10, { 0: part(-6), 1: part(-4) })).toEqual({ allowed: false, reason: 'too-few-parts', count: 0 });
    });

    it.each([
        ['missing', undefined],
        ['empty', ''],
        ['not a string', 42],
    ])('refuses a part whose category is %s', (_label, category) => {
        expect(evaluateSplitParts(-10, [part(-6), { amount: -4, category }]))
            .toEqual({ allowed: false, reason: 'missing-category', index: 1 });
    });

    // A malformed later part would only fail after earlier parts are saved, forcing a rollback.
    it.each([
        ['tags that are not an array', { tags: 't-1' }, 'tags'],
        ['tags that are not all strings', { tags: ['t-1', 2] }, 'tags'],
        ['a description that is not a string', { desc: 42 }, 'desc'],
    ])('refuses a part with %s', (_label, extra, field) => {
        expect(evaluateSplitParts(-10, [part(-6), { ...part(-4), ...extra }]))
            .toEqual({ allowed: false, reason: 'invalid-field', index: 1, field });
    });

    it('allows parts with string tags and a string description', () => {
        expect(evaluateSplitParts(-10, [{ ...part(-6), tags: ['t-1'], desc: 'lunch' }, { ...part(-4), tags: [] }]))
            .toEqual({ allowed: true });
    });

    it('refuses a part that is not an object', () => {
        expect(evaluateSplitParts(-10, [part(-6), null])).toEqual({ allowed: false, reason: 'missing-category', index: 1 });
    });

    it.each([
        ['zero', 0],
        ['NaN', NaN],
        ['Infinity', -Infinity],
        ['a string', '-4'],
        ['finer than a cent', -4.001],
    ])('refuses a part whose amount is %s', (_label, amount) => {
        expect(evaluateSplitParts(-10, [part(-6), part(amount)]))
            .toEqual({ allowed: false, reason: 'invalid-amount', index: 1 });
    });

    // Without this, -14 and +4 would "add up" to -10 and turn part of an expense into income.
    it('refuses a part of the opposite sign to the parent even when the sum matches', () => {
        expect(evaluateSplitParts(-10, [part(-14), part(4)]))
            .toEqual({ allowed: false, reason: 'sign-mismatch', index: 1 });
    });

    it('refuses any part of a zero-amount parent, since no part can share its sign', () => {
        expect(evaluateSplitParts(0, [part(-5), part(5)]))
            .toEqual({ allowed: false, reason: 'sign-mismatch', index: 0 });
    });

    it('fails closed when the parent amount is unreadable', () => {
        expect(evaluateSplitParts(NaN, [part(-6), part(-4)])).toEqual({ allowed: false, reason: 'unknown-amount' });
    });
});
