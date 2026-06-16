export function callbackVerificationToken(payload) {
  return String(
    payload?.token ||
    payload?.event?.token ||
    payload?.header?.token ||
    ''
  );
}

export function isEncryptedCallbackPayload(payload) {
  return typeof payload?.encrypt === 'string' && payload.encrypt.length > 0;
}

export function assertCallbackVerificationToken(payload, expectedToken) {
  if (!expectedToken) return;
  if (callbackVerificationToken(payload) === expectedToken) return;

  const error = new Error('飞书回调 token 校验失败');
  error.statusCode = 401;
  throw error;
}
