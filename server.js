import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import * as Lark from '@larksuiteoapi/node-sdk';
import path from 'node:path';
import sharp from 'sharp';
import { createWorker, PSM } from 'tesseract.js';
import { fileURLToPath } from 'node:url';
import {
  createSessionCookie,
  readSessionCookie,
  serializeExpiredSessionCookie
} from './lib/session.js';
import { parseImageRecords } from './lib/ocr-parser.js';
import {
  assertCallbackVerificationToken,
  isEncryptedCallbackPayload
} from './lib/lark-callback.js';
import { parseWithdrawCommand } from './lib/withdraw-command.js';
import { withdrawDigest } from './lib/withdraw-digest.js';
import { WithdrawCompletionRegistry } from './lib/withdraw-idempotency.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnvFile(filePath = path.join(__dirname, '.env')) {
  if (!existsSync(filePath)) return;
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/u);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (!match || process.env[match[1]] != null) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadEnvFile();

// 以下配置全部支持环境变量覆盖，便于同一份代码部署到不同服务器或多维表格。
// 代码中的默认值只保留原项目历史配置，生产环境建议全部显式写入 .env。
const BASE_TOKEN = process.env.BASE_TOKEN || 'KrVRbjTKOatunlslgHlcdPyindc';
const LEDGER_TABLE = process.env.LEDGER_TABLE || 'tbl88pkryfLsRNNk';
const ACCOUNT_TABLE = process.env.ACCOUNT_TABLE || 'tblcvlBAmioZD4CJ';
const WITHDRAW_TABLE = process.env.WITHDRAW_TABLE || 'tblP1pNflMJGHDgf';
const WHITELIST_TABLE = process.env.WHITELIST_TABLE || 'tbleU3I3ejRn3sTj';
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || 'ou_0666dc75244dd56bbbad486f995caf1f';
const LARK_APP_ID = process.env.FEISHU_APP_ID || 'cli_aaba740b6939dbb7';
const LARK_APP_SECRET = process.env.FEISHU_APP_SECRET;
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const LARK_VERIFICATION_TOKEN = process.env.LARK_VERIFICATION_TOKEN || process.env.FEISHU_VERIFICATION_TOKEN || '';
const LARK_ENCRYPT_KEY = process.env.LARK_ENCRYPT_KEY || process.env.FEISHU_ENCRYPT_KEY || '';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_BATCH_ROWS = 20;
const MAX_JSON_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const WITHDRAW_POLL_INTERVAL_MS = Number(process.env.WITHDRAW_POLL_INTERVAL_MS || 60 * 1000);
const WITHDRAW_POLL_ENABLED = process.env.WITHDRAW_POLL_ENABLED !== 'false';
const LARK_WS_EVENTS_ENABLED = process.env.LARK_WS_EVENTS_ENABLED !== 'false';
const WITHDRAW_WEBHOOK_TOKEN = process.env.WITHDRAW_WEBHOOK_TOKEN || SESSION_SECRET || '';
const rateLimitBuckets = new Map();
const FEISHU_AUTHORIZE_URL = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize';
const FEISHU_OAUTH_TOKEN_URL = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token';
const FEISHU_USER_INFO_URL = 'https://open.feishu.cn/open-apis/authen/v1/user_info';

const FIELD = {
  ledgerPerson: 'flddaf8PjY',
  ledgerAmount: 'fldhwCZ4yi',
  ledgerTask: 'fldTcwBrNl',
  ledgerAccount: 'fldRPa1c85',
  ledgerReason: 'fldjXM4dcF',
  ledgerStatus: 'fldD2oD6Qr',
  ledgerSerial: 'fldo3y6Tl7',
  ledgerSent: 'fldAXt8txt',
  accountName: 'fldNFkryXS',
  accountPerson: 'fldaCZqNY4',
  accountBalance: 'fldq1dWxL5',
  accountStatus: 'fldcRghGZ7',
  accountWithdraws: 'fldTq9ZhiA',
  withdrawSerial: process.env.WITHDRAW_SERIAL_FIELD || 'fldNvlM3Q8',
  withdrawPerson: process.env.WITHDRAW_PERSON_FIELD || 'fldMh5eZJx',
  withdrawAccount: process.env.WITHDRAW_ACCOUNT_FIELD || 'fldMBp5NJI',
  withdrawAmount: process.env.WITHDRAW_AMOUNT_FIELD || 'flddN5H2om',
  withdrawBeforeBalance: process.env.WITHDRAW_BEFORE_BALANCE_FIELD || 'fldYaKq6dU',
  withdrawAfterBalance: process.env.WITHDRAW_AFTER_BALANCE_FIELD || 'fldHoUYMSx',
  withdrawTime: process.env.WITHDRAW_TIME_FIELD || 'fld80lEU6y',
  frontendWhitelistPerson: process.env.WHITELIST_PERSON_FIELD || 'fldqSinMmy'
};

const publicDir = path.join(__dirname, 'src');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
};

const reviewActionText = {
  confirm: '确认入账',
  reject: '驳回'
};

const claimCache = new Map();
const fieldCache = new Map();
const oauthStateCache = new Map();
const withdrawCache = new Map();
const withdrawCompletionRegistry = new WithdrawCompletionRegistry();
const processedEventIds = new Map();
const seenWithdrawRecordDigests = new Map();
let withdrawPollInitialized = false;
let withdrawPollRunning = false;
let whitelistCache = null;
let larkClient;
let larkWsClient;
let ocrWorkerPromise;

const cardActionHandler = new Lark.CardActionHandler({
  // HTTP 入口先做 token 校验；SDK 在这里负责解密和适配不同卡片回调形态。
  verificationToken: undefined,
  encryptKey: LARK_ENCRYPT_KEY || undefined,
  loggerLevel: Lark.LoggerLevel.fatal
}, handleCardAction);

