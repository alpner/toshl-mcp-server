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
 * JSON schema of the repeat property shared by entry_create and entry_update
 */
export const REPEAT_INPUT_SCHEMA = {
    type: 'object',
    description: 'Makes the entry repeat, following RFC 5545 RRULE semantics. '
        + 'Repeating every two months is frequency monthly with interval 2. '
        + 'A series ends at end or after count repetitions; the two are mutually exclusive, and with neither it repeats without an end date. '
        + 'On entry_create, start defaults to the entry date and interval to 1. '
        + 'On entry_update, the given fields are merged into the existing series.',
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

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Validates a repeat object from tool input and returns only the fields Toshl accepts.
 * @param input Raw repeat argument
 * @param options.defaultStart Start date used when none is given (the entry's own date)
 * @param options.partial When true the repeat is a set of changes to an existing series,
 *                        so frequency is not required and interval is not defaulted
 */
export const normalizeRepeat = (
    input: unknown,
    options: { defaultStart?: string; partial?: boolean } = {},
): RepeatResult => {
    if (!isPlainObject(input)) {
        return { ok: false, error: 'repeat must be an object' };
    }

    const repeat: RepeatInput = {};

    if (input.frequency !== undefined) {
        if (!(REPEAT_FREQUENCIES as readonly unknown[]).includes(input.frequency)) {
            return { ok: false, error: `repeat.frequency must be one of: ${REPEAT_FREQUENCIES.join(', ')}` };
        }
        repeat.frequency = input.frequency as RepeatInput['frequency'];
    } else if (!options.partial) {
        return { ok: false, error: 'repeat.frequency is required' };
    }

    if (input.interval !== undefined) {
        const interval = input.interval;
        if (typeof interval !== 'number' || !Number.isInteger(interval)
            || interval < REPEAT_INTERVAL_MIN || interval > REPEAT_INTERVAL_MAX) {
            return { ok: false, error: `repeat.interval must be an integer from ${REPEAT_INTERVAL_MIN} to ${REPEAT_INTERVAL_MAX}` };
        }
        repeat.interval = interval;
    } else if (!options.partial) {
        repeat.interval = REPEAT_INTERVAL_MIN;
    }

    const start = input.start ?? (options.partial ? undefined : options.defaultStart);
    if (start !== undefined) {
        if (typeof start !== 'string' || !DATE_PATTERN.test(start)) {
            return { ok: false, error: 'repeat.start must be a date in YYYY-MM-DD format' };
        }
        repeat.start = start;
    } else if (!options.partial) {
        return { ok: false, error: 'repeat.start is required when the entry has no date to start from' };
    }

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
            if (typeof value !== 'string' || value.trim() === '') {
                return { ok: false, error: `repeat.${key} must be a non-empty string` };
            }
            repeat[key] = value;
        }
    }

    return { ok: true, repeat };
};
