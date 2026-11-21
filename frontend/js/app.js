/* ==========================================================
   AI 陪伴对话 · 前端逻辑
   - 选性格 → 起名字 → 进入对话（人设配置 localStorage 持久化）
   - axios 对接 FastAPI 后端，SSE 流式解析
   - 多会话管理 / Markdown 渲染 / 复制 / 重新生成
   ========================================================== */
(function () {
  'use strict';

  /* ---------- 配置 ---------- */
  // 后端地址：默认本机 8000 端口。部署到其他环境时，在 index.html 里先声明
  // window.__API_BASE__ = 'https://your-domain.com' 即可覆盖，无需改动本文件。
  const API_BASE = (window.__API_BASE__ || 'http://127.0.0.1:8000').replace(/\/+$/, '');
  const STORAGE_KEY = 'chat.conversations.v1';
  const MODEL_KEY = 'chat.model.v1';
  const CONFIG_KEY = 'chat.config.v1';
  const USER_KEY = 'chat.user.v1';
  const CURRENT_ID_KEY = 'chat.currentId.v1';
  const MAX_TITLE_LEN = 18;

  // 按用户生成独立的存储 key，避免不同账号串数据
  function userStorageKey(base) {
    return currentUser ? base + '.u' + currentUser.id : base;
  }

  /* ---------- 内置性格（后端 /api/personas 拉取失败时兜底） ----------
     head  / card：真人风图片路径（文心一格生成后放入 frontend/assets/）
     图片未到位时，前端自动回退到 emoji + 渐变，不影响功能 */
  const ASSETS = 'assets';
  const FALLBACK_PERSONAS = [
    { id: 'gentle', name: '温柔', emoji: '🌸', tagline: '轻声细语 · 眼里都是你', description: '体贴入微，说话软软的，永远站在你这边。', accent: ['#ff9eb5', '#ff6fa5'], head: ASSETS + '/head_gentle.png', card: ASSETS + '/card_gentle.png' },
    { id: 'hot',    name: '暴躁', emoji: '🔥', tagline: '嘴硬心软 · 凶你是爱你', description: '动不动就炸毛，其实心里全是担心你。', accent: ['#ff7a59', '#ff5f5f'], head: ASSETS + '/head_hot.png',   card: ASSETS + '/card_hot.png'   },
    { id: 'sharp',  name: '犀利', emoji: '⚡', tagline: '一针见血 · 吐槽拉满',   description: '毒舌又聪明，怼你怼得你哑口无言还觉得爽。', accent: ['#7ad7ff', '#4a8dff'], head: ASSETS + '/head_sharp.png', card: ASSETS + '/card_sharp.png' },
    { id: 'sweet',  name: '甜美', emoji: '🍓', tagline: '甜度超标 · 天天撒娇',   description: '撒娇卖萌小甜心，会缠着你撒娇要亲亲抱抱。', accent: ['#ffd08a', '#ff7ab8'], head: ASSETS + '/head_sweet.png', card: ASSETS + '/card_sweet.png' },
    { id: 'cool',   name: '高冷', emoji: '🧊', tagline: '惜字如金 · 傲娇得很',   description: '又冷又傲娇，表面爱答不理，心里其实很在意。', accent: ['#9fb4ff', '#6b7cff'], head: ASSETS + '/head_cool.png',  card: ASSETS + '/card_cool.png'  },
  ];

  const DEFAULT_NAMES = { gentle: '小柔', hot: '辣妹', sharp: '小刀', sweet: '小甜', cool: '小冷' };
  const NAME_POOL = ['小柔', '晚晚', '晓晓', '诺诺', '嘉嘉', '依依', '小野', '绫绫', '楠楠', '瞳瞳', '乖乖', '小艾', '铃铃', '眠眠', '甜甜', '一一'];

  const GREETINGS = {
    gentle: ['宝贝你来啦～今天过得怎么样呀？', '想我了吗？我一直在等你呢 (*^▽^*)'],
    hot: ['来了？又这么久不回消息，烦死了！！', '喂，干嘛去了？再不回我消息我真的生气了！'],
    sharp: ['哟，舍得来找我了？', '说吧，找我什么事，我听听有多离谱。'],
    sweet: ['哥哥！！你终于来找我啦！', '宝贝宝贝，我超想你的！你都不想我吗！'],
    cool: ['……你来啦。', '嗯，等你半天了。'],
  };

  const STARTERS = ['今天过得怎么样？', '在忙什么呀，想你了', '周末要不要一起出去玩？', '讲个笑话哄我开心'];

  /* ---------- DOM 快捷引用 ---------- */
  const $ = (sel, el) => (el || document).querySelector(sel);
  const els = {
    // 设定页
    setupScreen: $('#setupScreen'),
    chatApp: $('#chatApp'),
    personaGrid: $('#personaGrid'),
    nameStep: $('#nameStep'),
    nameInput: $('#nameInput'),
    btnDice: $('#btnDice'),
    btnStartChat: $('#btnStartChat'),
    namePreview: $('#namePreview'),
    dot1: $('#dot1'),
    dot2: $('#dot2'),
    // 聊天
    list: $('#conversationList'),
    btnNewChat: $('#btnNewChat'),
    btnNewChatLabel: $('#btnNewChatLabel'),
    btnClearChat: $('#btnClearChat'),
    btnReconfigure: $('#btnReconfigure'),
    modelSelect: $('#modelSelect'),
    statusDot: $('#statusDot'),
    statusText: $('#statusText'),
    gfChip: $('#gfChip'),
    chatTitle: $('#chatTitle'),
    chatSubtitle: $('#chatSubtitle'),
    chatScroll: $('#chatScroll'),
    messages: $('#messages'),
    inputBox: $('#inputBox'),
    btnSend: $('#btnSend'),
    btnStop: $('#btnStop'),
    // 认证
    authScreen: $('#authScreen'),
    loginForm: $('#loginForm'),
    registerForm: $('#registerForm'),
    loginMsg: $('#loginMsg'),
    regMsg: $('#regMsg'),
    btnLogin: $('#btnLogin'),
    btnRegister: $('#btnRegister'),
    btnSkipAuth: $('#btnSkipAuth'),
    userNameDisplay: $('#userNameDisplay'),
    btnLogout: $('#btnLogout'),
    // 侧边栏女友切换
    personaSelect: $('#personaSelect'),
    gfNameInput: $('#gfNameInput'),
    btnApplyGf: $('#btnApplyGf'),
    gfSwitchEmoji: $('#gfSwitchEmoji'),
  };

  /* ---------- 状态 ---------- */
  const state = {
    conversations: loadConversations(),
    currentId: null,
    config: loadConfig(),
    personas: FALLBACK_PERSONAS,
    streaming: false,
    abortController: null,
    streamEl: null,        // 正在流式渲染的 assistant 消息节点
    streamText: '',
    streamReasoning: '',
    streamError: '',
  };
  let selectedPersonaId = state.config ? state.config.personaId : null;

  /* ---------- 用户认证状态 ---------- */
  function loadUser() {
    try {
      const raw = JSON.parse(localStorage.getItem(USER_KEY));
      return (raw && raw.id) ? raw : null;
    } catch (e) { return null; }
  }

  function saveUser(user) {
    try { localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch (e) { /* 忽略 */ }
  }

  function clearUser() {
    try { localStorage.removeItem(USER_KEY); } catch (e) { /* 忽略 */ }
  }

  let currentUser = loadUser();   // { id, username } | null

  /* 切换用户时清理旧用户的内存状态 */
  function switchUser(user) {
    if (currentUser && user && currentUser.id === user.id) return;
    currentUser = user;
    if (user) {
      saveUser(user);
      // 加载新用户的本地数据
      state.conversations = loadConversations();
      state.config = loadConfig();
      selectedPersonaId = state.config ? state.config.personaId : null;
    } else {
      clearUser();
      state.conversations = [];
      state.config = null;
      selectedPersonaId = null;
    }
    updateUserDisplay();
  }

  /* ==========================================================
     工具函数
     ========================================================== */
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function esc(str) {
    const div = document.createElement('div');
    div.textContent = String(str == null ? '' : str);
    return div.innerHTML;
  }

  function loadConversations() {
    try {
      const raw = JSON.parse(localStorage.getItem(userStorageKey(STORAGE_KEY)));
      return Array.isArray(raw) ? raw : [];
    } catch (e) { return []; }
  }

  function saveConversations() {
    try { localStorage.setItem(userStorageKey(STORAGE_KEY), JSON.stringify(state.conversations)); } catch (e) { /* 忽略 */ }
  }

  function getConversation(id) {
    return state.conversations.find((c) => c.id === id);
  }

  function currentConversation() {
    return getConversation(state.currentId);
  }

  function loadConfig() {
    try {
      const raw = JSON.parse(localStorage.getItem(userStorageKey(CONFIG_KEY)));
      if (raw && raw.personaId) return raw;
    } catch (e) { /* 忽略 */ }
    return null;
  }

  function saveConfig() {
    try { localStorage.setItem(userStorageKey(CONFIG_KEY), JSON.stringify(state.config)); } catch (e) { /* 忽略 */ }
  }

  /* ---------- 当前女友 ---------- */
  function getPersona() {
    return state.personas.find((p) => p.id === (state.config && state.config.personaId))
      || state.personas[0];
  }

  /* 头像/卡片图就绪检查：未加载成功则返回空（走 emoji 兜底） */
  function personaHeadImg(p) {
    if (p && p.head) return p.head;
    return '';
  }
  function personaCardImg(p) {
    if (p && p.card) return p.card;
    return '';
  }

  function gfName() {
    const n = state.config && state.config.name;
    return (n && n.trim()) ? n.trim() : getPersona().name;
  }

  function gfGradient(p) {
    p = p || getPersona();
    return 'linear-gradient(135deg, ' + (p.accent[0] || '#ff6fa5') + ', ' + (p.accent[1] || p.accent[0] || '#9b6bff') + ')';
  }

  function defaultTitle() {
    return '和 ' + gfName() + ' 的对话';
  }

  /* ==========================================================
     Markdown 渲染
     ========================================================== */
  function renderMarkdown(text) {
    const source = String(text || '');
    if (window.marked) {
      window.marked.setOptions({ breaks: true, gfm: true });
      const html = window.marked.parse(source);
      if (window.DOMPurify) return window.DOMPurify.sanitize(html);
      return html;
    }
    // 降级：纯文本 + 换行
    return '<div class="plain-text">' + esc(source).replace(/\n/g, '<br>') + '</div>';
  }

  function applyHighlight(container) {
    if (!window.hljs || !container) return;
    container.querySelectorAll('pre code:not(.hljs)').forEach((block) => {
      try { window.hljs.highlightElement(block); } catch (e) { /* 忽略 */ }
    });
  }

  /* ==========================================================
     消息 DOM 构建
     ========================================================== */
  function appendUserMessage(content, msg) {
    const wrap = document.createElement('div');
    wrap.className = 'msg user';
    wrap.innerHTML =
      '<div class="avatar me">我</div>' +
      '<div class="msg-body">' +
        '<div class="msg-name">我</div>' +
        '<div class="msg-bubble"><div class="msg-content"></div></div>' +
      '</div>';
    wrap.querySelector('.msg-content').innerHTML = renderMarkdown(content);
    if (msg) wrap._msg = msg;
    els.messages.appendChild(wrap);
    return wrap;
  }

  function appendAssistantMessage({ content, reasoning, error, typing, showRegen }, msg) {
    const persona = getPersona();
    const wrap = document.createElement('div');
    wrap.className = 'msg assistant';

    let inner =
      '<div class="avatar ai" style="background:' + gfGradient(persona) + '">' +
        (personaHeadImg(persona)
          ? '<img class="avatar-img" src="' + esc(personaHeadImg(persona)) + '" alt="' + esc(gfName()) + '" onerror="this.style.display=\'none\'">'
          : '') +
        '<span class="avatar-emoji">' + persona.emoji + '</span>' +
      '</div>' +
      '<div class="msg-body">' +
        '<div class="msg-name">' + esc(gfName()) + '</div>' +
        '<div class="msg-bubble">';

    if (reasoning) {
      inner +=
        '<div class="reasoning-wrap open">' +
          '<button class="reasoning-toggle"><span class="chevron">▶</span> 思考过程</button>' +
          '<div class="reasoning-body"><div class="reasoning-content">' +
            esc(reasoning) +
          '</div></div>' +
        '</div>';
    }

    if (error) {
      inner += '<p class="msg-error">⚠️ ' + esc(error) + '</p>';
    } else {
      // 始终保留 .msg-content，流式更新直接往里面写；打字动画只是它的临时内容
      inner += '<div class="msg-content">' +
        (typing ? '<div class="typing"><span></span><span></span><span></span></div>' : '') +
        '</div>';
    }

    inner +=
      '</div>' +
      '<div class="msg-tools">' +
        '<button class="tool-btn" data-action="copy">📋 复制</button>' +
        '<button class="tool-btn" data-action="regenerate">↻ 重新生成</button>' +
      '</div>' +
      '</div>';

    wrap.innerHTML = inner;

    // 填充内容
    if (!typing && !error) {
      wrap.querySelector('.msg-content').innerHTML = renderMarkdown(content);
      applyHighlight(wrap);
    }

    // 重新生成按钮：默认隐藏，仅对最后一条 assistant 消息显示
    const regenBtn = wrap.querySelector('[data-action="regenerate"]');
    if (!showRegen) regenBtn.classList.add('hidden');

    if (msg) wrap._msg = msg;
    els.messages.appendChild(wrap);
    return wrap;
  }

  function renderMessages() {
    const conv = currentConversation();
    els.messages.innerHTML = '';
    if (!conv || !conv.messages.length) {
      renderWelcome();
      return;
    }
    conv.messages.forEach((m, i) => {
      if (m.role === 'user') appendUserMessage(m.content, m);
      else appendAssistantMessage({
        content: m.content,
        reasoning: m.reasoning,
        error: m.error,
        showRegen: i === conv.messages.length - 1,
      }, m);
    });
    applyHighlight(els.messages);
    requestAnimationFrame(() => scrollToBottom(false));
  }

  /* 空对话时：她的问候 + 聊天话题 */
  function renderWelcome() {
    const persona = getPersona();
    const greetList = GREETINGS[persona.id] || ['你来啦～'];
    const greet = greetList[Math.floor(Math.random() * greetList.length)];

    els.messages.innerHTML =
      '<div class="welcome">' +
        '<div class="welcome-avatar" style="background:' + gfGradient(persona) + '">' +
          (personaHeadImg(persona)
            ? '<img class="avatar-img" src="' + esc(personaHeadImg(persona)) + '" alt="' + esc(gfName()) + '" onerror="this.style.display=\'none\'">'
            : '') +
          '<span class="avatar-emoji">' + persona.emoji + '</span>' +
        '</div>' +
        '<h2>' + esc(gfName()) + '</h2>' +
        '<p class="welcome-tag">' + esc(persona.tagline) + '</p>' +
        '<p class="welcome-greet">' + esc(greet) + '</p>' +
        '<div class="starters">' +
          STARTERS.map((s) => '<button class="starter-chip" data-q="' + esc(s) + '">' + esc(s) + '</button>').join('') +
        '</div>' +
      '</div>';

    // 点击话题直接发送
    els.messages.querySelectorAll('.starter-chip').forEach((chip) => {
      chip.addEventListener('click', () => submit(chip.dataset.q));
    });
  }

  /* ==========================================================
     滚动
     ========================================================== */
  function scrollToBottom(smooth) {
    els.chatScroll.scrollTo({
      top: els.chatScroll.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto',
    });
  }

  /* ==========================================================
     侧边栏
     ========================================================== */
  function renderSidebar() {
    els.list.innerHTML = '';
    if (!state.conversations.length) {
      els.list.innerHTML = '<div class="conv-empty">暂无历史对话</div>';
      return;
    }
    state.conversations.forEach((conv) => {
      const item = document.createElement('div');
      item.className = 'conv-item' + (conv.id === state.currentId ? ' active' : '');
      item.dataset.id = conv.id;

      const label = document.createElement('div');
      label.className = 'conv-label';
      label.textContent = conv.title || '新对话';

      const del = document.createElement('button');
      del.className = 'conv-del';
      del.title = '删除对话';
      del.innerHTML = '✕';

      item.appendChild(label);
      item.appendChild(del);
      els.list.appendChild(item);
    });
  }

  function switchConversation(id) {
    if (state.streaming) stopGeneration();
    state.currentId = id;
    try { localStorage.setItem(userStorageKey(CURRENT_ID_KEY), id); } catch (e) { /* 忽略 */ }
    const conv = getConversation(id);
    els.chatTitle.textContent = (conv && conv.title) || defaultTitle();
    renderSidebar();
    renderMessages();
  }

  function newChat() {
    if (state.streaming) stopGeneration();
    const conv = { id: uid(), title: '', createdAt: Date.now(), messages: [] };
    state.conversations.unshift(conv);
    saveConversations();
    switchConversation(conv.id);
    els.inputBox.focus();
  }

  function deleteConversation(id) {
    state.conversations = state.conversations.filter((c) => c.id !== id);
    saveConversations();
    deleteCloudConversation(id);
    if (state.currentId === id) {
      const next = state.conversations[0];
      state.currentId = next ? next.id : null;
    }
    renderSidebar();
    renderMessages();
  }

  /* 点击侧边栏：切换 / 删除 */
  els.list.addEventListener('click', (e) => {
    const delBtn = e.target.closest('.conv-del');
    const item = e.target.closest('.conv-item');
    if (!item) return;
    if (delBtn) {
      deleteConversation(item.dataset.id);
      return;
    }
    if (item.dataset.id !== state.currentId) {
      switchConversation(item.dataset.id);
    }
  });

  els.btnNewChat.addEventListener('click', newChat);
  els.btnClearChat.addEventListener('click', () => {
    const conv = currentConversation();
    if (!conv) return;
    conv.messages = [];
    conv.title = '';
    saveConversations();
    els.chatTitle.textContent = defaultTitle();
    renderSidebar();
    renderMessages();
    els.inputBox.focus();
  });

  /* ==========================================================
     设定女友页
     ========================================================== */
  function renderPersonaGrid() {
    els.personaGrid.innerHTML = state.personas.map((p) => {
      const cardImg = p.card && p.card.length > 0 ? p.card : '';
      // 图片未就绪/加载失败时，img 自隐藏，露出 emoji 兜底
      return '<div class="persona-card' + (p.id === selectedPersonaId ? ' selected' : '') + '"' +
        ' data-id="' + p.id + '"' +
        ' style="--card-accent:' + (p.accent[0] || '#ff6fa5') + '">' +
        '<div class="persona-photo" style="background:' + gfGradient(p) + '">' +
          (cardImg
            ? '<img class="photo-img" src="' + esc(cardImg) + '" alt="' + esc(p.name) + '" ' +
              'onerror="this.style.display=\'none\'" loading="lazy">'
            : '') +
          '<span class="photo-emoji">' + p.emoji + '</span>' +
        '</div>' +
        '<div class="persona-name">' + esc(p.name) + '</div>' +
        '<div class="persona-tag">' + esc(p.tagline) + '</div>' +
        '<div class="persona-desc">' + esc(p.description) + '</div>' +
        '<div class="persona-check">♥</div>' +
      '</div>';
    }).join('');
  }

  els.personaGrid.addEventListener('click', (e) => {
    const card = e.target.closest('.persona-card');
    if (!card) return;
    selectPersona(card.dataset.id);
  });

  function selectPersona(id) {
    selectedPersonaId = id;
    const p = state.personas.find((x) => x.id === id);
    if (!p) return;
    renderPersonaGrid();
    // 第一次选性格时，若还没输入名字，预填一个对应的默认名
    if (!els.nameInput.value.trim()) {
      els.nameInput.value = DEFAULT_NAMES[id] || '';
    }
    els.nameStep.classList.remove('hidden');
    els.dot1.classList.remove('active');
    els.dot2.classList.add('active');
    updateNamePreview();
    els.nameInput.focus();
  }

  els.btnDice.addEventListener('click', () => {
    els.nameInput.value = NAME_POOL[Math.floor(Math.random() * NAME_POOL.length)];
    updateNamePreview();
    els.nameInput.focus();
  });

  els.nameInput.addEventListener('input', updateNamePreview);

  els.nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      startChat();
    }
  });

  function updateNamePreview() {
    const p = state.personas.find((x) => x.id === selectedPersonaId);
    if (!p) return;
    const n = els.nameInput.value.trim();
    els.namePreview.textContent = n
      ? p.emoji + ' ' + n + ' · ' + p.name + ' 的她'
      : '给「' + p.name + '」的她起个名字吧';
  }

  els.btnStartChat.addEventListener('click', startChat);

  function startChat() {
    const p = state.personas.find((x) => x.id === selectedPersonaId);
    if (!p) return;
    const name = els.nameInput.value.trim() || DEFAULT_NAMES[p.id] || p.name;
    state.config = { personaId: p.id, name: name };
    saveConfig();
    els.setupScreen.classList.add('hidden');
    startChatApp(true);   // 换人/首次设定后开启全新对话
  }

  els.btnReconfigure.addEventListener('click', () => {
    if (state.streaming) stopGeneration();
    selectedPersonaId = state.config ? state.config.personaId : null;
    els.nameInput.value = state.config ? state.config.name : '';
    renderPersonaGrid();
    els.nameStep.classList.remove('hidden');
    els.dot2.classList.add('active');
    els.dot1.classList.remove('active');
    updateNamePreview();
    els.setupScreen.classList.remove('hidden');
  });

  /* 侧边栏女友切换 */
  els.btnApplyGf.addEventListener('click', async () => {
    if (state.streaming) stopGeneration();
    const newPersonaId = els.personaSelect.value;
    const newName = els.gfNameInput.value.trim();
    if (!newName) {
      els.gfNameInput.focus();
      return;
    }
    const p = state.personas.find((x) => x.id === newPersonaId);
    if (!p) return;

    // 更新配置
    state.config = { personaId: newPersonaId, name: newName };
    selectedPersonaId = newPersonaId;
    saveConfig();

    // 刷新 UI
    applyConfigToUI();

    // 重新加载该女友的云端对话
    state.conversations = [];
    if (currentUser) {
      await loadCloudConversations();
    }
    // 如果没有历史对话，建一个新的；否则打开第一个
    if (state.conversations.length === 0) {
      newChat();
    } else {
      const first = state.conversations[0];
      switchConversation(first.id);
    }
    saveConversations();
    els.inputBox.focus();
  });

  // 性格下拉变化时更新 emoji
  els.personaSelect.addEventListener('change', () => {
    const p = state.personas.find((x) => x.id === els.personaSelect.value);
    if (p) {
      els.gfSwitchEmoji.textContent = p.emoji;
      els.gfSwitchEmoji.style.background = gfGradient(p);
    }
  });

  /* ==========================================================
     聊天应用启动
     ========================================================== */
  async function startChatApp(fresh) {
    els.chatApp.classList.remove('hidden');
    applyConfigToUI();
    // 已登录时加载云端对话
    if (currentUser) {
      await loadCloudConversations();
    }
    if (fresh) {
      newChat();
    } else {
      // 恢复上次会话（优先打开最近一次）
      const last = state.conversations.find((c) => c.id === (localStorage.getItem(userStorageKey(CURRENT_ID_KEY)) || ''))
        || state.conversations[0];
      if (last) state.currentId = last.id;
      renderSidebar();
      renderMessages();
    }
    els.inputBox.focus();
  }

  function applyConfigToUI() {
    const p = getPersona();
    // 把她的专属颜色写进全局变量，按钮/输入框/欢迎页都跟随
    document.documentElement.style.setProperty('--accent-0', p.accent[0] || '#ff6fa5');
    document.documentElement.style.setProperty('--accent-1', p.accent[1] || p.accent[0] || '#9b6bff');
    els.chatTitle.textContent = defaultTitle();
    els.chatSubtitle.textContent = '性格：' + p.name + ' · DeepSeek 驱动 · 流式输出';
    els.btnNewChatLabel.textContent = '和 ' + gfName() + ' 聊天';
    els.personaSelect.value = p.id;
    els.gfNameInput.value = gfName();
    els.gfSwitchEmoji.textContent = p.emoji;
    els.gfSwitchEmoji.style.background = gfGradient(p);
    updateUserDisplay();
  }

  function updateUserDisplay() {
    if (currentUser) {
      els.userNameDisplay.textContent = currentUser.username;
      els.btnLogout.style.display = '';
    } else {
      els.userNameDisplay.textContent = '未登录';
      els.btnLogout.style.display = 'none';
    }
  }

  /* ==========================================================
     认证 UI 与 API
     ========================================================== */
  function showAuth() {
    els.authScreen.classList.remove('hidden');
    els.setupScreen.classList.add('hidden');
    els.chatApp.classList.add('hidden');
    // 重置表单
    els.loginMsg.textContent = '';
    els.regMsg.textContent = '';
    els.loginForm.reset();
    els.registerForm.reset();
  }

  function hideAuth() {
    els.authScreen.classList.add('hidden');
  }

  // 登录/注册 tab 切换
  els.loginForm.querySelector('.auth-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.auth-tab');
    if (!tab) return;
    const target = tab.dataset.tab;
    if (target === 'register') {
      els.loginForm.classList.add('hidden');
      els.registerForm.classList.remove('hidden');
    } else {
      els.registerForm.classList.add('hidden');
      els.loginForm.classList.remove('hidden');
    }
  });

  els.registerForm.querySelector('.auth-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.auth-tab');
    if (!tab) return;
    const target = tab.dataset.tab;
    if (target === 'login') {
      els.registerForm.classList.add('hidden');
      els.loginForm.classList.remove('hidden');
    } else {
      els.loginForm.classList.add('hidden');
      els.registerForm.classList.remove('hidden');
    }
  });

  // 登录提交
  els.loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    els.loginMsg.textContent = '';
    els.loginMsg.className = 'auth-msg';
    const username = $('#loginUsername').value.trim();
    const password = $('#loginPassword').value;
    if (!username || !password) {
      els.loginMsg.textContent = '请填写用户名和密码。';
      return;
    }
    els.btnLogin.disabled = true;
    els.btnLogin.textContent = '登录中…';
    try {
      const res = await axios.post(API_BASE + '/api/login', { username, password }, { timeout: 10000 });
      if (res.data && res.data.ok) {
        switchUser(res.data.user);
        els.loginMsg.className = 'auth-msg ok';
        els.loginMsg.textContent = '登录成功！';
        setTimeout(() => proceedAfterAuth(), 600);
      }
    } catch (err) {
      const detail = (err.response && err.response.data && err.response.data.detail) ? err.response.data.detail : '网络错误，请检查后端是否启动。';
      els.loginMsg.textContent = detail;
    } finally {
      els.btnLogin.disabled = false;
      els.btnLogin.textContent = '💌 登录';
    }
  });

  // 注册提交
  els.registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    els.regMsg.textContent = '';
    els.regMsg.className = 'auth-msg';
    const username = $('#regUsername').value.trim();
    const password = $('#regPassword').value;
    const password2 = $('#regPassword2').value;
    if (!username || !password) {
      els.regMsg.textContent = '请填写用户名和密码。';
      return;
    }
    if (password !== password2) {
      els.regMsg.textContent = '两次密码不一致。';
      return;
    }
    els.btnRegister.disabled = true;
    els.btnRegister.textContent = '注册中…';
    try {
      const res = await axios.post(API_BASE + '/api/register', { username, password }, { timeout: 10000 });
      if (res.data && res.data.ok) {
        switchUser(res.data.user);
        els.regMsg.className = 'auth-msg ok';
        els.regMsg.textContent = '注册成功！';
        setTimeout(() => proceedAfterAuth(), 600);
      }
    } catch (err) {
      const detail = (err.response && err.response.data && err.response.data.detail) ? err.response.data.detail : '网络错误，请检查后端是否启动。';
      els.regMsg.textContent = detail;
    } finally {
      els.btnRegister.disabled = false;
      els.btnRegister.textContent = '💌 注册';
    }
  });

  // 跳过登录
  els.btnSkipAuth.addEventListener('click', () => {
    switchUser(null);
    proceedAfterAuth();
  });

  // 退出登录
  els.btnLogout.addEventListener('click', () => {
    if (state.streaming) stopGeneration();
    switchUser(null);
    saveConversations();
    showAuth();
  });

  async function proceedAfterAuth() {
    hideAuth();
    // 已登录：尝试从云端加载该用户的所有对话
    if (currentUser) {
      await loadCloudConversations();
    }
    // 判断是否已设定过女友
    if (state.config) {
      selectedPersonaId = state.config.personaId;
      els.setupScreen.classList.add('hidden');
      startChatApp(false);
    } else {
      showSetup();
    }
    checkHealth();
  }

  /* ==========================================================
     云端对话同步
     ========================================================== */
  async function syncConversation(conv) {
    if (!currentUser || !conv) return;
    const cfg = state.config;
    if (!cfg) return;
    try {
      await axios.post(API_BASE + '/api/conversations/save', {
        user_id: currentUser.id,
        conv_id: conv.id,
        persona_id: cfg.personaId,
        gf_name: cfg.name || getPersona().name,
        title: conv.title || defaultTitle(),
        messages: conv.messages.map((m) => ({
          role: m.role,
          content: m.content || '',
          reasoning: m.reasoning || '',
          error: m.error || '',
        })),
      }, { timeout: 10000 });
    } catch (e) { /* 后台静默同步失败不影响使用 */ }
  }

  async function loadCloudConversations() {
    if (!currentUser) return;
    const cfg = state.config;
    const gfName = cfg ? cfg.name : null;
    const personaId = cfg ? cfg.personaId : null;
    try {
      const params = { user_id: currentUser.id };
      if (gfName) params.gf_name = gfName;
      if (personaId) params.persona_id = personaId;
      const res = await axios.get(API_BASE + '/api/conversations', { params, timeout: 10000 });
      if (res.data && Array.isArray(res.data.conversations) && res.data.conversations.length) {
        // 将云端对话合并到本地（云端优先）
        const cloudConvs = res.data.conversations.map((c) => ({
          id: c.id,
          title: c.title,
          createdAt: new Date(c.created_at).getTime(),
          messages: c.messages.map((m) => ({
            role: m.role,
            content: m.content,
            reasoning: m.reasoning || undefined,
            error: m.error || undefined,
            ts: new Date(m.ts).getTime(),
          })),
        }));
        // 合并：云端有的覆盖本地，本地独有的保留
        const cloudIds = new Set(cloudConvs.map((c) => c.id));
        const localOnly = state.conversations.filter((c) => !cloudIds.has(c.id));
        state.conversations = [...cloudConvs, ...localOnly];
        saveConversations();
      }
    } catch (e) { /* 加载失败不影响本地使用 */ }
  }

  async function deleteCloudConversation(convId) {
    if (!currentUser) return;
    try {
      // 带上 user_id：后端会校验归属，避免仅凭 conv_id 就能删除他人对话
      await axios.delete(API_BASE + '/api/conversations/' + encodeURIComponent(convId), {
        params: { user_id: currentUser.id },
        timeout: 5000,
      });
    } catch (e) { /* 云端删除失败不影响本地已删除的结果 */ }
  }

  /* ==========================================================
     输入区
     ========================================================== */
  function autoGrow() {
    els.inputBox.style.height = 'auto';
    els.inputBox.style.height = Math.min(els.inputBox.scrollHeight, 160) + 'px';
  }

  els.inputBox.addEventListener('input', autoGrow);

  els.inputBox.addEventListener('keydown', (e) => {
    // e.isComposing：中文输入法选词时按下 Enter，不应发送
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      submit();
    }
  });

  els.btnSend.addEventListener('click', () => submit());

  function submit(text) {
    const content = (text || els.inputBox.value).trim();
    if (!content || state.streaming) return;
    els.inputBox.value = '';
    autoGrow();
    sendMessage(content);
  }

  /* ==========================================================
     发送消息 + 流式接收
     ========================================================== */
  function ensureConversation() {
    let conv = currentConversation();
    if (!conv) {
      conv = { id: uid(), title: '', createdAt: Date.now(), messages: [] };
      state.conversations.unshift(conv);
    }
    if (!conv.title) {
      const firstUser = conv.messages.find((m) => m.role === 'user');
      const base = firstUser ? firstUser.content : '';
      if (base) conv.title = base.length > MAX_TITLE_LEN ? base.slice(0, MAX_TITLE_LEN) + '…' : base;
    }
    return conv;
  }

  async function sendMessage(text) {
    const conv = ensureConversation();
    const userMsg = { role: 'user', content: text, ts: Date.now() };
    conv.messages.push(userMsg);
    saveConversations();
    renderSidebar();
    els.chatTitle.textContent = conv.title || defaultTitle();

    appendUserMessage(text, userMsg);
    scrollToBottom(true);

    // 流式占位
    const streamEl = appendAssistantMessage({ typing: true });
    const contentEl = streamEl.querySelector('.msg-content');
    let reasoningWrap = null;
    let reasoningContentEl = null;

    const showReasoning = () => {
      if (!reasoningWrap) {
        const bubble = streamEl.querySelector('.msg-bubble');
        const typingEl = bubble.querySelector('.typing');
        if (typingEl) typingEl.remove();
        reasoningWrap = document.createElement('div');
        reasoningWrap.className = 'reasoning-wrap open';
        reasoningWrap.innerHTML =
          '<button class="reasoning-toggle"><span class="chevron">▶</span> 思考过程</button>' +
          '<div class="reasoning-body"><div class="reasoning-content"></div></div>';
        bubble.insertBefore(reasoningWrap, bubble.querySelector('.msg-content'));
        reasoningContentEl = reasoningWrap.querySelector('.reasoning-content');
      }
    };

    const history = conv.messages.slice(0, -1)
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    state.streaming = true;
    state.streamEl = streamEl;
    state.abortController = new AbortController();
    setStreamingUI(true);

    let sseBuffer = '';
    let rafPending = false;

    const refresh = () => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        if (state.streamText) contentEl.innerHTML = renderMarkdown(state.streamText);
        scrollToBottom(false);   // 流式期间用即时滚动，避免动画堆积
      });
    };

    const handlePayload = (p) => {
      if (p.reasoning) {
        showReasoning();
        state.streamReasoning += p.reasoning;
        reasoningContentEl.textContent = state.streamReasoning;
      }
      if (p.delta) {
        if (state.streamText === '') {
          // 首次输出内容时移除打字动画
          const typingEl = streamEl.querySelector('.typing');
          if (typingEl) typingEl.remove();
        }
        state.streamText += p.delta;
        refresh();
      }
      if (p.error) {
        state.streamError = p.error;
      }
    };

    const parseSSE = (chunk) => {
      sseBuffer += chunk;
      let idx;
      while ((idx = sseBuffer.indexOf('\n\n')) !== -1) {
        const raw = sseBuffer.slice(0, idx);
        sseBuffer = sseBuffer.slice(idx + 2);
        raw.split('\n').forEach((line) => {
          if (!line.startsWith('data: ')) return;
          try { handlePayload(JSON.parse(line.slice(6))); } catch (e) { /* 忽略坏帧 */ }
        });
      }
    };

    try {
      await axios.post(
        API_BASE + '/api/chat',
        {
          messages: [...history, { role: 'user', content: text }],
          model: els.modelSelect.value,
          stream: true,
          persona: state.config ? state.config.personaId : null,
          girlfriend_name: gfName(),
        },
        {
          signal: state.abortController.signal,
          responseType: 'text',
          timeout: 600000,
          onDownloadProgress: (evt) => {
            // axios 1.x 的进度事件对象没有 currentTarget，原始 XHR 在 evt.event 里
            const raw = evt.event || evt;
            const xhr = raw && (raw.currentTarget || raw.target);
            const full = (xhr && xhr.responseText) || '';
            if (full.length > 0) parseSSE(full.slice(state._lastLen || 0));
            state._lastLen = full.length;
          },
        }
      );
    } catch (err) {
      if (axios.isCancel(err)) {
        // 用户主动停止，保留已生成的内容
      } else if (!err.response) {
        state.streamError = '无法连接后端服务，请确认后端已启动（在 backend 目录执行 uv run ai-chat-backend）。';
      } else {
        const detail = err.response.data && err.response.data.detail
          ? err.response.data.detail
          : err.response.statusText;
        state.streamError = '后端返回错误（' + err.response.status + '）：' + detail;
      }
    } finally {
      delete state._lastLen;
      finishStreaming(conv, streamEl, contentEl, reasoningWrap);
    }
  }

  function finishStreaming(conv, streamEl, contentEl, reasoningWrap) {
    // 移除打字动画
    const typingEl = streamEl.querySelector('.typing');
    if (typingEl) typingEl.remove();

    if (state.streamError) {
      contentEl.innerHTML = '<p class="msg-error">⚠️ ' + esc(state.streamError) + '</p>';
    } else {
      contentEl.innerHTML = renderMarkdown(state.streamText);
      applyHighlight(contentEl);
    }

    if (state.streamText || state.streamError) {
      const msg = {
        role: 'assistant',
        content: state.streamText,
        reasoning: state.streamReasoning || undefined,
        error: state.streamError || undefined,
        ts: Date.now(),
      };
      conv.messages.push(msg);
      streamEl._msg = msg;
      // 消息完成后显示「重新生成」按钮
      const regenBtn = streamEl.querySelector('[data-action="regenerate"]');
      if (regenBtn) regenBtn.classList.remove('hidden');
    }

    state.streaming = false;
    state.streamEl = null;
    state.streamText = '';
    state.streamReasoning = '';
    state.streamError = '';
    state.abortController = null;

    setStreamingUI(false);
    saveConversations();
    renderSidebar();
    scrollToBottom(true);
    els.inputBox.focus();

    // 云端同步（静默）
    syncConversation(conv);
  }

  /* 停止生成 */
  function stopGeneration() {
    if (state.abortController) state.abortController.abort();
  }

  /* ==========================================================
     流式状态 UI
     ========================================================== */
  function setStreamingUI(on) {
    if (on) {
      els.btnSend.classList.add('hidden');
      els.btnStop.classList.remove('hidden');
      els.btnNewChat.disabled = true;
      els.btnNewChat.style.opacity = 0.55;
    } else {
      els.btnSend.classList.remove('hidden');
      els.btnStop.classList.add('hidden');
      els.btnNewChat.disabled = false;
      els.btnNewChat.style.opacity = '';
    }
  }

  els.btnStop.addEventListener('click', stopGeneration);

  /* 思考过程折叠/展开（事件委托） */
  els.messages.addEventListener('click', (e) => {
    const toggle = e.target.closest('.reasoning-toggle');
    if (toggle) {
      const wrap = toggle.closest('.reasoning-wrap');
      if (wrap) wrap.classList.toggle('open');
    }
  });

  /* ==========================================================
     消息工具条：复制 / 重新生成
     ========================================================== */
  els.messages.addEventListener('click', (e) => {
    const btn = e.target.closest('.tool-btn');
    if (!btn) return;
    const msgEl = btn.closest('.msg');
    const action = btn.dataset.action;
    const conv = currentConversation();
    const msg = msgEl && msgEl._msg;
    if (!conv || !msg) return;

    if (action === 'copy') {
      copyText(msg.content, btn);
    } else if (action === 'regenerate') {
      regenerate(conv, msg);
    }
  });

  function copyText(text, btn) {
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta);
      flashCopied(btn);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => flashCopied(btn)).catch(fallback);
    } else {
      fallback();
    }
  }

  function flashCopied(btn) {
    const old = btn.textContent;
    btn.textContent = '✓ 已复制';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = old;
      btn.classList.remove('copied');
    }, 1500);
  }

  function regenerate(conv, msg) {
    const idx = conv.messages.indexOf(msg);
    if (idx === -1) return;
    // 找到该 assistant 消息之前的最后一条 user 消息
    const lastUser = conv.messages.slice(0, idx)
      .filter((m) => m.role === 'user').pop();
    if (!lastUser) return;
    // 删掉该 assistant 消息，重新请求
    conv.messages.splice(idx, 1);
    saveConversations();
    renderMessages();
    sendMessage(lastUser.content);
  }

  /* ==========================================================
     模型选择持久化
     ========================================================== */
  function initModel() {
    try {
      const saved = localStorage.getItem(userStorageKey(MODEL_KEY));
      if (saved) els.modelSelect.value = saved;
    } catch (e) { /* 忽略 */ }
    els.modelSelect.addEventListener('change', () => {
      try { localStorage.setItem(userStorageKey(MODEL_KEY), els.modelSelect.value); } catch (e) { /* 忽略 */ }
    });
  }

  /* ==========================================================
     后端健康检查 / 性格列表
     ========================================================== */
  function setStatus(mode, text) {
    els.statusDot.className = 'status-dot ' + mode + (mode === 'online' ? ' pulse' : '');
    els.statusText.textContent = text;
  }

  async function checkHealth() {
    try {
      const res = await axios.get(API_BASE + '/api/health', { timeout: 5000 });
      if (res.data && res.data.status === 'ok') {
        setStatus('online', '她已上线 · ' + (res.data.model || ''));
      } else {
        setStatus('warn', '后端响应异常');
      }
    } catch (e) {
      setStatus('offline', '她还没上线 · ' + API_BASE);
    }
  }

  async function loadPersonas() {
    try {
      const res = await axios.get(API_BASE + '/api/personas', { timeout: 5000 });
      if (res.data && Array.isArray(res.data.personas) && res.data.personas.length) {
        state.personas = res.data.personas.map((p) => ({
          ...p,
          accent: Array.isArray(p.accent) && p.accent.length
            ? [p.accent[0], p.accent[1] || p.accent[0]]
            : FALLBACK_PERSONAS[0].accent,
        }));
        // 当前配置指向的人设如果不存在，回退到第一个
        if (state.config && !state.personas.find((p) => p.id === state.config.personaId)) {
          state.config.personaId = state.personas[0].id;
        }
        // 设定页已经打开时，用后端数据重绘卡片
        if (!els.setupScreen.classList.contains('hidden')) {
          renderPersonaGrid();
          updateNamePreview();
        }
      }
    } catch (e) { /* 拉取失败时使用内置兜底列表 */ }
  }

  /* ==========================================================
     依赖检查（CDN 未加载时提示）
     ========================================================== */
  function checkDeps() {
    if (!window.axios || !window.marked) {
      const banner = document.createElement('div');
      banner.className = 'offline-banner';
      banner.textContent = '⚠️ 未能加载前端依赖（axios / marked），需要联网访问 CDN，请检查网络后刷新页面。';
      document.body.appendChild(banner);
    }
  }

  /* ==========================================================
     启动
     ========================================================== */
  function boot() {
    checkDeps();
    initModel();
    loadPersonas();
    updateUserDisplay();

    // 首先显示登录/注册页
    showAuth();

    // 后台检查后端健康
    checkHealth();
    setInterval(checkHealth, 30000);
  }

  function showSetup() {
    els.setupScreen.classList.remove('hidden');
    selectPersona(state.personas[0] ? state.personas[0].id : null);
  }

  boot();
})();