function safeErrorMessage(error) {
  return error?.response?.data?.msg ||
    error?.response?.data?.message ||
    error?.msg ||
    error?.message ||
    '未知错误';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function forget(promise, label) {
  promise.catch((error) => console.warn(`${label}失败：${safeErrorMessage(error)}`));
}

function rememberClaim(claim) {
  if (!claim?.serial) return claim;
  claimCache.set(claim.serial, claim);
  return claim;
}

function rememberWithdraw(withdraw) {
  if (!withdraw?.serial) return withdraw;
  withdrawCache.set(withdraw.serial, withdraw);
  return withdraw;
}

function getLarkClient() {
  if (!LARK_APP_SECRET) {
    throw new Error('缺少 FEISHU_APP_SECRET，请设置企业自建应用 App Secret 后重启服务');
  }
  if (!larkClient) {
    larkClient = new Lark.Client({
      appId: LARK_APP_ID,
      appSecret: LARK_APP_SECRET,
      appType: Lark.AppType.SelfBuild,
      domain: Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel.fatal
    });
  }
  return larkClient;
}

function requireSessionSecret() {
  if (!SESSION_SECRET || SESSION_SECRET.length < 24) {
    throw new Error('缺少 SESSION_SECRET，请设置至少 24 位随机字符串后重启服务');
  }
}

function cleanupOAuthStates() {
  const now = Date.now();
  for (const [state, payload] of oauthStateCache.entries()) {
    if (!payload || payload.expiresAt <= now) oauthStateCache.delete(state);
  }
}

function externalOrigin(req) {
  // PUBLIC_ORIGIN 是生产部署时的权威外部地址。
  // 如果未配置，则根据反向代理头推断，方便本地调试。
  if (PUBLIC_ORIGIN) return PUBLIC_ORIGIN.replace(/\/+$/u, '');
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function oauthRedirectUri(req) {
  return process.env.FEISHU_OAUTH_REDIRECT_URI || `${externalOrigin(req)}/oauth/callback`;
}

function buildLoginUrl(req) {
  cleanupOAuthStates();
  const state = randomUUID();
  const redirectUri = oauthRedirectUri(req);
  oauthStateCache.set(state, {
    redirectUri,
    expiresAt: Date.now() + OAUTH_STATE_TTL_MS
  });
  const url = new URL(FEISHU_AUTHORIZE_URL);
  url.searchParams.set('app_id', LARK_APP_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

async function feishuPost(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...headers
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || (payload.code != null && Number(payload.code) !== 0) || payload.error) {
    throw new Error(payload.msg || payload.error_description || payload.error || payload.message || `飞书接口返回 ${response.status}`);
  }
  return payload.data || payload;
}

async function exchangeOAuthCode(code, redirectUri) {
  const data = await feishuPost(FEISHU_OAUTH_TOKEN_URL, {
    grant_type: 'authorization_code',
    client_id: LARK_APP_ID,
    client_secret: LARK_APP_SECRET,
    code,
    redirect_uri: redirectUri
  });
  const accessToken = data.access_token || data.user_access_token;
  if (!accessToken) throw new Error('未获取到用户登录态');
  return accessToken;
}

async function fetchOAuthUser(accessToken) {
  const response = await fetch(FEISHU_USER_INFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || (payload.code != null && Number(payload.code) !== 0)) {
    throw new Error(payload.msg || payload.message || '获取登录用户信息失败');
  }
  const data = payload.data || payload;
  const openId = data.open_id;
  if (!openId) throw new Error('登录成功，但未获取到 open_id');
  return {
    openId,
    name: data.name || data.en_name || '飞书用户',
    avatarUrl: data.avatar_url || data.avatar_thumb || ''
  };
}

function currentSession(req) {
  if (!SESSION_SECRET) return null;
  return readSessionCookie({
    cookieHeader: req.headers.cookie || '',
    secret: SESSION_SECRET
  });
}

async function unwrapLark(promise) {
  const response = await promise;
  if (response?.code && response.code !== 0) {
    throw new Error(response.msg || '飞书接口调用失败');
  }
  return response?.data || {};
}

async function requestLark(payload) {
  const response = await getLarkClient().request(payload);
  if (response?.code && response.code !== 0) {
    throw new Error(response.msg || '飞书接口调用失败');
  }
  return response?.data || {};
}

async function getFieldMeta(table) {
  if (fieldCache.has(table)) return fieldCache.get(table);
  const byId = new Map();
  let pageToken = undefined;
  do {
    const data = await unwrapLark(getLarkClient().bitable.appTableField.list({
      path: { app_token: BASE_TOKEN, table_id: table },
      params: { page_size: 100, page_token: pageToken }
    }));
    (data.items || []).forEach((field) => {
      if (field.field_id) byId.set(field.field_id, field);
    });
    pageToken = data.has_more ? data.page_token : undefined;
  } while (pageToken);
  fieldCache.set(table, byId);
  return byId;
}

async function getFieldNames(table, fieldIds) {
  const meta = await getFieldMeta(table);
  return fieldIds.map((fieldId) => meta.get(fieldId)?.field_name || fieldId);
}

async function fieldsByIdToName(table, valuesByFieldId) {
  const meta = await getFieldMeta(table);
  return Object.fromEntries(
    Object.entries(valuesByFieldId).map(([fieldId, value]) => {
      const field = meta.get(fieldId);
      return [field?.field_name || fieldId, normalizeRecordValue(field, value)];
    })
  );
}

async function rowToRecordFields(table, fieldIds, row) {
  const values = {};
  fieldIds.forEach((fieldId, index) => {
    values[fieldId] = row[index];
  });
  return fieldsByIdToName(table, values);
}

function normalizeRecordValue(field, value) {
  if (Array.isArray(value) && ['SingleLink', 'DuplexLink'].includes(field?.ui_type)) {
    return value.map((item) => typeof item === 'object' ? item.id || item.record_id : item).filter(Boolean);
  }
  return value;
}

function normalizeUser(user, matchedQuery = '') {
  const departmentPath = Array.isArray(user.department_path)
    ? user.department_path
      .map((item) => item.department_path?.department_path_name?.name || item.department_name?.name)
      .filter(Boolean)
      .join('/')
    : '';
  return {
    ...user,
    localized_name: user.localized_name || user.name || '',
    matched_query: matchedQuery,
    department: departmentPath || (user.department_ids || []).join('/'),
    enterprise_email: user.enterprise_email || user.email || ''
  };
}

function cellText(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(cellText).filter(Boolean).join('、');
  if (typeof value === 'object') return value.name || value.text || value.value || value.id || '';
  return String(value);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cardPlainText(value) {
  return String(value || '').replace(/[<>]/g, '');
}

function compactMarkdownLines(lines) {
  return lines.map((line) => cardPlainText(line)).join('\n');
}

function firstUser(value) {
  return Array.isArray(value) && value.length ? value[0] : null;
}

function fieldItemId(value) {
  const item = firstUser(value);
  if (!item) return '';
  if (typeof item === 'string') return item;
  return item.id || item.record_id || item.open_id || '';
}

async function listRecords(table, fields, limit = 200, offset = 0) {
  const fieldNames = await getFieldNames(table, fields);
  let skipped = 0;
  let pageToken = undefined;

  while (true) {
    const data = await unwrapLark(getLarkClient().bitable.appTableRecord.list({
      path: { app_token: BASE_TOKEN, table_id: table },
      params: {
        field_names: JSON.stringify(fieldNames),
        page_size: Math.min(500, Math.max(limit, offset - skipped + limit)),
        page_token: pageToken,
        user_id_type: 'open_id'
      }
    }));
    const items = data.items || [];
    if (skipped + items.length > offset || !data.has_more) {
      const slice = items.slice(Math.max(0, offset - skipped), Math.max(0, offset - skipped) + limit);
      return {
        data: slice.map((item) => fieldNames.map((fieldName, index) => item.fields?.[fieldName] ?? item.fields?.[fields[index]])),
        record_id_list: slice.map((item) => item.record_id),
        has_more: Boolean(data.has_more || skipped + items.length > offset + limit)
      };
    }
    skipped += items.length;
    pageToken = data.page_token;
    if (!pageToken) return { data: [], record_id_list: [], has_more: false };
  }
}

async function listAllRecords(table, fields) {
  const rows = [];
  const fieldNames = await getFieldNames(table, fields);
  let pageToken = undefined;
  do {
    const data = await unwrapLark(getLarkClient().bitable.appTableRecord.list({
      path: { app_token: BASE_TOKEN, table_id: table },
      params: {
        field_names: JSON.stringify(fieldNames),
        page_size: 500,
        page_token: pageToken,
        user_id_type: 'open_id'
      }
    }));
    (data.items || []).forEach((item) => rows.push({
      id: item.record_id,
      row: fieldNames.map((fieldName, index) => item.fields?.[fieldName] ?? item.fields?.[fields[index]])
    }));
    pageToken = data.has_more ? data.page_token : undefined;
  } while (pageToken);
  return rows;
}

async function getAccounts() {
  const rows = [];
  let offset = 0;
  while (true) {
    const data = await listRecords(
      ACCOUNT_TABLE,
      [FIELD.accountName, FIELD.accountPerson, FIELD.accountBalance, FIELD.accountStatus],
      200,
      offset
    );
    const records = data.data || [];
    const ids = data.record_id_list || [];
    records.forEach((row, index) => {
      if (cellText(row[3]) === '停用') return;
      const user = firstUser(row[1]);
      rows.push({
        id: ids[index],
        name: cellText(row[0]) || user?.name || '未命名账户',
        userId: user?.id || '',
        userName: user?.name || cellText(row[0]),
        balance: Number(cellText(row[2]) || 0)
      });
    });
    if (!data.has_more || records.length === 0) break;
    offset += records.length;
  }
  return rows;
}

async function getClaimAccounts() {
  const accounts = await getAccounts();
  return accounts.map(({ id, name, userId, userName }) => ({ id, name, userId, userName }));
}

async function getWhitelistOpenIds(options = {}) {
  const now = Date.now();
  if (!WHITELIST_TABLE) {
    throw new Error('缺少 WHITELIST_TABLE，请设置前端白名单多维表格表 ID');
  }
  if (!options.forceRefresh && whitelistCache && now - whitelistCache.fetchedAt < 5 * 60 * 1000) {
    return whitelistCache.openIds;
  }

  // 白名单表只需要一个“人员”字段。这里读取人员字段里的 open_id，
  // 后续接口只认 open_id，不认前端传来的姓名，避免用户伪造身份。
  const rows = await listAllRecords(WHITELIST_TABLE, [FIELD.frontendWhitelistPerson]);
  const openIds = new Set();
  rows.forEach(({ row }) => {
    const user = firstUser(row[0]);
    if (user?.id) openIds.add(user.id);
  });
  whitelistCache = { openIds, fetchedAt: now };
  return openIds;
}

async function isWhitelisted(openId) {
  // 白名单是后端权限判断，不依赖前端页面是否展示按钮。
  // 只要 open_id 不在白名单表中，业务接口就不会继续写入多维表格。
  if (!openId) return false;
  const openIds = await getWhitelistOpenIds();
  return openIds.has(openId);
}

async function getTasks() {
  const meta = await getFieldMeta(LEDGER_TABLE);
  return (meta.get(FIELD.ledgerTask)?.property?.options || []).map((option) => option.name).filter(Boolean);
}

async function getUsersByIds(userIds) {
  const users = [];
  const uniqueIds = Array.from(new Set(userIds.filter(Boolean)));
  for (let index = 0; index < uniqueIds.length; index += 100) {
    const chunk = uniqueIds.slice(index, index + 100);
    const data = await unwrapLark(getLarkClient().contact.user.batch({
      params: {
        user_ids: chunk,
        user_id_type: 'open_id',
        department_id_type: 'department_id'
      }
    }));
    users.push(...(data.items || []).map((user) => normalizeUser(user)));
  }
  return users;
}

function normalizeName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function stripNameAlias(value) {
  return normalizeName(value).replace(/\s*[\(（][^\)）]*[\)）]\s*$/u, '');
}

function parsePeople(value) {
  const seen = new Set();
  return String(value || '')
    .split(/[\n\r,，、;；\s]+/u)
    .map(normalizeName)
    .filter(Boolean)
    .filter((name) => {
      const key = name.toLocaleLowerCase('zh-Hans-CN');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function namesForAccount(account) {
  return [account.name, account.userName, stripNameAlias(account.name), stripNameAlias(account.userName)]
    .map(normalizeName)
    .filter(Boolean);
}

function matchPeopleToAccounts(people, accounts) {
  const exact = new Map();
  const alias = new Map();
  accounts
    .forEach((account) => {
      namesForAccount(account).forEach((name) => {
        const key = name.toLocaleLowerCase('zh-Hans-CN');
        const bucket = name === stripNameAlias(name) ? alias : exact;
        if (!bucket.has(key)) bucket.set(key, []);
        bucket.get(key).push(account);
      });
    });

  return people.map((name) => {
    const key = name.toLocaleLowerCase('zh-Hans-CN');
    const candidates = exact.get(key) || alias.get(key) || [];
    const unique = Array.from(new Map(candidates.map((account) => [account.id, account])).values());
    return { name, candidates: unique };
  });
}

function departmentParts(value) {
  return normalizeName(value).split(/[-/／>｜|]/u).map(normalizeName).filter(Boolean);
}

function displayDepartment(value) {
  const parts = departmentParts(value);
  return parts[1] || parts[0] || '未显示部门';
}

async function accountOptions(accounts) {
  const users = await getUsersByIds(accounts.map((account) => account.userId));
  const userById = new Map(users.map((user) => [user.open_id, user]));
  return accounts.map((account) => {
    const user = userById.get(account.userId);
    return {
      id: account.userId,
      accountId: account.id,
      name: user?.localized_name || account.userName || account.name,
      department: displayDepartment(user?.department || ''),
      departmentPath: user?.department || '',
      email: user?.enterprise_email || user?.email || ''
    };
  });
}

function describeMatchError(matches, options = {}) {
  const unmatched = matches.filter((match) => match.candidates.length === 0 && !match.hasMore).map((match) => match.name);
  const ambiguous = matches
    .filter((match) => match.candidates.length > 1 || match.hasMore)
    .map((match) => {
      const names = match.candidates.map((candidate) => candidate.name || candidate.localized_name).join('、');
      return names ? `${match.name}（${names}）` : match.name;
    });
  const parts = [];
  if (unmatched.length) parts.push(`以下人员未匹配到${options.source || '账户'}：${unmatched.join('、')}`);
  if (ambiguous.length) parts.push(`以下姓名存在多个匹配，请输入更完整的姓名：${ambiguous.join('；')}`);
  return parts.join('；');
}

async function resolveClaimAccounts(people, accounts, selectedUsers = {}) {
  const accountMatches = matchPeopleToAccounts(people, accounts);
  const selectedAccounts = [];
  const missingNames = [];
  const selectionRequired = [];
  const selectedUserIds = new Map(
    Object.entries(selectedUsers || {}).map(([name, userId]) => [normalizeName(name), normalizeName(userId)])
  );

  for (const match of accountMatches) {
    const pickedUserId = selectedUserIds.get(match.name);
    const linkedAccounts = match.candidates.filter((account) => account.userId);
    const emptyAccounts = match.candidates.filter((account) => !account.userId);
    const uniqueUserIds = new Set(linkedAccounts.map((account) => account.userId));

    if (pickedUserId) {
      const pickedAccount = accounts.find((account) => account.userId === pickedUserId);
      if (pickedAccount) {
        selectedAccounts.push(pickedAccount);
        continue;
      }
      missingNames.push(match.name);
      continue;
    }

    if (linkedAccounts.length === 1) {
      selectedAccounts.push(linkedAccounts[0]);
      continue;
    }

    if (uniqueUserIds.size > 1) {
      selectionRequired.push({
        name: match.name,
        options: await accountOptions(linkedAccounts)
      });
      continue;
    }

    if (linkedAccounts.length > 1 || emptyAccounts.length > 1) {
      return {
        error: `账户表里「${match.name}」存在重复账户，请先在账户表里合并或补齐人员字段`
      };
    }

    missingNames.push(match.name);
  }

  if (selectionRequired.length) return { selectionRequired };

  const lookupNames = Array.from(new Set(missingNames));
  if (!lookupNames.length) return { accounts: selectedAccounts };

  return {
    error: `以下人员未匹配到账户表中已绑定人员字段的账户：${lookupNames.join('、')}；请先在账户表维护人员字段`
  };
}

function accountPersonPayload(account) {
  if (!account?.userId || !account?.id) return null;
  return {
    id: account.userId,
    accountId: account.id,
    name: account.userName || account.name,
    accountName: account.name,
    fieldValue: [{ id: account.userId }]
  };
}

async function resolveOcrRecords(records) {
  if (!records.length) return records;
  const accounts = await getAccounts();
  const resolvedRows = [];
  for (const [index, record] of records.entries()) {
    const name = normalizeName(record.name);
    if (!name) {
      resolvedRows.push({
        ...record,
        matchStatus: 'unmatched',
        matchMessage: `第 ${index + 1} 行缺少人员姓名`
      });
      continue;
    }

    const match = matchPeopleToAccounts([name], accounts)[0];
    const linkedAccounts = (match?.candidates || []).filter((account) => account.userId);
    const emptyAccounts = (match?.candidates || []).filter((account) => !account.userId);
    if (linkedAccounts.length > 1) {
      resolvedRows.push({
        ...record,
        matchStatus: 'ambiguous',
        matchMessage: '识别到账户表里存在多个匹配人员，请选择对应人员',
        candidates: await accountOptions(linkedAccounts)
      });
      continue;
    }
    if (!linkedAccounts.length) {
      resolvedRows.push({
        ...record,
        matchStatus: 'unmatched',
        matchMessage: emptyAccounts.length
          ? `账户表里的「${name}」还没有绑定人员字段`
          : `未匹配到账户人员字段：${name}`
      });
      continue;
    }

    const person = accountPersonPayload(linkedAccounts[0]);
    resolvedRows.push({
      ...record,
      name: person.name || name,
      ocrName: name,
      person,
      accountId: person.accountId,
      userId: person.id,
      matchStatus: 'matched'
    });
  }
  return resolvedRows;
}

function jsonHeaders(req) {
  const origin = req?.headers?.origin || '';
  const allowedOrigin = PUBLIC_ORIGIN || origin || '*';
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  };
  if (!PUBLIC_ORIGIN || origin === PUBLIC_ORIGIN) {
    headers['Access-Control-Allow-Origin'] = allowedOrigin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return headers;
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown')
    .split(',')[0]
    .trim();
}

function assertRateLimit(req, name, limit) {
  const now = Date.now();
  const key = `${name}:${clientIp(req)}`;
  const bucket = rateLimitBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return;
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    const error = new Error('请求过于频繁，请稍后再试');
    error.statusCode = 429;
    throw error;
  }
}

function sendJson(req, res, status, body) {
  res.writeHead(status, {
    ...jsonHeaders(req)
  });
  res.end(JSON.stringify(body));
}

function sendReviewPage(res, status, title, body, tone = 'ok') {
  const color = tone === 'error' ? '#c23b3b' : tone === 'warn' ? '#b96800' : '#12805c';
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f7f9; color: #1d2530; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }
      main { width: min(480px, calc(100vw - 32px)); background: #fff; border: 1px solid #dce1e8; border-radius: 8px; padding: 24px; box-shadow: 0 18px 45px rgba(31, 44, 67, 0.10); }
      h1 { margin: 0 0 12px; color: ${color}; font-size: 24px; line-height: 1.25; }
      p { margin: 8px 0 0; color: #687385; line-height: 1.6; }
      a { color: #1f6feb; text-decoration: none; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      ${body}
      <p><a href="javascript:window.close()">关闭页面</a></p>
    </main>
  </body>
</html>`);
}

async function updateClaimReview(recordId, action) {
  const patch = action === 'confirm'
    ? {
        [FIELD.ledgerStatus]: '已确认',
        [FIELD.ledgerSent]: '是',
        [FIELD.ledgerReason]: '管理员通过消息链接确认'
      }
    : {
        [FIELD.ledgerStatus]: '已驳回',
        [FIELD.ledgerSent]: '否',
        [FIELD.ledgerReason]: '管理员通过消息链接驳回'
      };

  return unwrapLark(getLarkClient().bitable.appTableRecord.update({
    path: { app_token: BASE_TOKEN, table_id: LEDGER_TABLE, record_id: recordId },
    params: { user_id_type: 'open_id' },
    data: {
      fields: await fieldsByIdToName(LEDGER_TABLE, patch)
    }
  }));
}

async function updateApprovalCard(token, claim, status) {
  if (!token) return null;
  return requestLark({
    method: 'POST',
    url: '/open-apis/interactive/v1/card/update',
    data: {
      token,
      card: buildApprovalCard({
        ...claim,
        status
      })
    }
  });
}

const pendingApprovalUpdates = new Set();

function queueClaimReviewUpdate(serial, action) {
  const key = serial;
  if (pendingApprovalUpdates.has(key)) return;
  pendingApprovalUpdates.add(key);

  setTimeout(async () => {
    let claim = null;
    try {
      claim = await getClaimBySerial(serial);
      if (!claim) {
        console.error(`未找到待处理申请：${serial}`);
        return;
      }
      if (claim.status !== '待确认') {
        console.log(`skip handled claim ${serial}, current status: ${claim.status}`);
        return;
      }
      await updateClaimReview(claim.id, action);
      console.log(`updated claim ${action} for ${serial}`);
    } catch (error) {
      console.error(`处理卡片点击失败：${error.message}`);
    } finally {
      pendingApprovalUpdates.delete(key);
    }
  }, 0);
}

function buildApprovalCard({ id, serial, person, amount, task, status = '待确认' }) {
  const title = status === '待确认' ? '光年币领取申请待确认' : `光年币领取申请${status}`;
  const statusColor = status === '已确认' ? 'green' : status === '已驳回' ? 'red' : 'orange';
  const elements = [
    {
      tag: 'markdown',
      content: `**申请人：**${cardPlainText(person)}\n**数量：**${cardPlainText(amount)}\n**任务：**${cardPlainText(task)}\n**流水号：**${cardPlainText(serial)}`
    },
    {
      tag: 'hr'
    }
  ];

  if (status === '待确认') {
    elements.push({
      tag: 'action',
      layout: 'bisected',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '确认入账' },
          type: 'primary',
          value: { action: 'confirm', serial, recordId: id }
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '驳回' },
          type: 'danger',
          value: { action: 'reject', serial, recordId: id }
        }
      ]
    });
  } else {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: status === '已确认' ? '已确认' : '已驳回' },
          type: status === '已确认' ? 'primary' : 'danger'
        }
      ]
    });
  }

  return {
    config: {
      update_multi: true,
      wide_screen_mode: true
    },
    header: {
      template: status === '已确认' ? 'green' : status === '已驳回' ? 'red' : 'orange',
      title: { tag: 'plain_text', content: title }
    },
    elements: [
      ...elements,
      {
        tag: 'markdown',
        content: `**当前状态：**<font color="${statusColor}">${cardPlainText(status)}</font>`
      }
    ]
  };
}

function buildInfoCard(title, lines, template = 'green') {
  return {
    config: {
      update_multi: true,
      wide_screen_mode: true
    },
    header: {
      template,
      title: { tag: 'plain_text', content: title }
    },
    elements: [{
      tag: 'markdown',
      content: compactMarkdownLines(lines)
    }]
  };
}

function buildWithdrawHelpCard(template = 'blue') {
  return buildInfoCard('光年币支取助手', [
    '**支取格式：**支取 姓名 数量',
    '**示例：**支取 刘云澈 10',
    '**说明：**机器人会先返回确认卡片，点击确认后才会扣减余额。'
  ], template);
}

function buildWithdrawConfirmCard(withdraw) {
  return {
    config: {
      update_multi: true,
      wide_screen_mode: true
    },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: '确认支取光年币' }
    },
    elements: [
      {
        tag: 'markdown',
        content: compactMarkdownLines([
          `**支取人：**${withdraw.account.userName || withdraw.account.name}`,
          `**支取数量：**${withdraw.amount}`,
          `**当前余额：**${withdraw.beforeBalance}`,
          `**支取后余额：**${withdraw.afterBalance}`,
          `**流水号：**${withdraw.serial}`
        ])
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '确认支取' },
            type: 'danger',
            value: {
              action: 'withdraw_confirm',
              serial: withdraw.serial,
              accountId: withdraw.account.id,
              userId: withdraw.account.userId,
              amount: withdraw.amount
            }
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '取消' },
            value: {
              action: 'withdraw_cancel',
              serial: withdraw.serial
            }
          }
        ]
      }
    ]
  };
}

function buildWithdrawResultCard(withdraw, status = 'success', message = '') {
  const ok = status === 'success';
  const template = ok ? 'green' : status === 'cancelled' ? 'blue' : 'red';
  const title = ok ? '光年币支取已完成' : status === 'cancelled' ? '支取已取消' : '光年币支取失败';
  const lines = [
    `**支取人：**${withdraw?.account?.userName || withdraw?.account?.name || withdraw?.person || '-'}`,
    `**支取数量：**${withdraw?.amount ? `-${withdraw.amount}` : '-'}`,
    `**支取前余额：**${withdraw?.beforeBalance ?? '-'}`,
    `**当前余额：**${withdraw?.afterBalance ?? withdraw?.currentBalance ?? '-'}`,
    `**流水号：**${withdraw?.serial || '-'}`
  ];
  if (message) lines.push(`**说明：**${message}`);
  return buildInfoCard(title, lines, template);
}

function claimDisplayName(item) {
  return item.userName || item.account?.userName || item.account?.name || item.name || '未知人员';
}

function uniqueBy(items, keyFn) {
  return Array.from(new Map(items.filter(Boolean).map((item) => [keyFn(item), item])).values());
}

function groupClaimsByRecipient(items = []) {
  const groups = new Map();
  items.forEach((item) => {
    const userId = item.userId || item.account?.userId;
    if (!userId) return;
    if (!groups.has(userId)) groups.set(userId, []);
    groups.get(userId).push(item);
  });
  return groups;
}

function accountLookupByName(accounts = []) {
  const byName = new Map();
  accounts.forEach((account) => {
    namesForAccount(account).forEach((name) => {
      const key = normalizeName(name).toLocaleLowerCase('zh-Hans-CN');
      if (!byName.has(key)) byName.set(key, account);
    });
  });
  return byName;
}

async function sendBotMessage(userId, card, idempotencyKey) {
  return unwrapLark(getLarkClient().im.message.create({
    params: {
      receive_id_type: 'open_id',
      uuid: idempotencyKey
    },
    data: {
      receive_id: userId,
      msg_type: 'interactive',
      content: JSON.stringify(card)
    }
  }));
}

async function sendClaimNotifications(items, submitter = null) {
  if (!items.length) return;
  await sleep(800);
  const accounts = await getAccounts();
  const balanceByUser = new Map(accounts.map((account) => [account.userId, account.balance]));

  for (const [userId, claims] of groupClaimsByRecipient(items)) {
    const amount = claims.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const taskText = uniqueBy(claims.map((item) => item.task).filter(Boolean), (task) => task).join('、');
    const currentBalance = balanceByUser.get(userId);
    await sendBotMessage(userId, buildInfoCard('光年币余额已更新', [
      `**本次入账：**+${amount}`,
      `**当前余额：**${currentBalance ?? '-'}`,
      `**任务：**${taskText || '-'}`,
      '**状态：**已到账'
    ]), `gn-recipient-${userId}-${claims[0]?.serial || Date.now()}`).catch((error) => console.warn(`入账人通知发送失败：${error.message}`));
  }
}

async function getAccountById(accountId) {
  if (!accountId) return null;
  return (await getAccounts()).find((account) => account.id === accountId) || null;
}

async function resolveSingleAccountByName(name) {
  const accounts = await getAccounts();
  const resolved = await resolveClaimAccounts([name], accounts);
  if (resolved.selectionRequired) {
    const options = resolved.selectionRequired[0]?.options || [];
    const names = options.map((option) => `${option.name}${option.department ? `（${option.department}）` : ''}`).join('、');
    const error = new Error(names ? `找到多个「${name}」，请在账户表确认唯一人员后再支取：${names}` : `找到多个「${name}」，请提供更完整姓名`);
    error.statusCode = 409;
    throw error;
  }
  if (resolved.error) {
    const error = new Error(resolved.error);
    error.statusCode = 400;
    throw error;
  }
  const account = resolved.accounts?.[0];
  if (!account?.id || !account.userId) {
    const error = new Error(`未找到可支取账户：${name}`);
    error.statusCode = 404;
    throw error;
  }
  return account;
}

function createWithdrawDraft(account, amount) {
  const beforeBalance = Number(account.balance || 0);
  return rememberWithdraw({
    serial: `GW-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
    account,
    amount,
    beforeBalance,
    afterBalance: beforeBalance - amount
  });
}

async function createWithdrawRecord(withdraw) {
  const fieldIds = [
    FIELD.withdrawSerial,
    FIELD.withdrawPerson,
    FIELD.withdrawAccount,
    FIELD.withdrawAmount,
    FIELD.withdrawBeforeBalance,
    FIELD.withdrawAfterBalance
  ];
  const record = {
    fields: await rowToRecordFields(WITHDRAW_TABLE, fieldIds, [
      withdraw.serial,
      [{ id: withdraw.account.userId }],
      [{ id: withdraw.account.id }],
      withdraw.amount,
      withdraw.beforeBalance,
      withdraw.afterBalance
    ])
  };
  const data = await unwrapLark(getLarkClient().bitable.appTableRecord.create({
    path: { app_token: BASE_TOKEN, table_id: WITHDRAW_TABLE },
    params: { user_id_type: 'open_id' },
    data: record
  }));
  return data.record?.record_id || data.record_id || data.id || '';
}

async function deleteWithdrawRecord(recordId) {
  if (!recordId) return;
  await unwrapLark(getLarkClient().bitable.appTableRecord.delete({
    path: { app_token: BASE_TOKEN, table_id: WITHDRAW_TABLE, record_id: recordId }
  }));
}

async function updateWithdrawRecordSnapshot(recordId, withdraw) {
  if (!recordId || !withdraw) return;
  const patch = {
    [FIELD.withdrawSerial]: withdraw.serial,
    [FIELD.withdrawBeforeBalance]: withdraw.beforeBalance,
    [FIELD.withdrawAfterBalance]: withdraw.afterBalance
  };
  await unwrapLark(getLarkClient().bitable.appTableRecord.update({
    path: { app_token: BASE_TOKEN, table_id: WITHDRAW_TABLE, record_id: recordId },
    params: { user_id_type: 'open_id' },
    data: {
      fields: await fieldsByIdToName(WITHDRAW_TABLE, patch)
    }
  }));
}

async function notifyWithdrawRecipient(withdraw, idempotencySuffix = '') {
  if (!withdraw?.account?.userId) return;
  await sendBotMessage(withdraw.account.userId, buildInfoCard('光年币余额已更新', [
    `**本次支取：**-${withdraw.amount}`,
    `**当前余额：**${withdraw.afterBalance}`,
    `**流水号：**${withdraw.serial || '-'}`
  ], 'red'), `gn-withdraw-recipient-${withdraw.account.userId}-${withdraw.serial || idempotencySuffix || Date.now()}`);
}

async function completeWithdraw(withdraw) {
  const serial = normalizeName(withdraw?.serial);
  const idempotency = withdrawCompletionRegistry.start(serial);
  if (idempotency.status === 'completed') {
    return {
      ok: true,
      withdraw: idempotency.value,
      card: buildWithdrawResultCard(idempotency.value, 'success', '这笔支取已处理，未重复扣减。')
    };
  }
  if (idempotency.status === 'pending') {
    return {
      ok: false,
      card: buildWithdrawResultCard(withdraw, 'error', '这笔支取正在处理中，请勿重复点击。')
    };
  }

  try {
    const account = await getAccountById(withdraw.account?.id || withdraw.accountId);
    if (!account?.userId) {
      withdrawCompletionRegistry.fail(serial);
      return {
        ok: false,
        card: buildWithdrawResultCard(withdraw, 'error', '未找到对应账户，未执行支取。')
      };
    }
    const amount = Number(withdraw.amount);
    if (!Number.isInteger(amount) || amount <= 0) {
      withdrawCompletionRegistry.fail(serial);
      return {
        ok: false,
        card: buildWithdrawResultCard({ ...withdraw, account }, 'error', '支取数量无效，未执行支取。')
      };
    }
    const beforeBalance = Number(account.balance || 0);
    if (beforeBalance < amount) {
      withdrawCompletionRegistry.fail(serial);
      return {
        ok: false,
        card: buildWithdrawResultCard({
          ...withdraw,
          account,
          amount,
          beforeBalance,
          currentBalance: beforeBalance,
          afterBalance: beforeBalance
        }, 'error', '余额不足，已拒绝。')
      };
    }
    const committed = rememberWithdraw({
      ...withdraw,
      account,
      amount,
      beforeBalance,
      afterBalance: beforeBalance - amount
    });
    committed.recordId = await createWithdrawRecord(committed);
    seenWithdrawRecordDigests.set(committed.recordId, withdrawDigest(committed));
    await notifyWithdrawRecipient(committed);
    withdrawCompletionRegistry.finish(serial, committed);
    return {
      ok: true,
      withdraw: committed,
      card: buildWithdrawResultCard(committed)
    };
  } catch (error) {
    withdrawCompletionRegistry.fail(serial);
    throw error;
  }
}

async function getWithdrawRecord(recordId) {
  const fieldIds = [
    FIELD.withdrawSerial,
    FIELD.withdrawPerson,
    FIELD.withdrawAccount,
    FIELD.withdrawAmount,
    FIELD.withdrawBeforeBalance,
    FIELD.withdrawAfterBalance,
    FIELD.withdrawTime
  ];
  const fieldNames = await getFieldNames(WITHDRAW_TABLE, fieldIds);
  const data = await unwrapLark(getLarkClient().bitable.appTableRecord.get({
    path: { app_token: BASE_TOKEN, table_id: WITHDRAW_TABLE, record_id: recordId },
    params: {
      field_names: JSON.stringify(fieldNames),
      user_id_type: 'open_id'
    }
  }));
  const record = data.record || data;
  const value = (fieldId) => {
    const fieldName = fieldNames[fieldIds.indexOf(fieldId)];
    return record.fields?.[fieldName] ?? record.fields?.[fieldId];
  };
  const person = firstUser(value(FIELD.withdrawPerson));
  const accountId = fieldItemId(value(FIELD.withdrawAccount));
  const amount = Number(cellText(value(FIELD.withdrawAmount)) || 0);
  return {
    id: record.record_id || recordId,
    serial: cellText(value(FIELD.withdrawSerial)) || `GW-BASE-${recordId}`,
    person: person?.name || cellText(value(FIELD.withdrawPerson)),
    userId: person?.id || '',
    accountId,
    amount,
    beforeBalance: Number(cellText(value(FIELD.withdrawBeforeBalance)) || 0),
    afterBalance: Number(cellText(value(FIELD.withdrawAfterBalance)) || 0),
    createdAt: cellText(value(FIELD.withdrawTime))
  };
}

async function handleManualWithdrawRecord(recordId, options = {}) {
  const row = await getWithdrawRecord(recordId);
  if (!row.accountId) {
    console.warn(`支取记录 ${recordId} 缺少账户关联，跳过通知`);
    return { ok: false, skipped: true, reason: 'missing_account' };
  }
  if (!Number.isInteger(row.amount) || row.amount <= 0) {
    await deleteWithdrawRecord(recordId);
    console.warn(`支取记录 ${recordId} 数量无效，已删除`);
    return { ok: false, rejected: true, reason: 'invalid_amount' };
  }
  const account = await getAccountById(row.accountId);
  await sleep(800);
  const refreshedAccount = await getAccountById(row.accountId);
  const effectiveAccount = refreshedAccount || account;
  if (!effectiveAccount?.userId) {
    console.warn(`支取记录 ${recordId} 未找到关联账户，跳过通知`);
    return { ok: false, skipped: true, reason: 'missing_account_record' };
  }
  const afterBalance = Number(effectiveAccount.balance || 0);
  const beforeBalance = Number(row.beforeBalance || afterBalance + row.amount || 0);
  if (afterBalance < 0) {
    await deleteWithdrawRecord(recordId);
    console.warn(`支取记录 ${recordId} 导致余额为负，已删除`);
    return { ok: false, rejected: true, reason: 'insufficient_balance' };
  }
  const withdraw = rememberWithdraw({
    recordId,
    serial: row.serial,
    account: effectiveAccount,
    amount: row.amount,
    beforeBalance,
    afterBalance
  });
  await updateWithdrawRecordSnapshot(recordId, withdraw);
  seenWithdrawRecordDigests.set(recordId, withdrawDigest(withdraw));
  if (!options.silent) await notifyWithdrawRecipient(withdraw, recordId);
  return { ok: true, withdraw };
}

async function listRecentWithdrawRecords(limit = 50) {
  const fieldIds = [
    FIELD.withdrawSerial,
    FIELD.withdrawPerson,
    FIELD.withdrawAccount,
    FIELD.withdrawAmount,
    FIELD.withdrawTime
  ];
  const fieldNames = await getFieldNames(WITHDRAW_TABLE, fieldIds);
  const data = await unwrapLark(getLarkClient().bitable.appTableRecord.list({
    path: { app_token: BASE_TOKEN, table_id: WITHDRAW_TABLE },
    params: {
      field_names: JSON.stringify(fieldNames),
      page_size: Math.min(500, limit),
      sort: JSON.stringify([{ field_name: fieldNames[fieldIds.indexOf(FIELD.withdrawTime)], desc: true }]),
      user_id_type: 'open_id'
    }
  }));
  return (data.items || []).map((record) => {
    const value = (fieldId) => {
      const fieldName = fieldNames[fieldIds.indexOf(fieldId)];
      return record.fields?.[fieldName] ?? record.fields?.[fieldId];
    };
    const person = firstUser(value(FIELD.withdrawPerson));
    const accountId = fieldItemId(value(FIELD.withdrawAccount));
    return {
      id: record.record_id,
      serial: cellText(value(FIELD.withdrawSerial)),
      person: person?.id || cellText(value(FIELD.withdrawPerson)),
      accountId,
      amount: Number(cellText(value(FIELD.withdrawAmount)) || 0)
    };
  });
}

async function pollWithdrawTable() {
  if (withdrawPollRunning || !WITHDRAW_POLL_ENABLED) return;
  withdrawPollRunning = true;
  try {
    const records = await listRecentWithdrawRecords();
    for (const record of records) {
      if (!record.id) continue;
      const digest = withdrawDigest(record);
      if (!withdrawPollInitialized) {
        seenWithdrawRecordDigests.set(record.id, digest);
        continue;
      }
      if (seenWithdrawRecordDigests.get(record.id) === digest) continue;
      const result = await handleManualWithdrawRecord(record.id);
      if (result?.ok || result?.rejected || result?.skipped) {
        seenWithdrawRecordDigests.set(record.id, digest);
      }
    }
    withdrawPollInitialized = true;
  } catch (error) {
    console.warn(`支取表轮询失败：${safeErrorMessage(error)}`);
  } finally {
    withdrawPollRunning = false;
  }
}

async function createAutoConfirmedClaims(items, reason) {
  // 这是“白名单自动入账”的唯一写表入口。
  // 所有调用方在进入这里之前，都必须已经完成：
  // 1. 飞书登录校验；
  // 2. 白名单校验；
  // 3. 人员/账户解析；
  // 4. 数量和任务合法性校验。
  // 因此这里直接把流水状态写成“已确认”，并把“已发送/入账”写成“是”。
  const fieldIds = [
    FIELD.ledgerPerson,
    FIELD.ledgerAmount,
    FIELD.ledgerTask,
    FIELD.ledgerAccount,
    FIELD.ledgerStatus,
    FIELD.ledgerSerial,
    FIELD.ledgerSent,
    FIELD.ledgerReason
  ];
  const records = await Promise.all(items.map(async (item) => ({
    fields: await rowToRecordFields(LEDGER_TABLE, fieldIds, [
      [{ id: item.account.userId }],
      item.amount,
      item.task,
      [{ id: item.account.id }],
      '已确认',
      item.serial,
      '是',
      reason
    ])
  })));
  const data = await unwrapLark(getLarkClient().bitable.appTableRecord.batchCreate({
    path: { app_token: BASE_TOKEN, table_id: LEDGER_TABLE },
    params: { user_id_type: 'open_id' },
    data: { records }
  }));
  const recordIds = (data.records || []).map((record) => record.record_id).filter(Boolean);
  items.forEach((item, index) => {
    rememberClaim({
      id: recordIds[index],
      person: item.account.userName || item.account.name,
      userId: item.account.userId,
      amount: item.amount,
      task: item.task,
      status: '已确认',
      serial: item.serial,
      sent: '是'
    });
  });
  return { data, recordIds };
}

async function getClaimBySerial(serial) {
  const cached = claimCache.get(serial);
  if (cached) return cached;

  const fieldIds = [
    FIELD.ledgerPerson,
    FIELD.ledgerAmount,
    FIELD.ledgerTask,
    FIELD.ledgerStatus,
    FIELD.ledgerSerial,
    FIELD.ledgerSent
  ];
  const fieldNames = await getFieldNames(LEDGER_TABLE, fieldIds);
  const serialFieldName = fieldNames[fieldIds.indexOf(FIELD.ledgerSerial)];
  const data = await unwrapLark(getLarkClient().bitable.appTableRecord.search({
    path: { app_token: BASE_TOKEN, table_id: LEDGER_TABLE },
    params: { user_id_type: 'open_id', page_size: 1 },
    data: {
      field_names: fieldNames,
      filter: {
        conjunction: 'and',
        conditions: [{
          field_name: serialFieldName,
          operator: 'is',
          value: [serial]
        }]
      }
    }
  }));
  const record = data.items?.[0];
  if (!record?.record_id) return null;
  const value = (fieldId) => {
    const fieldName = fieldNames[fieldIds.indexOf(fieldId)];
    return record.fields?.[fieldName] ?? record.fields?.[fieldId];
  };
  const person = firstUser(value(FIELD.ledgerPerson));
  return rememberClaim({
    id: record.record_id,
    person: cellText(value(FIELD.ledgerPerson)),
    userId: person?.id || '',
    amount: cellText(value(FIELD.ledgerAmount)),
    task: cellText(value(FIELD.ledgerTask)),
    status: cellText(value(FIELD.ledgerStatus)),
    serial: cellText(value(FIELD.ledgerSerial)),
    sent: cellText(value(FIELD.ledgerSent))
  });
}

async function sendApprovalCard(claim) {
  console.warn(`旧审批卡片发送入口已停用，跳过发送：${claim?.serial || '-'}`);
  return null;
}

async function handleApprovalAction(event) {
  const actionValue = event?.action?.value || event?.event?.action?.value || {};
  const openMessageId = event?.open_message_id || event?.context?.open_message_id || event?.event?.open_message_id || '';
  const action = actionValue.action;
  const serial = normalizeName(actionValue.serial);
  const recordId = normalizeName(actionValue.recordId);
  if (!reviewActionText[action] || !serial) {
    return buildApprovalCard({
      serial: serial || '未知',
      person: '无法识别这个操作',
      amount: '',
      task: '请重新提交申请',
      status: '已驳回'
    });
  }

  const claim = recordId
    ? rememberClaim({
        id: recordId,
        serial,
        person: actionValue.person,
        amount: actionValue.amount,
        task: actionValue.task,
        status: '待确认'
      })
    : await getClaimBySerial(serial);
  if (!claim) {
    return buildApprovalCard({
      serial,
      person: '未找到这条申请',
      amount: '',
      task: '请重新提交申请',
      status: '已驳回'
    });
  }
  if (claim.status !== '待确认') {
    return buildApprovalCard(claim);
  }

  const nextStatus = action === 'confirm' ? '已确认' : '已驳回';
  queueClaimReviewUpdate(serial, action);
  if (openMessageId) {
    console.log(`accepted card action ${action} for ${serial} on ${openMessageId}`);
  }
  return buildApprovalCard({ ...claim, status: nextStatus });
}

async function handleWithdrawAction(event) {
  const actionValue = event?.action?.value || event?.event?.action?.value || {};
  const operatorOpenId = event?.open_id || event?.operator?.open_id || event?.event?.operator?.open_id || event?.user_id || '';
  const action = actionValue.action;
  const serial = normalizeName(actionValue.serial);

  if (operatorOpenId !== ADMIN_USER_ID) {
    return buildInfoCard('无权操作支取', [
      '**状态：**已拒绝',
      '**说明：**只有当前管理员可以发起或确认支取。'
    ], 'red');
  }

  const cached = withdrawCache.get(serial);
  if (action === 'withdraw_cancel') {
    return buildWithdrawResultCard(cached || { serial }, 'cancelled', '管理员已取消，未执行支取。');
  }
  if (action !== 'withdraw_confirm' || !serial) {
    return buildInfoCard('无法识别支取操作', [
      '**状态：**已拒绝',
      '**说明：**请重新发送支取命令。'
    ], 'red');
  }

  const withdraw = cached || {
    serial,
    accountId: normalizeName(actionValue.accountId),
    userId: normalizeName(actionValue.userId),
    amount: Number(actionValue.amount)
  };
  const result = await completeWithdraw(withdraw);
  return result.card;
}

async function handleCardAction(event) {
  const actionValue = event?.action?.value || event?.event?.action?.value || {};
  if (String(actionValue.action || '').startsWith('withdraw_')) {
    return handleWithdrawAction(event);
  }
  return buildInfoCard('旧审批卡片入口已停用', [
    '**状态：**已拒绝',
    '**说明：**请通过白名单领取页面提交，旧审批卡片不能继续修改状态。'
  ], 'red');
}

function normalizeEventPayload(payload) {
  const event = payload?.event || payload || {};
  const senderId =
    event.sender?.sender_id?.open_id ||
    event.sender?.sender_id?.user_id ||
    event.sender_id?.open_id ||
    event.sender_id ||
    event.open_id ||
    '';
  const message = event.message || event;
  const messageId = message.message_id || event.message_id || event.id || payload?.header?.event_id || '';
  const chatType = message.chat_type || event.chat_type || '';
  const chatId = message.chat_id || event.chat_id || '';
  const messageType = message.message_type || event.message_type || '';
  let content = message.content ?? event.content ?? '';
  if (typeof content === 'string') {
    try {
      const parsed = JSON.parse(content);
      content = parsed.text || parsed.content || content;
    } catch {
      // keep plain text
    }
  }
  return {
    eventId: payload?.header?.event_id || event.event_id || messageId,
    senderId,
    chatType,
    chatId,
    messageId,
    messageType,
    content: typeof content === 'string' ? content : JSON.stringify(content)
  };
}

function rememberEvent(eventId) {
  if (!eventId) return true;
  const now = Date.now();
  for (const [id, time] of processedEventIds.entries()) {
    if (now - time > 10 * 60 * 1000) processedEventIds.delete(id);
  }
  if (processedEventIds.has(eventId)) return false;
  processedEventIds.set(eventId, now);
  return true;
}

async function handleMessageEvent(event) {
  const normalized = normalizeEventPayload(event);
  if (!rememberEvent(normalized.eventId)) return;
  if (normalized.chatType && normalized.chatType !== 'p2p') return;
  if (normalized.messageType && normalized.messageType !== 'text') return;

  const command = parseWithdrawCommand(normalized.content);
  if (!command) return;

  if (normalized.senderId !== ADMIN_USER_ID) {
    await sendBotMessage(normalized.senderId, buildInfoCard('无权发起支取', [
      '**状态：**已拒绝',
      '**说明：**目前只有管理员可以发起光年币支取。'
    ], 'red'), `gn-withdraw-denied-${normalized.eventId || Date.now()}`).catch((error) => console.warn(`支取拒绝通知发送失败：${error.message}`));
    return;
  }

  if (command.help) {
    await sendBotMessage(ADMIN_USER_ID, buildWithdrawHelpCard(), `gn-withdraw-help-${normalized.eventId || Date.now()}`);
    return;
  }
  if (command.error) {
    await sendBotMessage(ADMIN_USER_ID, buildInfoCard('支取命令格式不正确', [
      `**说明：**${command.error}`,
      '**示例：**支取 刘云澈 10'
    ], 'red'), `gn-withdraw-format-${normalized.eventId || Date.now()}`);
    return;
  }

  try {
    const account = await resolveSingleAccountByName(command.name);
    if (account.balance < command.amount) {
      await sendBotMessage(ADMIN_USER_ID, buildWithdrawResultCard({
        account,
        amount: command.amount,
        beforeBalance: account.balance,
        currentBalance: account.balance,
        afterBalance: account.balance,
        serial: `GW-REJECT-${Date.now()}`
      }, 'error', '余额不足，已拒绝。'), `gn-withdraw-insufficient-${normalized.eventId || Date.now()}`);
      return;
    }
    const draft = createWithdrawDraft(account, command.amount);
    await sendBotMessage(ADMIN_USER_ID, buildWithdrawConfirmCard(draft), `gn-withdraw-confirm-${draft.serial}`);
  } catch (error) {
    await sendBotMessage(ADMIN_USER_ID, buildInfoCard('支取发起失败', [
      `**说明：**${safeErrorMessage(error)}`,
      '**示例：**支取 刘云澈 10'
    ], 'red'), `gn-withdraw-error-${normalized.eventId || Date.now()}`).catch((sendError) => console.warn(`支取错误通知发送失败：${sendError.message}`));
  }
}

process.on('unhandledRejection', (error) => {
  console.error(safeErrorMessage(error));
});

process.on('uncaughtException', (error) => {
  console.error(safeErrorMessage(error));
});

async function handleReview(req, res, url) {
  // 自动入账版本不再支持 URL 审批。旧链接如果还在聊天记录里，也不能继续改状态。
  return sendReviewPage(res, 410, '审批链接已停用', '<p>当前版本已改为白名单用户自动确认入账，请通过领取页面提交。</p>', 'warn');
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) {
      throw new Error('请求体过大，请上传更小的图片或减少批量数据');
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('请求 JSON 格式不正确');
    error.statusCode = 400;
    throw error;
  }
}

async function handleOAuthStart(req, res) {
  requireSessionSecret();
  res.writeHead(302, { Location: buildLoginUrl(req) });
  res.end();
}

async function handleOAuthCallback(req, res, url) {
  requireSessionSecret();
  const code = normalizeName(url.searchParams.get('code'));
  const state = normalizeName(url.searchParams.get('state'));
  const errorCode = normalizeName(url.searchParams.get('error'));
  const errorDescription = normalizeName(url.searchParams.get('error_description'));
  const statePayload = oauthStateCache.get(state);
  oauthStateCache.delete(state);

  if (errorCode || errorDescription || !code || !statePayload || statePayload.expiresAt <= Date.now()) {
    console.error(`飞书登录失败：${errorCode || 'oauth_error'} ${errorDescription || ''}`.trim());
    res.setHeader('Set-Cookie', serializeExpiredSessionCookie());
    res.writeHead(302, { Location: '/?login=failed' });
    res.end();
    return;
  }

  try {
    const accessToken = await exchangeOAuthCode(code, statePayload.redirectUri);
    const user = await fetchOAuthUser(accessToken);
    const secure = externalOrigin(req).startsWith('https://');
    res.setHeader('Set-Cookie', createSessionCookie({
      secret: SESSION_SECRET,
      secure,
      session: {
        id: randomUUID(),
        openId: user.openId,
        name: user.name,
        avatarUrl: user.avatarUrl,
        expiresAt: Date.now() + SESSION_TTL_MS
      },
      maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000)
    }));
    res.writeHead(302, { Location: '/' });
    res.end();
  } catch (error) {
    console.error(`飞书登录失败：${error.message}`);
    res.setHeader('Set-Cookie', serializeExpiredSessionCookie());
    res.writeHead(302, { Location: '/?login=failed' });
    res.end();
  }
}

async function handleCardActionCallback(req, res) {
  const payload = await readJson(req);
  if (!isEncryptedCallbackPayload(payload)) {
    assertCallbackVerificationToken(payload, LARK_VERIFICATION_TOKEN);
  } else if (!LARK_ENCRYPT_KEY) {
    return sendJson(req, res, 400, { error: '卡片回调已加密，但服务未配置 LARK_ENCRYPT_KEY' });
  }
  if (payload?.challenge) {
    return sendJson(req, res, 200, { challenge: payload.challenge });
  }
  const assigned = Object.assign(Object.create({ headers: req.headers }), payload);
  const card = await cardActionHandler.invoke(assigned);
  if (!card) return sendJson(req, res, 401, { error: '卡片回调校验失败' });
  return sendJson(req, res, 200, card);
}

async function handleLarkEventCallback(req, res) {
  const payload = await readJson(req);
  if (isEncryptedCallbackPayload(payload)) {
    return sendJson(req, res, 400, { error: '消息事件暂不支持加密回调，请在开放平台关闭事件加密' });
  }
  assertCallbackVerificationToken(payload, LARK_VERIFICATION_TOKEN);
  if (payload?.challenge) {
    return sendJson(req, res, 200, { challenge: payload.challenge });
  }
  const type = payload?.header?.event_type || payload?.event?.type || payload?.type;
  if (type === 'url_verification') {
    return sendJson(req, res, 200, { challenge: payload.challenge });
  }
  if (type === 'im.message.receive_v1' || payload?.event?.message || payload?.message_type) {
    forget(handleMessageEvent(payload), '处理飞书消息事件');
  }
  return sendJson(req, res, 200, { ok: true });
}

function startLarkEventWsClient() {
  if (!LARK_WS_EVENTS_ENABLED) return;
  if (!LARK_APP_SECRET) {
    console.warn('未启动飞书长连接事件：缺少 FEISHU_APP_SECRET');
    return;
  }
  if (larkWsClient) return;

  larkWsClient = new Lark.WSClient({
    appId: LARK_APP_ID,
    appSecret: LARK_APP_SECRET,
    domain: Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.fatal,
    onReady: () => console.log('飞书长连接事件已连接'),
    onError: (error) => console.warn(`飞书长连接事件错误：${safeErrorMessage(error)}`)
  });
  const eventDispatcher = new Lark.EventDispatcher({
    loggerLevel: Lark.LoggerLevel.fatal
  }).register({
    'im.message.receive_v1': async (data) => {
      forget(handleMessageEvent({ event: data, header: { event_id: data?.event_id } }), '处理飞书长连接消息事件');
    }
  });
  larkWsClient.start({ eventDispatcher });
}

async function handleWithdrawTableEvent(req, res) {
  const payload = await readJson(req);
  if (WITHDRAW_WEBHOOK_TOKEN && payload.token !== WITHDRAW_WEBHOOK_TOKEN) {
    return sendJson(req, res, 403, { error: '无权调用支取表回调' });
  }
  const recordId = normalizeName(payload.record_id || payload.recordId || payload.id);
  if (!recordId) return sendJson(req, res, 400, { error: '缺少支取表 record_id' });
  const result = await handleManualWithdrawRecord(recordId);
  return sendJson(req, res, result.ok ? 200 : 400, result);
}

function imageBufferFromDataUrl(image) {
  const match = String(image || '').match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/iu);
  if (!match) return null;
  const buffer = Buffer.from(match[2], 'base64');
  return buffer.length ? buffer : null;
}

async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    // OCR worker 初始化较慢，因此做进程级复用；轻量版单服务部署下保持一个 worker 足够。
    // 语言组合使用 chi_sim+eng 字符串，避免数组形式在 tesseract.js 初始化时解析异常。
    ocrWorkerPromise = createWorker('chi_sim+eng', 1, {
      logger: () => {},
      errorHandler: (error) => console.error('OCR worker 错误:', error)
    }).then(async (worker) => {
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SPARSE_TEXT,
        preserve_interword_spaces: '1',
        user_defined_dpi: '300'
      });
      return worker;
    }).catch((error) => {
      ocrWorkerPromise = undefined;
      throw error;
    });
  }
  return ocrWorkerPromise;
}

