import { matchRestoredEntry } from '../../src/tools/split-restore.js';
import { ToshlEntry } from '../../src/utils/types.js';

// After a split is undone, Toshl deletes the children and restores the original as a NEW
// entry with a new id (verified against a live account on 2026-10-06). The matcher picks
// that entry out of the day's entries. A wrong pick would point a later edit or re-split at
// someone else's entry, so the cases that matter most are the ones where it must not match.

const original = {
    id: '100', amount: -238.54, currency: { code: 'EUR', rate: 1, main_rate: 1, fixed: false },
    date: '2026-10-06', desc: 'Mastercard payment', account: 'acc-1', category: 'cat-1', tags: ['t-1'],
    created: '2026-10-06T07:02:31Z', modified: 'm1', deleted: true, split: { children: ['201', '202'] },
} as ToshlEntry;

const restored = {
    id: '300', amount: -238.54, currency: { code: 'EUR', rate: 1, main_rate: 1, fixed: false },
    date: '2026-10-06', desc: 'Mastercard payment', account: 'acc-1', category: 'cat-1', tags: ['t-1'],
    created: '2026-10-06T07:02:31Z', modified: 'm2',
} as ToshlEntry;

describe('matchRestoredEntry', () => {
    it('finds the one entry that is the original under a new id', () => {
        expect(matchRestoredEntry(original, [restored])).toEqual({ found: restored });
    });

    it('finds it among unrelated entries', () => {
        const other = { ...restored, id: '301', desc: 'Groceries', amount: -12.3 } as ToshlEntry;

        expect(matchRestoredEntry(original, [other, restored])).toEqual({ found: restored });
    });

    it('reports none for an empty list', () => {
        expect(matchRestoredEntry(original, [])).toEqual({ none: true });
    });

    it('ignores the original id itself', () => {
        const stale = { ...restored, id: '100' } as ToshlEntry;

        expect(matchRestoredEntry(original, [stale])).toEqual({ none: true });
    });

    it('ignores deleted entries', () => {
        const deleted = { ...restored, deleted: true } as ToshlEntry;

        expect(matchRestoredEntry(original, [deleted])).toEqual({ none: true });
    });

    // Split children carry the parent's created timestamp, so created alone proves nothing.
    it('ignores split children, which share the original created timestamp', () => {
        const child = { ...restored, id: '201', split: { parent: '100', children: ['201', '202'] } } as ToshlEntry;

        expect(matchRestoredEntry(original, [child])).toEqual({ none: true });
    });

    it('ignores an entry that is itself a split parent', () => {
        const parent = { ...restored, split: { children: ['400', '401'] } } as ToshlEntry;

        expect(matchRestoredEntry(original, [parent])).toEqual({ none: true });
    });

    it('accepts an empty split.children list as unsplit', () => {
        const unsplit = { ...restored, split: { children: [] } } as ToshlEntry;

        expect(matchRestoredEntry(original, [unsplit])).toEqual({ found: unsplit });
    });

    it.each([
        ['another account', { account: 'acc-2' }],
        ['another date', { date: '2026-10-05' }],
        ['a one-cent amount difference', { amount: -238.53 }],
        ['another category', { category: 'cat-2' }],
        ['another description', { desc: 'Something else' }],
        ['another created timestamp', { created: '2026-10-05T10:00:00Z' }],
    ])('ignores an entry with %s', (_label, overrides) => {
        const candidate = { ...restored, ...overrides } as ToshlEntry;

        expect(matchRestoredEntry(original, [candidate])).toEqual({ none: true });
    });

    it('compares amounts in integer cents, absorbing floating-point noise', () => {
        const noisy = { ...original, amount: -0.29 } as ToshlEntry;
        const candidate = { ...restored, amount: -0.29 } as ToshlEntry;

        expect(matchRestoredEntry(noisy, [candidate])).toEqual({ found: candidate });
    });

    it('does not match when an amount cannot be read exactly', () => {
        const fine = { ...original, amount: -1.234 } as ToshlEntry;
        const candidate = { ...restored, amount: -1.234 } as ToshlEntry;

        expect(matchRestoredEntry(fine, [candidate])).toEqual({ none: true });
    });

    it('treats a missing description as empty on both sides', () => {
        const { desc: _a, ...bare } = original;
        const { desc: _b, ...bareRestored } = restored;
        const withEmpty = { ...restored, desc: '' } as ToshlEntry;

        expect(matchRestoredEntry(bare as ToshlEntry, [bareRestored as ToshlEntry])).toEqual({ found: bareRestored });
        expect(matchRestoredEntry(bare as ToshlEntry, [withEmpty])).toEqual({ found: withEmpty });
    });

    it('does not require created when either side lacks one', () => {
        const { created: _c, ...noCreated } = restored;

        expect(matchRestoredEntry(original, [noCreated as ToshlEntry])).toEqual({ found: noCreated });
    });

    // Never pick one of two identical candidates: the wrong pick points a re-split at a
    // different entry than the one that was restored.
    it('reports both ids and picks neither when two entries are identical', () => {
        const twin = { ...restored, id: '301' } as ToshlEntry;

        expect(matchRestoredEntry(original, [restored, twin])).toEqual({ ambiguous: ['300', '301'] });
    });
});
