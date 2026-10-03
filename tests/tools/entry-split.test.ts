import { jest } from '@jest/globals';

// Stub the HTTP layer so the whole validate/create/verify/rollback sequence can be observed
// without credentials. The stub behaves like Toshl did against a live account: the first
// child carrying split.parent hides the parent and links every child to it, and
// DELETE /entries/split/:id restores the parent and removes the children.
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
    images: [{ id: 'img-1', path: 'https://img.toshl.com/1/', status: 'uploaded' }], modified: 'm1',
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

const childIds = () => children.map((child) => child.id);

const routeGet = async (path: string) => {
    if (failGets.has(path)) { throw new Error(`GET ${path} failed`); }
    if (path === `/entries/${parent.id}`) {
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

    test('undoes the split and reports the restored entry', async () => {
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
        mockGet.mockResolvedValue(ok(splitParent));
        mockDelete.mockResolvedValue(ok(undefined));

        const result = await handleEntrySplitUndoTool({ id: '100' });

        expect(result.isError).toBeUndefined();
        expect(textOf(result)).toMatch(/could not be confirmed/i);
    });
});
