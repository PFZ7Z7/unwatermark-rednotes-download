import axios from 'axios';
import {
  AdminCookieAccount,
  AdminCookieValidationError,
  validateAdminCookie,
} from './adminCookieStore';

export type VerifiedXhsCookie = {
  cookie: string;
  account?: AdminCookieAccount;
};

export class XhsCookieVerificationError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'XhsCookieVerificationError';
    this.statusCode = statusCode;
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

function getMediaCrawlerApi(): string {
  return process.env.MEDIACRAWLER_API || 'http://localhost:8080';
}

export async function verifyXhsCookie(rawCookie: unknown): Promise<VerifiedXhsCookie> {
  const format = validateAdminCookie(rawCookie);
  if (!format.valid || !format.cookie) {
    throw new AdminCookieValidationError(format.message);
  }

  try {
    const response = await axios.post(
      `${getMediaCrawlerApi()}/api/xhs/validate-cookie`,
      { cookie: format.cookie },
      { timeout: 20_000 },
    );

    const payload = response.data || {};
    if (!payload.valid) {
      throw new XhsCookieVerificationError(payload.message || 'Cookie 校验未通过', 400);
    }

    return {
      cookie: format.cookie,
      account: sanitizeAccount(payload.account),
    };
  } catch (error: any) {
    if (error instanceof XhsCookieVerificationError || error instanceof AdminCookieValidationError) {
      throw error;
    }

    const status = Number(error?.response?.status || 0);
    const message = error?.response?.data?.message || error?.response?.data?.detail;
    if (status === 400 || status === 401 || status === 403) {
      throw new XhsCookieVerificationError(message || 'Cookie 已失效或无法访问当前账号', 400);
    }
    if (status === 404) {
      throw new XhsCookieVerificationError('驱动器版本过旧，暂不支持 Cookie 实效校验，请更新并重启驱动器', 503);
    }

    throw new XhsCookieVerificationError(
      error?.code === 'ECONNREFUSED'
        ? '驱动器未运行，无法校验 Cookie'
        : (message || `Cookie 校验服务不可用: ${error?.message || 'unknown'}`),
      503,
    );
  }
}
