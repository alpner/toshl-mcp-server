import { handleApiError, mapApiErrorToMcpError } from '../../src/utils/error-handler.js';
import { ApiError } from '../../src/utils/types.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

describe('Error Handler', () => {
    test('mapApiErrorToMcpError should map 401 to InvalidRequest', () => {
        // Create API error
        const apiError: ApiError = {
            status: 401,
            message: 'Unauthorized',
            id: 'unauthorized'
        };

        // Map error
        const mcpError = mapApiErrorToMcpError(apiError);

        // Verify error
        expect(mcpError.code).toBe(ErrorCode.InvalidRequest);
        expect(mcpError.message).toContain('Authentication failed');
    });

    test('mapApiErrorToMcpError should map 404 to MethodNotFound', () => {
        // Create API error
        const apiError: ApiError = {
            status: 404,
            message: 'Not Found',
            id: 'not_found'
        };

        // Map error
        const mcpError = mapApiErrorToMcpError(apiError);

        // Verify error
        expect(mcpError.code).toBe(ErrorCode.MethodNotFound);
        expect(mcpError.message).toContain('Resource not found');
    });

    test('mapApiErrorToMcpError should map 400 to InvalidParams', () => {
        // Create API error
        const apiError: ApiError = {
            status: 400,
            message: 'Bad Request',
            id: 'bad_request'
        };

        // Map error
        const mcpError = mapApiErrorToMcpError(apiError);

        // Verify error
        expect(mcpError.code).toBe(ErrorCode.InvalidParams);
        expect(mcpError.message).toContain('Invalid request');
    });

    test('mapApiErrorToMcpError should map 429 to InvalidRequest', () => {
        // Create API error
        const apiError: ApiError = {
            status: 429,
            message: 'Too Many Requests',
            id: 'rate_limit_exceeded'
        };

        // Map error
        const mcpError = mapApiErrorToMcpError(apiError);

        // Verify error
        expect(mcpError.code).toBe(ErrorCode.InvalidRequest);
        expect(mcpError.message).toContain('Rate limit exceeded');
    });

    test('mapApiErrorToMcpError should map 500 to InternalError', () => {
        // Create API error
        const apiError: ApiError = {
            status: 500,
            message: 'Internal Server Error',
            id: 'server_error'
        };

        // Map error
        const mcpError = mapApiErrorToMcpError(apiError);

        // Verify error
        expect(mcpError.code).toBe(ErrorCode.InternalError);
        expect(mcpError.message).toContain('Toshl API server error');
    });

    test('mapApiErrorToMcpError should map unknown status to InternalError', () => {
        // Create API error
        const apiError: ApiError = {
            status: 418, // I'm a teapot
            message: 'I\'m a teapot',
            id: 'teapot'
        };

        // Map error
        const mcpError = mapApiErrorToMcpError(apiError);

        // Verify error
        expect(mcpError.code).toBe(ErrorCode.InternalError);
        expect(mcpError.message).toContain('Unexpected error');
    });

    test('mapApiErrorToMcpError should map 409 to InvalidRequest and keep the status', () => {
        const mcpError = mapApiErrorToMcpError({ status: 409, message: 'Tag already exists.' });

        expect(mcpError.code).toBe(ErrorCode.InvalidRequest);
        expect(mcpError.message).toContain('Conflict: Tag already exists.');
        expect(mcpError.data).toEqual({ status: 409 });
    });
});

describe('handleApiError', () => {
    const axiosError = (status: number, data: unknown) => ({
        message: `Request failed with status code ${status}`,
        response: { status, data },
    });

    const thrownBy = (error: unknown): McpError => {
        try {
            handleApiError(error);
        } catch (thrown) {
            return thrown as McpError;
        }
        throw new Error('handleApiError did not throw');
    };

    test('prefers the Toshl description over the generic axios text', () => {
        const mcpError = thrownBy(axiosError(409, { id: 'conflict', description: 'Tag already exists.' }));

        expect(mcpError.message).toContain('Conflict: Tag already exists.');
        expect(mcpError.message).not.toContain('status code 409');
        expect(mcpError.data).toEqual({ status: 409 });
    });

    test('appends field errors to the description', () => {
        const mcpError = thrownBy(axiosError(400, {
            id: 'input_error',
            description: 'Could not insert expense.',
            fields: [
                { field: 'amount', error: 'Amount cannot be zero.' },
                { field: 'category', error: 'Please select at least one category.' },
            ],
        }));

        expect(mcpError.code).toBe(ErrorCode.InvalidParams);
        expect(mcpError.message).toContain(
            'Could not insert expense. amount: Amount cannot be zero.; category: Please select at least one category.'
        );
    });

    test('falls back to message, then to the axios text', () => {
        expect(thrownBy(axiosError(403, { message: 'Nope.' })).message).toContain('Access denied: Nope.');
        expect(thrownBy(axiosError(403, undefined)).message).toContain('Access denied: Request failed with status code 403');
    });

    test('appends the Toshl error id when the body has one', () => {
        const mcpError = thrownBy(axiosError(400, { id: 'input_error', description: 'Data error.' }));

        expect(mcpError.code).toBe(ErrorCode.InvalidParams);
        expect(mcpError.message).toBe('MCP error -32602: Invalid request: Data error. (id: input_error)');
    });

    test('appends the id after the field errors', () => {
        const mcpError = thrownBy(axiosError(400, {
            id: 'input_error',
            description: 'Could not insert expense.',
            fields: [{ field: 'amount', error: 'Amount cannot be zero.' }],
        }));

        expect(mcpError.message).toBe(
            'MCP error -32602: Invalid request: Could not insert expense. amount: Amount cannot be zero. (id: input_error)'
        );
    });

    test('leaves the message unchanged when the body has no id', () => {
        expect(thrownBy(axiosError(400, { description: 'Data error.' })).message)
            .toBe('MCP error -32602: Invalid request: Data error.');
        expect(thrownBy(axiosError(409, { description: 'Tag already exists.' })).message)
            .toBe('MCP error -32600: Conflict: Tag already exists.');
        expect(thrownBy(axiosError(403, undefined)).message)
            .toBe('MCP error -32600: Access denied: Request failed with status code 403');
    });

    test('ignores an id that is not a string', () => {
        expect(thrownBy(axiosError(400, { id: { nested: true }, description: 'Data error.' })).message)
            .toBe('MCP error -32602: Invalid request: Data error.');
    });

    test('keeps the fixed 401 and 429 texts even when the body has an id', () => {
        expect(thrownBy(axiosError(401, { id: 'unauthorized', description: 'Bad token.' })).message)
            .toBe('MCP error -32600: Authentication failed. Please check your API token.');
        expect(thrownBy(axiosError(429, { id: 'rate_limit', description: 'Slow down.' })).message)
            .toBe('MCP error -32600: Rate limit exceeded. Please try again later.');
    });
});
