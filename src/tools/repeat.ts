// Toshl's documented bounds for an entry's repeat object (docs/api/schema/entry-schema.json)
export const REPEAT_FREQUENCIES = ['daily', 'weekly', 'monthly', 'yearly'] as const;
const REPEAT_INTERVAL_MIN = 1;
const REPEAT_INTERVAL_MAX = 127;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The repeat fields a caller may send. Server-assigned fields (id, iteration, template)
 * are deliberately absent so they can never be set through the tools.
 */
export interface RepeatInput {
    frequency?: (typeof REPEAT_FREQUENCIES)[number];
    interval?: number;
    start?: string;
    end?: string;
    count?: number;
    byday?: string;
    bymonthday?: string;
    bysetpos?: string;
}

export type RepeatResult =
    | { ok: true; repeat: RepeatInput }
    | { ok: false; error: string };

/**
 * JSON schema of entry_create's repeat property. Toshl accepts a repeat only when an entry is
 * created: its PUT schema marks every repeat field readonly.
 */
export const REPEAT_INPUT_SCHEMA = {
    type: 'object',
    description: 'Makes the entry repeat, following RFC 5545 RRULE semantics. '
        + 'Repeating every two months is frequency monthly with interval 2. '
        + 'A series ends at end or after count repetitions; the two are mutually exclusive, and with neither it repeats without an end date. '
        + 'When omitted, start is the entry date and interval is 1.',
    properties: {
        frequency: {
            type: 'string',
            description: 'Repeat frequency',
            enum: [...REPEAT_FREQUENCIES],
        },
        interval: {
            type: 'integer',
            description: `Repeat interval, ${REPEAT_INTERVAL_MIN}-${REPEAT_INTERVAL_MAX}`,
            minimum: REPEAT_INTERVAL_MIN,
            maximum: REPEAT_INTERVAL_MAX,
        },
        start: {
            type: 'string',
            description: 'Repeat start date (YYYY-MM-DD)',
        },
        end: {
            type: 'string',
            description: 'Repeat end date (YYYY-MM-DD)',
        },
        count: {
            type: 'integer',
            description: 'How many times the entry repeats',
            minimum: 1,
        },
        byday: {
            type: 'string',
            description: 'Comma separated weekdays (MO,TU,...), each optionally preceded by a position such as 1MO or -1MO',
        },
        bymonthday: {
            type: 'string',
            description: 'Comma separated days of the month (1-31), each optionally signed',
        },
        bysetpos: {
            type: 'string',
            description: 'Comma separated nth occurrences within bymonthday. '
                + 'The last day of the month is bymonthday 28,29,30,31 with bysetpos -1',
        },
    },
};

const BYDAY_ITEM_PATTERN = /^[+-]?\d{0,2}(MO|TU|WE|TH|FR|SA|SU)$/;
const SIGNED_INTEGER_PATTERN = /^[+-]?\d+$/;

/**
 * Accepts an optionally signed integer whose absolute value is within [min, max]
 */
const isSignedIntegerInRange = (item: string, min: number, max: number): boolean => {
    if (!SIGNED_INTEGER_PATTERN.test(item)) {
        return false;
    }
    const magnitude = Math.abs(Number(item));
    return magnitude >= min && magnitude <= max;
};

// Per-item rules for the comma separated RRULE parts (RFC 5545 section 3.3.10). bysetpos is
// kept as permissive as the RFC (up to 366) so Toshl, not this server, has the final say.
const BY_RULES = {
    byday: {
        isValid: (item: string) => BYDAY_ITEM_PATTERN.test(item),
        expected: 'comma separated weekdays (MO-SU), each optionally preceded by a signed position',
        example: 'MO,WE or 1MO or -1FR',
    },
    bymonthday: {
        isValid: (item: string) => isSignedIntegerInRange(item, 1, 31),
        expected: 'comma separated days of the month, each an optionally signed integer from 1 to 31',
        example: '1,15 or -1',
    },
    bysetpos: {
        isValid: (item: string) => isSignedIntegerInRange(item, 1, 366),
        expected: 'comma separated nonzero integers, each optionally signed, up to 366',
        example: '-1',
    },
} as const;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Validates a repeat object from tool input and returns only the fields Toshl accepts.
 * @param input Raw repeat argument
 * @param options.defaultStart Start date used when none is given (the entry's own date)
 */
export const normalizeRepeat = (
    input: unknown,
    options: { defaultStart?: string } = {},
): RepeatResult => {
    if (!isPlainObject(input)) {
        return { ok: false, error: 'repeat must be an object' };
    }

    const repeat: RepeatInput = {};

    if (input.frequency === undefined) {
        return { ok: false, error: 'repeat.frequency is required' };
    }
    if (!(REPEAT_FREQUENCIES as readonly unknown[]).includes(input.frequency)) {
        return { ok: false, error: `repeat.frequency must be one of: ${REPEAT_FREQUENCIES.join(', ')}` };
    }
    repeat.frequency = input.frequency as RepeatInput['frequency'];

    if (input.interval !== undefined) {
        const interval = input.interval;
        if (typeof interval !== 'number' || !Number.isInteger(interval)
            || interval < REPEAT_INTERVAL_MIN || interval > REPEAT_INTERVAL_MAX) {
            return { ok: false, error: `repeat.interval must be an integer from ${REPEAT_INTERVAL_MIN} to ${REPEAT_INTERVAL_MAX}` };
        }
        repeat.interval = interval;
    } else {
        repeat.interval = REPEAT_INTERVAL_MIN;
    }

    const start = input.start ?? options.defaultStart;
    if (start === undefined) {
        return { ok: false, error: 'repeat.start is required when the entry has no date to start from' };
    }
    if (typeof start !== 'string' || !DATE_PATTERN.test(start)) {
        return { ok: false, error: 'repeat.start must be a date in YYYY-MM-DD format' };
    }
    repeat.start = start;

    if (input.end !== undefined) {
        if (typeof input.end !== 'string' || !DATE_PATTERN.test(input.end)) {
            return { ok: false, error: 'repeat.end must be a date in YYYY-MM-DD format' };
        }
        repeat.end = input.end;
    }

    if (input.count !== undefined) {
        if (typeof input.count !== 'number' || !Number.isInteger(input.count) || input.count < 1) {
            return { ok: false, error: 'repeat.count must be an integer of at least 1' };
        }
        repeat.count = input.count;
    }

    if (repeat.end !== undefined && repeat.count !== undefined) {
        return { ok: false, error: 'repeat.end and repeat.count cannot both be set' };
    }

    for (const key of ['byday', 'bymonthday', 'bysetpos'] as const) {
        const value = input[key];
        if (value !== undefined) {
            const rule = BY_RULES[key];
            const items = typeof value === 'string' ? value.split(',').map((item) => item.trim()) : [];
            if (items.length === 0 || !items.every((item) => item !== '' && rule.isValid(item))) {
                return { ok: false, error: `repeat.${key} must be ${rule.expected}, for example ${rule.example}` };
            }
            repeat[key] = items.join(',');
        }
    }

    return { ok: true, repeat };
};
