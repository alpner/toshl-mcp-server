import { AxiosError, InternalAxiosRequestConfig } from 'axios';
import { ToshlApiClient } from '../../src/api/toshl-client.js';
import { AuthProvider, AuthType } from '../../src/api/auth.js';
import { createEntriesClient } from '../../src/api/endpoints/entries.js';

// Toshl answers a repeated request carrying If-None-Match with a 304 that has no Link
// header. The client replays the cached body on a 304; it must replay the cached Link
// header with it, or a repeated page call reports next_page: null.
//
// The axios adapter is replaced so no request leaves the process, and the token is fake.

type Reply = { status: number; data?: unknown; headers: Record<string, string> };

const clientWithReplies = (replies: Reply[]) => {
    const client = new ToshlApiClient(
        { baseUrl: 'https://api.toshl.com', token: 'test-token' },
        new AuthProvider({ type: AuthType.BASIC, token: 'test-token' }),
    );
    const seen: InternalAxiosRequestConfig[] = [];

    (client as any).client.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
        seen.push(config);
        const reply = replies.shift();
        if (!reply) {
            throw new Error('unexpected request');
        }

        const response = { ...reply, statusText: '', config, request: {} };
        if (reply.status >= 300) {
            throw new AxiosError(
                `Request failed with status code ${reply.status}`,
                AxiosError.ERR_BAD_REQUEST,
                config,
                {},
                response as any,
            );
        }
        return response;
    };

    return { client, seen };
};

describe('ETag cache keeps the Link header', () => {
    test('a 304 without Link still reports the next page from the cached 200', async () => {
        // Unique params so this test's cache entries cannot collide with any other
        const params = { from: '2031-05-01', to: '2031-10-06', page: 0, per_page: 500 };
        const { client, seen } = clientWithReplies([
            {
                status: 200,
                data: [{ id: 'a' }],
                headers: { etag: '"v1"', link: '</entries?page=1>; rel="next", </entries?page=1>; rel="last"' },
            },
            { status: 304, headers: { etag: '"v1"' } },
        ]);
        const entries = await createEntriesClient(client);

        const first = await entries.listEntriesPage(params);
        const second = await entries.listEntriesPage(params);

        expect(first).toEqual({ entries: [{ id: 'a' }], nextPage: 1 });
        expect(seen[1].headers['If-None-Match']).toBe('"v1"');
        expect(second).toEqual({ entries: [{ id: 'a' }], nextPage: 1 });
    });

    test('a cached last page still reports no next page after a 304', async () => {
        const params = { from: '2031-05-01', to: '2031-10-06', page: 1, per_page: 500 };
        const { client } = clientWithReplies([
            { status: 200, data: [{ id: 'z' }], headers: { etag: '"v2"', link: '</entries?page=0>; rel="prev"' } },
            { status: 304, headers: { etag: '"v2"' } },
        ]);
        const entries = await createEntriesClient(client);

        await entries.listEntriesPage(params);
        const second = await entries.listEntriesPage(params);

        expect(second).toEqual({ entries: [{ id: 'z' }], nextPage: null });
    });
});