async function recognizeFeishuImage(buffer) {
  const data = await requestLark({
    method: 'POST',
    url: '/open-apis/optical_char_recognition/v1/image/basic_recognize',
    data: { image: buffer.toString('base64') }
  });
  const textList = Array.isArray(data.text_list) ? data.text_list : [];
  return {
    text: textList.join('\n'),
    engine: 'feishu'
  };
}

async function recognizeTesseractImage(buffer) {
  const worker = await getOcrWorker();
  const ocrBuffer = await preprocessOcrImage(buffer);
  const result = await worker.recognize(ocrBuffer);
  return {
    text: result?.data?.text || '',
    engine: 'tesseract'
  };
}

async function preprocessOcrImage(buffer) {
  try {
    const image = sharp(buffer, { limitInputPixels: 50_000_000 });
    const metadata = await image.metadata();
    const width = metadata.width || 0;
    const resizeWidth = width && width < 2200 ? Math.min(2600, Math.round(width * 2.5)) : undefined;
    return await image
      .resize(resizeWidth ? { width: resizeWidth, kernel: sharp.kernel.lanczos3 } : undefined)
      .grayscale()
      .normalize()
      .sharpen()
      .png()
      .toBuffer();
  } catch (error) {
    console.warn('OCR 图片预处理失败，使用原图识别:', error?.message || error);
    return buffer;
  }
}

