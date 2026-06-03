import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMediaCrawlerStartPayload,
  mergeEnrichedNoteMedia,
  parseCrawlerLogProgress,
} from './xiaohongshu';

describe('MediaCrawler start payload', () => {
  test('uses current max_notes_count field for search tasks', () => {
    const payload = buildMediaCrawlerStartPayload({
      crawlerType: 'search',
      cookies: 'web_session=session-value',
      maxCount: 20,
      keywords: 'test',
    });

    assert.equal(payload.max_notes_count, 20);
    assert.equal('max_notes' in payload, false);
  });

  test('uses current max_notes_count field for creator tasks', () => {
    const payload = buildMediaCrawlerStartPayload({
      crawlerType: 'creator',
      cookies: 'web_session=session-value',
      maxCount: 12,
      creatorId: '5e422d99000000000100a219',
    });

    assert.equal(payload.creator_ids, '5e422d99000000000100a219');
    assert.equal(payload.max_notes_count, 12);
    assert.equal('max_notes' in payload, false);
  });
});

describe('MediaCrawler progress parsing', () => {
  test('counts creator index discovery separately from parsed details', () => {
    const progress = parseCrawlerLogProgress([
      { message: "[XiaoHongShuClient.get_all_notes_by_creator] got user_id:abc notes len : 31" },
      { message: "[get_note_detail_async_task] Begin get note detail, note_id: note_a" },
      { message: "[get_note_detail_async_task] Begin get note detail, note_id: note_b" },
    ]);

    assert.equal(progress.discoveredCount, 31);
    assert.equal(progress.detailTaskCount, 2);
  });

  test('counts search response index items without rec_query and hot_query entries', () => {
    const progress = parseCrawlerLogProgress([
      {
        message: "[XiaoHongShuCrawler.search] Search notes response: {'items': [{'model_type': 'note', 'id': 'a'}, {'model_type': 'rec_query'}, {'model_type': 'hot_query'}, {'model_type': 'note', 'id': 'b'}]}",
      },
    ]);

    assert.equal(progress.discoveredCount, 2);
  });
});

describe('note media enrichment merge', () => {
  test('keeps list metadata while replacing richer media fields', () => {
    const merged = mergeEnrichedNoteMedia(
      {
        noteId: 'note_1',
        title: '列表标题',
        desc: '列表描述',
        type: 'image',
        author: { nickname: '列表作者', avatar: 'avatar-a' },
        images: ['https://example.com/a.jpg'],
        likes: 10,
        collects: 2,
        comments: 1,
        noteUrl: 'https://www.xiaohongshu.com/explore/note_1',
        parseMode: 'mediacrawler',
      },
      {
        noteId: 'note_1',
        title: '详情标题',
        desc: '详情描述',
        type: 'image',
        author: { nickname: '详情作者', avatar: 'avatar-b' },
        images: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
        livePhotos: [{
          imageUrl: 'https://example.com/b.jpg',
          videoUrl: 'https://example.com/b.mp4',
          index: 1,
          duration: 0,
        }],
        likes: 0,
        collects: 0,
        comments: 0,
        parseMode: 'anonymous',
      }
    );

    assert.equal(merged.title, '列表标题');
    assert.equal(merged.author.nickname, '列表作者');
    assert.deepEqual(merged.images, ['https://example.com/a.jpg', 'https://example.com/b.jpg']);
    assert.equal(merged.livePhotos?.[0].videoUrl, 'https://example.com/b.mp4');
    assert.equal(merged.parseMode, 'anonymous');
  });
});
