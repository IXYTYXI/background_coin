import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import * as Lark from '@larksuiteoapi/node-sdk';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE_TOKEN = 'KrVRbjTKOatunlslgHlcdPyindc';
const LEDGER_TABLE = 'tbl88pkryfLsRNNk';
const ACCOUNT_TABLE = 'tblcvlBAmioZD4CJ';
const ADMIN_USER_ID = 'ou_64a560dfa39a4acbfce6eee29a08fb3a';
const LARK_APP_ID = process.env.FEISHU_APP_ID || 'cli_a956e0b1eb3bdbc9';
const LARK_APP_SECRET = process.env.FEISHU_APP_SECRET;

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
  accountStatus: 'fldcRghGZ7'
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
let larkClient;

const cardActionHandler = new Lark.CardActionHandler({ loggerLevel: Lark.LoggerLevel.warn }, handleApprovalAction);

function rememberClaim(claim) {
  if (!claim?.serial) return claim;
  claimCache.set(claim.serial, claim);
  return claim;
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
      loggerLevel: Lark.LoggerLevel.warn
    });
  }
  return larkClient;
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

function firstUser(value) {
  return Array.isArray(value) && value.length ? value[0] : null;
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
      [FIELD.accountName, FIELD.accountPerson, FIELD.accountBalance],
      200,
      offset
    );
    const records = data.data || [];
    const ids = data.record_id_list || [];
    records.forEach((row, index) => {
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

async function getTasks() {
  const meta = await getFieldMeta(LEDGER_TABLE);
  return (meta.get(FIELD.ledgerTask)?.property?.options || []).map((option) => option.name).filter(Boolean);
}

async function searchUsersByNames(names) {
  const users = [];
  const queries = [];
  for (const name of names) {
    const data = await requestLark({
      method: 'GET',
      url: '/open-apis/search/v1/user',
      params: {
        query: name,
        page_size: 20
      }
    });
    users.push(...(data.users || []).map((user) => normalizeUser(user, name)));
    queries.push({ query: name, has_more: Boolean(data.has_more) });
  }
  return { users, queries };
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

async function createAccountsFromUsers(users) {
  if (!users.length) return [];
  const fieldIds = [FIELD.accountName, FIELD.accountPerson, FIELD.accountStatus];
  const records = await Promise.all(users.map(async (user) => ({
    fields: await rowToRecordFields(ACCOUNT_TABLE, fieldIds, [
      user.localized_name,
      [{ id: user.open_id }],
      '启用'
    ])
  })));
  const data = await unwrapLark(getLarkClient().bitable.appTableRecord.batchCreate({
    path: { app_token: BASE_TOKEN, table_id: ACCOUNT_TABLE },
    params: { user_id_type: 'open_id' },
    data: { records }
  }));
  return users.map((user, index) => ({
    id: data.records?.[index]?.record_id,
    name: user.localized_name,
    userId: user.open_id,
    userName: user.localized_name,
    balance: 0
  })).filter((account) => account.id);
}

async function updateAccountsFromUsers(accountUserPairs) {
  const updatedAccounts = [];
  for (const { account, user } of accountUserPairs) {
    await unwrapLark(getLarkClient().bitable.appTableRecord.update({
      path: { app_token: BASE_TOKEN, table_id: ACCOUNT_TABLE, record_id: account.id },
      params: { user_id_type: 'open_id' },
      data: {
        fields: await fieldsByIdToName(ACCOUNT_TABLE, {
        [FIELD.accountName]: account.name || user.localized_name,
        [FIELD.accountPerson]: [{ id: user.open_id }],
        [FIELD.accountStatus]: '启用'
        })
      }
    }));
    updatedAccounts.push({
      ...account,
      name: account.name || user.localized_name,
      userId: user.open_id,
      userName: user.localized_name
    });
  }
  return updatedAccounts;
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

function matchPeopleToUsers(people, users, queryStates) {
  const queryStateByName = new Map(
    queryStates.map((item) => [normalizeName(item.query).toLocaleLowerCase('zh-Hans-CN'), item])
  );
  const usersByQuery = new Map();
  users.forEach((user) => {
    const query = normalizeName(user.matched_query).toLocaleLowerCase('zh-Hans-CN');
    if (!usersByQuery.has(query)) usersByQuery.set(query, []);
    usersByQuery.get(query).push(user);
  });

  return people.map((name) => {
    const key = name.toLocaleLowerCase('zh-Hans-CN');
    const matches = (usersByQuery.get(key) || [])
      .filter((user) => !user.is_cross_tenant)
      .filter((user) => normalizeName(user.localized_name) === name);
    const unique = Array.from(new Map(matches.map((user) => [user.open_id, user])).values());
    return {
      name,
      candidates: unique,
      hasMore: Boolean(queryStateByName.get(key)?.has_more)
    };
  });
}

function departmentParts(value) {
  return normalizeName(value).split(/[-/／>｜|]/u).map(normalizeName).filter(Boolean);
}

function displayDepartment(value) {
  const parts = departmentParts(value);
  return parts[1] || parts[0] || '未显示部门';
}

function userOption(user) {
  const departmentPath = user.department || '';
  return {
    id: user.open_id,
    name: user.localized_name,
    department: displayDepartment(departmentPath),
    departmentPath,
    email: user.enterprise_email || user.email || ''
  };
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
  const emptyAccountByName = new Map();
  const selectionRequired = [];
  const selectedUserIds = new Map(
    Object.entries(selectedUsers || {}).map(([name, userId]) => [normalizeName(name), normalizeName(userId)])
  );
  const usersToCreate = [];
  const accountUserPairs = [];

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
      if (emptyAccounts.length === 1) emptyAccountByName.set(match.name, emptyAccounts[0]);
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

    if (emptyAccounts.length === 1) emptyAccountByName.set(match.name, emptyAccounts[0]);
    missingNames.push(match.name);
  }

  if (selectionRequired.length) return { selectionRequired };

  const lookupNames = Array.from(new Set(missingNames));
  if (!lookupNames.length) return { accounts: selectedAccounts };

  const { users, queries } = await searchUsersByNames(lookupNames);
  const userMatches = matchPeopleToUsers(lookupNames, users, queries);

  for (const match of userMatches) {
    if (!missingNames.includes(match.name)) continue;
    const pickedUserId = selectedUserIds.get(match.name);
    const user = pickedUserId
      ? match.candidates.find((candidate) => candidate.open_id === pickedUserId)
      : match.candidates[0];

    if (!pickedUserId && match.candidates.length > 1) {
      selectionRequired.push({
        name: match.name,
        options: match.candidates.map(userOption)
      });
      continue;
    }

    if (pickedUserId && !user) {
      selectionRequired.push({
        name: match.name,
        options: match.candidates.map(userOption)
      });
      continue;
    }

    if (!user || match.candidates.length === 0) {
      return { error: `以下人员未匹配到通讯录：${match.name}` };
    }

    if (!pickedUserId && match.hasMore && match.candidates.length > 1) {
      selectionRequired.push({
        name: match.name,
        options: match.candidates.map(userOption)
      });
      continue;
    }

    const existingAccount = accounts.find((account) => account.userId === user.open_id);
    if (existingAccount) {
      selectedAccounts.push(existingAccount);
      continue;
    }

    const emptyAccount = emptyAccountByName.get(match.name);
    if (emptyAccount) {
      accountUserPairs.push({ account: emptyAccount, user });
    } else {
      usersToCreate.push(user);
    }
  }

  if (selectionRequired.length) return { selectionRequired };

  const updatedAccounts = await updateAccountsFromUsers(accountUserPairs);
  const newAccounts = await createAccountsFromUsers(usersToCreate);
  return { accounts: [...selectedAccounts, ...updatedAccounts, ...newAccounts] };
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
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
  try {
    await unwrapLark(getLarkClient().im.message.create({
      params: {
        receive_id_type: 'open_id',
        uuid: `gn-approval-${claim.serial}`
      },
      data: {
        receive_id: ADMIN_USER_ID,
        msg_type: 'interactive',
        content: JSON.stringify(buildApprovalCard(claim))
      }
    }));
  } catch (error) {
    console.error(error.message);
  }
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

process.on('unhandledRejection', (error) => {
  console.error(error?.message || error);
});

process.on('uncaughtException', (error) => {
  console.error(error?.message || error);
});

async function handleReview(req, res, url) {
  const action = url.searchParams.get('action');
  const serial = normalizeName(url.searchParams.get('serial'));
  if (!reviewActionText[action]) {
    return sendReviewPage(res, 400, '无法处理', '<p>审批动作无效，请从消息卡片按钮重新进入。</p>', 'error');
  }
  if (!serial) {
    return sendReviewPage(res, 400, '无法处理', '<p>缺少申请流水号，请从消息卡片按钮重新进入。</p>', 'error');
  }

  const rows = await listAllRecords(LEDGER_TABLE, [
    FIELD.ledgerPerson,
    FIELD.ledgerAmount,
    FIELD.ledgerTask,
    FIELD.ledgerStatus,
    FIELD.ledgerSerial,
    FIELD.ledgerSent
  ]);
  const claim = rows.find((item) => cellText(item.row[4]) === serial);
  if (!claim) {
    return sendReviewPage(res, 404, '未找到申请', `<p>流水号：${escapeHtml(serial)}</p>`, 'error');
  }

  const person = cellText(claim.row[0]);
  const amount = cellText(claim.row[1]);
  const task = cellText(claim.row[2]);
  const status = cellText(claim.row[3]);
  if (status !== '待确认') {
    return sendReviewPage(
      res,
      200,
      '这条申请已处理',
      `<p>当前状态：${escapeHtml(status || '未知')}</p><p>申请人：${escapeHtml(person)}</p><p>数量：${escapeHtml(amount)}</p><p>任务：${escapeHtml(task)}</p>`,
      'warn'
    );
  }

  await updateClaimReview(claim.id, action);
  return sendReviewPage(
    res,
    200,
    `${reviewActionText[action]}成功`,
    `<p>申请人：${escapeHtml(person)}</p><p>数量：${escapeHtml(amount)}</p><p>任务：${escapeHtml(task)}</p><p>流水号：${escapeHtml(serial)}</p>`
  );
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function handleCardActionCallback(req, res) {
  const payload = await readJson(req);
  if (payload?.challenge) {
    return sendJson(res, 200, { challenge: payload.challenge });
  }

  const result = await cardActionHandler.invoke({
    ...payload,
    headers: req.headers
  });

  return sendJson(res, 200, result || {
    toast: { type: 'error', content: '这次操作没有处理成功，请稍后重试' }
  });
}

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/accounts') {
    const accounts = await getClaimAccounts();
    accounts.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    return sendJson(res, 200, { accounts });
  }

  if (req.method === 'GET' && pathname === '/api/balance') {
    return sendJson(res, 404, { error: '接口不存在' });
  }

  if (req.method === 'GET' && pathname === '/api/tasks') {
    const tasks = await getTasks();
    return sendJson(res, 200, { tasks });
  }

  if (req.method === 'GET' && pathname === '/api/claims') {
    return sendJson(res, 404, { error: '接口不存在' });
  }

  if (req.method === 'POST' && pathname === '/api/claims') {
    const { accountId, people, amount, task, selectedUsers } = await readJson(req);
    const numericAmount = Number(amount);
    if (!Number.isInteger(numericAmount) || numericAmount <= 0) {
      return sendJson(res, 400, { error: '领取数量只能填写正整数' });
    }
    if (!String(task || '').trim()) {
      return sendJson(res, 400, { error: '请选择任务' });
    }

    const accounts = await getAccounts();
    const selectedAccounts = [];

    if (accountId) {
      const account = accounts.find((item) => item.id === accountId && item.userId);
      if (!account) return sendJson(res, 404, { error: '未找到人员账户' });
      selectedAccounts.push(account);
    } else {
      const parsedPeople = parsePeople(people);
      if (parsedPeople.length === 0) return sendJson(res, 400, { error: '请输入人员姓名' });
      if (parsedPeople.length > 200) return sendJson(res, 400, { error: '单次最多提交 200 人' });

      const resolved = await resolveClaimAccounts(parsedPeople, accounts, selectedUsers);
      if (resolved.selectionRequired) {
        return sendJson(res, 409, {
          code: 'SELECTION_REQUIRED',
          error: '请选择对应人员后再提交',
          selectionRequired: resolved.selectionRequired
        });
      }
      if (resolved.error) return sendJson(res, 400, { error: resolved.error });
      selectedAccounts.push(...resolved.accounts);
    }

    const serials = selectedAccounts.map(
      () => `GN-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
    );
    const fieldIds = [
      FIELD.ledgerPerson,
      FIELD.ledgerAmount,
      FIELD.ledgerTask,
      FIELD.ledgerAccount,
      FIELD.ledgerStatus,
      FIELD.ledgerSerial,
      FIELD.ledgerSent
    ];
    const records = await Promise.all(selectedAccounts.map(async (account, index) => ({
      fields: await rowToRecordFields(LEDGER_TABLE, fieldIds, [
        [{ id: account.userId }],
        numericAmount,
        String(task).trim(),
        [{ id: account.id }],
        '待确认',
        serials[index],
        '否'
      ])
    })));
    const data = await unwrapLark(getLarkClient().bitable.appTableRecord.batchCreate({
      path: { app_token: BASE_TOKEN, table_id: LEDGER_TABLE },
      params: { user_id_type: 'open_id' },
      data: { records }
    }));
    const recordIds = (data.records || []).map((record) => record.record_id).filter(Boolean);
    return sendJson(res, 200, {
      ok: true,
      serial: serials[0],
      serials,
      recordId: recordIds[0],
      recordIds,
      count: selectedAccounts.length,
      message: '申请已提交，等待管理员确认'
    });
  }

  return sendJson(res, 404, { error: '接口不存在' });
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
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
      });
      res.end();
    } else if (req.method === 'POST' && url.pathname === '/lark/card-action') {
      await handleCardActionCallback(req, res);
    } else if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url.pathname);
    } else if (url.pathname === '/review') {
      await handleReview(req, res, url);
    } else {
      await serveStatic(req, res, url.pathname);
    }
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}).listen(port, () => {
  console.log(`光年币领取系统已启动：http://localhost:${port}`);
});
