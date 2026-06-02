# 光年币领取系统

这是一个可部署的 Node.js 单服务应用。用户通过飞书 OAuth 登录后，系统会校验其是否在前端白名单表中；白名单用户可以手动提交或通过图片批量上传光年币领取记录，后端会直接写入多维表格并自动确认入账。

## 当前能力

- 飞书 OAuth 登录。
- 前端白名单校验。
- 白名单用户自动确认入账。
- 支持单人/多人手动领取。
- 支持图片 OCR 批量识别，最多一次提交 20 条。
- 入账后通知管理员、提交人和被入账人。
- 支持 systemd + Nginx 轻量部署。

## 运行要求

- Node.js 18+
- 飞书企业自建应用
- 飞书应用需要具备以下能力：
  - 获取用户身份或网页 OAuth 登录
  - 多维表格读写
  - 读取通讯录用户
  - 搜索用户
  - 发送消息
- 飞书应用需要被安装到企业，并且对目标多维表格有访问权限。

## 多维表格要求

系统默认使用三张表：

- 流水表：记录每次光年币领取。
- 账户表：维护人员账户和人员字段。
- 前端白名单表：维护允许访问领取页面的飞书人员。

前端白名单表至少需要一个“人员”字段，并把字段 ID 配置到 `WHITELIST_PERSON_FIELD`。

## 环境变量

先复制示例文件：

```bash
cp .env.example .env
```

`.env` 示例：

```bash
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxx
BASE_TOKEN=xxxxxxxxxxxxxxxx
LEDGER_TABLE=tblxxxxxxxxxxxx
ACCOUNT_TABLE=tblxxxxxxxxxxxx
WHITELIST_TABLE=tblxxxxxxxxxxxx
WHITELIST_PERSON_FIELD=fldxxxxxxxx
ADMIN_USER_ID=ou_xxxxxxxxxxxxxxxx
PUBLIC_ORIGIN=https://guangnianbi.yc345.tv
SESSION_SECRET=请填写32位以上随机字符串
PORT=19001
```

说明：

- `PUBLIC_ORIGIN` 必须是用户实际访问的 HTTPS 地址。
- 飞书开发者后台的 OAuth 重定向 URL 必须配置为：`PUBLIC_ORIGIN/oauth/callback`。
- `SESSION_SECRET` 用于签名 Cookie，不能使用示例值。
- `WHITELIST_TABLE` 为空或字段 ID 错误时，所有业务接口都会无法通过白名单校验。

## 本地启动

```bash
npm install
npm start
```

启动后访问：

```text
http://localhost:4173
```

如果本地调试 OAuth，需要把本地回调地址也加入飞书开发者后台：

```text
http://localhost:4173/oauth/callback
```

## systemd 部署

当前模板默认服务目录为：

```text
/data/program/background_coin-main
```

安装并启动系统级服务：

```bash
sudo cp deploy/guangnian-claim.service /etc/systemd/system/guangnian-claim.service
sudo systemctl daemon-reload
sudo systemctl enable --now guangnian-claim
sudo systemctl status guangnian-claim
```

无 sudo 时可以使用用户级 systemd：

```bash
mkdir -p ~/.config/systemd/user
cp deploy/guangnian-claim.user.service ~/.config/systemd/user/guangnian-claim.service
systemctl --user daemon-reload
systemctl --user enable --now guangnian-claim
loginctl enable-linger $USER
```

查看日志：

```bash
journalctl --user -u guangnian-claim -f
```

## Nginx 反向代理

HTTP 模板：

```bash
sudo cp deploy/nginx-guangnian-claim.conf /etc/nginx/sites-available/guangnian-claim.conf
sudo ln -sf /etc/nginx/sites-available/guangnian-claim.conf /etc/nginx/sites-enabled/guangnian-claim.conf
sudo nginx -t
sudo systemctl reload nginx
```

HTTPS 模板：

```bash
sudo cp deploy/nginx-guangnian-claim.https.conf /etc/nginx/sites-available/guangnian-claim.conf
sudo ln -sf /etc/nginx/sites-available/guangnian-claim.conf /etc/nginx/sites-enabled/guangnian-claim.conf
sudo nginx -t
sudo systemctl reload nginx
```

HTTPS 证书路径需要与 `deploy/nginx-guangnian-claim.https.conf` 中的配置一致。

## 安全说明

- 只有飞书登录且在白名单表中的用户可以访问业务接口。
- 会话 Cookie 使用 `SESSION_SECRET` 签名，后端会校验是否被篡改。
- 生产环境建议只通过 `PUBLIC_ORIGIN` 访问，避免跨域 Cookie 滥用。
- 图片 OCR 接口限制请求体大小和图片大小，避免超大图片占用过多内存。
- 白名单用户提交后会自动写入 `已确认` 和 `是`，不再等待管理员审批。
- `package.json` 使用 `overrides` 固定 `axios` 到修复版本，避免飞书 SDK 间接依赖旧版本造成安全审计失败。

## 验证命令

```bash
npm test
npm start
curl -i http://127.0.0.1:4173/
curl -i http://127.0.0.1:4173/api/me
npm audit --audit-level=high
```

上线前应确认 `npm audit --audit-level=high` 输出 `found 0 vulnerabilities`。如果后续升级飞书 SDK，需要重新检查 `package.json` 中的依赖覆盖规则是否仍然生效。
