import { jest } from '@jest/globals';

// Stub the HTTP layer so the whole validate/create/verify/rollback sequence can be observed
// without credentials. The stub behaves like Toshl did against a live account: the first
// child carrying split.parent hides the parent and links every child to it, and
// DELETE /entries/split/:id removes the children and restores the original as a NEW entry
// (verified 2026-10-06). The old id stays deleted and keeps its stale split.children.
type Call = (...args: any[]) => Promise<any>;
const mockGet = jest.fn<Call>();
const mockPost = jest.fn<Call>();
const mockDelete = jest.fn<Call>();
jest.mock('../../src/api/toshl-client.js', () => ({
    __esModule: true,
    default: { get: mockGet, post: mockPost, delete: mockDelete },
    ToshlApiClient: class {},
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleEntrySplitTool, handleEntrySplitUndoTool } = require('../../src/tools/entry-tools.js');

const ok = (data: unknown, headers: Record<string, string> = {}) => ({ data, status: 200, headers });

const PARENT = {
    id: '100', amount: -10, currency: { code: 'EUR', rate: 1, main_rate: 1, fixed: false },
    date: '2026-10-01', desc: 'split test', account: 'acc-cash', category: 'cat-orig', tags: ['t-orig'],
    images: [{ id: 'img-1', path: 'https://img.toshl.com/1/', status: 'uploaded' }],
    created: '2026-10-01T08:00:00Z', modified: 'm1',
};

const PARTS = [
    { amount: -6, category: 'cat-food', tags: ['t-1'] },
    { amount: -4, category: 'cat-other', desc: 'the rest' },
];

/** Mutable fake of one Toshl account's entries. */
let parent: Record<string, any>;
let children: Array<{ id: string; body: Record<string, any> }>;
let failGets: Set<string>;
let linkChildren: boolean;
// The original as Toshl restored it under a new id, once a split has been undone
let restored: Record<string, any> | undefined;
// What the old id reads as after an undo that did not restore it
let staleParent: Record<string, any> | undefined;
// Other live entries on the same account and date
let listed: Array<Record<string, any>>;
let listLink: string | undefined;

const childIds = () => children.map((child) => child.id);

const routeGet = async (path: string, _params?: Record<string, any>) => {
    if (failGets.has(path)) { throw new Error(`GET ${path} failed`); }
    if (path === '/entries') {
        return ok([...(restored ? [restored] : []), ...listed], listLink ? { link: listLink } : {});
    }
    if (restored && path === `/entries/${restored.id}`) {
        return ok(restored);
    }
    if (path === `/entries/${parent.id}`) {
        if (staleParent) { return ok(staleParent); }
        return ok(children.length > 0 && linkChildren
            ? { ...parent, deleted: true, split: { children: childIds() } }
            : parent);
    }
    const child = children.find((c) => path === `/entries/${c.id}`);
    if (child) {
        return ok({ ...child.body, id: child.id, split: { parent: parent.id, children: childIds() } });
    }
    throw new Error(`unexpected GET ${path}`);
};

const createChild = async (path: string, body: Record<string, any>) => {
    if (path !== '/entries') { throw new Error(`unexpected POST ${path}`); }
    const id = String(201 + children.length);
    children.push({ id, body });
    return ok(null, { location: `https://api.toshl.com/entries/${id}` });
};

const undoSplit = async (path: string) => {
    if (path !== `/entries/split/${parent.id}`) { throw new Error(`unexpected DELETE ${path}`); }
    const { split: _split, deleted: _deleted, ...original } = parent;
    staleParent = { ...parent, deleted: true, split: { children: childIds() } };
    restored = { ...original, id: '300', modified: 'm2' };
    children = [];
    return ok(undefined);
};

const textOf = (result: { content: Array<{ text: string }> }) => result.content[0].text;

beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockDelete.mockReset();
    parent = { ...PARENT };
    children = [];
    failGets = new Set();
    linkChildren = true;
    restored = undefined;
    staleParent = undefined;
    listed = [];
    listLink = undefined;
    mockGet.mockImplementation(routeGet);
    mockPost.mockImplementation(createChild);
    mockDelete.mockImplementation(undoSplit);
});

