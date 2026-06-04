import crypto from 'crypto';

export type DownloadJobStatus = 'queued' | 'enriching' | 'ready' | 'downloading' | 'completed' | 'failed';

export type DownloadJobProgress = {
  jobId: string;
  status: DownloadJobStatus;
  totalNotes: number;
  enrichedNotes: number;
  totalFiles: number;
  zippedFiles: number;
  downloadedBytes: number;
  createdAt: string;
  updatedAt: string;
  message: string;
};

export type DownloadJob<TNote = unknown, TDownloadItem = unknown> = DownloadJobProgress & {
  notes: TNote[];
  downloadItems?: TDownloadItem[];
  expiresAt: number;
  error?: string;
  fileStartedAt?: string;
  fileCompletedAt?: string;
};

export type DownloadJobStoreOptions = {
  ttlMs?: number;
  maxJobs?: number;
  now?: () => number;
};

export type DownloadJobStore<TNote = unknown, TDownloadItem = unknown> = {
  create(notes: TNote[]): DownloadJob<TNote, TDownloadItem>;
  get(jobId: string): DownloadJob<TNote, TDownloadItem> | null;
  getProgress(jobId: string): DownloadJobProgress | null;
  setDownloadItems(jobId: string, items: TDownloadItem[]): void;
  markEnriching(jobId: string): void;
  recordNoteEnriched(jobId: string): void;
  markReady(jobId: string, totalFiles: number): void;
  markDownloading(jobId: string): void;
  recordFileBytes(jobId: string, bytes: number): void;
  recordFileAdded(jobId: string): void;
  markCompleted(jobId: string): void;
  markFailed(jobId: string, error: unknown): void;
  prune(): void;
};

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_JOBS = 50;
const SENSITIVE_QUERY_PATTERN = /((?:xsec_token|web_session|token|sign|password)=)[^&#\s]+/gi;

function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || '任务失败');
  return raw.replace(SENSITIVE_QUERY_PATTERN, '$1***').slice(0, 300);
}

function messageForStatus(status: DownloadJobStatus): string {
  switch (status) {
    case 'queued':
      return '任务已创建';
    case 'enriching':
      return '正在补全媒体信息';
    case 'ready':
      return 'ZIP 已准备生成';
    case 'downloading':
      return '正在生成 ZIP';
    case 'completed':
      return '下载已完成';
    case 'failed':
      return '任务失败';
  }
}

export function createDownloadJobStore<TNote = unknown, TDownloadItem = unknown>(
  options: DownloadJobStoreOptions = {}
): DownloadJobStore<TNote, TDownloadItem> {
  const ttlMs = Math.max(1, options.ttlMs ?? DEFAULT_TTL_MS);
  const maxJobs = Math.max(1, options.maxJobs ?? DEFAULT_MAX_JOBS);
  const now = options.now ?? Date.now;
  const jobs = new Map<string, DownloadJob<TNote, TDownloadItem>>();

  function iso(): string {
    return new Date(now()).toISOString();
  }

  function touch(job: DownloadJob<TNote>): void {
    job.updatedAt = iso();
    job.expiresAt = now() + ttlMs;
  }

  function setStatus(job: DownloadJob<TNote>, status: DownloadJobStatus, message?: string): void {
    job.status = status;
    job.message = message || messageForStatus(status);
    touch(job);
  }

  function get(jobId: string): DownloadJob<TNote, TDownloadItem> | null {
    const job = jobs.get(jobId);
    if (!job) return null;
    if (job.expiresAt <= now()) {
      jobs.delete(jobId);
      return null;
    }
    return job;
  }

  function requireJob(jobId: string): DownloadJob<TNote, TDownloadItem> {
    const job = get(jobId);
    if (!job) {
      throw new Error('下载任务不存在或已过期');
    }
    return job;
  }

  function toProgress(job: DownloadJob<TNote>): DownloadJobProgress {
    return {
      jobId: job.jobId,
      status: job.status,
      totalNotes: job.totalNotes,
      enrichedNotes: job.enrichedNotes,
      totalFiles: job.totalFiles,
      zippedFiles: job.zippedFiles,
      downloadedBytes: job.downloadedBytes,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      message: job.message,
    };
  }

  function prune(): void {
    const current = now();
    for (const [jobId, job] of jobs) {
      if (job.expiresAt <= current) {
        jobs.delete(jobId);
      }
    }

    while (jobs.size > maxJobs) {
      const oldest = jobs.keys().next().value;
      if (!oldest) break;
      jobs.delete(oldest);
    }
  }

  return {
    create(notes: TNote[]): DownloadJob<TNote, TDownloadItem> {
      prune();
      const jobId = crypto.randomBytes(12).toString('hex');
      const timestamp = iso();
      const job: DownloadJob<TNote, TDownloadItem> = {
        jobId,
        status: 'queued',
        totalNotes: notes.length,
        enrichedNotes: 0,
        totalFiles: 0,
        zippedFiles: 0,
        downloadedBytes: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        message: messageForStatus('queued'),
        notes: notes.slice(),
        expiresAt: now() + ttlMs,
      };
      jobs.set(jobId, job);
      prune();
      return job;
    },
    get,
    getProgress(jobId: string): DownloadJobProgress | null {
      const job = get(jobId);
      return job ? toProgress(job) : null;
    },
    setDownloadItems(jobId: string, items: TDownloadItem[]): void {
      const job = requireJob(jobId);
      job.downloadItems = items.slice();
      touch(job);
    },
    markEnriching(jobId: string): void {
      setStatus(requireJob(jobId), 'enriching');
    },
    recordNoteEnriched(jobId: string): void {
      const job = requireJob(jobId);
      job.enrichedNotes = Math.min(job.totalNotes, job.enrichedNotes + 1);
      touch(job);
    },
    markReady(jobId: string, totalFiles: number): void {
      const job = requireJob(jobId);
      job.totalFiles = Math.max(0, Math.floor(totalFiles));
      setStatus(job, 'ready');
    },
    markDownloading(jobId: string): void {
      const job = requireJob(jobId);
      job.fileStartedAt = iso();
      setStatus(job, 'downloading');
    },
    recordFileBytes(jobId: string, bytes: number): void {
      const job = requireJob(jobId);
      job.downloadedBytes += Math.max(0, Math.floor(bytes));
      touch(job);
    },
    recordFileAdded(jobId: string): void {
      const job = requireJob(jobId);
      job.zippedFiles = Math.min(Math.max(job.totalFiles, 0), job.zippedFiles + 1);
      touch(job);
    },
    markCompleted(jobId: string): void {
      const job = requireJob(jobId);
      job.fileCompletedAt = iso();
      setStatus(job, 'completed');
    },
    markFailed(jobId: string, error: unknown): void {
      const job = requireJob(jobId);
      job.error = safeMessage(error);
      setStatus(job, 'failed', job.error);
    },
    prune,
  };
}
