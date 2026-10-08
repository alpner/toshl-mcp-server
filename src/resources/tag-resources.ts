import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { createTagsClient } from '../api/endpoints/tags.js';
import logger from '../utils/logger.js';

/**
 * Sets up tag resources
 * @param server MCP server
 * @param uri Resource URI
 * @returns Resource response
 */
export async function setupTagResources(server: Server, uri: string) {
    logger.debug('Setting up tag resources', { uri });

    // Create tags client
    const tagsClient = await createTagsClient();

    try {
        // Handle list tags
        if (uri === 'toshl://tags/list') {
            const tags = await tagsClient.listAllTags();

            return {
                contents: [
                    {
                        uri,
                        mimeType: 'application/json',
                        text: JSON.stringify(tags, null, 2),
                    },
                ],
            };
        }

        // Handle get tag by ID
        const tagMatch = uri.match(/^toshl:\/\/tags\/([^\/]+)$/);
        if (tagMatch) {
            const tagId = tagMatch[1];
            const tag = await tagsClient.getTag(tagId);

            return {
                contents: [
                    {
                        uri,
                        mimeType: 'application/json',
                        text: JSON.stringify(tag, null, 2),
                    },
                ],
            };
        }

        // If we get here, the URI is not supported
        throw new McpError(
            ErrorCode.MethodNotFound,
            `Resource not found: ${uri}`
        );
    } catch (error) {
        // If it's already an MCP error, rethrow it
        if (error instanceof McpError) {
            throw error;
        }

        // Otherwise, wrap it in an MCP error
        logger.error('Error handling tag resource', { uri, error });
        throw new McpError(
            ErrorCode.InternalError,
            `Error handling tag resource: ${(error as Error).message}`
        );
    }
}
