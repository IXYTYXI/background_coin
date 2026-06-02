const state = {
  tasks: [],
  selections: {},
  lastSubmission: null,
  pendingSubmission: null,
  currentPage: 'gate',
  batchRows: [],
  me: null
};

const FALLBACK_TASKS = [
  '任务1｜新视界分享',
  '任务2｜建设性意见',
  '任务3｜部门子任务｜策略名称脑暴',
  '任务3｜部门子任务｜大团建活动支持',
  '任务3｜部门子任务｜岗中全员训',
  '任务3｜部门子任务｜季度积分',
  '任务3｜部门子任务｜捐书',
  '任务3｜部门子任务｜面试官培训',
  '任务3｜部门子任务｜启动会工作人员',
  '任务3｜部门子任务｜启动会志愿者',
  '任务3｜部门子任务｜暑促启动会分享',
  '任务3｜部门子任务｜暑期经验分享',
  '任务3｜部门子任务｜暑期TOP问答会',
  '任务3｜部门子任务｜数据中台BI分享',
  '任务3｜部门子任务｜体验营管理训优秀学员分享',
  '任务3｜部门子任务｜突发召集令-活动志愿者',
  '任务3｜部门子任务｜为退款挽单提出有效建议',
  '任务3｜部门子任务｜未分类',
  '任务3｜部门子任务｜武汉冲顶启动会主持人',
  '任务3｜部门子任务｜武汉年会工作人员',
  '任务3｜部门子任务｜武汉招聘项目期招聘激励',
  '任务3｜部门子任务｜新兵营奖励',
  '任务3｜部门子任务｜长沙年会志愿者',
  '任务3｜部门子任务｜知识竞赛活动支撑',
  '任务3｜部门子任务｜TOP赋能课',
  '任务4｜活动建议与志愿者',
  '任务5｜知识库投稿/分享',
  '任务6｜内部培训分享',
  '任务7｜用户洞察有效提报/思考',
  '任务8｜服务之星',
  '任务9｜内推',
  '任务10｜赛季打卡',
  '任务11｜技术部落文档分享/分享会',
  '任务12｜部门内部分享',
  '任务13｜半年度复盘'
];

const gatePage = document.querySelector('#gatePage');
const gateTitle = document.querySelector('#gateTitle');
const gateCopy = document.querySelector('#gateCopy');
const gateMessage = document.querySelector('#gateMessage');
const loginLink = document.querySelector('#loginLink');
const formPage = document.querySelector('#formPage');
const statusPage = document.querySelector('#statusPage');
const manualClaimPanel = document.querySelector('#manualClaimPanel');
const peopleInput = document.querySelector('#peopleInput');
const form = document.querySelector('#claimForm');
const amountInput = document.querySelector('#amountInput');
const taskSelect = document.querySelector('#taskSelect');
const formMessage = document.querySelector('#formMessage');
const imageInput = document.querySelector('#imageInput');
const pasteZone = document.querySelector('#pasteZone');
const batchMessage = document.querySelector('#batchMessage');
const batchEditor = document.querySelector('#batchEditor');
const selectionPanel = document.querySelector('#selectionPanel');
const backBtn = document.querySelector('#backBtn');
const statusHeading = document.querySelector('#statusHeading');
const statusCopy = document.querySelector('#statusCopy');
const statusBadge = document.querySelector('#statusBadge');
const successTitle = document.querySelector('#successTitle');
const successBody = document.querySelector('#successBody');
const successPeople = document.querySelector('#successPeople');
const successAmount = document.querySelector('#successAmount');
const successTask = document.querySelector('#successTask');
const successSerial = document.querySelector('#successSerial');
const toast = document.querySelector('#toast');
const toastTitle = document.querySelector('#toastTitle');
const toastBody = document.querySelector('#toastBody');
const toastCloseBtn = document.querySelector('#toastCloseBtn');
const API_BASE = window.location.protocol === 'file:'
  ? 'http://localhost:4173'
  : '';
const query = new URLSearchParams(window.location.search);

