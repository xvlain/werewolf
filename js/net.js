/**
 * net.js — Supabase 联机层
 *
 * 架构要点（防作弊是狼人杀联机的第一约束）：
 *   1. 身份分配与夜晚结算全部在 Postgres 函数（RPC）内完成，
 *      客户端永远拿不到完整身份表 —— wr_roles 表启用 RLS 且不开放任何 SELECT 策略，
 *      玩家只能通过 wr_my_role() 读到自己那一张牌。
 *   2. client_id 作为轻量承载令牌（localStorage 持久化），
 *      由 SECURITY DEFINER 函数内部校验，避免暴露 service_role。
 *   3. 同步方式：优先 Supabase Realtime 订阅 wr_rooms 变更；
 *      SDK 加载失败时自动降级为轮询，功能等价。
 *
 * 依赖：sql/werewolf_schema.sql 需先在 Supabase SQL Editor 执行。
 */
(function () {
  'use strict';

  const CFG = window.WW.Config;
  const SB = CFG.supabase;

  // ---------- 客户端身份 ----------
  function clientId() {
    let id = localStorage.getItem('wr_client_id');
    if (!id) {
      id = 'c_' + Date.now().toString(36) + '_' +
           Math.random().toString(36).slice(2, 10);
      localStorage.setItem('wr_client_id', id);
    }
    return id;
  }

  function nick() {
    return localStorage.getItem('wr_nick') || ('玩家' + clientId().slice(-4));
  }

  // ---------- RPC 调用 ----------
  async function rpc(fn, args) {
    const res = await fetch(SB.url + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SB.anonKey,
        'Authorization': 'Bearer ' + SB.anonKey
      },
      body: JSON.stringify(args || {})
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!res.ok) {
      const msg = (data && (data.message || data.error)) || ('HTTP ' + res.status);
      const err = new Error(msg);
      err.detail = data;
      throw err;
    }
    return data;
  }

  // ---------- Realtime / 轮询 ----------
  let sbClient = null;
  let channel = null;
  let pollTimer = null;
  let currentRoom = null;
  let onChange = null;

  function loadSdk() {
    return new Promise((resolve) => {
      if (window.supabase) return resolve(window.supabase);
      const s = document.createElement('script');
      s.src = SB.sdkCdn;
      s.onload = () => resolve(window.supabase);
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
      setTimeout(() => resolve(window.supabase || null), 6000);
    });
  }

  async function subscribe(roomCode, cb) {
    currentRoom = roomCode;
    onChange = cb;

    const sdk = await loadSdk();
    if (sdk && sdk.createClient) {
      try {
        sbClient = sdk.createClient(SB.url, SB.anonKey);
        channel = sbClient.channel('wr_room_' + roomCode);
        channel.on('postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'wr_rooms', filter: 'id=eq.' + roomCode },
          () => pull());
        channel.on('postgres_changes',
          { event: '*', schema: 'public', table: 'wr_players', filter: 'room_id=eq.' + roomCode },
          () => pull());
        await channel.subscribe();
        setStatus('已连接实时通道', 'ok');
        return;
      } catch (e) {
        console.warn('[Net] Realtime 订阅失败，降级轮询', e);
      }
    }
    // 降级：轮询
    setStatus('实时通道不可用，已切换轮询同步', '');
    stopPoll();
    pollTimer = setInterval(pull, CFG.pollInterval);
  }

  function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (channel) { try { channel.unsubscribe(); } catch (e) {} channel = null; }
  }

  async function pull() {
    if (!currentRoom || !onChange) return;
    try {
      const st = await rpc('wr_room_state', { p_room: currentRoom, p_client: clientId() });
      onChange(st);
    } catch (e) {
      console.warn('[Net] 拉取房间状态失败', e.message);
    }
  }

  function setStatus(text, kind) {
    const n = document.querySelector('#lobby-status');
    if (!n) return;
    n.textContent = text;
    n.className = 'lobby-status' + (kind ? ' ' + kind : '');
  }

  // ---------- 大厅 UI ----------
  let roomCode = null;
  let isHost = false;

  function initLobby() {
    const inp = document.querySelector('#inp-nick');
    if (inp && !inp.value) inp.value = localStorage.getItem('wr_nick') || '';
    setStatus('');
    document.querySelector('#room-panel').classList.add('hidden');
  }

  async function createRoom() {
    const n = document.querySelector('#inp-nick').value.trim();
    if (n) localStorage.setItem('wr_nick', n);
    setStatus('正在创建房间…');
    try {
      const r = await rpc('wr_create_room', { p_client: clientId(), p_nick: nick() });
      roomCode = r.room;
      isHost = true;
      enterRoom(r.room);
    } catch (e) {
      setStatus('创建失败：' + e.message, 'err');
      hintSchema(e);
    }
  }

  async function joinRoom(code) {
    const n = document.querySelector('#inp-nick').value.trim();
    if (n) localStorage.setItem('wr_nick', n);
    if (!code) { setStatus('请输入房间号', 'err'); return; }
    setStatus('正在加入房间 ' + code + ' …');
    try {
      await rpc('wr_join_room', { p_room: code, p_client: clientId(), p_nick: nick() });
      roomCode = code;
      isHost = false;
      enterRoom(code);
    } catch (e) {
      setStatus('加入失败：' + e.message, 'err');
      hintSchema(e);
    }
  }

  function hintSchema(err) {
    const m = String(err.message || '');
    if (/could not find the function|function .* does not exist|404/i.test(m)) {
      setStatus('后端尚未初始化：请先在 Supabase SQL Editor 执行 sql/werewolf_schema.sql', 'err');
    }
  }

  function enterRoom(code) {
    document.querySelector('#room-panel').classList.remove('hidden');
    document.querySelector('#room-code-val').textContent = code;
    setStatus('房间 ' + code + ' 已就绪，等待玩家加入', 'ok');
    subscribe(code, renderRoom);
    pull();
  }

  function renderRoom(st) {
    if (!st) return;
    const list = document.querySelector('#room-players');
    if (!list) return;
    list.innerHTML = '';
    const seats = st.seats || [];
    for (let i = 0; i < 12; i++) {
      const s = seats.find(x => x.seat === i);
      const li = document.createElement('li');
      if (!s) { li.className = 'empty'; li.textContent = (i + 1) + '号 · 空位'; }
      else {
        li.textContent = (i + 1) + '号 · ' + s.nick + (s.is_ai ? '（AI）' : '');
        if (s.client_id === clientId()) li.className = 'me';
        if (s.is_ai) li.className = 'ai';
      }
      list.appendChild(li);
    }
    const humans = seats.filter(s => !s.is_ai).length;
    const btn = document.querySelector('#btn-start-room');
    if (btn) {
      btn.disabled = !(isHost && humans >= 2);
      btn.textContent = humans >= 12 ? '开始游戏' : `开始游戏（${humans}/12 人，不足由 AI 补位）`;
    }
    // 房主已开局（任何非 lobby 阶段）→ 进入对局
    if (st.phase && st.phase !== 'lobby') {
      stopPoll();
      window.WW.Net.enterGame(st);
    }
  }

  async function startRoom() {
    if (!roomCode) return;
    const aiFill = document.querySelector('#opt-aifill').checked;
    setStatus('正在发牌…');
    try {
      const r = await rpc('wr_start_game', {
        p_room: roomCode, p_client: clientId(), p_ai_fill: aiFill
      });
      stopPoll();
      window.WW.Net.enterGame(r);
    } catch (e) {
      setStatus('开局失败：' + e.message, 'err');
      hintSchema(e);
    }
  }

  /**
   * 进入联机对局
   * v1 说明：联机对局的状态机由服务端 wr_advance() 驱动，
   * 这里负责把服务端返回的公共状态 + 本人私密信息渲染到同一套 UI。
   */
  async function enterGame(state) {
    if (!window.WW.NetGame) {
      setStatus('联机对局界面尚未加载', 'err');
      return;
    }
    window.WW.NetGame.start(state, { rpc, roomCode, clientId: clientId() });
  }

  // ---------- 导出 ----------
  window.WW.Net = {
    clientId, nick, rpc,
    initLobby, createRoom, joinRoom, startRoom,
    subscribe, pull, stopPoll, enterGame,
    get roomCode() { return roomCode; },
    get isHost() { return isHost; }
  };

  // 绑定大厅按钮
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    const a = t.dataset.action;
    if (a === 'create-room') createRoom();
    else if (a === 'join-room') joinRoom((document.querySelector('#inp-room').value || '').trim().toUpperCase());
    else if (a === 'start-room') startRoom();
  });
  document.addEventListener('DOMContentLoaded', () => {
    const b = document.querySelector('#btn-start-room');
    if (b) b.onclick = startRoom;
  });
})();
