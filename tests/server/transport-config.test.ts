import { loadTransportConfig } from '../../src/server/transport-config.js';

// Placeholder long enough to pass the length check.
const TOKEN = 'x'.repeat(32);

describe('loadTransportConfig', () => {
    test('defaults to stdio', () => {
        expect(loadTransportConfig({})).toEqual({ transport: 'stdio' });
    });

    test('http defaults to loopback port 3000 without auth', () => {
        expect(loadTransportConfig({ MCP_TRANSPORT: 'http' })).toEqual({
            transport: 'http',
            http: { host: '127.0.0.1', port: 3000, authToken: undefined, allowedHosts: [] },
        });
    });

    test('reads host, port, token and allowed hosts', () => {
        const config = loadTransportConfig({
            MCP_TRANSPORT: 'HTTP',
            MCP_HTTP_HOST: '0.0.0.0',
            MCP_HTTP_PORT: '8080',
            MCP_AUTH_TOKEN: TOKEN,
            MCP_ALLOWED_HOSTS: ' Toshl-MCP.example.com , ,other.example.com',
        });

        expect(config).toEqual({
            transport: 'http',
            http: {
                host: '0.0.0.0',
                port: 8080,
                authToken: TOKEN,
                allowedHosts: ['toshl-mcp.example.com', 'other.example.com'],
            },
        });
    });

    test('treats an empty MCP_AUTH_TOKEN as unset', () => {
        const config = loadTransportConfig({ MCP_TRANSPORT: 'http', MCP_AUTH_TOKEN: '  ' });

        expect(config.transport === 'http' && config.http.authToken).toBeUndefined();
    });

    test('rejects an unknown transport', () => {
        expect(() => loadTransportConfig({ MCP_TRANSPORT: 'sse' })).toThrow('MCP_TRANSPORT');
    });

    test.each(['0', '65536', 'abc', '80.5', '-1'])('rejects port %s', (port) => {
        expect(() => loadTransportConfig({ MCP_TRANSPORT: 'http', MCP_HTTP_PORT: port })).toThrow(
            'MCP_HTTP_PORT'
        );
    });

    test('rejects a short MCP_AUTH_TOKEN without echoing it', () => {
        expect(() => loadTransportConfig({ MCP_TRANSPORT: 'http', MCP_AUTH_TOKEN: 'hunter2' })).toThrow(
            /^MCP_AUTH_TOKEN must be at least 32 characters$/
        );
    });
});