async function recognizeClaimImage(image) {
  // 前端会先限制图片大小，但服务端仍然必须重新校验。
  // 这样即使有人绕过页面直接调接口，也不能上传超大 payload 占用内存。
  const buffer = imageBufferFromDataUrl(image);
  if (!buffer) throw new Error('请上传 png、jpg、jpeg 或 webp 图片');
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('图片不能超过 8MB');
  try {
    const tasks = await getTasks();
    let text = '';
    let engine = 'feishu';
    try {
      ({ text, engine } = await recognizeFeishuImage(buffer));
    } catch (error) {
      console.warn('飞书 OCR 失败，回退到本地 Tesseract:', error?.message || error);
      ({ text, engine } = await recognizeTesseractImage(buffer));
    }
    if (!text.trim()) {
      ({ text, engine } = await recognizeTesseractImage(buffer));
    }
    const records = parseImageRecords(text, tasks);
    if (!records.length && text.trim()) {
      console.warn(`图片 OCR 完成但未解析出记录（${engine}），原始文本预览:`, text.slice(0, 500));
    }
    return {
      text,
      records: await resolveOcrRecords(records),
      tasks,
      engine
    };
  } catch (error) {
    console.error('图片识别失败:', error?.message || error);
    if (error?.stack) console.error(error.stack);
    throw error;
  }
}

