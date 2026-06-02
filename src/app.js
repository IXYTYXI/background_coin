const state = {
  tasks: [],
  selections: {},
  lastSubmission: null,
  pendingSubmission: null,
  currentPage: 'form'
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

const formPage = document.querySelector('#formPage');
const statusPage = document.querySelector('#statusPage');
const peopleInput = document.querySelector('#peopleInput');
const form = document.querySelector('#claimForm');
const amountInput = document.querySelector('#amountInput');
const taskSelect = document.querySelector('#taskSelect');
const formMessage = document.querySelector('#formMessage');
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

async function request(path, options) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
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

function showToast(title, body) {
  toastTitle.textContent = title;
  toastBody.textContent = body;
  toast.hidden = false;
  toastCloseBtn.focus();
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
    return;
  }
  taskSelect.innerHTML = state.tasks
    .map((task) => `<option value="${escapeHtml(task)}">${escapeHtml(task)}</option>`)
    .join('');
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
  const isForm = page === 'form';
  formPage.hidden = !isForm;
  statusPage.hidden = isForm;
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
      ? '申请已进入多维表格流程，等待管理员确认后处理。'
      : '申请没有提交成功，请返回检查后重试。';

  statusBadge.textContent = isPending ? '提交中' : isSuccess ? '已提交' : '提交失败';
  statusBadge.className = `success-badge ${isPending ? 'pending' : isError ? 'error' : ''}`.trim();

  successTitle.textContent = isPending ? '正在提交申请' : isSuccess ? '你的领取申请已提交' : '申请提交失败';
  successBody.textContent = isPending
    ? '请不要关闭页面。'
    : isSuccess
      ? '你的申请已经进入审批流程，接下来请等待管理员确认。'
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
      setMessage(`申请已提交，共 ${payload.count} 人，等待管理员确认`, 'ok');
    } else {
      setMessage('申请已提交，等待管理员确认', 'ok');
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