async function request(path, options) {
  // 生产部署走同源 API，由 Nginx 把请求反向代理给 Node 后端。
  // credentials: 'include' 用于携带后端签名 Cookie，会话校验只在后端完成。
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    ...options
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error || '请求失败');
    error.payload = payload;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function setMessage(text, type = '') {
  formMessage.textContent = text;
  formMessage.className = `message ${type}`.trim();
}

function setBatchMessage(text, type = '') {
  batchMessage.textContent = text;
  batchMessage.className = `message ${type}`.trim();
}

function showToast(title, body) {
  toastTitle.textContent = title;
  toastBody.textContent = body;
  toast.hidden = false;
  toastCloseBtn.focus();
}

function rowKey(index) {
  return `row:${index + 1}`;
}

function ensureBatchKeys(rows = []) {
  return rows.map((row, index) => ({
    key: row.key || rowKey(index),
    ...row
  }));
}

function syncManualClaimVisibility() {
  manualClaimPanel.hidden = state.batchRows.length > 0;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}

function taskOptionsHtml(selectedTask) {
  return '<option value="">请选择任务</option>' + state.tasks
    .map((task) => `<option value="${escapeHtml(task)}" ${task === selectedTask ? 'selected' : ''}>${escapeHtml(task)}</option>`)
    .join('');
}