describe('entry_split', () => {
    test('creates one child per part, each inheriting the parent and linked to it', async () => {
        const result = await handleEntrySplitTool({ id: '100', parts: PARTS });

        expect(result.isError).toBeUndefined();
        expect(mockPost).toHaveBeenCalledTimes(2);
        for (const [path, body] of mockPost.mock.calls) {
            expect(path).toBe('/entries');
            expect(body).toMatchObject({
                split: { parent: '100' },
                account: 'acc-cash',
                date: '2026-10-01',
                currency: { code: 'EUR', rate: 1, main_rate: 1, fixed: false },
                images: [{ id: 'img-1' }],
            });
        }
        expect(mockDelete).not.toHaveBeenCalled();
    });

    test("takes amount, category and tags from each part, and the parent's description unless the part has one", async () => {
        await handleEntrySplitTool({ id: '100', parts: PARTS });

        const [first, second] = mockPost.mock.calls.map(([, body]) => body);
        expect(first).toMatchObject({ amount: -6, category: 'cat-food', tags: ['t-1'], desc: 'split test' });
        expect(second).toMatchObject({ amount: -4, category: 'cat-other', desc: 'the rest' });
        expect(second.tags).toBeUndefined();
    });

    test('forwards only the documented part fields, not whatever else the caller sent', async () => {
        await handleEntrySplitTool({
            id: '100',
            parts: [{ ...PARTS[0], account: 'acc-other', extra: { x: 1 } }, PARTS[1]],
        });

        const [, body] = mockPost.mock.calls[0];
        expect(body.account).toBe('acc-cash');
        expect(body.extra).toBeUndefined();
    });

    test('omits images when the parent has none', async () => {
        parent = { ...PARENT, images: [] };

        await handleEntrySplitTool({ id: '100', parts: PARTS });

        expect(mockPost.mock.calls[0][1].images).toBeUndefined();
    });

    test('returns the now-hidden parent and every child', async () => {
        const result = await handleEntrySplitTool({ id: '100', parts: PARTS });

        const body = JSON.parse(textOf(result));
        expect(body.parent).toMatchObject({ id: '100', deleted: true, split: { children: ['201', '202'] } });
        expect(body.children.map((c: { id: string }) => c.id)).toEqual(['201', '202']);
    });

    test('writes nothing when the parts do not add up, and reports both totals', async () => {
        const result = await handleEntrySplitTool({
            id: '100',
            parts: [{ amount: -6, category: 'cat-food' }, { amount: -3.99, category: 'cat-other' }],
        });

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain('-9.99');
        expect(textOf(result)).toContain('-10.00');
        expect(mockPost).not.toHaveBeenCalled();
        expect(mockDelete).not.toHaveBeenCalled();
    });

    test('writes nothing when a later part is malformed, rather than saving the first and rolling back', async () => {
        const result = await handleEntrySplitTool({
            id: '100',
            parts: [PARTS[0], { amount: -4, category: 'cat-other', tags: 't-1' }],
        });

        expect(result.isError).toBe(true);
        expect(mockPost).not.toHaveBeenCalled();
    });

    test('writes nothing when given fewer than two parts', async () => {
        const result = await handleEntrySplitTool({ id: '100', parts: [{ amount: -10, category: 'cat-food' }] });

        expect(result.isError).toBe(true);
        expect(mockPost).not.toHaveBeenCalled();
    });

    test.each([
        ['already a split parent', { deleted: true, split: { children: ['9', '10'] } }],
        ['a split child', { split: { parent: '99', children: ['100', '101'] } }],
        ['a transfer', { transaction: { id: '7', account: 'acc-2', currency: { code: 'EUR' } } }],
        ['repeating', { repeat: { id: '8', frequency: 'monthly', interval: 1, start: '2026-01-01' } }],
        ['deleted', { deleted: true }],
    ])('writes nothing when the entry is %s', async (_label, overrides) => {
        parent = { ...PARENT, ...overrides };

        const result = await handleEntrySplitTool({ id: '100', parts: PARTS });

        expect(result.isError).toBe(true);
        expect(mockPost).not.toHaveBeenCalled();
        expect(mockDelete).not.toHaveBeenCalled();
    });

    test('names the parent when asked to split a split child', async () => {
        parent = { ...PARENT, split: { parent: '99', children: ['100', '101'] } };

        const result = await handleEntrySplitTool({ id: '100', parts: PARTS });

        expect(textOf(result)).toContain('99');
    });

    test('writes nothing when the entry cannot be read', async () => {
        failGets.add('/entries/100');

        const result = await handleEntrySplitTool({ id: '100', parts: PARTS });

        expect(result.isError).toBe(true);
        expect(mockPost).not.toHaveBeenCalled();
    });

    test('undoes the split when a later part fails to save, and says so', async () => {
        mockPost.mockImplementation(async (path: string, body: Record<string, any>) => {
            if (children.length === 1) { throw new Error('boom'); }
            return createChild(path, body);
        });

        const result = await handleEntrySplitTool({ id: '100', parts: PARTS });

        expect(result.isError).toBe(true);
        expect(mockDelete).toHaveBeenCalledWith('/entries/split/100');
        expect(textOf(result)).toMatch(/rolled back/i);
        expect(children).toHaveLength(0);
    });

    test('lists the parent, every created child and the unassigned amount when the rollback fails', async () => {
        mockPost.mockImplementation(async (path: string, body: Record<string, any>) => {
            if (children.length === 1) { throw new Error('boom'); }
            return createChild(path, body);
        });
        mockDelete.mockRejectedValue(new Error('rollback boom'));

        const result = await handleEntrySplitTool({ id: '100', parts: PARTS });

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain('100');
        expect(textOf(result)).toContain('201');
        // -10.00 parent, -6.00 assigned to the one child that exists
        expect(textOf(result)).toContain('-4.00');
    });

    test("reports the restored entry's new id when a failed split is rolled back", async () => {
        mockPost.mockImplementation(async (path: string, body: Record<string, any>) => {
            if (children.length === 1) { throw new Error('boom'); }
            return createChild(path, body);
        });

        const result = await handleEntrySplitTool({ id: '100', parts: PARTS });

        expect(result.isError).toBe(true);
        expect(textOf(result)).toMatch(/rolled back/i);
        expect(textOf(result)).toMatch(/restored as entry 300/);
        expect(textOf(result)).toMatch(/retry .*300/i);
    });

    test('falls back to the plain rollback text when the restored entry cannot be identified', async () => {
        mockPost.mockImplementation(async (path: string, body: Record<string, any>) => {
            if (children.length === 1) { throw new Error('boom'); }
            return createChild(path, body);
        });
        failGets.add('/entries');

        const result = await handleEntrySplitTool({ id: '100', parts: PARTS });

        expect(result.isError).toBe(true);
        expect(textOf(result)).toMatch(/rolled back/i);
        expect(textOf(result)).toContain('the original entry was restored.');
        expect(textOf(result)).not.toMatch(/restored as entry/);
    });

    // The POST can land even though the client saw an error (a timeout, or the follow-up
    // GET failing). Toshl has then already hidden the parent, so it must still be undone.
    test('undoes the split when the first part saved on Toshl but the client saw a failure', async () => {
        failGets.add('/entries/201');

        const result = await handleEntrySplitTool({ id: '100', parts: PARTS });

        expect(result.isError).toBe(true);
        expect(mockDelete).toHaveBeenCalledWith('/entries/split/100');
        expect(children).toHaveLength(0);
    });

    test('does not attempt an undo when the first part failed and nothing was split', async () => {
        mockPost.mockRejectedValue(new Error('boom'));

        const result = await handleEntrySplitTool({ id: '100', parts: PARTS });

        expect(result.isError).toBe(true);
        expect(mockDelete).not.toHaveBeenCalled();
        expect(textOf(result)).toMatch(/unchanged/i);
    });

    test('reports the parent id when the first part failed and the parent cannot be re-read', async () => {
        mockPost.mockRejectedValue(new Error('boom'));
        mockGet.mockImplementation(async (path: string) => {
            if (mockPost.mock.calls.length > 0) { throw new Error('GET failed'); }
            return routeGet(path);
        });

        const result = await handleEntrySplitTool({ id: '100', parts: PARTS });

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain('100');
        expect(textOf(result)).not.toMatch(/unchanged/i);
    });

    test('undoes the split when Toshl does not record it as expected', async () => {
        linkChildren = false;

        const result = await handleEntrySplitTool({ id: '100', parts: PARTS });

        expect(result.isError).toBe(true);
        expect(mockDelete).toHaveBeenCalledWith('/entries/split/100');
    });
});

