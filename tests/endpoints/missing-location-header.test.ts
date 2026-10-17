import { jest } from '@jest/globals';
import { EntriesClient } from '../../src/api/endpoints/entries.js';
import { CategoriesClient } from '../../src/api/endpoints/categories.js';
import { TagsClient } from '../../src/api/endpoints/tags.js';
import logger from '../../src/utils/logger.js';

// Credential-free: a create whose 201 carries no Location header, against a stub HTTP
// client. Toshl returns the new id only in that header, so the client must fail clearly.

const stubClient = () => ({
    get: jest.fn<(...args: any[]) => Promise<any>>(),
    post: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({
        data: { echoed: 'response body' },
        status: 201,
        headers: { 'content-type': 'application/json' },
    }),
});

describe('create without a location header', () => {
    let debugSpy: ReturnType<typeof jest.spyOn>;

    beforeEach(() => {
        debugSpy = jest.spyOn(logger, 'debug');
    });

    afterEach(() => {
        debugSpy.mockRestore();
    });

    test.each([
        ['entry', (c: any) => new EntriesClient(c).createEntry({ amount: -1 }), 'entry ID'],
        ['category', (c: any) => new CategoriesClient(c).createCategory({ name: 'x' }), 'category ID'],
        ['tag', (c: any) => new TagsClient(c).createTag({ name: 'x' }), 'tag ID'],
    ])('%s: throws the invalid-response error without fetching anything', async (_name, create, idName) => {
        const client = stubClient();

        await expect(create(client)).rejects.toThrow(
            `Invalid response. Expected location header to contain ${idName}`
        );
        expect(client.get).not.toHaveBeenCalled();
    });

    test.each([
        ['entry', (c: any) => new EntriesClient(c).createEntry({ amount: -1 })],
        ['category', (c: any) => new CategoriesClient(c).createCategory({ name: 'x' })],
        ['tag', (c: any) => new TagsClient(c).createTag({ name: 'x' })],
    ])('%s: logs only the status, not the response headers or body', async (_name, create) => {
        await expect(create(stubClient())).rejects.toThrow();

        expect(debugSpy).toHaveBeenCalledWith('Response', { status: 201 });
    });
});
