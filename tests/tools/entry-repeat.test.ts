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

describe('normalizeRepeat by-rules', () => {
    const MONTHLY = { frequency: 'monthly', start: '2026-10-31' };

    test.each([
        ['byday', 'MO'],
        ['byday', '1MO'],
        ['byday', '-1MO'],
        ['byday', 'MO,WE,FR'],
        ['byday', '+2TU,-10SU'],
        ['bymonthday', '1'],
        ['bymonthday', '-1'],
        ['bymonthday', '+31'],
        ['bymonthday', '1,15'],
        ['bysetpos', '-1'],
        ['bysetpos', '366'],
        ['bysetpos', '1,-1'],
    ])('accepts %s %s', (key, value) => {
        const result = normalizeRepeat({ ...MONTHLY, [key]: value }, {});
        expect(result).toEqual({ ok: true, repeat: expect.objectContaining({ [key]: value }) });
    });

    test('accepts the last day of the month', () => {
        const result = normalizeRepeat({ ...MONTHLY, bymonthday: '28,29,30,31', bysetpos: '-1' }, {});
        expect(result).toEqual({
            ok: true,
            repeat: expect.objectContaining({ bymonthday: '28,29,30,31', bysetpos: '-1' }),
        });
    });

    test('trims spaces around items', () => {
        const result = normalizeRepeat({ ...MONTHLY, byday: 'MO, WE ,FR' }, {});
        expect(result.repeat.byday).toBe('MO,WE,FR');
    });

    test.each([
        ['byday', 'MO;XX'],
        ['byday', 'XX'],
        ['byday', 'mo'],
        ['byday', '1MO,'],
        ['byday', '100MO'],
        ['byday', ''],
        ['bymonthday', '32'],
        ['bymonthday', '0'],
        ['bymonthday', '-32'],
        ['bymonthday', '1.5'],
        ['bymonthday', '1,,2'],
        ['bymonthday', ''],
        ['bysetpos', '0'],
        ['bysetpos', '367'],
        ['bysetpos', 'last'],
        ['bysetpos', '-1,'],
        ['bysetpos', ''],
    ])('rejects %s %j', (key, value) => {
        const result = normalizeRepeat({ ...MONTHLY, [key]: value }, {});
        expect(result.ok).toBe(false);
        expect(result.error).toContain(`repeat.${key} must be`);
        expect(result.error).toContain('for example');
    });

    test('rejects a by-rule that is not a string', () => {
        const result = normalizeRepeat({ ...MONTHLY, bymonthday: 15 }, {});
        expect(result.ok).toBe(false);
        expect(result.error).toContain('repeat.bymonthday');
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

describe('entry_update repeat end and count', () => {
    const COUNTED_ENTRY = { ...REPEATING_ENTRY, repeat: { ...REPEATING_ENTRY.repeat, count: 12 } };
    const ENDED_ENTRY = { ...REPEATING_ENTRY, repeat: { ...REPEATING_ENTRY.repeat, end: '2027-09-11' } };

    beforeEach(() => {
        mockGet.mockReset();
        mockPut.mockReset();
        mockPut.mockResolvedValue(ok({ ...REPEATING_ENTRY }));
    });

    test('an end replaces the series count', async () => {
        mockGet.mockResolvedValue(ok(COUNTED_ENTRY));

        await handleEntryUpdateTool({ id: '100', repeat: { end: '2027-06-11' }, updateMode: 'all' });

        const repeat = mockPut.mock.calls[0][1].repeat;
        expect(repeat.end).toBe('2027-06-11');
        expect(repeat).not.toHaveProperty('count');
    });

    test('a count replaces the series end', async () => {
        mockGet.mockResolvedValue(ok(ENDED_ENTRY));

        await handleEntryUpdateTool({ id: '100', repeat: { count: 6 }, updateMode: 'all' });

        const repeat = mockPut.mock.calls[0][1].repeat;
        expect(repeat.count).toBe(6);
        expect(repeat).not.toHaveProperty('end');
    });

    test('a change that sends neither keeps the series count', async () => {
        mockGet.mockResolvedValue(ok(COUNTED_ENTRY));

        await handleEntryUpdateTool({ id: '100', repeat: { interval: 2 }, updateMode: 'all' });

        const repeat = mockPut.mock.calls[0][1].repeat;
        expect(repeat).toMatchObject({ interval: 2, count: 12 });
        expect(repeat).not.toHaveProperty('end');
    });
});

describe('entry_update repeat change scope', () => {
    beforeEach(() => {
        mockGet.mockReset();
        mockPut.mockReset();
        mockPut.mockResolvedValue(ok({ ...REPEATING_ENTRY }));
    });

    test('a repeat change on a repeating entry without updateMode is refused before the PUT', async () => {
        mockGet.mockResolvedValue(ok(REPEATING_ENTRY));

        const result = await handleEntryUpdateTool({ id: '100', repeat: { interval: 2 } });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('updateMode is required');
        expect(result.content[0].text).toContain('one, tail or all');
        expect(result.content[0].text).toContain('all entries in the series');
        expect(mockPut).not.toHaveBeenCalled();
    });

    test('making a plain entry repeat needs no updateMode', async () => {
        mockGet.mockResolvedValue(ok(PLAIN_ENTRY));

        const result = await handleEntryUpdateTool({ id: '100', repeat: { frequency: 'monthly' } });

        expect(result.isError).toBeUndefined();
        expect(mockPut).toHaveBeenCalledTimes(1);
        expect(mockPut.mock.calls[0][2]).toEqual({});
    });

    test.each(['one', 'tail', 'all'])('a repeat change with updateMode %s goes through', async (updateMode) => {
        mockGet.mockResolvedValue(ok(REPEATING_ENTRY));

        const result = await handleEntryUpdateTool({ id: '100', repeat: { interval: 2 }, updateMode });

        expect(result.isError).toBeUndefined();
        expect(mockPut.mock.calls[0][2]).toEqual({ update: updateMode });
    });
});
