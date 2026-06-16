# 光年币领取系统

这是一个可部署的 Node.js 单服务应用。用户通过飞书 OAuth 登录后，系统会校验其是否在前端白名单表中；白名单用户可以手动提交或通过图片批量上传光年币领取记录，后端会直接写入多维表格并自动确认入账。

## 当前能力

- 飞书 OAuth 登录。
- 前端白名单校验。
- 白名单用户自动确认入账。
- 支持单人/多人手动领取。
- 支持图片 OCR 批量识别，最多一次提交 20 条。
- 入账后只通知每个被入账人，卡片包含本次增加和当前完整余额。
- 管理员可和“光年币助手”私聊发起支取，确认后扣减余额并通知被支取人。
- 管理员也可直接在支取表新增支取记录；服务会轮询支取表并通知被支取人。
- 支持 systemd + Nginx 轻量部署。

## 运行要求

- Node.js 18+
- 飞书企业自建应用
- 飞书应用需要具备以下能力：
  - 获取用户身份或网页 OAuth 登录
  - 多维表格读写
  - 读取已绑定 open_id 的通讯录用户
  - 发送消息
  - 接收机器人私聊消息事件
  - 处理交互卡片回调
  - OCR 图片识别
- 飞书应用需要被安装到企业，并且对目标多维表格有访问权限。

## 多维表格要求

系统默认使用四张业务表：

- 流水表：记录每次光年币领取。
- 账户表：维护人员账户和人员字段。
- 支取表：记录每次从账户余额中支取的光年币。
- 前端白名单表：维护允许访问领取页面的飞书人员。

前端白名单表至少需要一个“人员”字段，并把字段 ID 配置到 `WHITELIST_PERSON_FIELD`。
账户表里的可领取/可支取人员必须提前绑定“人员”字段；服务不再通过姓名自动搜索通讯录创建账户。

支取表已创建在当前 Base 中：

```text
光年币支取表：tblP1pNflMJGHDgf
```

账户表“当前余额”公式已调整为：已确认领取合计减去支取记录合计。支取不新增负数领取流水。

## 环境变量

先复制示例文件：

```bash
cp .env.example .env
```

`.env` 示例：

```bash
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxx
BASE_TOKEN=KrVRbjTKOatunlslgHlcdPyindc
LEDGER_TABLE=tbl88pkryfLsRNNk
ACCOUNT_TABLE=tblcvlBAmioZD4CJ
WITHDRAW_TABLE=tblP1pNflMJGHDgf
WHITELIST_TABLE=tbleU3I3ejRn3sTj
WHITELIST_PERSON_FIELD=fldqSinMmy
ADMIN_USER_ID=ou_0666dc75244dd56bbbad486f995caf1f
PUBLIC_ORIGIN=https://guangnianbi.yc345.tv
SESSION_SECRET=请填写32位以上随机字符串
PORT=19001
```

说明：

- `PUBLIC_ORIGIN` 必须是用户实际访问的 HTTPS 地址。
- 飞书开发者后台的 OAuth 重定向 URL 必须配置为：`PUBLIC_ORIGIN/oauth/callback`。
- 飞书开放平台事件订阅方式默认使用长连接，订阅 `im.message.receive_v1`；如果改为 HTTP 事件订阅，URL 为 `PUBLIC_ORIGIN/lark/events`。
- 飞书开放平台卡片回调 URL：`PUBLIC_ORIGIN/lark/card-action`。
- 卡片回调可启用验签/加密，并把后台的 Verification Token / Encrypt Key 写入 `LARK_VERIFICATION_TOKEN` / `LARK_ENCRYPT_KEY`。
- 消息事件 `/lark/events` 当前不要开启事件加密；如需开启，需要先补事件解密适配。
- `LARK_WS_EVENTS_ENABLED=true` 时服务会启动飞书长连接事件客户端；同一应用多实例部署时，同一条事件只会随机推给其中一个实例。
- `SESSION_SECRET` 用于签名 Cookie，不能使用示例值。
- `ADMIN_USER_ID` 当前为芮婷在“光年币助手”应用视角下的 open_id，只有该 open_id 能发起和确认支取。
- `WHITELIST_TABLE` 为空或字段 ID 错误时，所有业务接口都会无法通过白名单校验。

## 支取方式

管理员和“光年币助手”私聊：

```text
支取 刘云澈 10
```

机器人会返回确认卡片，点击“确认支取”后才会写入支取表并扣减账户余额。余额不足会直接拒绝，不写入支取表。

管理员也可以直接在“光年币支取表”新增记录，至少填写：

```text
支取人、账户、支取数量
```

服务会轮询支取表；如果支取后余额为负，会删除这条支取记录，等价于拒绝。成功支取只通知被支取人。
直接改支取表时，代码无法从记录本身识别修改人；请在 Base 权限里把支取表编辑权限限制给芮婷和“光年币助手”应用。
如果改用 Base 自动化回调，回调地址为 `PUBLIC_ORIGIN/lark/withdraw-table-event`，请求体需包含 `record_id` 和 `token`，`token` 对应 `WITHDRAW_WEBHOOK_TOKEN`；未单独配置时默认使用 `SESSION_SECRET`。

## 飞书应用配置清单

- 应用名称：光年币助手。
- App ID：`cli_aaba740b6939dbb7`。
- 应用头像：使用用户提供的蓝色卡通洋葱货币图案。
- OAuth 重定向 URL：`https://guangnianbi.yc345.tv/oauth/callback`。
- 事件订阅：使用长连接接收事件，订阅 `im.message.receive_v1`；如切 HTTP，URL 为 `https://guangnianbi.yc345.tv/lark/events`，不要开启事件加密。
- 卡片回调 URL：`https://guangnianbi.yc345.tv/lark/card-action`。
- 应用可见范围至少覆盖：芮婷、前端授权名单用户、账户表所有可能被入账/支取人员。
- 把应用加入目标多维表格协作者，并给编辑权限。
- 建议权限：OAuth 用户身份、Base 读写、通讯录基础读取、机器人发送消息、`im:message.p2p_msg:readonly`、OCR 图片识别。

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
- 支取不走前端白名单，只认管理员 `ADMIN_USER_ID`。
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
