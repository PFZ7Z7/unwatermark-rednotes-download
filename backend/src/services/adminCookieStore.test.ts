import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearAdminCookie,
  getAdminCookieStatus,
  readAdminCookie,
  saveAdminCookie,
  validateAdminCookie,
} from './adminCookieStore';

let tmpDir = '';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-cookie-store-'));
  process.env.XHS_COOKIE_STORE_PATH = path.join(tmpDir, 'nested', 'xhs-cookie.json');
});

afterEach(() => {
  delete process.env.XHS_COOKIE_STORE_PATH;
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  }
});

describe('admin cookie store', () => {
  test('rejects a cookie without web_session', () => {
    const result = validateAdminCookie('a=1; foo=bar');

    assert.equal(result.valid, false);
    assert.match(result.message, /web_session/);
  });

  test('stores a valid cookie and returns safe metadata only', () => {
    const status = saveAdminCookie('a=1; web_session=session-value; webId=abc', {
      nickname: 'tester',
      avatar: 'https://example.com/avatar.jpg',
      userId: 'user_1',
    });

    assert.equal(status.present, true);
    assert.equal(status.validFormat, true);
    assert.equal(status.verified, true);
    assert.equal(status.account?.nickname, 'tester');
    assert.equal(typeof status.updatedAt, 'string');
    assert.equal('cookie' in status, false);

    const raw = fs.readFileSync(process.env.XHS_COOKIE_STORE_PATH!, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.cookie, 'a=1; web_session=session-value; webId=abc');
    assert.equal(parsed.validationMode, 'selfinfo-v2');
    assert.equal(parsed.account.nickname, 'tester');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(process.env.XHS_COOKIE_STORE_PATH!).mode & 0o777, 0o600);
    }
  });

  test('reads the stored cookie for internal service use', () => {
    saveAdminCookie('web_session=session-value; webId=abc');

    const record = readAdminCookie();

    assert.equal(record?.cookie, 'web_session=session-value; webId=abc');
    assert.equal(record?.status, 'active');
  });

  test('does not treat legacy format-only records as verified login state', () => {
    const storePath = process.env.XHS_COOKIE_STORE_PATH!;
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify({
      cookie: 'web_session=legacy-session',
      updatedAt: new Date().toISOString(),
      validatedAt: new Date().toISOString(),
      status: 'active',
    }));

    const status = getAdminCookieStatus();

    assert.equal(status.present, true);
    assert.equal(status.validFormat, true);
    assert.equal(status.verified, false);
    assert.equal(readAdminCookie(), null);
  });

  test('clear removes the stored cookie and reports missing status', () => {
    saveAdminCookie('web_session=session-value; webId=abc');

    const status = clearAdminCookie();

    assert.equal(status.present, false);
    assert.equal(status.validFormat, false);
    assert.equal(fs.existsSync(process.env.XHS_COOKIE_STORE_PATH!), false);
    assert.equal(getAdminCookieStatus().present, false);
  });

  test('rejects oversized cookies', () => {
    const oversized = `web_session=${'x'.repeat(50_001)}`;

    const result = validateAdminCookie(oversized);

    assert.equal(result.valid, false);
    assert.match(result.message, /过长/);
  });
});
