import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'gn_session';

// 会话内容本身不加密，只做 base64url 编码，方便服务端无状态解析。
// 真实的防篡改能力来自后面的 HMAC 签名；客户端即使能看到 payload，也不能伪造签名。
function toBase64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

// 将 base64url 编码的 JSON payload 还原为对象。
// 解析失败会在 decodeSession 中被捕获，并统一视为无效会话。
function fromBase64UrlJson(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

// 使用 SESSION_SECRET 对 payload 签名。
// 这里选 HMAC-SHA256：部署简单、无需额外依赖，也适合单服务轻量部署。
function sign(value, secret) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

// 比较签名时使用 timingSafeEqual，避免普通字符串比较带来的时序侧信道。
// 长度不同的签名不能直接传给 timingSafeEqual，所以先做长度判断。
function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

// 解析 Cookie 请求头。Node 原生 http 模块不会帮我们解析 Cookie，
// 这个项目为了保持轻量部署，没有引入 Express/cookie-parser。
export function parseCookieHeader(cookieHeader = '') {
  return Object.fromEntries(
    String(cookieHeader || '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        if (index < 0) return [part, ''];
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

// 把会话对象编码成 payload.signature 格式。
// 注意：调用方必须设置足够随机的 SESSION_SECRET，否则签名没有实际安全意义。
export function encodeSession(session, secret) {
  if (!secret) throw new Error('缺少 SESSION_SECRET，请设置后重启服务');
  const payload = toBase64UrlJson(session);
  return `${payload}.${sign(payload, secret)}`;
}

// 解析并校验签名后的会话值。
// 返回 null 表示未登录、Cookie 被篡改、签名密钥不匹配、JSON 损坏或会话已过期。
export function decodeSession(value, secret) {
  if (!secret || !value) return null;
  const [payload, signature] = String(value).split('.');
  if (!payload || !signature || !constantTimeEqual(signature, sign(payload, secret))) return null;
  try {
    const session = fromBase64UrlJson(payload);
    if (!session?.openId || Number(session.expiresAt || 0) <= Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

// 生成浏览器 Set-Cookie 头。
// 生产 HTTPS 环境应传 secure=true；本地 http 调试时 secure=false 才能正常写入 Cookie。
export function createSessionCookie({ session, secret, secure = false, maxAgeSeconds = 604800 }) {
  const value = encodeURIComponent(encodeSession(session, secret));
  const securePart = secure ? '; Secure' : '';
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${securePart}`;
}

// 从请求 Cookie 里读取并校验当前登录会话。
// 这个函数只负责校验“用户是谁”；是否在白名单里由 server.js 单独查询多维表格。
export function readSessionCookie({ cookieHeader, secret }) {
  const cookies = parseCookieHeader(cookieHeader);
  return decodeSession(cookies[SESSION_COOKIE], secret);
}

// 登出或 OAuth 失败时使用，让浏览器立即清理已有会话。
export function serializeExpiredSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
