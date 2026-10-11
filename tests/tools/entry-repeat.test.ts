import { jest } from '@jest/globals';

// Stub the HTTP layer so create/update can be observed without credentials.
type Call = (...args: any[]) => Promise<any>;
const mockGet = jest.fn<Call>();
const mockPost = jest.fn<Call>();
const mockPut = jest.fn<Call>();
jest.mock('../../src/api/toshl-client.js', () => ({
    __esModule: true,
    default: { get: mockGet, post: mockPost, put: mockPut },
    ToshlApiClient: class {},
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleEntryCreateTool, handleEntryUpdateTool, setupEntryTools } = require('../../src/tools/entry-tools.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { normalizeRepeat } = require('../../src/tools/repeat.js');

const ok = (data: unknown, headers: Record<string, string> = {}) => ({ data, status: 200, headers });

const BASE = {
    amount: -12.49, currency: { code: 'EUR' }, date: '2026-10-10', account: 'acc-1', category: 'cat-music',
};
const PLAIN_ENTRY = { ...BASE, id: '100', desc: 'Spotify', modified: 'x' };
const REPEATING_ENTRY = {
    ...PLAIN_ENTRY,
    repeat: { id: '9', start: '2026-09-11', frequency: 'monthly', interval: 1, iteration: 3, template: false },
};

describe('normalizeRepeat', () => {
    test('defaults interval to 1 and start to the entry date', () => {
        expect(normalizeRepeat({ frequency: 'monthly' }, { defaultStart: '2026-10-10' }))
            .toEqual({ ok: true, repeat: { frequency: 'monthly', interval: 1, start: '2026-10-10' } });
    });

    test('keeps only the fields Toshl accepts', () => {
        const result = normalizeRepeat(
            { frequency: 'weekly', interval: 2, start: '2026-10-10', byday: 'MO', id: '999', iteration: 7, template: true },
            {},
        );
        expect(result).toEqual({
            ok: true,
            repeat: { frequency: 'weekly', interval: 2, start: '2026-10-10', byday: 'MO' },
        });
    });

    test.each([
        [{}, 'repeat.frequency is required'],
        [{ frequency: 'hourly' }, 'repeat.frequency must be one of'],
        [{ frequency: 'monthly', interval: 0 }, 'repeat.interval'],
        [{ frequency: 'monthly', interval: 128 }, 'repeat.interval'],
        [{ frequency: 'monthly', interval: 1.5 }, 'repeat.interval'],
        [{ frequency: 'monthly', start: '10/10/2026' }, 'repeat.start must be a date'],
        [{ frequency: 'monthly', end: 'soon' }, 'repeat.end must be a date'],
        [{ frequency: 'monthly', count: 0 }, 'repeat.count'],
        [{ frequency: 'monthly', end: '2027-01-01', count: 3 }, 'cannot both be set'],
        [{ frequency: 'monthly', byday: '' }, 'repeat.byday'],
    ])('rejects %j', (input, message) => {
        const result = normalizeRepeat(input, { defaultStart: '2026-10-10' });
        expect(result.ok).toBe(false);
        expect(result.error).toContain(message);
    });

    test('rejects a repeat without a start when there is no entry date to fall back on', () => {
        const result = normalizeRepeat({ frequency: 'monthly' }, {});
        expect(result.ok).toBe(false);
        expect(result.error).toContain('repeat.start');
    });

    test('partial mode accepts a change that names only some fields', () => {
        expect(normalizeRepeat({ end: '2027-01-01' }, { partial: true }))
            .toEqual({ ok: true, repeat: { end: '2027-01-01' } });
    });

    test('rejects a non-object', () => {
        expect(normalizeRepeat('monthly', {}).ok).toBe(false);
        expect(normalizeRepeat(null, {}).ok).toBe(false);
        expect(normalizeRepeat([], {}).ok).toBe(false);
    });
});

describe('tool schemas', () => {
    test('entry_create and entry_update both advertise repeat', () => {
        const tools = setupEntryTools();
        for (const name of ['entry_create', 'entry_update']) {
            const tool = tools.find((t: any) => t.name === name);
            expect(tool.inputSchema.properties.repeat.properties.frequency.enum)
                .toEqual(['daily', 'weekly', 'monthly', 'yearly']);
        }
    });

    test('repeat is optional on both tools', () => {
        const tools = setupEntryTools();
        for (const name of ['entry_create', 'entry_update']) {
            const tool = tools.find((t: any) => t.name === name);
            expect(tool.inputSchema.required).not.toContain('repeat');
        }
    });
});

describe('entry_create with repeat', () => {
    beforeEach(() => {
        mockGet.mockReset();
        mockPost.mockReset();
        mockPut.mockReset();
        mockPost.mockResolvedValue(ok(null, { location: 'https://api.toshl.com/entries/200' }));
        mockGet.mockResolvedValue(ok({ ...PLAIN_ENTRY, id: '200' }));
    });

    test('posts a normalized repeat that starts on the entry date', async () => {
        const result = await handleEntryCreateTool({ ...BASE, repeat: { frequency: 'monthly' } });

        expect(result.isError).toBeUndefined();
        expect(mockPost).toHaveBeenCalledWith('/entries', expect.objectContaining({
            repeat: { frequency: 'monthly', interval: 1, start: '2026-10-10' },
        }));
    });

    test('refuses an invalid repeat before anything is written', async () => {
        const result = await handleEntryCreateTool({ ...BASE, repeat: { frequency: 'hourly' } });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Invalid repeat');
        expect(mockPost).not.toHaveBeenCalled();
    });

    test('an entry without repeat is posted exactly as before', async () => {
        await handleEntryCreateTool({ ...BASE });

        expect(mockPost).toHaveBeenCalledWith('/entries', BASE);
        expect(mockPost.mock.calls[0][1]).not.toHaveProperty('repeat');
    });
});

describe('entry_update with repeat', () => {
    beforeEach(() => {
        mockGet.mockReset();
        mockPost.mockReset();
        mockPut.mockReset();
        mockPut.mockResolvedValue(ok({ ...REPEATING_ENTRY }));
    });

    test('turns a plain entry into a repeating one starting on its own date', async () => {
        mockGet.mockResolvedValue(ok(PLAIN_ENTRY));

        const result = await handleEntryUpdateTool({ id: '100', repeat: { frequency: 'monthly', interval: 1 } });

        expect(result.isError).toBeUndefined();
        expect(mockPut.mock.calls[0][1].repeat).toEqual({ start: '2026-10-10', frequency: 'monthly', interval: 1 });
    });

    test('a plain entry made repeating defaults interval to 1', async () => {
        mockGet.mockResolvedValue(ok(PLAIN_ENTRY));

        await handleEntryUpdateTool({ id: '100', repeat: { frequency: 'weekly' } });

        expect(mockPut.mock.calls[0][1].repeat).toEqual({ start: '2026-10-10', frequency: 'weekly', interval: 1 });
    });

    test('a plain entry cannot be made repeating without a frequency', async () => {
        mockGet.mockResolvedValue(ok(PLAIN_ENTRY));

        const result = await handleEntryUpdateTool({ id: '100', repeat: { end: '2027-06-11' } });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('repeat.frequency is required');
        expect(mockPut).not.toHaveBeenCalled();
    });

    test('a partial change keeps the series id and iteration', async () => {
        mockGet.mockResolvedValue(ok(REPEATING_ENTRY));

        await handleEntryUpdateTool({ id: '100', repeat: { end: '2027-06-11' }, updateMode: 'tail' });

        expect(mockPut.mock.calls[0][1].repeat).toEqual({
            id: '9', start: '2026-09-11', frequency: 'monthly', interval: 1, iteration: 3, template: false, end: '2027-06-11',
        });
        expect(mockPut.mock.calls[0][2]).toEqual({ update: 'tail' });
    });

    test('refuses an invalid repeat before anything is written', async () => {
        const result = await handleEntryUpdateTool({ id: '100', repeat: { interval: 500 } });

        expect(result.isError).toBe(true);
        expect(mockGet).not.toHaveBeenCalled();
        expect(mockPut).not.toHaveBeenCalled();
    });

    test('an update without repeat leaves an existing series untouched', async () => {
        mockGet.mockResolvedValue(ok(REPEATING_ENTRY));

        await handleEntryUpdateTool({ id: '100', desc: 'Spotify Family' });

        expect(mockPut.mock.calls[0][1].repeat).toEqual(REPEATING_ENTRY.repeat);
        expect(mockPut.mock.calls[0][1].desc).toBe('Spotify Family');
    });
});
