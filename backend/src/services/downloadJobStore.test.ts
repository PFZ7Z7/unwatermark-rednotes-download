import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDownloadJobStore,
  type DownloadJobProgress,
} from './downloadJobStore';

describe('download job store', () => {
  test('tracks download job lifecycle and counters', () => {
    const store = createDownloadJobStore({ ttlMs: 60_000, maxJobs: 10 });
    const job = store.create([{ noteId: 'a' }, { noteId: 'b' }]);

    assert.equal(job.status, 'queued');
    assert.equal(job.totalNotes, 2);
    assert.equal(job.enrichedNotes, 0);
    assert.equal(job.totalFiles, 0);
    assert.equal(job.zippedFiles, 0);
    assert.equal(job.downloadedBytes, 0);

    store.markEnriching(job.jobId);
    store.recordNoteEnriched(job.jobId);
    store.recordNoteEnriched(job.jobId);
    store.markReady(job.jobId, 5);
    store.markDownloading(job.jobId);
    store.recordFileBytes(job.jobId, 1024);
    store.recordFileAdded(job.jobId);
    store.recordFileBytes(job.jobId, 2048);
    store.recordFileAdded(job.jobId);

    const progress = store.getProgress(job.jobId) as DownloadJobProgress;
    assert.equal(progress.status, 'downloading');
    assert.equal(progress.enrichedNotes, 2);
    assert.equal(progress.totalFiles, 5);
    assert.equal(progress.zippedFiles, 2);
    assert.equal(progress.downloadedBytes, 3072);
    assert.equal(progress.message, '正在生成 ZIP');

    store.markCompleted(job.jobId);
    assert.equal(store.getProgress(job.jobId)?.status, 'completed');
  });

  test('stores safe failure state and prunes expired jobs', () => {
    let now = 1_000;
    const store = createDownloadJobStore({ ttlMs: 100, maxJobs: 10, now: () => now });
    const job = store.create([{ noteId: 'a' }]);

    store.markFailed(job.jobId, new Error('upstream token=secret failed'));

    const failed = store.getProgress(job.jobId);
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.message, 'upstream token=*** failed');

    now = 1_200;
    store.prune();
    assert.equal(store.getProgress(job.jobId), null);
  });

  test('stores prepared download items on the job', () => {
    const store = createDownloadJobStore({ ttlMs: 60_000, maxJobs: 10 });
    const job = store.create([{ noteId: 'a' }]);

    store.setDownloadItems(job.jobId, [{ url: 'https://example.com/a.jpg', filename: 'a.jpg' }]);

    const saved = store.get(job.jobId);
    assert.deepEqual(saved?.downloadItems, [{ url: 'https://example.com/a.jpg', filename: 'a.jpg' }]);
  });
});
