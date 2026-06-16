export function withdrawDigest(withdraw) {
  const accountId = withdraw?.account?.id || withdraw?.accountId || '';
  const userId = withdraw?.account?.userId || withdraw?.userId || withdraw?.person || '';
  const amount = withdraw?.amount ?? '';
  return [accountId, userId, amount].join('|');
}