function renderBatchEditor() {
  if (!state.batchRows.length) {
    batchEditor.hidden = true;
    batchEditor.innerHTML = '';
    syncManualClaimVisibility();
    return;
  }

  batchEditor.hidden = false;
  syncManualClaimVisibility();
  batchEditor.innerHTML = `
    <div class="batch-toolbar">
      <p>识别到 ${state.batchRows.length} 条，请确认后提交。</p>
      <button id="clearBatchBtn" class="text-button" type="button">清空</button>
    </div>
    <div class="batch-table-wrap">
      <table class="batch-table">
        <thead>
          <tr>
            <th>人员</th>
            <th>任务</th>
            <th>数量</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${state.batchRows.map((row, index) => `
            <tr data-index="${index}">
              <td><input class="batch-name" value="${escapeHtml(row.name)}" aria-label="人员姓名" /></td>
              <td>
                <select class="batch-task" aria-label="任务">
                  ${taskOptionsHtml(row.task)}
                </select>
                ${row.rawTask && !row.task ? `<small class="batch-warning">未匹配：${escapeHtml(row.rawTask)}</small>` : ''}
              </td>
              <td><input class="batch-amount" type="number" min="1" step="1" value="${escapeHtml(row.amount)}" aria-label="领取数量" /></td>
              <td><button class="row-remove" type="button" aria-label="删除此行">删除</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    <button id="submitBatchBtn" class="primary" type="button">提交批量申请</button>
  `;
}

function syncBatchRowsFromDom() {
  state.batchRows = Array.from(batchEditor.querySelectorAll('tbody tr')).map((row) => {
    const index = Number(row.dataset.index);
    return {
      key: state.batchRows[index]?.key || rowKey(index),
      name: row.querySelector('.batch-name').value.trim(),
      task: row.querySelector('.batch-task').value,
      amount: Number(row.querySelector('.batch-amount').value),
      rawTask: state.batchRows[index]?.rawTask || ''
    };
  });
}

async function recognizeImageFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    showToast('图片格式不支持', '请上传或粘贴 png、jpg、jpeg、webp 图片。');
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    showToast('图片过大', '请上传 8MB 以内的图片。');
    return;
  }
  setBatchMessage('正在识别图片，请稍候。');
  try {
    const image = await fileToDataUrl(file);
    const payload = await request('/api/claim-image/recognize', {
      method: 'POST',
      body: JSON.stringify({ image })
    });
    state.batchRows = ensureBatchKeys((payload.records || []).slice(0, 20));
    renderBatchEditor();
    setBatchMessage(
      state.batchRows.length
        ? `已识别 ${state.batchRows.length} 条，请确认人员、任务和数量。`
        : '没有识别到有效记录，请换一张更清晰的表格截图。',
      state.batchRows.length ? 'ok' : 'error'
    );
  } catch (error) {
    setBatchMessage(error.message || '图片识别失败，请稍后重试。', 'error');
  } finally {
    imageInput.value = '';
  }
}

async function submitBatchRows() {
  syncBatchRowsFromDom();
  const invalidIndex = state.batchRows.findIndex((row) => !row.name || !row.task || !Number.isInteger(Number(row.amount)) || Number(row.amount) <= 0);
  if (invalidIndex >= 0) {
    setBatchMessage(`第 ${invalidIndex + 1} 行信息不完整，请补齐人员、任务和正整数数量。`, 'error');
    return;
  }
  const submission = {
    people: state.batchRows.map((row) => row.name).join('、'),
    amount: state.batchRows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
    task: `${state.batchRows.length} 条批量申请`
  };
  state.pendingSubmission = submission;
  setStatusPage('pending', { submission });
  try {
    const payload = await request('/api/claims', {
      method: 'POST',
      body: JSON.stringify({
        items: state.batchRows.map((row) => ({
          key: row.key,
          name: row.name,
          task: row.task,
          amount: Number(row.amount)
        })),
        selectedUsers: state.selections
      })
    });
    populateSuccess(payload, submission);
    clearSelections();
    state.batchRows = [];
    renderBatchEditor();
    setBatchMessage('');
  } catch (error) {
    showPage('form');
    if (error.status === 409 && error.payload?.selectionRequired) {
      renderSelectionPanel(error.payload.selectionRequired);
      setBatchMessage('存在重名人员，请选择对应人员后再次提交批量申请。', 'error');
    } else {
      setBatchMessage(friendlySubmitError(error), 'error');
    }
  }
}

function hideToast() {
  toast.hidden = true;
}

function friendlySubmitError(error) {
  const message = String((error && error.message) || '');
  if (
    message.includes('未匹配到通讯录') ||
    message.includes('未匹配到账户') ||
    message.includes('未找到人员账户') ||
    message.includes('未匹配到')
  ) {
    return '检索不到，请检查姓名是否正确，或联系管理员@芮婷。';
  }
  return message || '提交失败，请稍后重试，或联系管理员@芮婷。';
}

function renderTasks() {
  if (!state.tasks.length) {
    taskSelect.innerHTML = '<option value="">正在加载任务...</option>';
    renderBatchEditor();
    return;
  }
  taskSelect.innerHTML = state.tasks
    .map((task) => `<option value="${escapeHtml(task)}">${escapeHtml(task)}</option>`)
    .join('');
  renderBatchEditor();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function clearSelections() {
  state.selections = {};
  selectionPanel.hidden = true;
  selectionPanel.innerHTML = '';
}

function renderSelectionPanel(groups) {
  const nextSelections = {};
  selectionPanel.hidden = false;
  selectionPanel.innerHTML = groups.map((group) => `
    <section class="selection-group" data-name="${escapeHtml(group.name)}">
      <p class="selection-title">${escapeHtml(group.name)}</p>
      <div class="selection-options">
        ${group.options.map((option) => `
          <button class="choice" type="button" data-name="${escapeHtml(group.name)}" data-id="${escapeHtml(option.id)}">
            <span>${escapeHtml(option.name)}</span>
            <small>二级部门：${escapeHtml(option.department || '未显示部门')}</small>
            ${option.departmentPath ? `<small>完整部门：${escapeHtml(option.departmentPath)}</small>` : ''}
            ${option.email ? `<small>${escapeHtml(option.email)}</small>` : ''}
          </button>
        `).join('')}
      </div>
    </section>
  `).join('');

  groups.forEach((group) => {
    if (state.selections[group.name]) nextSelections[group.name] = state.selections[group.name];
  });
  state.selections = nextSelections;
  Object.entries(state.selections).forEach(([name, id]) => {
    const choice = Array.from(selectionPanel.querySelectorAll('.choice'))
      .find((item) => item.dataset.name === name && item.dataset.id === id);
    if (choice) choice.classList.add('selected');
  });
}

selectionPanel.addEventListener('click', (event) => {
  const choice = event.target.closest('.choice');
  if (!choice) return;
  const { name, id } = choice.dataset;
  state.selections[name] = id;
  const group = choice.closest('.selection-group');
  group.querySelectorAll('.choice').forEach((item) => item.classList.remove('selected'));
  choice.classList.add('selected');
});

function showPage(page) {
  state.currentPage = page;
  gatePage.hidden = page !== 'gate';
  formPage.hidden = page !== 'form';
  statusPage.hidden = page !== 'status';
}

function parsePeopleText(value) {
  return value
    .split(/[\n,，]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .join('、');
}

function setStatusPage(status, detail = {}) {
  const isPending = status === 'pending';
  const isSuccess = status === 'success';
  const isError = status === 'error';
  const submission = detail.submission || state.pendingSubmission || {};

  statusHeading.textContent = isPending ? '正在提交' : isSuccess ? '提交成功' : '提交失败';
  statusCopy.textContent = isPending
    ? '正在把申请写入多维表格，请稍候。'
    : isSuccess
      ? '申请已写入多维表格，光年币已自动入账。'
      : '申请没有提交成功，请返回检查后重试。';

  statusBadge.textContent = isPending ? '提交中' : isSuccess ? '已入账' : '提交失败';
  statusBadge.className = `success-badge ${isPending ? 'pending' : isError ? 'error' : ''}`.trim();

  successTitle.textContent = isPending ? '正在提交申请' : isSuccess ? '你的领取申请已入账' : '申请提交失败';
  successBody.textContent = isPending
    ? '请不要关闭页面。'
    : isSuccess
      ? '本次领取已经自动确认，相关人员会收到余额更新提醒。'
      : detail.message || '请检查姓名是否正确，或联系管理员@芮婷。';

  successPeople.textContent = submission.people || '-';
  successAmount.textContent = submission.amount ? String(submission.amount) : '-';
  successTask.textContent = submission.task || '-';
  successSerial.textContent = detail.serial || '-';
  backBtn.textContent = isSuccess ? '继续提交' : '返回填写';
  showPage('status');
  statusPage.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function populateSuccess(payload, submission) {
  const serial = (payload.serials && payload.serials[0]) || payload.serial || '';

  state.lastSubmission = {
    people: submission.people,
    amount: submission.amount,
    task: submission.task,
    serial
  };
  setStatusPage('success', { submission, serial });
}

async function load() {
  // 页面首次加载只做身份与白名单校验。
  // 只有 /api/me 返回 authorized=true 后，才展示领取表单和批量上传入口。
  showPage('gate');
  loginLink.hidden = true;
  gateTitle.textContent = '正在校验权限';
  gateCopy.textContent = '正在确认你的飞书身份和页面访问权限。';
  gateMessage.textContent = query.get('login') === 'failed'
    ? '飞书登录回调没有完成，请确认飞书开发者后台已配置当前回调地址。'
    : '请稍候。';

  try {
    const me = await request('/api/me');
    state.me = me;
    if (!me.authenticated) {
      gateTitle.textContent = '需要飞书登录';
      gateCopy.textContent = '请先使用飞书身份登录，系统会校验你是否在前端授权名单内。';
      gateMessage.textContent = query.get('login') === 'failed'
        ? `飞书登录失败。请确认开发者后台已添加重定向 URL：${me.oauthRedirectUri || '当前页面 /oauth/callback'}`
        : '登录后即可继续填写光年币领取信息。';
      loginLink.href = me.loginUrl || `${API_BASE}/oauth/start`;
      loginLink.hidden = false;
      return;
    }
    if (!me.authorized) {
      gateTitle.textContent = '暂无访问权限';
      gateCopy.textContent = '你的飞书账号暂未加入前端授权名单。';
      gateMessage.textContent = '请联系管理员 @芮婷 添加授权后再使用。';
      return;
    }
    showPage('form');
  } catch (error) {
    gateTitle.textContent = '权限校验失败';
    gateCopy.textContent = '暂时无法连接多维表格服务。';
    gateMessage.textContent = error.message || '请稍后重试，或联系管理员 @芮婷。';
    return;
  }

  renderTasks();
  try {
    const taskPayload = await request('/api/tasks');
    state.tasks = taskPayload.tasks && taskPayload.tasks.length ? taskPayload.tasks : FALLBACK_TASKS;
    renderTasks();
  } catch (error) {
    state.tasks = FALLBACK_TASKS;
    renderTasks();
    setMessage('任务列表已使用本地缓存；如需最新选项，请通过 http://localhost:4173 打开页面。', '');
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  setMessage('');
  try {
    const numericAmount = Number(amountInput.value);
    if (!Number.isInteger(numericAmount) || numericAmount <= 0) {
      throw new Error('领取数量只能填写正整数');
    }
    const selectedTask = taskSelect.value;
    if (!selectedTask) {
      showToast('任务未加载完成', '请稍等片刻后再提交；如果一直没有任务选项，请联系管理员@芮婷。');
      return;
    }

    const submission = {
      people: parsePeopleText(peopleInput.value),
      amount: numericAmount,
      task: selectedTask
    };
    state.pendingSubmission = submission;
    setStatusPage('pending', { submission });

    const payload = await request('/api/claims', {
      method: 'POST',
      body: JSON.stringify({
        people: peopleInput.value,
        amount: numericAmount,
        task: selectedTask,
        selectedUsers: state.selections
      })
    });

    if (payload.count > 1) {
      setMessage(`申请已自动入账，共 ${payload.count} 人`, 'ok');
    } else {
      setMessage('申请已自动入账', 'ok');
    }

    populateSuccess(payload, submission);
    clearSelections();
    form.reset();
    amountInput.value = '10';
    selectionPanel.hidden = true;
    load().catch(() => {});
  } catch (error) {
    if (error.status === 409 && error.payload && error.payload.selectionRequired) {
      showPage('form');
      renderSelectionPanel(error.payload.selectionRequired);
      setMessage('存在重名人员，请选择对应人员后再次提交', 'error');
      formPage.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      const friendlyMessage = friendlySubmitError(error);
      setMessage('');
      setStatusPage('error', {
        submission: state.pendingSubmission,
        message: friendlyMessage
      });
    }
  } finally {
    button.disabled = false;
  }
});

imageInput.addEventListener('change', () => {
  recognizeImageFile(imageInput.files && imageInput.files[0]);
});

pasteZone.addEventListener('paste', (event) => {
  const item = Array.from(event.clipboardData?.items || []).find((entry) => entry.type.startsWith('image/'));
  if (!item) {
    showToast('没有读取到截图', '请先复制图片或表格截图，再粘贴到上传区域。');
    return;
  }
  event.preventDefault();
  recognizeImageFile(item.getAsFile());
});

pasteZone.addEventListener('click', () => {
  pasteZone.focus();
});

batchEditor.addEventListener('input', (event) => {
  if (!event.target.matches('.batch-name, .batch-task, .batch-amount')) return;
  syncBatchRowsFromDom();
});

batchEditor.addEventListener('click', (event) => {
  if (event.target.id === 'clearBatchBtn') {
    state.batchRows = [];
    renderBatchEditor();
    setBatchMessage('');
    return;
  }
  if (event.target.id === 'submitBatchBtn') {
    submitBatchRows();
    return;
  }
  if (event.target.classList.contains('row-remove')) {
    syncBatchRowsFromDom();
    const row = event.target.closest('tr');
    state.batchRows.splice(Number(row.dataset.index), 1);
    renderBatchEditor();
    setBatchMessage(state.batchRows.length ? `剩余 ${state.batchRows.length} 条待提交。` : '');
  }
});

toastCloseBtn.addEventListener('click', hideToast);

toast.addEventListener('click', (event) => {
  if (event.target === toast) hideToast();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !toast.hidden) hideToast();
});

backBtn.addEventListener('click', () => {
  showPage('form');
  setMessage('');
  formPage.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

load();
