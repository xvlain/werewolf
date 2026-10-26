/**
 * netgame.js — 联机对局交互层
 *
 * 与单机 ui.js 共用同一套 DOM 结构（座位环 / HUD / 信息栏 / 行动区），
 * 但数据源从本地 engine 切换为服务端 wr_room_state() 返回的状态。
 * 房主通过 wr_advance() 驱动状态机，非房主被动同步。
 */
(function () {
  'use strict';

  const ROLE_INFO = window.WW.UI.ROLE_INFO;
  const roleName = window.WW.UI.roleName;
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const el = (tag, cls, txt) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt !== undefined && txt !== null) n.textContent = txt;
    return n;
  };

  let rpc, roomCode, myClientId;
  let state = null;
  let pollTimer = null;
  let godView = false;

  // ---------- 渲染复用 ----------
  function seatEl(id) { return $('#seats .seat[data-id="' + id + '"]'); }

  function buildSeats() {
    const host = $('#seats');
    host.innerHTML = '';
    for (let i = 0; i < 12; i++) {
      const ang = (i / 12) * Math.PI * 2 - Math.PI / 2;
      const R = 42;
      const s = el('div', 'seat');
      s.dataset.id = String(i);
      s.style.left = (50 + R * Math.cos(ang)) + '%';
      s.style.top = (50 + R * Math.sin(ang)) + '%';
      s.appendChild(el('span', 'seat-no', String(i + 1)));
      s.appendChild(el('span', 'seat-name', ''));
      s.appendChild(el('span', 'seat-role', ''));
      s.appendChild(el('span', 'vote-count', '0'));
      host.appendChild(s);
    }
  }

  function renderState(st) {
    state = st;
    if (!st) return;

    // HUD
    const phaseNames = {
      election: '警长竞选', speech: '发言', vote: '投票',
      night: '夜晚', hunter_shot: '猎人开枪', over: '结算'
    };
    $('#hud-day').textContent = st.day > 0 ? '第 ' + st.day + ' 天' : '准备';
    $('#hud-phase').textContent = phaseNames[st.phase] || st.phase;
    $('#hud-phase').className = 'hud-chip ' + (st.phase === 'night' ? 'phase-night' : 'phase-day');
    const alive = (st.seats || []).filter(s => s.alive).length;
    $('#hud-alive').textContent = '存活 ' + alive + '/12';

    // 中央提示
    $('#center-phase').textContent = phaseNames[st.phase] || '';
    const hints = {
      election: '选择是否上警竞选警长',
      speech: '发言阶段',
      vote: '点击座位投票放逐',
      night: '天黑请闭眼',
      hunter_shot: '猎人请选择开枪目标',
      over: '游戏结束'
    };
    $('#center-hint').textContent = hints[st.phase] || '';
    $('#table').classList.toggle('night', st.phase === 'night');
    $('#table').classList.toggle('day', st.phase !== 'night');
    $('#night-veil').classList.toggle('on', st.phase === 'night');

    // 座位
    (st.seats || []).forEach(p => {
      const s = seatEl(p.seat);
      if (!s) return;
      s.querySelector('.seat-name').textContent = p.nick;
      s.classList.toggle('dead', !p.alive);
      s.classList.toggle('me', p.client_id === myClientId);
      s.classList.toggle('sheriff', (st.state || {}).sheriff === p.seat);
      // 身份可见：上帝观战 / 自己 / 已出局 / 狼人队友
      const mates = (st.my_info || {}).mates || [];
      const visible = godView || p.client_id === myClientId || !p.alive || mates.includes(p.seat);
      s.classList.toggle('show-role', visible);
      if (visible && st.my_role) {
        // 只有自己的身份是确切知道的；其他人的身份在上帝观战模式下需要服务端下发
        // v1 联机不下发他人身份，上帝观战仅显示自己 + 队友 + 死者翻牌
      }
    });

    // 我的身份面板
    if (st.my_role) {
      const info = ROLE_INFO[st.my_role];
      const node = $('#my-role');
      node.textContent = (info ? info.icon + ' ' : '') + roleName(st.my_role);
      node.className = 'my-role ' + (info ? info.faction : '');
      $('#my-role-desc').textContent = info ? info.desc : '';
    }

    // 情报栏
    const mi = st.my_info || {};
    const checks = mi.checks || [];
    $('#intel-checks').innerHTML = checks.length
      ? '<span class="k">查验：</span>' + checks.map(c =>
          `${c.target + 1}号 <span class="${c.result === 'evil' ? 'wolf' : 'safe'}">${c.result === 'evil' ? '查杀' : '金水'}</span>`
        ).join(' ')
      : '';
    const cw = (st.state || {}).confirmedWolves || [];
    $('#intel-wolves').innerHTML = cw.length
      ? '<span class="k">确认狼人：</span><span class="wolf">' + cw.map(i => (i + 1) + '号').join('、') + '</span>'
      : '';

    // 日志
    const logHost = $('#log-stream');
    const deaths = (st.state || {}).deaths || [];
    deaths.forEach(d => {
      if (!d._logged) {
        d._logged = true;
        const line = el('div', 'log-line death');
        line.innerHTML = `☠ ${d.seat + 1}号 死亡（${roleName(d.role)}）`;
        logHost.appendChild(line);
      }
    });
    const expelled = (st.state || {}).expelled;
    if (expelled !== null && expelled !== undefined && !st.state._expLogged) {
      st.state._expLogged = true;
      const line = el('div', 'log-line death');
      line.innerHTML = `⛓ ${expelled + 1}号 被放逐（${roleName(st.state.expelledRole)}）`;
      logHost.appendChild(line);
    }
    const flip = (st.state || {}).idiotFlipSeat;
    if (flip !== null && flip !== undefined && !st.state._flipLogged) {
      st.state._flipLogged = true;
      const line = el('div', 'log-line claim');
      line.innerHTML = `🃏 ${flip + 1}号 白痴翻牌免死！`;
      logHost.appendChild(line);
    }
    const hs = (st.state || {}).hunterShot;
    if (hs && !st.state._hsLogged) {
      st.state._hsLogged = true;
      const line = el('div', 'log-line death');
      line.innerHTML = hs.target !== null
        ? `🏹 ${hs.shooter + 1}号猎人开枪带走 ${hs.target + 1}号（${roleName(hs.targetRole)}）`
        : `🏹 ${hs.shooter + 1}号猎人未开枪`;
      logHost.appendChild(line);
    }
    logHost.scrollTop = logHost.scrollHeight;

    // 行动区
    renderActionBar(st);
  }

  function renderActionBar(st) {
    const title = $('#action-title');
    const body = $('#action-body');
    const btns = $('#action-buttons');
    title.textContent = '';
    body.innerHTML = '';
    btns.innerHTML = '';

    const mySeat = st.my_seat;
    const myRole = st.my_role;
    const isHost = st.is_host;
    const phase = st.phase;
    const mi = st.my_info || {};

    // 结算
    if (phase === 'over') {
      const w = (st.state || {}).winner;
      title.textContent = w === 'good' ? '好人阵营胜利' : (w === 'evil' ? '狼人阵营胜利' : '流局');
      body.innerHTML = (st.state || {}).reason || '';
      return;
    }

    // 非本人回合 / 非房主推进 → 等待
    if (!isHost && phase !== 'election' && phase !== 'vote' && phase !== 'hunter_shot') {
      title.textContent = '等待房主推进…';
      return;
    }

    // [election] 上警 / 投票
    if (phase === 'election') {
      const myCandidacy = /* check if already submitted */ false; // simplified
      title.textContent = '警长竞选';
      body.innerHTML = '是否上警？警长拥有 1.5 票归票权。';
      addBtn('上警', 'btn-primary', async () => {
        await rpc('wr_submit_action', { p_room: roomCode, p_client: myClientId, p_kind: 'candidacy', p_payload: {} });
        await advance();
      });
      addBtn('不上警', 'btn-ghost', async () => { await advance(); });
      return;
    }

    // [night] 按角色显示操作
    if (phase === 'night') {
      if (myRole === 'werewolf') {
        title.textContent = '🐺 狼人行动';
        body.innerHTML = '队友：' + ((mi.mates || []).map(i => (i + 1) + '号').join('、') || '无') + '<br>选择击杀目标：';
        enableSeatPick(async (target) => {
          await rpc('wr_submit_action', { p_room: roomCode, p_client: myClientId, p_kind: 'wolf_kill', p_payload: { target } });
          await advance();
        }, p => p.alive && !(mi.mates || []).includes(p.seat));
      } else if (myRole === 'seer') {
        title.textContent = '🔮 预言家查验';
        body.innerHTML = '选择一名玩家查验其阵营身份。';
        enableSeatPick(async (target) => {
          await rpc('wr_submit_action', { p_room: roomCode, p_client: myClientId, p_kind: 'seer_check', p_payload: { target } });
          await advance();
        }, p => p.alive && p.seat !== mySeat);
      } else if (myRole === 'witch') {
        title.textContent = '🧪 女巫行动';
        const kt = mi.killTarget;
        body.innerHTML = kt !== null && kt !== undefined
          ? `今晚 ${kt + 1}号 被狼人杀害。`
          : '今晚无人被杀。';
        addBtn('不用药', 'btn-ghost', async () => {
          await rpc('wr_submit_action', { p_room: roomCode, p_client: myClientId, p_kind: 'witch', p_payload: { antidote: false, poison: null } });
          await advance();
        });
        if (kt !== null && kt !== undefined && kt !== mySeat) {
          addBtn('💊 救人', 'act-btn-good', async () => {
            await rpc('wr_submit_action', { p_room: roomCode, p_client: myClientId, p_kind: 'witch', p_payload: { antidote: true, poison: null } });
            await advance();
          });
        }
        addBtn('☠ 毒人', 'act-btn-wolf', () => {
          body.innerHTML = '选择毒杀目标：';
          btns.innerHTML = '';
          enableSeatPick(async (target) => {
            await rpc('wr_submit_action', { p_room: roomCode, p_client: myClientId, p_kind: 'witch', p_payload: { antidote: false, poison: target } });
            await advance();
          }, p => p.alive && p.seat !== mySeat);
        });
      } else {
        title.textContent = '🌙 夜晚 · 闭眼等待';
        body.innerHTML = '本阶段无需行动。';
        addBtn('继续', 'btn-primary', async () => { await advance(); });
      }
      return;
    }

    // [vote] 投票
    if (phase === 'vote') {
      title.textContent = '🗳 放逐投票';
      body.innerHTML = '点击座位选择你要投出的玩家。';
      enableSeatPick(async (target) => {
        await rpc('wr_submit_action', { p_room: roomCode, p_client: myClientId, p_kind: 'vote', p_payload: { target } });
        await advance();
      }, p => p.alive && p.seat !== mySeat);
      return;
    }

    // [hunter_shot]
    if (phase === 'hunter_shot') {
      const pending = (st.state || {}).pendingHunterSeat;
      if (pending === mySeat) {
        title.textContent = '🏹 猎人开枪';
        body.innerHTML = '你已出局，可以选择带走一名存活玩家。';
        enableSeatPick(async (target) => {
          await rpc('wr_submit_action', { p_room: roomCode, p_client: myClientId, p_kind: 'hunter_shot', p_payload: { target } });
          await advance();
        }, p => p.alive && p.seat !== mySeat);
      } else {
        title.textContent = '🏹 等待猎人开枪…';
      }
      return;
    }

    // [speech] 纯展示
    if (phase === 'speech') {
      title.textContent = '💬 发言阶段';
      body.innerHTML = '请根据场上信息发言分析。';
      if (isHost) addBtn('结束发言 → 投票', 'btn-primary', async () => { await advance(); });
      return;
    }
  }

  function addBtn(text, cls, fn) {
    const b = el('button', 'btn ' + (cls || ''), text);
    b.onclick = fn;
    $('#action-buttons').appendChild(b);
  }

  function enableSeatPick(onPick, filterFn) {
    let picked = null;
    $$('#seats .seat').forEach(s => { s.classList.remove('selectable', 'picked'); s.onclick = null; });
    (state.seats || []).forEach(p => {
      if (!filterFn || !filterFn(p)) return;
      const s = seatEl(p.seat);
      if (!s) return;
      s.classList.add('selectable');
      s.onclick = () => {
        $$('#seats .seat').forEach(x => x.classList.remove('picked'));
        s.classList.add('picked');
        picked = p.seat;
        confirmBtn.disabled = false;
        confirmBtn.textContent = '确认选择 ' + (p.seat + 1) + '号';
      };
    });
    const confirmBtn = addBtn('请先点击一个座位', 'btn-primary', async () => {
      if (picked === null) return;
      $$('#seats .seat').forEach(s => { s.classList.remove('selectable', 'picked'); s.onclick = null; });
      await onPick(picked);
    });
    confirmBtn.disabled = true;
  }

  async function advance() {
    try {
      const st = await rpc('wr_advance', { p_room: roomCode, p_client: myClientId });
      renderState(st);
    } catch (e) {
      console.error('[NetGame] advance failed:', e);
    }
  }

  // ---------- 入口 ----------
  function start(initialState, opts) {
    rpc = opts.rpc;
    roomCode = opts.roomCode;
    myClientId = opts.clientId;
    godView = !!$('#opt-godview')?.checked;

    window.WW.UI.showScreen('screen-game');
    buildSeats();
    $('#log-stream').innerHTML = '';
    renderState(initialState);

    // 非房主轮询同步
    if (!initialState.is_host) {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(async () => {
        try {
          const st = await rpc('wr_room_state', { p_room: roomCode, p_client: myClientId });
          renderState(st);
        } catch (e) { /* ignore */ }
      }, 1500);
    }
  }

  window.WW.NetGame = { start };
})();
