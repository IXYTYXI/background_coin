import assert from 'node:assert/strict';
import test from 'node:test';
import { parseImageRecords } from '../lib/ocr-parser.js';

const tasks = [
  '任务1｜活动分享',
  '任务2｜知识库投稿',
  '任务3｜建设性意见',
  '任务4｜活动志愿者',
  '任务5｜内部培训分享',
  '任务6｜内推',
  '任务7｜部门子任务'
];

test('parses table OCR cells without treating task names as people', () => {
  const text = [
    '10',
    '202606',
    '刘云澈',
    '产品团队',
    '任务1 活动分享',
    '5',
    '202606',
    '刘云澈',
    '产品团队',
    '任务1 活动分享',
    '20',
    '202606',
    '朱晶',
    '课程团队',
    '任务7 部门子任务',
    '20',
    '202606',
    '王莹',
    '课程团队',
    '任务7 部门子任务',
    '20',
    '202606',
    '卢静洁',
    '课程团队',
    '任务7 部门子任务'
  ].join('\n');

  assert.deepEqual(parseImageRecords(text, tasks).map(({ name, task, amount }) => ({ name, task, amount })), [
    { name: '刘云澈', task: '任务1｜活动分享', amount: 10 },
    { name: '刘云澈', task: '任务1｜活动分享', amount: 5 },
    { name: '朱晶', task: '任务7｜部门子任务', amount: 20 },
    { name: '王莹', task: '任务7｜部门子任务', amount: 20 },
    { name: '卢静洁', task: '任务7｜部门子任务', amount: 20 }
  ]);
});

test('does not parse task and amount fragments as a person row', () => {
  const text = [
    '活动分享 1',
    '部门子任务 20'
  ].join('\n');

  assert.deepEqual(parseImageRecords(text, tasks), []);
});

test('keeps amounts inside each task-terminated OCR segment', () => {
  const text = [
    '10',
    '刘云澈',
    '产品团队',
    '202606',
    '任务1|活动分享',
    '5',
    '刘云澈',
    '产品团队',
    '202606',
    '任务1|活动分享',
    '20',
    '刘云澈洋葱学园',
    '未晶',
    '课程团队中园',
    '202606',
    '任务7|部门子任务',
    '刘云澈 注心',
    '王垚',
    '20',
    '课程团队',
    '202606',
    '任务7|部门子任务',
    '20',
    '卢静洁',
    '课程团队',
    '202606',
    '任务7|部门子任务'
  ].join('\n');

  assert.deepEqual(parseImageRecords(text, tasks).map(({ name, task, amount }) => ({ name, task, amount })), [
    { name: '刘云澈', task: '任务1｜活动分享', amount: 10 },
    { name: '刘云澈', task: '任务1｜活动分享', amount: 5 },
    { name: '未晶', task: '任务7｜部门子任务', amount: 20 },
    { name: '王垚', task: '任务7｜部门子任务', amount: 20 },
    { name: '卢静洁', task: '任务7｜部门子任务', amount: 20 }
  ]);
});