describe('entry_split_undo', () => {
    const splitParent = { ...PARENT, deleted: true, split: { children: ['201', '202'] } };

    // The live behaviour (2026-10-06): the old id stays deleted, the original comes back as a new entry.
    const seedSplit = () => {
        children = [{ id: '201', body: {} }, { id: '202', body: {} }];
    };

    test('reports the restored entry under its new id', async () => {
        seedSplit();

        const result = await handleEntrySplitUndoTool({ id: '100' });

        expect(result.isError).toBeUndefined();
        expect(mockDelete).toHaveBeenCalledWith('/entries/split/100');
        expect(textOf(result)).toContain('The split of entry 100 was undone');
        expect(textOf(result)).toContain('(201, 202)');
        expect(textOf(result)).toContain('Toshl restored the original as a new entry, 300.');
        expect(textOf(result)).toContain('"id": "300"');
        expect(textOf(result)).toContain('"desc": "split test"');
    });

    test("scopes the lookup of the restored entry to the parent's account and date", async () => {
        seedSplit();

        await handleEntrySplitUndoTool({ id: '100' });

        const listCalls = mockGet.mock.calls.filter(([path]) => path === '/entries');
        expect(listCalls).toHaveLength(1);
        expect(listCalls[0][1]).toMatchObject({
            from: '2026-10-01', to: '2026-10-01', accounts: 'acc-cash', per_page: 500,
        });
    });

    test('picks the restored entry out of the other entries of that day', async () => {
        seedSplit();
        listed = [{ ...PARENT, id: '301', desc: 'Groceries', amount: -12.3 }];

        const result = await handleEntrySplitUndoTool({ id: '100' });

        expect(textOf(result)).toContain('new entry, 300.');
    });

    test('finds the restored entry on a later page', async () => {
        seedSplit();
        let pagesServed = 0;
        mockGet.mockImplementation(async (path: string, params?: Record<string, any>) => {
            if (path !== '/entries') { return routeGet(path, params); }
            pagesServed++;
            return params?.page === 1
                ? ok([restored])
                : ok([], { link: '<https://api.toshl.com/entries?page=1&per_page=500>; rel="next"' });
        });

        const result = await handleEntrySplitUndoTool({ id: '100' });

        expect(pagesServed).toBe(2);
        expect(textOf(result)).toContain('new entry, 300.');
    });

    test('reports the undo as done and lists both candidates, claiming neither, when two entries match', async () => {
        seedSplit();
        listed = [{ ...PARENT, id: '301', modified: 'm3' }];

        const result = await handleEntrySplitUndoTool({ id: '100' });

        expect(result.isError).toBeUndefined();
        expect(textOf(result)).toContain('The split of entry 100 was undone');
        expect(textOf(result)).toContain('300');
        expect(textOf(result)).toContain('301');
        expect(textOf(result)).not.toMatch(/restored the original as a new entry/);
        expect(textOf(result)).not.toContain('"modified"');
    });

    test('reports the restored entry could not be confirmed when listing fails', async () => {
        seedSplit();
        failGets.add('/entries');

        const result = await handleEntrySplitUndoTool({ id: '100' });

        expect(result.isError).toBeUndefined();
        expect(textOf(result)).toContain('The split of entry 100 was undone');
        expect(textOf(result)).toMatch(/could not be confirmed/i);
        expect(textOf(result)).not.toMatch(/restored the original as a new entry/);
    });

    test('does not leak the failed list error into the response', async () => {
        seedSplit();
        mockGet.mockImplementation(async (path: string, params?: Record<string, any>) => {
            if (path === '/entries') { throw new Error('Bearer secret-token'); }
            return routeGet(path, params);
        });

        const result = await handleEntrySplitUndoTool({ id: '100' });

        expect(textOf(result)).not.toContain('secret-token');
    });

    test('reports it could not be confirmed when the list is longer than the page cap', async () => {
        seedSplit();
        listLink = '<https://api.toshl.com/entries?page=1&per_page=500>; rel="next"';

        const result = await handleEntrySplitUndoTool({ id: '100' });

        // The restored entry is on page 0, but with more pages left the list cannot be
        // checked completely, so nothing is claimed.
        expect(mockGet.mock.calls.filter(([path]) => path === '/entries')).toHaveLength(3);
        expect(textOf(result)).toContain('The split of entry 100 was undone');
        expect(textOf(result)).toMatch(/could not be confirmed/i);
        expect(textOf(result)).not.toMatch(/restored the original as a new entry/);
    });

    test('reports the restored entry when Toshl restores the original under its old id', async () => {
        let undone = false;
        mockGet.mockImplementation(async () => ok(undone ? PARENT : splitParent));
        mockDelete.mockImplementation(async () => { undone = true; return ok(undefined); });

        const result = await handleEntrySplitUndoTool({ id: '100' });

        expect(result.isError).toBeUndefined();
        expect(mockDelete).toHaveBeenCalledWith('/entries/split/100');
        expect(textOf(result)).toContain('"desc": "split test"');
    });

    test('refuses a split child and names its parent', async () => {
        mockGet.mockResolvedValue(ok({ ...PARENT, id: '201', split: { parent: '100', children: ['201', '202'] } }));

        const result = await handleEntrySplitUndoTool({ id: '201' });

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain('100');
        expect(mockDelete).not.toHaveBeenCalled();
    });

    test('refuses an entry that is not a split parent', async () => {
        mockGet.mockResolvedValue(ok(PARENT));

        const result = await handleEntrySplitUndoTool({ id: '100' });

        expect(result.isError).toBe(true);
        expect(mockDelete).not.toHaveBeenCalled();
    });

    test('refuses when the entry cannot be read', async () => {
        mockGet.mockRejectedValue(new Error('GET failed'));

        const result = await handleEntrySplitUndoTool({ id: '100' });

        expect(result.isError).toBe(true);
        expect(mockDelete).not.toHaveBeenCalled();
    });

    test('reports the undo as done when the restored entry cannot be re-read', async () => {
        let undone = false;
        mockGet.mockImplementation(async () => {
            if (undone) { throw new Error('not found'); }
            return ok(splitParent);
        });
        mockDelete.mockImplementation(async () => { undone = true; return ok(undefined); });

        const result = await handleEntrySplitUndoTool({ id: '100' });

        expect(result.isError).toBeUndefined();
        expect(textOf(result)).toMatch(/could not be confirmed/i);
    });

    test('does not claim the restored entry kept its id when the old id still reads as split', async () => {
        mockGet.mockImplementation(async (path: string) => ok(path === '/entries' ? [] : splitParent));
        mockDelete.mockResolvedValue(ok(undefined));

        const result = await handleEntrySplitUndoTool({ id: '100' });

        expect(result.isError).toBeUndefined();
        expect(textOf(result)).toMatch(/could not be confirmed/i);
    });
});
