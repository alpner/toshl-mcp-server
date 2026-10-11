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
        expect(result.error).toContain('the entry date is missing or invalid');
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
    test('entry_create advertises an optional repeat', () => {
        const tool = setupEntryTools().find((t: any) => t.name === 'entry_create');
        expect(tool.inputSchema.properties.repeat.properties.frequency.enum)
            .toEqual(['daily', 'weekly', 'monthly', 'yearly']);
        expect(tool.inputSchema.required).not.toContain('repeat');
    });

    test('entry_update does not advertise repeat', () => {
        const tool = setupEntryTools().find((t: any) => t.name === 'entry_update');
        expect(tool.inputSchema.properties).not.toHaveProperty('repeat');
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

    test('a malformed entry date without repeat.start is reported as the entry date', async () => {
        const result = await handleEntryCreateTool({ ...BASE, date: '10/10/2026', repeat: { frequency: 'monthly' } });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('the entry date is missing or invalid');
        expect(result.content[0].text).not.toContain('repeat.start must be');
        expect(mockPost).not.toHaveBeenCalled();
    });

    test('an entry without repeat is posted exactly as before', async () => {
        await handleEntryCreateTool({ ...BASE });

        expect(mockPost).toHaveBeenCalledWith('/entries', BASE);
        expect(mockPost.mock.calls[0][1]).not.toHaveProperty('repeat');
    });
});

describe('entry_update and repeat', () => {
    beforeEach(() => {
        mockGet.mockReset();
        mockPut.mockReset();
        mockPut.mockResolvedValue(ok({ ...PLAIN_ENTRY }));
    });

    test('a repeat sent to entry_update is rejected before anything is read or written', async () => {
        const result = await handleEntryUpdateTool({
            id: '100', desc: 'Spotify Family', repeat: { frequency: 'monthly', interval: 1, start: '2026-10-10' },
        });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toBe('repeat cannot be changed through entry_update: '
            + 'Toshl\'s PUT schema marks every repeat field readonly. Create a new repeating series with entry_create.');
        expect(mockGet).not.toHaveBeenCalled();
        expect(mockPut).not.toHaveBeenCalled();
    });

    test('a repeat change on a repeating entry is rejected even with an updateMode', async () => {
        const result = await handleEntryUpdateTool({ id: '100', repeat: { frequency: 'weekly', count: 2 }, updateMode: 'one' });

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
