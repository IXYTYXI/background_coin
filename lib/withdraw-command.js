function normalizeName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

export function parseWithdrawCommand(text) {
  const normalized = normalizeName(text).replace(/^@\S+\s*/u, '');
  if (!normalized) return null;
  if (/^(帮助|help|支取帮助)$/iu.test(normalized)) return { help: true };

  const match = normalized.match(/^支取\s+(.+?)\s+(\d+)\s*$/u);
  if (!match) {
    if (normalized.startsWith('支取')) return { error: '支取格式不正确，请发送：支取 姓名 数量' };
    return null;
  }

  const amount = Number(match[2]);
  if (!Number.isInteger(amount) || amount <= 0) return { error: '支取数量只能填写正整数' };
  return {
    name: normalizeName(match[1]),
    amount
  };
}
