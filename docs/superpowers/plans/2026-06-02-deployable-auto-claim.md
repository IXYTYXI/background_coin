# 可部署自动入账实现计划

> **给后续执行者：** 请按任务逐项实现和验证。每个步骤使用复选框（`- [ ]`）跟踪进度。

**目标：** 做成一个可用 systemd/Nginx 部署的单 Node.js 服务，飞书白名单用户登录后可以自动确认光年币入账，并支持图片批量上传。

**架构：** 保留原项目“Node 后端 + 飞书 SDK + 环境变量”的部署模型，在此基础上增加飞书 OAuth、签名 Cookie 会话、白名单校验、自动确认入账和 OCR 批量识别。前端与后端保持同源访问，不依赖 Cloudflare Tunnel、本机 `lark-cli` 或 `keytar`。

**技术栈：** Node.js ESM、`@larksuiteoapi/node-sdk`、Node 内置 `crypto/http/fetch`、`tesseract.js`、systemd、Nginx。

---

## 文件结构

- 修改 `package.json` 和 `package-lock.json`：增加 `tesseract.js`，不引入 `keytar`。
- 新增 `lib/session.js`：负责签名 Cookie 的生成、解析、过期校验和防篡改校验。
- 修改 `server.js`：增加环境变量配置、OAuth、白名单查询、接口鉴权、自动确认入账、OCR 识别、CORS 限制。
- 修改 `src/index.html`：增加登录权限页和图片批量上传区域。
- 修改 `src/app.js`：使用同源 API、携带 Cookie、登录权限页、图片预处理、批量编辑和批量提交。
- 修改 `src/styles.css`：增加权限页和批量上传样式。
- 修改 `.env.example`：用中文说明生产部署所需环境变量。
- 修改 `README.md`：用中文说明轻量版 systemd/Nginx 部署和飞书 OAuth 配置。

## 任务 1：部署配置与签名 Cookie 会话

**涉及文件：**
- 修改：`server.js`
- 修改：`.env.example`

- [ ] **步骤 1：增加环境变量配置**

在 `server.js` 顶部附近增加配置常量：

```js
const config = {
  baseToken: process.env.BASE_TOKEN || BASE_TOKEN,
  ledgerTable: process.env.LEDGER_TABLE || LEDGER_TABLE,
  accountTable: process.env.ACCOUNT_TABLE || ACCOUNT_TABLE,
  whitelistTable: process.env.WHITELIST_TABLE || '',
  adminUserId: process.env.ADMIN_USER_ID || ADMIN_USER_ID,
  appId: process.env.FEISHU_APP_ID || 'cli_xxxxxxxxxxxxxxxx',
  appSecret: process.env.FEISHU_APP_SECRET,
  publicOrigin: process.env.PUBLIC_ORIGIN || '',
  sessionSecret: process.env.SESSION_SECRET || ''
};
```

- [ ] **步骤 2：增加签名 Cookie 工具**

使用 `createHmac`、`randomUUID` 和 base64url JSON 载荷增加会话辅助函数：

```js
function signValue(value) {
  return createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
}

function encodeSession(session) {
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `${payload}.${signValue(payload)}`;
}

function decodeSession(value) {
  const [payload, signature] = String(value || '').split('.');
  if (!payload || !signature || signature !== signValue(payload)) return null;
  const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  return session.expiresAt > Date.now() ? session : null;
}
```

- [ ] **步骤 3：更新 `.env.example`**

包含以下配置：

```bash
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=replace_with_your_app_secret
BASE_TOKEN=replace_with_bitable_app_token
LEDGER_TABLE=replace_with_ledger_table_id
ACCOUNT_TABLE=replace_with_account_table_id
WHITELIST_TABLE=replace_with_whitelist_table_id
ADMIN_USER_ID=replace_with_admin_open_id
PUBLIC_ORIGIN=https://guangnianbi.yc345.tv
SESSION_SECRET=replace_with_32_plus_random_chars
PORT=19001
```

## 任务 2：飞书 OAuth 与白名单门禁

**涉及文件：**
- 修改：`server.js`
- 修改：`src/index.html`
- 修改：`src/app.js`

- [ ] **步骤 1：增加 OAuth 路由**

实现 `GET /oauth/start` 和 `GET /oauth/callback`。OAuth state 暂存在内存中，有效期 10 分钟；回调成功后拉取飞书用户信息，并写入签名 Cookie。

- [ ] **步骤 2：增加 `/api/me`**

返回示例：

```json
{
  "authenticated": true,
  "authorized": true,
  "user": { "openId": "ou_xxx", "name": "User" },
  "loginUrl": null
}
```

未登录用户返回 `authenticated: false` 和 `loginUrl`。

- [ ] **步骤 3：增加 API 鉴权保护**

访问 `/api/accounts`、`/api/tasks`、`/api/claim-image/recognize` 和 `/api/claims` 前，必须具备有效签名会话，并且飞书用户在白名单表中。

## 任务 3：白名单用户自动确认入账

**涉及文件：**
- 修改：`server.js`

- [ ] **步骤 1：修改领取记录创建逻辑**

白名单用户提交后，写入流水表时直接设置：

```js
'已确认'
'是'
'白名单用户自动确认入账'
```

- [ ] **步骤 2：发送入账通知**

写入成功后，机器人发送通知给：

- `ADMIN_USER_ID`
- submitter, when different from admin
- recipient users

通知失败只记录日志，不回滚已经写入的入账记录。

## 任务 4：OCR 图片批量上传

**涉及文件：**
- 修改：`package.json`
- 修改：`server.js`
- 修改：`src/index.html`
- 修改：`src/app.js`
- 修改：`src/styles.css`

- [ ] **步骤 1：增加 `tesseract.js`**

安装 `tesseract.js`，不要安装 `keytar`。

- [ ] **步骤 2：增加 `/api/claim-image/recognize`**

接收 `png`、`jpg`、`jpeg` 或 `webp` 的 data URL，服务端校验解码后图片不超过 8MB，使用中英文 OCR 识别，最多解析 20 条领取记录，并返回可编辑数据。

- [ ] **步骤 3：增加批量提交**

允许 `POST /api/claims` 接收以下数据：

```json
{
  "items": [
    { "key": "row:1", "name": "张三", "task": "任务1｜新视界分享", "amount": 10 }
  ],
  "selectedUsers": {}
}
```

逐行校验人员、任务和数量，解析用户/账户，写入已确认流水，并返回每条流水号。

## 任务 5：部署文档与验证

**涉及文件：**
- 修改：`README.md`
- 修改：`deploy/guangnian-claim.service`
- 修改：`deploy/nginx-guangnian-claim.conf`
- 修改：`deploy/nginx-guangnian-claim.https.conf`

- [ ] **步骤 1：更新 README**

用中文说明飞书 OAuth 回调地址、环境变量、systemd 启动和 Nginx 反向代理。

- [ ] **步骤 2：执行验证**

执行：

```bash
npm install
npm start
curl -i http://127.0.0.1:4173/
curl -i http://127.0.0.1:4173/api/me
npm audit --audit-level=high
```

预期结果：服务能启动；首页返回 200；`/api/me` 返回未登录状态；`npm audit --audit-level=high` 没有高危漏洞。