async function handleApi(req, res, pathname) {
  const session = currentSession(req);

  if (req.method === 'GET' && pathname === '/api/me') {
    if (!SESSION_SECRET || SESSION_SECRET.length < 24) {
      return sendJson(req, res, 500, {
        code: 'SERVER_CONFIG_REQUIRED',
        error: '服务端缺少 SESSION_SECRET，请联系管理员完成部署配置。'
      });
    }
    // 前端首次加载只调用 /api/me。它既返回登录地址，也返回当前用户是否已进入白名单。
    // 这样页面可以在不暴露业务接口的情况下展示“需要登录/暂无权限/可填写”三种状态。
    if (!session) {
      return sendJson(req, res, 200, {
        authenticated: false,
        authorized: false,
        loginUrl: buildLoginUrl(req),
        oauthRedirectUri: oauthRedirectUri(req)
      });
    }
    const authorized = await isWhitelisted(session.openId);
    return sendJson(req, res, 200, {
      authenticated: true,
      authorized,
      loginUrl: authorized ? null : buildLoginUrl(req),
      oauthRedirectUri: oauthRedirectUri(req),
      user: {
        openId: session.openId,
        name: session.name,
        avatarUrl: session.avatarUrl || ''
      }
    });
  }

  if (req.method === 'POST' && pathname === '/api/logout') {
    res.setHeader('Set-Cookie', serializeExpiredSessionCookie());
    return sendJson(req, res, 200, { ok: true });
  }

  // 除 /api/me 外，所有业务 API 都必须完成飞书登录并在白名单内。
  // 这就是“白名单用户自动入账”的安全边界：前端展示不可信，后端会重新校验身份。
  if (!session) {
    return sendJson(req, res, 401, {
      code: 'LOGIN_REQUIRED',
      error: '请先使用飞书登录',
      loginUrl: buildLoginUrl(req),
      oauthRedirectUri: oauthRedirectUri(req)
    });
  }
  if (!(await isWhitelisted(session.openId))) {
    return sendJson(req, res, 403, {
      code: 'FORBIDDEN',
      error: '你暂无权限使用此领取页面，请联系管理员@芮婷。'
    });
  }

  if (req.method === 'GET' && pathname === '/api/accounts') {
    const accounts = await getClaimAccounts();
    accounts.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    return sendJson(req, res, 200, { accounts });
  }

  if (req.method === 'GET' && pathname === '/api/balance') {
    return sendJson(req, res, 404, { error: '接口不存在' });
  }

  if (req.method === 'GET' && pathname === '/api/tasks') {
    const tasks = await getTasks();
    return sendJson(req, res, 200, { tasks });
  }

  if (req.method === 'POST' && pathname === '/api/claim-image/recognize') {
    assertRateLimit(req, 'ocr', 6);
    const { image } = await readJson(req);
    let result;
    try {
      result = await recognizeClaimImage(image);
    } catch (error) {
      console.error('图片识别接口失败:', error?.message || error);
      throw error;
    }
    return sendJson(req, res, 200, {
      ok: true,
      text: result.text,
      records: result.records,
      count: result.records.length,
      limit: MAX_BATCH_ROWS,
      engine: result.engine
    });
  }

  if (req.method === 'GET' && pathname === '/api/claims') {
    return sendJson(req, res, 404, { error: '接口不存在' });
  }

  if (req.method === 'POST' && pathname === '/api/claims') {
    assertRateLimit(req, 'claims', 30);
    const { accountId, people, amount, task, selectedUsers, items } = await readJson(req);
    if (Array.isArray(items)) {
      // 批量图片提交不信任 OCR 原始结果：每一行都必须在服务端重新校验任务和数量，
      // 再通过账户表解析到真实 open_id，最后才允许自动确认入账。
      if (!items.length) return sendJson(req, res, 400, { error: '请先添加要提交的人员' });
      if (items.length > MAX_BATCH_ROWS) return sendJson(req, res, 400, { error: `单张图片最多提交 ${MAX_BATCH_ROWS} 条` });
      const tasks = await getTasks();
      const normalizedItems = items.map((item, index) => {
        const name = normalizeName(item.name);
        const selectedTask = normalizeName(item.task);
        const numericAmount = Number(item.amount);
        const key = normalizeName(item.key) || `row:${index + 1}`;
        const personId = normalizeName(item.person?.id || item.userId);
        const personAccountId = normalizeName(item.person?.accountId || item.accountId);
        if (!name && !personId) throw new Error(`第 ${index + 1} 行缺少人员姓名`);
        if (!Number.isInteger(numericAmount) || numericAmount <= 0) {
          throw new Error(`第 ${index + 1} 行领取数量只能填写正整数`);
        }
        if (!selectedTask || !tasks.includes(selectedTask)) {
          throw new Error(`第 ${index + 1} 行请选择有效任务`);
        }
        return {
          key,
          name,
          amount: numericAmount,
          task: selectedTask,
          personId,
          personAccountId
        };
      });

      const accounts = await getAccounts();
      const directItems = [];
      const unresolvedItems = [];
      normalizedItems.forEach((item) => {
        const account = item.personAccountId
          ? accounts.find((candidate) => candidate.id === item.personAccountId && candidate.userId === item.personId)
          : null;
        if (account) {
          directItems.push({ ...item, account });
        } else {
          unresolvedItems.push(item);
        }
      });

      const resolved = unresolvedItems.length
        ? await resolveClaimAccounts(unresolvedItems.map((item) => item.name), accounts, selectedUsers)
        : { accounts: [] };
      if (resolved.selectionRequired) {
        return sendJson(req, res, 409, {
          code: 'SELECTION_REQUIRED',
          error: '请选择对应人员后再提交',
          selectionRequired: resolved.selectionRequired
        });
      }
      if (resolved.error) return sendJson(req, res, 400, { error: resolved.error });
      const resolvedAccountByName = accountLookupByName(resolved.accounts || []);
      const resolvedItems = unresolvedItems.map((item) => ({
        ...item,
        account: resolvedAccountByName.get(item.name.toLocaleLowerCase('zh-Hans-CN'))
      }));
      const claimItems = [...directItems, ...resolvedItems].map((item) => ({
        ...item,
        serial: `GN-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
      })).filter((item) => item.account?.userId);
      if (claimItems.length !== normalizedItems.length) {
        return sendJson(req, res, 400, { error: '部分人员未匹配到账户，请检查姓名后重试' });
      }

      const result = await createAutoConfirmedClaims(claimItems, '图片批量上传；白名单用户自动确认入账');
      forget(sendClaimNotifications(claimItems, session), '发送入账通知');
      return sendJson(req, res, 200, {
        ok: true,
        serial: claimItems[0]?.serial,
        serials: claimItems.map((item) => item.serial),
        recordId: result.recordIds[0],
        recordIds: result.recordIds,
        count: claimItems.length,
        message: '批量申请已自动确认入账'
      });
    }

    const numericAmount = Number(amount);
    // 普通手动提交和批量提交共用同一套“登录 + 白名单 + 账户解析 + 自动确认”后端边界。
    // 前端只是交互层，不能作为任何权限或数据合法性的依据。
    if (!Number.isInteger(numericAmount) || numericAmount <= 0) {
      return sendJson(req, res, 400, { error: '领取数量只能填写正整数' });
    }
    if (!String(task || '').trim()) {
      return sendJson(req, res, 400, { error: '请选择任务' });
    }

    const accounts = await getAccounts();
    const selectedAccounts = [];

    if (accountId) {
      const account = accounts.find((item) => item.id === accountId && item.userId);
      if (!account) return sendJson(req, res, 404, { error: '未找到人员账户' });
      selectedAccounts.push(account);
    } else {
      const parsedPeople = parsePeople(people);
      if (parsedPeople.length === 0) return sendJson(req, res, 400, { error: '请输入人员姓名' });
      if (parsedPeople.length > 200) return sendJson(req, res, 400, { error: '单次最多提交 200 人' });

      const resolved = await resolveClaimAccounts(parsedPeople, accounts, selectedUsers);
      if (resolved.selectionRequired) {
        return sendJson(req, res, 409, {
          code: 'SELECTION_REQUIRED',
          error: '请选择对应人员后再提交',
          selectionRequired: resolved.selectionRequired
        });
      }
      if (resolved.error) return sendJson(req, res, 400, { error: resolved.error });
      selectedAccounts.push(...resolved.accounts);
    }

    const claimItems = selectedAccounts.map((account) => ({
      account,
      amount: numericAmount,
      task: String(task).trim(),
      serial: `GN-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
    }));
    const result = await createAutoConfirmedClaims(claimItems, '白名单用户自动确认入账');
    forget(sendClaimNotifications(claimItems, session), '发送入账通知');
    return sendJson(req, res, 200, {
      ok: true,
      serial: claimItems[0]?.serial,
      serials: claimItems.map((item) => item.serial),
      recordId: result.recordIds[0],
      recordIds: result.recordIds,
      count: selectedAccounts.length,
      message: '申请已自动确认入账'
    });
  }

  return sendJson(req, res, 404, { error: '接口不存在' });
}

async function serveStatic(req, res, pathname) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(publicDir, path.normalize(safePath).replace(/^(\.\.[/\\])+/, ''));
  const ext = path.extname(filePath);
  try {
    await readFile(filePath);
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const port = Number(process.env.PORT || 4173);

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, jsonHeaders(req));
      res.end();
    } else if (req.method === 'GET' && url.pathname === '/oauth/start') {
      await handleOAuthStart(req, res);
    } else if (req.method === 'GET' && url.pathname === '/oauth/callback') {
      await handleOAuthCallback(req, res, url);
    } else if (req.method === 'POST' && url.pathname === '/lark/card-action') {
      await handleCardActionCallback(req, res);
    } else if (req.method === 'POST' && url.pathname === '/lark/events') {
      await handleLarkEventCallback(req, res);
    } else if (req.method === 'POST' && url.pathname === '/lark/withdraw-table-event') {
      await handleWithdrawTableEvent(req, res);
    } else if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url.pathname);
    } else if (url.pathname === '/review') {
      await handleReview(req, res, url);
    } else {
      await serveStatic(req, res, url.pathname);
    }
  } catch (error) {
    const statusCode = Number(error.statusCode || 500);
    sendJson(req, res, statusCode, { error: safeErrorMessage(error) });
  }
}).listen(port, () => {
  console.log(`光年币领取系统已启动：http://localhost:${port}`);
  if (WITHDRAW_POLL_ENABLED) {
    setTimeout(() => pollWithdrawTable(), 1000);
    setInterval(() => pollWithdrawTable(), WITHDRAW_POLL_INTERVAL_MS).unref();
  }
  startLarkEventWsClient();
});
