import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/server/server.js';
import { RunningHttpServer, startHttpServer } from '../../src/server/http.js';

// Credential-free: initialize and tools/list never reach the Toshl API.

const AUTH_TOKEN = 'test-token-0123456789abcdef0123456789';

/**
 * Lists tools over an in-memory transport, the same unconnected server stdio uses
 * @returns Tool names
 */
async function listToolsInProcess(): Promise<string[]> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({ name: 'test', version: '0.0.0' });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    await client.close();
    await server.close();

    return tools.map((tool) => tool.name);
}

describe('Streamable HTTP transport', () => {
    let running: RunningHttpServer;
    let baseUrl: string;

    beforeAll(async () => {
        running = await startHttpServer({
            host: '127.0.0.1',
            port: 0,
            authToken: AUTH_TOKEN,
            allowedHosts: [],
        });
        baseUrl = `http://127.0.0.1:${running.port}`;
    });

    afterAll(async () => {
        await running.close();
    });

    const connectClient = async (token = AUTH_TOKEN) => {
        const client = new Client({ name: 'test', version: '0.0.0' });
        const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
            requestInit: { headers: { Authorization: `Bearer ${token}` } },
        });
        await client.connect(transport);
        return { client, transport };
    };

    test('initialize and tools/list return the same tools as stdio', async () => {
        const { client, transport } = await connectClient();

        expect(transport.sessionId).toBeDefined();
        const { tools } = await client.listTools();
        const expected = await listToolsInProcess();

        expect(expected.length).toBeGreaterThan(0);
        expect(tools.map((tool) => tool.name)).toEqual(expected);

        await transport.terminateSession();
        await client.close();
    });

    test('rejects /mcp without the bearer token', async () => {
        const response = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
            body: '{}',
        });

        expect(response.status).toBe(401);
        expect(response.headers.get('www-authenticate')).toBe('Bearer');
    });

    test('rejects /mcp with a wrong bearer token', async () => {
        await expect(connectClient('wrong-token-0123456789abcdef0123456789')).rejects.toThrow();
    });

    test('serves /healthz without auth and without data', async () => {
        const response = await fetch(`${baseUrl}/healthz`);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ status: 'ok' });
    });

    test('answers an unknown session with 404 so the client re-initializes', async () => {
        const response = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${AUTH_TOKEN}`,
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
                'Mcp-Session-Id': 'no-such-session',
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        });

        expect(response.status).toBe(404);
    });

    test('requires initialize before any other request', async () => {
        const response = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${AUTH_TOKEN}`,
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        });

        expect(response.status).toBe(400);
    });

    test('answers malformed JSON with a parse error', async () => {
        const response = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${AUTH_TOKEN}`,
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
            },
            body: '{not json',
        });

        expect(response.status).toBe(400);
        expect((await response.json()).error.code).toBe(-32700);
    });

    test('404s unknown paths', async () => {
        const response = await fetch(`${baseUrl}/elsewhere`);

        expect(response.status).toBe(404);
    });
});

describe('Streamable HTTP host validation', () => {
    let running: RunningHttpServer;

    beforeAll(async () => {
        running = await startHttpServer({
            host: '127.0.0.1',
            port: 0,
            allowedHosts: ['toshl-mcp.example.com'],
        });
    });

    afterAll(async () => {
        await running.close();
    });

    /**
     * Sends a request with an arbitrary Host header; fetch() does not allow overriding it
     * @param host Host header value
     * @returns HTTP status code
     */
    const statusForHost = async (host: string): Promise<number> => {
        return new Promise((resolve, reject) => {
            const req = request(
                { host: '127.0.0.1', port: running.port, path: '/healthz', headers: { Host: host } },
                (res) => {
                    res.resume();
                    resolve(res.statusCode ?? 0);
                }
            );
            req.on('error', reject);
            req.end();
        });
    };

    test('accepts loopback names and the configured public name', async () => {
        expect(await statusForHost(`localhost:${running.port}`)).toBe(200);
        expect(await statusForHost(`127.0.0.1:${running.port}`)).toBe(200);
        expect(await statusForHost('toshl-mcp.example.com')).toBe(200);
    });

    test('refuses any other Host, the DNS rebinding case', async () => {
        expect(await statusForHost('attacker.example.com')).toBe(403);
        expect(await statusForHost(`attacker.example.com:${running.port}`)).toBe(403);
    });
});
