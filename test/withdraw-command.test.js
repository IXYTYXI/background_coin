import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWithdrawCommand } from '../lib/withdraw-command.js';

test('parses administrator withdraw command', () => {
  assert.deepEqual(parseWithdrawCommand('支取 刘云澈 10'), {
    name: '刘云澈',
    amount: 10
  });
});

test('parses withdraw command with extra whitespace and mention prefix', () => {
  assert.deepEqual(parseWithdrawCommand('@光年币助手   支取   刘云澈   3  '), {
    name: '刘云澈',
    amount: 3
  });
});

test('rejects malformed withdraw commands without matching unrelated text', () => {
  assert.deepEqual(parseWithdrawCommand('帮助'), { help: true });
  assert.equal(parseWithdrawCommand('你好'), null);
  assert.deepEqual(parseWithdrawCommand('支取 刘云澈 0'), {
    error: '支取数量只能填写正整数'
  });
  assert.deepEqual(parseWithdrawCommand('支取 刘云澈 十'), {
    error: '支取格式不正确，请发送：支取 姓名 数量'
  });
});
