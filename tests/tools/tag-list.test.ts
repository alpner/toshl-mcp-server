import { jest } from '@jest/globals';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

// Stand in for the Toshl API client so the tag handlers can be exercised without
// credentials.
const mockGet = jest.fn<(...args: any[]) => Promise<any>>();
const mockPost = jest.fn<(...args: any[]) => Promise<any>>();
const mockPut = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('../../src/api/toshl-client.js', () => ({
    __esModule: true,
    default: { get: mockGet, post: mockPost, put: mockPut },
    ToshlApiClient: class {},
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleTagListTool, handleTagCreateTool, handleTagUpdateTool, setupTagTools } = require('../../src/tools/tag-tools.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createTagsClient } = require('../../src/api/endpoints/tags.js');

const apiResponse = (data: unknown, link?: string) => ({
    data,
    status: 200,
    headers: link ? { link } : {},
});

const tag = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: `tag ${id}`,
    modified: '2026-10-01T10:00:00Z',
    type: 'expense',
    ...extra,
});

const parseResult = (result: any) => JSON.parse(result.content[0].text);

describe('tag_list', () => {
    beforeEach(() => {
        mockGet.mockReset();
    });

    test('schema exposes bounded paging, the type enum and the booleans; nothing is required', () => {
        const tool = setupTagTools().find((t: any) => t.name === 'tag_list');
        const props = tool.inputSchema.properties;

        expect(props.page).toMatchObject({ type: 'integer', minimum: 0 });
        expect(props.per_page).toMatchObject({ type: 'integer', minimum: 10, maximum: 500 });
        expect(props.type).toMatchObject({ type: 'string', enum: ['expense', 'income'] });
        expect(props.include_deleted).toMatchObject({ type: 'boolean' });
        expect(props.compact).toMatchObject({ type: 'boolean' });
        expect(props.search).toMatchObject({ type: 'string' });
        expect(props.categories).toMatchObject({ type: 'string' });
        expect(props.ids).toMatchObject({ type: 'string' });
        expect(tool.inputSchema.required).toEqual([]);
    });

    test('forwards page, per_page and every allowed filter to GET /tags', async () => {
        mockGet.mockResolvedValue(apiResponse([]));

        await handleTagListTool({
            page: 2,
            per_page: 50,
            search: 'coffee',
            type: 'income',
            categories: '1,2',
            ids: '3,4',
            include_deleted: true,
        });

        expect(mockGet).toHaveBeenCalledWith('/tags', {
            page: 2,
            per_page: 50,
            search: 'coffee',
            type: 'income',
            categories: '1,2',
            ids: '3,4',
            include_deleted: true,
        });
    });

    test('does not forward compact or unknown args', async () => {
        mockGet.mockResolvedValue(apiResponse([]));

        await handleTagListTool({ compact: true, used_with_tags: '9', bogus: 'x' });

        expect(mockGet).toHaveBeenCalledWith('/tags', { page: 0, per_page: 200 });
    });

    test('wraps tags with pagination metadata and reads next_page from a relative Link header', async () => {
        mockGet.mockResolvedValue(apiResponse(
            [tag('a'), tag('b')],
            '</tags?page=1&per_page=10>; rel="next", </tags?page=4&per_page=10>; rel="last"',
        ));

        const result = await handleTagListTool({ per_page: 10 });

        expect(result.isError).toBeUndefined();
        expect(parseResult(result)).toEqual({
            tags: [tag('a'), tag('b')],
            page: 0,
            per_page: 10,
            count: 2,
            next_page: 1,
        });
    });

    test('reports next_page null on the last page', async () => {
        mockGet.mockResolvedValue(apiResponse([tag('z')], '</tags?page=2>; rel="prev"'));

        const result = await handleTagListTool({ page: 3 });

        expect(parseResult(result)).toMatchObject({ page: 3, count: 1, next_page: null });
    });

    test('defaults to page 0 and per_page 200', async () => {
        mockGet.mockResolvedValue(apiResponse([]));

        const result = await handleTagListTool({});

        expect(mockGet).toHaveBeenCalledWith('/tags', { page: 0, per_page: 200 });
        expect(parseResult(result)).toMatchObject({ page: 0, per_page: 200 });
    });

    test('handles a call with no args at all', async () => {
        mockGet.mockResolvedValue(apiResponse([]));

        const result = await handleTagListTool(undefined);

        expect(result.isError).toBeUndefined();
        expect(mockGet).toHaveBeenCalledWith('/tags', { page: 0, per_page: 200 });
    });

    test.each([
        [{ per_page: 5 }],
        [{ per_page: 501 }],
        [{ per_page: 20.5 }],
        [{ page: -1 }],
        [{ page: 1.5 }],
    ])('rejects %p before any request', async (args) => {
        const result = await handleTagListTool(args);

        expect(result.isError).toBe(true);
        expect(mockGet).not.toHaveBeenCalled();
    });

    test('compact returns only the listed fields', async () => {
        mockGet.mockResolvedValue(apiResponse([
            tag('a', {
                category: '7',
                meta_tag: false,
                deleted: false,
                counts: { entries: 12, unsorted_entries: 0 },
                extra: { anything: true },
            }),
            tag('b'),
        ]));

        const result = await handleTagListTool({ compact: true });

        expect(parseResult(result).tags).toEqual([
            { id: 'a', name: 'tag a', type: 'expense', category: '7', meta_tag: false, deleted: false, entries: 12 },
            { id: 'b', name: 'tag b', type: 'expense' },
        ]);
    });

    test('compact leaves entries out when the tag carries no usable count', async () => {
        mockGet.mockResolvedValue(apiResponse([tag('a', { counts: {} })]));

        const result = await handleTagListTool({ compact: true });

        expect(parseResult(result).tags[0]).not.toHaveProperty('entries');
    });
});

describe('TagsClient.listAllTags', () => {
    beforeEach(() => {
        mockGet.mockReset();
    });

    test('follows the Link header across pages and concatenates them in order', async () => {
        mockGet
            .mockResolvedValueOnce(apiResponse([tag('1'), tag('2')], '</tags?page=1&per_page=500>; rel="next"'))
            .mockResolvedValueOnce(apiResponse([tag('3')], '</tags?page=2&per_page=500>; rel="next"'))
            .mockResolvedValueOnce(apiResponse([tag('4')], '</tags?page=1&per_page=500>; rel="prev"'));

        const tagsClient = await createTagsClient();
        const tags = await tagsClient.listAllTags();

        expect(tags.map((t: any) => t.id)).toEqual(['1', '2', '3', '4']);
        expect(mockGet.mock.calls.map((call) => call[1])).toEqual([
            { page: 0, per_page: 500 },
            { page: 1, per_page: 500 },
            { page: 2, per_page: 500 },
        ]);
    });

    test('throws rather than return a partial list when pages remain past the cap', async () => {
        mockGet.mockImplementation(async (_url: unknown, params: any) =>
            apiResponse([tag(String(params.page))], `</tags?page=${params.page + 1}>; rel="next"`));

        const tagsClient = await createTagsClient();

        await expect(tagsClient.listAllTags(3)).rejects.toThrow(/3 pages/);
        expect(mockGet).toHaveBeenCalledTimes(3);
    });
});

describe('tag_create conflict', () => {
    beforeEach(() => {
        mockPost.mockReset();
    });

    test('a 409 returns the duplicate-name explanation', async () => {
        mockPost.mockRejectedValue(new McpError(ErrorCode.InvalidRequest, 'Conflict: Tag exists.', { status: 409 }));

        const result = await handleTagCreateTool({ name: 'coffee', type: 'expense' });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('a tag with this name already exists');
        expect(result.content[0].text).toContain('include_deleted');
        expect(result.content[0].text).toContain('Tag exists.');
    });

    test('other errors keep the generic message', async () => {
        mockPost.mockRejectedValue(new McpError(ErrorCode.InvalidParams, 'Invalid request: bad name', { status: 400 }));

        const result = await handleTagCreateTool({ name: 'coffee', type: 'expense' });

        expect(result.content[0].text).toMatch(/^Error creating tag: /);
        expect(result.content[0].text).not.toContain('already exists');
    });
});

describe('tag_update conflict', () => {
    beforeEach(() => {
        mockGet.mockReset();
        mockPut.mockReset();
        mockGet.mockResolvedValue(apiResponse(tag('a')));
        mockPut.mockRejectedValue(new McpError(ErrorCode.InvalidRequest, 'Conflict: Tag exists.', { status: 409 }));
    });

    test('a 409 on a rename names both possible causes', async () => {
        const result = await handleTagUpdateTool({ id: 'a', name: 'coffee' });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('a tag with the new name already exists');
        expect(result.content[0].text).toContain('changed elsewhere');
    });

    test('a 409 without a rename keeps the generic message', async () => {
        const result = await handleTagUpdateTool({ id: 'a', type: 'income' });

        expect(result.content[0].text).toMatch(/^Error updating tag: /);
    });
});
