import fs from 'fs';
import path from 'path';

const DEFAULT_COOKIE_STORE_PATH = path.join('runtime', 'xhs-cookie.json');
const MAX_COOKIE_LENGTH = 50_000;
const COOKIE_VALIDATION_MODE = 'selfinfo-v2';

export type AdminCookieAccount = {
  nickname?: string;
  avatar?: string;
  userId?: string;
};

export type AdminCookieStatus = {
  present: boolean;
  validFormat: boolean;
  verified: boolean;
  message: string;
  updatedAt?: string;
  validatedAt?: string;
  status?: 'active';
  account?: AdminCookieAccount;
};

export type StoredAdminCookie = {
  cookie: string;
  updatedAt: string;
  validatedAt?: string;
  status: 'active';
  validationMode?: typeof COOKIE_VALIDATION_MODE;
  account?: AdminCookieAccount;
};

export type AdminCookieValidationResult = {
  valid: boolean;
  message: string;
  cookie?: string;
};

export class AdminCookieValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminCookieValidationError';
  }
}

export function resolveAdminCookieStorePath(): string {
  const rawPath = process.env.XHS_COOKIE_STORE_PATH || DEFAULT_COOKIE_STORE_PATH;
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
}

export function validateAdminCookie(rawCookie: unknown): AdminCookieValidationResult {
  if (typeof rawCookie !== 'string') {
    return { valid: false, message: 'Cookie 必须是字符串' };
  }

  const cookie = rawCookie.trim();
  if (!cookie) {
    return { valid: false, message: 'Cookie 不能为空' };
  }

  if (cookie.length > MAX_COOKIE_LENGTH) {
    return { valid: false, message: `Cookie 过长，最多 ${MAX_COOKIE_LENGTH} 个字符` };
  }

  if (/[\r\n\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(cookie)) {
    return { valid: false, message: 'Cookie 不能包含换行或控制字符' };
  }

  const hasWebSession = cookie.split(';').some((part) => {
    const eqIndex = part.indexOf('=');
    if (eqIndex <= 0) return false;
    const name = part.slice(0, eqIndex).trim();
    const value = part.slice(eqIndex + 1).trim();
    return name === 'web_session' && value.length > 0;
  });

  if (!hasWebSession) {
    return { valid: false, message: 'Cookie 缺少有效的 web_session' };
  }

  return { valid: true, message: 'Cookie 格式有效', cookie };
}

function readStoredRecord(): StoredAdminCookie | null {
  const storePath = resolveAdminCookieStorePath();
  if (!fs.existsSync(storePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8')) as Partial<StoredAdminCookie>;
    if (typeof parsed.cookie !== 'string' || typeof parsed.updatedAt !== 'string') {
      return null;
    }
    return {
      cookie: parsed.cookie,
      updatedAt: parsed.updatedAt,
      validatedAt: typeof parsed.validatedAt === 'string' ? parsed.validatedAt : undefined,
      status: 'active',
      validationMode: parsed.validationMode === COOKIE_VALIDATION_MODE ? COOKIE_VALIDATION_MODE : undefined,
      account: sanitizeAccount(parsed.account),
    };
  } catch {
    return null;
  }
}

function sanitizeAccount(raw: unknown): AdminCookieAccount | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const account: AdminCookieAccount = {};
  if (typeof value.nickname === 'string' && value.nickname.trim()) {
    account.nickname = value.nickname.trim().slice(0, 80);
  }
  if (typeof value.avatar === 'string' && value.avatar.trim()) {
    account.avatar = value.avatar.trim().slice(0, 1000);
  }
  if (typeof value.userId === 'string' && value.userId.trim()) {
    account.userId = value.userId.trim().slice(0, 120);
  }
  return Object.keys(account).length > 0 ? account : undefined;
}

export function getAdminCookieStatus(): AdminCookieStatus {
  const record = readStoredRecord();
  if (!record) {
    return {
      present: false,
      validFormat: false,
      verified: false,
      message: '未配置 Cookie',
    };
  }

  const validation = validateAdminCookie(record.cookie);
  const verified = validation.valid && record.validationMode === COOKIE_VALIDATION_MODE;
  return {
    present: true,
    validFormat: validation.valid,
    verified,
    message: !validation.valid
      ? validation.message
      : verified
        ? 'Cookie 已通过实效校验'
        : 'Cookie 未通过实效校验，请重新提交',
    updatedAt: record.updatedAt,
    validatedAt: record.validatedAt,
    status: record.status,
    account: verified ? record.account : undefined,
  };
}

export function readAdminCookie(): StoredAdminCookie | null {
  const record = readStoredRecord();
  if (!record) return null;

  const validation = validateAdminCookie(record.cookie);
  if (!validation.valid) {
    return null;
  }
  if (record.validationMode !== COOKIE_VALIDATION_MODE) {
    return null;
  }

  return record;
}

export function saveAdminCookie(rawCookie: unknown, account?: AdminCookieAccount): AdminCookieStatus {
  const validation = validateAdminCookie(rawCookie);
  if (!validation.valid || !validation.cookie) {
    throw new AdminCookieValidationError(validation.message);
  }

  const now = new Date().toISOString();
  const storePath = resolveAdminCookieStorePath();
  const record: StoredAdminCookie = {
    cookie: validation.cookie,
    updatedAt: now,
    validatedAt: now,
    status: 'active',
    validationMode: COOKIE_VALIDATION_MODE,
    account: sanitizeAccount(account),
  };

  fs.mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(storePath, JSON.stringify(record, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.chmodSync(storePath, 0o600);

  return getAdminCookieStatus();
}

export function clearAdminCookie(): AdminCookieStatus {
  const storePath = resolveAdminCookieStorePath();
  try {
    fs.rmSync(storePath, { force: true });
  } catch {
    // Missing or concurrently removed files are equivalent to a cleared state.
  }

  return getAdminCookieStatus();
}
