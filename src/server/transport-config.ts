/**
 * Transport selection, loaded from the environment.
 *
 * stdio stays the default, so existing MCP client configs keep working unchanged.
 */

export interface HttpTransportConfig {
    /** Interface to bind. Loopback by default; put a TLS reverse proxy in front for remote use. */
    host: string;
    port: number;
    /** When set, `/mcp` requires `Authorization: Bearer <authToken>`. Never logged. */
    authToken?: string;
    /** Host header names accepted besides loopback, e.g. the reverse proxy's public name. */
    allowedHosts: string[];
}

export type TransportConfig =
    | { transport: 'stdio' }
    | { transport: 'http'; http: HttpTransportConfig };

/** Shortest MCP_AUTH_TOKEN accepted. 32 hex characters is 128 bits. */
export const MIN_AUTH_TOKEN_LENGTH = 32;

/**
 * Reads the transport settings from the environment
 * @param env Environment to read, `process.env` by default
 * @returns Transport configuration
 * @throws Error naming the offending variable when a value is invalid
 */
export function loadTransportConfig(env: NodeJS.ProcessEnv = process.env): TransportConfig {
    const transport = (env.MCP_TRANSPORT || 'stdio').trim().toLowerCase();

    if (transport === 'stdio') {
        return { transport: 'stdio' };
    }

    if (transport !== 'http') {
        throw new Error(`MCP_TRANSPORT must be "stdio" or "http", got "${transport}"`);
    }

    const portText = (env.MCP_HTTP_PORT || '3000').trim();
    const port = Number(portText);
    if (!/^\d+$/.test(portText) || port < 1 || port > 65535) {
        throw new Error(`MCP_HTTP_PORT must be a port number between 1 and 65535, got "${portText}"`);
    }

    const authToken = env.MCP_AUTH_TOKEN?.trim() || undefined;
    if (authToken !== undefined && authToken.length < MIN_AUTH_TOKEN_LENGTH) {
        // The value itself is deliberately left out of the message.
        throw new Error(`MCP_AUTH_TOKEN must be at least ${MIN_AUTH_TOKEN_LENGTH} characters`);
    }

    const allowedHosts = (env.MCP_ALLOWED_HOSTS || '')
        .split(',')
        .map((host) => host.trim().toLowerCase())
        .filter((host) => host.length > 0);

    return {
        transport: 'http',
        http: {
            host: (env.MCP_HTTP_HOST || '127.0.0.1').trim(),
            port,
            authToken,
            allowedHosts,
        },
    };
}
