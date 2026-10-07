import { TagsClient, createTagsClient } from '../../../src/api/endpoints/tags.js';
import { createTestClient } from '../../utils/test-helpers.js';

describe('TagsClient', () => {
    let client: TagsClient;

    beforeAll(async () => {
        const apiClient = createTestClient();
        client = await createTagsClient(apiClient);
    });

    test('listAllTags should return tags with status 200', async () => {
        const tags = await client.listAllTags();

        // Verify the response
        expect(Array.isArray(tags)).toBe(true);

        // If there are tags, verify their structure
        if (tags.length > 0) {
            const tag = tags[0];
            expect(tag.id).toBeDefined();
            expect(tag.name).toBeDefined();
            expect(tag.modified).toBeDefined();
        }
    });

    test('getTag should return tag with status 200', async () => {
        // First get the list of tags to find a valid ID
        const { tags } = await client.listTagsPage({ page: 0, per_page: 10 });

        // Skip the test if there are no tags
        if (tags.length === 0) {
            console.warn('Skipping getTag test: No tags available');
            return;
        }

        // Get the first tag ID
        const tagId = tags[0].id;

        // Get the tag details
        const tag = await client.getTag(tagId);

        // Verify the response
        expect(tag.id).toBe(tagId);
        expect(tag.name).toBeDefined();
        expect(tag.modified).toBeDefined();
    });
});
