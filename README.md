# 光年币领取系统

这是一个基于 Node.js 的飞书多维表格领取申请服务。用户在网页填写人员、数量和任务后，服务会通过企业自建应用调用 Feishu OpenAPI，把申请写入多维表格，并支持管理员确认或驳回。

## 运行要求

- Node.js 18+
- 飞书企业自建应用
- 应用需要具备多维表格读写、搜索用户、读取通讯录用户、发送消息等权限
- 应用需要被安装到企业，并对目标多维表格有访问权限

## 环境变量

```bash
export FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
export FEISHU_APP_SECRET=xxxxxxxxxxxxxxxx
export PORT=4173
```

`FEISHU_APP_ID` 默认值为代码中的历史 App ID；生产环境建议显式设置。`FEISHU_APP_SECRET` 必填。

## 本地启动

```bash
npm install
npm start
```

启动后访问：

```text
http://localhost:4173
```

## 部署说明

生产环境建议使用 Nginx 或其他网关提供对外访问，并反向代理到 `PORT` 指定的 Node 后端端口。当前模板对外监听 `19001` 的 HTTPS，Node 后端默认监听 `4173`。

### systemd 部署

先创建 `.env`：

```bash
cp .env.example .env
vim .env
```

把 `FEISHU_APP_SECRET` 改成飞书开放平台里企业自建应用的 `App Secret`。

`.env` 中建议设置 `PORT=19001`，由 Node 直接对外提供页面和 API。

安装并启动 systemd 服务（系统级，需要 sudo）：

```bash
sudo cp deploy/guangnian-claim.service /etc/systemd/system/guangnian-claim.service
sudo systemctl daemon-reload
sudo systemctl enable --now guangnian-claim
sudo systemctl status guangnian-claim
```

无 sudo 时，可使用用户级 systemd（当前机器已按此方式部署）：

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

### Nginx 前端与反向代理

项目提供了两个 Nginx 配置模板：

- `deploy/nginx-guangnian-claim.conf`：HTTP，监听 `80`，转发到 Node 的 `19001`
- `deploy/nginx-guangnian-claim.https.conf`：HTTPS，监听 `443`，转发到 Node 的 `19001`

当前 Node 服务由 systemd 监听 `19001`，Nginx 只负责域名和 HTTPS。

HTTP 配置安装：

```bash
sudo cp deploy/nginx-guangnian-claim.conf /etc/nginx/sites-available/guangnian-claim.conf
sudo ln -sf /etc/nginx/sites-available/guangnian-claim.conf /etc/nginx/sites-enabled/guangnian-claim.conf
sudo nginx -t
sudo systemctl reload nginx
```

访问地址：

```text
http://guangnianbi.yc345.tv
```

### HTTPS 配置

当前域名 `guangnianbi.yc345.tv` 解析到内网 IP `10.8.8.68`，公网 CA 通常无法通过 HTTP challenge 访问该地址。推荐使用 DNS challenge：

```bash
sudo certbot certonly --manual --preferred-challenges dns -d guangnianbi.yc345.tv
```

Certbot 会提示添加一条 TXT 记录，主机记录一般是：

```text
_acme-challenge.guangnianbi
```

TXT 生效后再按 Enter。可以用以下命令确认：

```bash
dig +short _acme-challenge.guangnianbi.yc345.tv TXT
```

证书生成后，HTTPS 模板使用以下证书路径：

```text
/etc/letsencrypt/live/guangnianbi.yc345.tv/fullchain.pem
/etc/letsencrypt/live/guangnianbi.yc345.tv/privkey.pem
```

安装 HTTPS 配置：

```bash
sudo cp deploy/nginx-guangnian-claim.https.conf /etc/nginx/sites-available/guangnian-claim.conf
sudo ln -sf /etc/nginx/sites-available/guangnian-claim.conf /etc/nginx/sites-enabled/guangnian-claim.conf
sudo nginx -t
sudo systemctl reload nginx
```

HTTPS 访问地址：

```text
https://guangnianbi.yc345.tv
```

普通网页审批入口为：

```text
https://guangnianbi.yc345.tv/review?action=confirm&serial=流水号
https://guangnianbi.yc345.tv/review?action=reject&serial=流水号
```

## 备注

当前版本直接通过 `@larksuiteoapi/node-sdk` 访问 Feishu OpenAPI，不再依赖 `lark-cli` 或本机登录态，适合服务器长期运行。
