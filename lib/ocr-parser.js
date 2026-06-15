function normalizeName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function cleanOcrText(value) {
  return normalizeName(value)
    .replace(/[|｜]/gu, ' ')
    .replace(/[“”"'`]/gu, '')
    .trim();
}

function amountFromText(value) {
  const text = cleanOcrText(value).replace(/[,，]/gu, '');
  const match = text.match(/^(\d{1,5})(?:\s*(?:个|枚|币|光年币))?$/u)
    || text.match(/(?:^|[\s:：])(\d{1,5})(?:\s*(?:个|枚|币|光年币))?$/u)
    || text.match(/(\d{1,5})(?:\s*(?:个|枚|币|光年币))?\s*$/u);
  if (!match) return null;
  const amount = Number(match[1]);
  return Number.isInteger(amount) && amount > 0 ? amount : null;
}

function looksLikePersonName(value) {
  const text = cleanOcrText(value);
  if (!text || /\d/u.test(text) || /姓名|人员|任务|数量|部门|光年币/u.test(text)) return false;
  return /^[\u4e00-\u9fa5]{2,5}$/u.test(text) || /^[A-Za-z][A-Za-z .'-]{1,28}$/.test(text);
}

function looksLikeNoisyPersonName(value) {
  const text = cleanOcrText(value);
  if (!text || /姓名|人员|任务|数量|部门|团队|课程|光年币/u.test(text)) return false;
  const compact = text.replace(/[^A-Za-z\u4e00-\u9fa5]/gu, '');
  if (compact.length < 2 || compact.length > 8) return false;
  return /[\u4e00-\u9fa5]/u.test(compact) || /^[A-Za-z][A-Za-z .'-]{1,28}$/.test(text);
}

function isOcrTableNoise(value) {
  const text = cleanOcrText(value);
  if (!text) return true;
  if (/^\d+$/u.test(text)) return true;
  if (/^(?:20)?\d{4,6}$/u.test(text)) return true;
  return /姓名|人员|领取|数量|部门|团队|课程|光年币/u.test(text);
}

function looksLikePeriodText(value) {
  const text = cleanOcrText(value).replace(/\D/gu, '');
  if (!/^\d{4,6}$/u.test(text)) return false;
  const numeric = Number(text);
  return Number.isInteger(numeric) && numeric >= 1000;
}

function amountFromTableCell(value) {
  if (looksLikePeriodText(value)) return null;
  const amount = amountFromText(value);
  return amount && amount <= 999 ? amount : null;
}

function normalizeTaskText(value) {
  return cleanOcrText(value)
    .replace(/[｜|【】\[\]（）()<>《》「」『』:：,，.。·、/／\\_\-\s]/gu, '')
    .toLocaleLowerCase('zh-Hans-CN');
}

function taskLookupKeys(value) {
  const key = normalizeTaskText(value);
  if (!key || /^\d+$/u.test(key)) return [];
  const keys = [key];
  const withoutTrailingAmount = key.replace(/\d{1,5}$/u, '');
  if (
    withoutTrailingAmount &&
    withoutTrailingAmount !== key &&
    /[A-Za-z\u4e00-\u9fa5]/u.test(withoutTrailingAmount)
  ) {
    keys.push(withoutTrailingAmount);
  }
  return Array.from(new Set(keys.filter((item) => item.length >= 2)));
}

export function matchTaskName(value, tasks) {
  const keys = taskLookupKeys(value);
  if (!keys.length) return '';
  return tasks.find((task) => {
    const taskKey = normalizeTaskText(task);
    return keys.some((key) => taskKey === key || taskKey.includes(key) || key.includes(taskKey));
  }) || '';
}

function looksLikeTaskFragment(value, tasks = []) {
  const keys = taskLookupKeys(value);
  if (!keys.length) return false;
  if (keys.some((key) => /^任务\d+/u.test(key))) return true;
  return tasks.some((task) => {
    const taskKey = normalizeTaskText(task);
    if (!taskKey) return false;
    return keys.some((key) => taskKey === key || taskKey.includes(key) || key.includes(taskKey));
  });
}

function extractLeadingName(text) {
  const cleaned = cleanOcrText(text);
  const cnMatch = cleaned.match(/^([\u4e00-\u9fa5]{2,5})/u);
  if (cnMatch && looksLikePersonName(cnMatch[1])) return cnMatch[1];
  const enMatch = cleaned.match(/^([A-Za-z][A-Za-z .'-]{1,28})/u);
  if (enMatch && looksLikePersonName(enMatch[1].trim())) return enMatch[1].trim();
  return null;
}

function matchLongestTaskInText(text, tasks) {
  const keys = taskLookupKeys(text);
  if (!keys.length) return '';
  const sorted = [...tasks].sort((a, b) => normalizeTaskText(b).length - normalizeTaskText(a).length);
  return sorted.find((task) => {
    const taskKey = normalizeTaskText(task);
    return taskKey && keys.some((key) => key.includes(taskKey) || taskKey.includes(key));
  }) || '';
}

function parseGluedImageRow(row, tasks) {
  const amount = amountFromText(row);
  if (!amount) return null;
  const remainder = cleanOcrText(row).replace(/(\d{1,5})(?:\s*(?:个|枚|币|光年币))?\s*$/u, '').trim();
  const name = extractLeadingName(remainder);
  if (!name || looksLikeTaskFragment(name, tasks)) return null;
  const taskText = remainder.slice(name.length).trim();
  const task = matchTaskName(taskText, tasks) || matchLongestTaskInText(taskText, tasks);
  return {
    name,
    task: task || '',
    rawTask: task ? '' : taskText,
    amount,
    sourceText: row
  };
}

function parseImageRecordRow(row, tasks) {
  if (/姓名|人员|领取|数量|任务|部门/u.test(row) && !/\d/u.test(row)) return null;
  const parts = row.split(/\t+|\s{2,}|\s+/u).map(cleanOcrText).filter(Boolean);
  const name = parts.find((part) => looksLikePersonName(part) && !looksLikeTaskFragment(part, tasks));
  const amount = [...parts].reverse().map(amountFromText).find((value) => Number.isInteger(value));
  if (name && amount) {
    const taskCandidates = parts.filter((part) => part !== name && amountFromText(part) == null);
    const joinedTaskText = taskCandidates.join('');
    const task = taskCandidates.map((part) => matchTaskName(part, tasks)).find(Boolean)
      || matchLongestTaskInText(joinedTaskText, tasks)
      || '';
    return {
      name,
      task,
      rawTask: task ? '' : taskCandidates.join(' '),
      amount,
      sourceText: row
    };
  }
  return parseGluedImageRow(row, tasks);
}

function findSegmentAmount(segment, nameIndex) {
  const candidates = segment
    .map((value, index) => ({ index, amount: amountFromTableCell(value) }))
    .filter((item) => Number.isInteger(item.amount));
  if (!candidates.length) return null;
  if (nameIndex < 0) return candidates[0].amount;
  candidates.sort((left, right) => Math.abs(left.index - nameIndex) - Math.abs(right.index - nameIndex));
  return candidates[0].amount;
}

function findSegmentName(segment, tasks) {
  const candidates = segment
    .map((value, index) => ({ index, text: cleanOcrText(value) }))
    .filter(({ text }) => {
      if (!text || /\d/u.test(text)) return false;
      if (isOcrTableNoise(text)) return false;
      if (looksLikeTaskFragment(text, tasks)) return false;
      if (/洋葱|学园|注心/u.test(text)) return false;
      return looksLikePersonName(text) || looksLikeNoisyPersonName(text);
    });
  const strict = candidates.find(({ text }) => looksLikePersonName(text));
  return strict || candidates[0] || null;
}

function parseTaskTerminatedTableRecords(rows, tasks) {
  const records = [];
  let segmentStart = 0;
  for (let index = 0; index < rows.length && records.length < 20; index += 1) {
    const task = matchTaskName(rows[index], tasks) || matchLongestTaskInText(rows[index], tasks);
    if (!task && !/任务\s*\d+/u.test(rows[index])) continue;

    const segment = rows.slice(segmentStart, index + 1);
    segmentStart = index + 1;
    const nameCandidate = findSegmentName(segment, tasks);
    if (!nameCandidate) continue;
    const amount = findSegmentAmount(segment, nameCandidate.index);
    if (!amount) continue;

    records.push({
      name: nameCandidate.text,
      task: task || '',
      rawTask: task ? '' : rows[index],
      amount,
      sourceText: segment.join(' / ')
    });
  }
  return records;
}

function nearbyAmount(rows, index) {
  for (let offset = 1; offset <= 3; offset += 1) {
    const amount = amountFromTableCell(rows[index + offset]);
    if (amount) return amount;
  }
  for (let offset = 1; offset <= 4; offset += 1) {
    const amount = amountFromTableCell(rows[index - offset]);
    if (amount) return amount;
  }
  return null;
}

function nearbyName(rows, index, tasks = []) {
  for (let offset = 1; offset <= 4; offset += 1) {
    const candidate = rows[index - offset];
    const text = cleanOcrText(candidate);
    if (isOcrTableNoise(candidate)) continue;
    if (/\d/u.test(text)) continue;
    if (looksLikeTaskFragment(candidate, tasks)) continue;
    if (looksLikePersonName(candidate) || looksLikeNoisyPersonName(candidate)) return text;
  }
  return '';
}

function structuredTableRecord(rows, index, task, rawTask) {
  let name = '';
  let nameIndex = -1;
  for (let offset = 1; offset <= 4; offset += 1) {
    const candidate = rows[index - offset];
    const text = cleanOcrText(candidate);
    if (isOcrTableNoise(candidate)) continue;
    if (/\d/u.test(text)) continue;
    if (looksLikeTaskFragment(candidate, [task])) continue;
    if (looksLikePersonName(candidate) || looksLikeNoisyPersonName(candidate)) {
      name = text;
      nameIndex = index - offset;
      break;
    }
  }
  if (!name) return null;

  let amount = null;
  for (let periodIndex = nameIndex - 1; periodIndex >= Math.max(0, nameIndex - 3); periodIndex -= 1) {
    if (!looksLikePeriodText(rows[periodIndex])) continue;
    for (let amountIndex = periodIndex - 1; amountIndex >= Math.max(0, periodIndex - 2); amountIndex -= 1) {
      amount = amountFromTableCell(rows[amountIndex]);
      if (amount) break;
    }
    if (amount) break;
  }
  if (!amount) amount = nearbyAmount(rows, index);
  if (!amount) return null;

  return {
    name,
    task: task || '',
    rawTask: task ? '' : rawTask,
    amount,
    sourceText: rows.slice(Math.max(0, nameIndex - 2), Math.min(rows.length, index + 2)).join(' / ')
  };
}

function parseMultilineImageRecords(rows, tasks) {
  const records = [];
  for (let index = 0; index < rows.length && records.length < 20; index += 1) {
    const row = rows[index];
    const task = matchTaskName(row, tasks) || matchLongestTaskInText(row, tasks);
    const looksLikeTaskRow = task || /任务\s*\d+/u.test(row);
    if (!looksLikeTaskRow) continue;

    const structured = structuredTableRecord(rows, index, task, row);
    if (structured) {
      records.push(structured);
      continue;
    }

    const name = nearbyName(rows, index, tasks);
    const amount = nearbyAmount(rows, index);
    if (!name || !amount) continue;

    records.push({
      name,
      task: task || '',
      rawTask: task ? '' : row,
      amount,
      sourceText: rows.slice(Math.max(0, index - 4), Math.min(rows.length, index + 4)).join(' / ')
    });
  }
  return records;
}

export function parseImageRecords(text, tasks = []) {
  const rows = String(text || '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(cleanOcrText)
    .filter(Boolean);

  const taskTerminatedRecords = parseTaskTerminatedTableRecords(rows, tasks);
  if (taskTerminatedRecords.length) return taskTerminatedRecords;

  const multilineRecords = parseMultilineImageRecords(rows, tasks);
  if (multilineRecords.length) return multilineRecords;

  const records = [];
  for (const row of rows) {
    if (records.length >= 20) break;
    const record = parseImageRecordRow(row, tasks);
    if (record) records.push(record);
  }
  return records;
}
