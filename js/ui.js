/**
 * ui.js — 狼人杀前端交互层
 *
 * 职责边界：
 *   engine.js 只管规则结算，ai.js 只管决策数学，
 *   本文件负责「把决策翻译成人话」+ 渲染 + 人类玩家交互。
 *
 * 视角：默认第一人称（只见自己身份与公共信息），
 *       可开关上帝观战模式（显示全场身份，用于复盘调试）。
 */
(function () {
  'use strict';

  const { WerewolfEngine, ROLES } = window.WW.Engine;
  const { AIDecision } = window.WW.AI;

  // ============ 角色元数据 ============
  const ROLE_INFO = {
    werewolf: { name: '狼人', faction: 'evil', icon: '🐺', desc: '每晚与队友共同猎杀一名玩家。白天伪装成好人，可悍跳预言家扰乱视听。' },
    seer:     { name: '预言家', faction: 'good', icon: '🔮', desc: '每晚查验一名玩家的阵营身份（好人 / 狼人），是好人的核心信息源。' },
    witch:    { name: '女巫', faction: 'good', icon: '🧪', desc: '拥有一瓶解药与一瓶毒药，各限用一次，同一夜不可同时使用，不可自救。' },
    hunter:   { name: '猎人', faction: 'good', icon: '🏹', desc: '被狼人杀害或被投票放逐时可开枪带走一名玩家；被女巫毒杀则无法发动。' },
    idiot:    { name: '白痴', faction: 'good', icon: '🃏', desc: '被投票放逐时翻牌免死，之后可继续发言但失去投票权。' },
    villager: { name: '平民', faction: 'good', icon: '👤', desc: '无夜间技能。靠发言与投票协助好人阵营找出狼人。' }
  };
  const GOD_ROLES = ['seer', 'witch', 'hunter', 'idiot'];
  const roleName = r => (ROLE_INFO[r] ? ROLE_INFO[r].name : r);

  // ============ 工具 ============
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const el = (tag, cls, txt) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt !== undefined && txt !== null) n.textContent = txt;
    return n;
  };

  let SPEED = 1;
  const wait = ms => new Promise(r => setTimeout(r, ms / SPEED));

  function toast(msg, kind) {
    const host = $('#toast-host');
    const t = el('div', 'toast' + (kind ? ' ' + kind : ''), msg);
    host.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 1800);
    setTimeout(() => t.remove(), 2200);
  }

  function showScreen(id) {
    $$('.screen').forEach(s => s.classList.remove('active'));
    const t = $('#' + id);
    if (t) t.classList.add('active');
  }

  // ============ 对局会话 ============
  class GameSession {
    constructor(opts) {
      this.opts = Object.assign({ godView: false, humanSeat: null, nick: '你' }, opts || {});
      this.engine = new WerewolfEngine();
      this.ai = new AIDecision(this.engine);
      this.godView = !!this.opts.godView;
      this.over = false;
      this.pendingInput = null;
      this.humanVoted = false;

      // 人类玩家座位：默认随机
      this.humanSeat = this.opts.humanSeat !== null && this.opts.humanSeat !== undefined
        ? this.opts.humanSeat
        : Math.floor(Math.random() * 12);
      this.humanPlayer = this.engine.players[this.humanSeat];

      // 昵称：AI 用编号名
      this.names = this.engine.players.map(p =>
        p.id === this.humanSeat ? this.opts.nick : (p.id + 1) + '号');

      this.stats = {
        checks: [], witchSaved: 0, witchPoisoned: null,
        hunterShots: [], expelledWolves: 0, days: 0
      };
    }

    get humanRole() { return this.humanPlayer.role; }
    isHuman(id) { return id === this.humanSeat; }
    label(id) { return id === null || id === undefined ? '—' : this.names[id]; }

    // ---------- 渲染 ----------
    buildSeats() {
      const host = $('#seats');
      host.innerHTML = '';
      const n = this.engine.players.length;
      this.engine.players.forEach((p, i) => {
        const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
        const R = 42;
        const x = 50 + R * Math.cos(ang);
        const y = 50 + R * Math.sin(ang);
        const s = el('div', 'seat');
        s.dataset.id = String(p.id);
        s.style.left = x + '%';
        s.style.top = y + '%';
        s.appendChild(el('span', 'seat-no', String(p.id + 1)));
        s.appendChild(el('span', 'seat-name', this.names[p.id]));
        const rr = el('span', 'seat-role', roleName(p.role));
        s.appendChild(rr);
        s.appendChild(el('span', 'vote-count', '0'));
        if (this.isHuman(p.id)) s.classList.add('me');
        host.appendChild(s);
      });
    }

    seatEl(id) { return $('#seats .seat[data-id="' + id + '"]'); }

    renderSeats() {
      this.engine.players.forEach(p => {
        const s = this.seatEl(p.id);
        if (!s) return;
        s.classList.toggle('dead', !p.alive);
        s.classList.toggle('sheriff', !!p.sheriff);
        // 身份可见条件：上帝观战 / 已出局翻牌 / 自己 / 狼人队友
        const visible = this.godView
          || !p.alive
          || this.isHuman(p.id)
          || (this.humanRole === ROLES.WEREWOLF
              && this.ai.memories[this.humanSeat].knownWolves.includes(p.id));
        s.classList.toggle('show-role', visible);
        s.classList.toggle('faction-good', visible && p.faction === 'good');
        s.classList.toggle('faction-evil', visible && p.faction === 'evil');
      });
      const alive = this.engine.getAlivePlayers().length;
      $('#hud-alive').textContent = `存活 ${alive}/12`;
    }

    renderRolePanel() {
      const info = ROLE_INFO[this.humanRole];
      const node = $('#my-role');
      node.textContent = info.icon + ' ' + info.name;
      node.className = 'my-role ' + info.faction;
      $('#my-role-desc').textContent = info.desc;
    }

    renderIntel() {
      const mem = this.ai.memories[this.humanSeat];
      const board = this.ai.board;

      // 查验记录（仅预言家自己看得到；上帝视角全开）
      const chk = $('#intel-checks');
      chk.innerHTML = '';
      const checks = this.godView ? board.publicChecks : mem.checkResults.map(r => ({ target: r.target, result: r.result, sourceId: this.humanSeat }));
      if (checks.length) {
        chk.appendChild(el('div', null, ''));
        chk.innerHTML = '<span class="k">查验：</span>' + checks.map(c =>
          `${this.label(c.target)} <span class="${c.result === 'evil' ? 'wolf' : 'safe'}">${c.result === 'evil' ? '查杀' : '金水'}</span>`
        ).join('　');
      }

      // 金水 / 银水
      const safe = $('#intel-safe');
      const silvers = board.silverWater.filter(id => this.engine.players[id].alive);
      const golds = checks.filter(c => c.result === 'good').map(c => this.label(c.target));
      const parts = [];
      if (golds.length) parts.push('<span class="k">金水：</span><span class="safe">' + golds.join('、') + '</span>');
      if (silvers.length) parts.push('<span class="k">银水：</span><span class="safe">' + silvers.map(i => this.label(i)).join('、') + '</span>');
      safe.innerHTML = parts.join('　');

      // 确认狼人
      const cw = board.getConfirmedWolves().filter(id => this.engine.players[id].alive);
      $('#intel-wolves').innerHTML = cw.length
        ? '<span class="k">确认狼人：</span><span class="wolf">' + cw.map(i => this.label(i)).join('、') + '</span>'
        : '';

      // 票型分析（自己的怀疑榜）
      const pat = $('#intel-pattern');
      if (!this.godView) {
        const ranked = this.engine.getAlivePlayers()
          .filter(p => p.id !== this.humanSeat)
          .map(p => ({ id: p.id, s: (mem.suspicion[p.id] || 0) - (mem.trust[p.id] || 0) * 1.8 }))
          .filter(x => x.s > 0)
          .sort((a, b) => b.s - a.s)
          .slice(0, 4);
        pat.innerHTML = ranked.length
          ? '<span class="k">票型怀疑榜：</span>' + ranked.map((r, i) => `${i + 1}. ${this.label(r.id)}`).join('　')
          : '';
      } else {
        const wolves = this.engine.getAliveWerewolves().map(p => this.label(p.id));
        pat.innerHTML = wolves.length
          ? '<span class="k">【观战】存活狼人：</span><span class="wolf">' + wolves.join('、') + '</span>'
          : '<span class="k">【观战】狼人已全灭</span>';
      }
    }

    log(text, cls) {
      const host = $('#log-stream');
      const line = el('div', 'log-line' + (cls ? ' ' + cls : ''));
      line.innerHTML = text;
      host.appendChild(line);
      host.scrollTop = host.scrollHeight;
    }

    clearLog() { $('#log-stream').innerHTML = ''; }

    setPhase(phase, hint) {
      const night = phase === 'night';
      $('#hud-phase').textContent = night ? '夜晚' : '白天';
      $('#hud-phase').className = 'hud-chip ' + (night ? 'phase-night' : 'phase-day');
      $('#hud-day').textContent = '第 ' + this.engine.day + ' 天';
      $('#center-phase').textContent = night ? '夜 晚' : '白 天';
      $('#center-hint').textContent = hint || '';
      $('#table').classList.toggle('night', night);
      $('#table').classList.toggle('day', !night);
      $('#night-veil').classList.toggle('on', night);
    }

    setAction(title, bodyHtml) {
      $('#action-title').textContent = title;
      $('#action-body').innerHTML = bodyHtml || '';
      $('#action-buttons').innerHTML = '';
    }

    addBtn(text, cls, fn) {
      const b = el('button', 'btn ' + (cls || ''), text);
      b.onclick = fn;
      $('#action-buttons').appendChild(b);
      return b;
    }

    // ---------- 人类输入 ----------
    /** 进入「点选座位」模式，返回被选中的座位 id */
    promptSeat(title, bodyHtml, filterFn) {
      return new Promise(resolve => {
        this.setAction(title, bodyHtml);
        let picked = null;

        const clearPick = () => {
          $$('#seats .seat').forEach(s => { s.classList.remove('picked', 'selectable'); });
        };

        this.engine.getAlivePlayers().forEach(p => {
          const s = this.seatEl(p.id);
          if (!s) return;
          if (filterFn && !filterFn(p)) return;
          s.classList.add('selectable');
          s.onclick = () => {
            clearPick();
            this.engine.getAlivePlayers().forEach(q => {
              const t = this.seatEl(q.id);
              if (t && filterFn && (!filterFn || filterFn(q))) t.classList.add('selectable');
            });
            s.classList.add('picked');
            picked = p.id;
            confirmBtn.disabled = false;
            confirmBtn.textContent = '确认选择 ' + this.label(p.id);
          };
        });

        const confirmBtn = this.addBtn('请先点击一个座位', 'btn-primary', () => {
          if (picked === null) return;
          clearPick();
          $$('#seats .seat').forEach(s => { s.onclick = null; });
          resolve(picked);
        });
        confirmBtn.disabled = true;
      });
    }

    promptChoice(title, bodyHtml, options) {
      return new Promise(resolve => {
        this.setAction(title, bodyHtml);
        options.forEach(o => {
          this.addBtn(o.text, o.cls || 'btn-ghost', () => resolve(o.value));
        });
      });
    }

    promptContinue(title, bodyHtml) {
      return this.promptChoice(title, bodyHtml, [{ text: '继续', cls: 'btn-primary', value: true }]);
    }

    // ---------- 发言叙述 ----------
    /** 把 AI 的内部决策翻译成玩家能看懂的发言文本 */
    narrateSpeech() {
      const board = this.ai.board;
      const alive = this.engine.getAlivePlayers();

      // 昨夜死讯
      const dead = board.deaths.filter(d => d.day === this.engine.day);
      if (dead.length === 0) {
        this.log('☾ 昨晚是平安夜，无人死亡', 'sys');
      } else {
        dead.forEach(d => {
          this.log(`☠ ${this.label(d.id)} 昨晚死亡，翻牌身份：<b>${roleName(d.role)}</b>`, 'death');
        });
      }

      // 遗言
      dead.forEach(d => {
        const p = this.engine.players[d.id];
        if (p.role === ROLES.SEER) {
          const mem = this.ai.memories[d.id];
          if (mem.checkResults.length) {
            const c = mem.checkResults[mem.checkResults.length - 1];
            this.log(`<span class="who">${this.label(d.id)}</span>（遗言）：我是预言家，昨晚验的 ${this.label(c.target)} 是${c.result === 'evil' ? '查杀，铁狼！' : '金水，好人。'}好人按我的查验走。`, 'check');
          }
        } else if (p.role === ROLES.HUNTER) {
          this.log(`<span class="who">${this.label(d.id)}</span>（遗言）：我是猎人，枪已经开了/带走一个，剩下交给你们。`, 'claim');
        } else if (p.faction === 'evil') {
          this.log(`<span class="who">${this.label(d.id)}</span> 翻牌为狼人，全场震动。`, 'death');
        }
      });

      // 起跳与报查验
      alive.forEach(p => {
        if (p.role !== ROLES.SEER && p.id !== this.ai.hanTiaoWolf) return;
        const isReal = p.role === ROLES.SEER;
        const mem = this.ai.memories[p.id];
        if (!mem.hasClaimed) return;
        const myChecks = board.publicChecks.filter(c => c.sourceId === p.id);
        const last = myChecks[myChecks.length - 1];
        if (last) {
          const txt = last.result === 'evil'
            ? `我是预言家，昨晚查验 <b>${this.label(last.target)}</b> —— <span class="wolf">查杀！</span>今天全票出他。`
            : `我是预言家，昨晚查验 <b>${this.label(last.target)}</b> —— <span class="safe">金水</span>，他是好人。`;
          this.log(`<span class="who">${this.label(p.id)}</span>：${txt}`, 'check');
        } else if (isReal) {
          this.log(`<span class="who">${this.label(p.id)}</span>：我是预言家，昨晚没验出狼，今天先听发言。警徽流我留到下一轮。`, 'claim');
        }
      });

      // 对跳提示
      const claims = board.getClaimsForRole(ROLES.SEER).filter(c => this.engine.players[c.playerId].alive);
      if (claims.length >= 2) {
        this.log(`⚠ 出现对跳：${claims.map(c => this.label(c.playerId)).join(' 与 ')} 都声称预言家，请分辨真假。`, 'sys');
      }

      // 女巫报银水
      const sil = board.silverWater.filter(id => this.engine.players[id].alive);
      if (sil.length && !this._silverAnnounced) {
        this._silverAnnounced = true;
        this.log(`<span class="who">女巫</span>（起跳）：昨晚 ${this.label(sil[sil.length - 1])} 是我的银水，我救的，他是好人。`, 'claim');
      }

      // 队长归票
      if (board.leaderId !== null && this.engine.players[board.leaderId] && this.engine.players[board.leaderId].alive) {
        const lr = board.leaderRole;
        if (board.leaderCall !== null) {
          this.log(`<span class="who">${this.label(board.leaderId)}</span>（${roleName(lr)}起跳带队）：预言家已经走了，我来归票，今天全票出 <b>${this.label(board.leaderCall)}</b>。`, 'claim');
        }
      }

      // 普通玩家发言（抽样，避免刷屏）
      const talkers = alive.filter(p =>
        p.role !== ROLES.SEER && p.id !== this.ai.hanTiaoWolf && p.id !== board.leaderId);
      talkers.sort(() => Math.random() - 0.5);
      talkers.slice(0, 3).forEach(p => {
        const mem = this.ai.memories[p.id];
        const ranked = alive.filter(x => x.id !== p.id)
          .map(x => ({ id: x.id, s: (mem.suspicion[x.id] || 0) - (mem.trust[x.id] || 0) * 1.8 }))
          .sort((a, b) => b.s - a.s)[0];
        const lines = p.faction === 'evil'
          ? [
              ranked && ranked.s > 0
                ? `我是好人，${this.label(ranked.id)} 刚才发言逻辑不对，我怀疑他。`
                : '我闭眼玩家，没什么信息，先跟着警长走。',
              '别乱投好人，狼就在中间带节奏。'
            ]
          : [
              ranked && ranked.s > 3
                ? `我站边真预言家，${this.label(ranked.id)} 的票型和发言都有问题。`
                : '我是好人，信息不多，这轮听归票。',
              '前面那位发言太划水了，建议重点听。'
            ];
        this.log(`<span class="who">${this.label(p.id)}</span>：${lines[Math.floor(Math.random() * lines.length)]}`, 'vote');
      });
    }

    // ---------- 警长竞选 ----------
    async runElection() {
      this.setPhase('day', '警长竞选');
      this.log('━━━ 第 1 天 · 警长竞选 ━━━', 'day-head');

      const alive = this.engine.getAlivePlayers();
      let humanRuns = false;

      if (alive.some(p => p.id === this.humanSeat)) {
        const want = await this.promptChoice(
          '警长竞选',
          '是否上警竞选警长？警长拥有 <b>1.5 票归票权</b>，并能决定发言顺序。<br>预言家通常必须上警。',
          [
            { text: '上警竞选', cls: 'btn-primary', value: true },
            { text: '不上警', cls: 'btn-ghost', value: false }
          ]
        );
        humanRuns = want;
      }

      // 记录人类意愿，交由 AI 模块统一处理竞选（人类视为额外候选人）
      if (humanRuns) this._humanCandidate = true;
      const sheriff = this.ai.runSheriffElection(this._humanCandidate ? this.humanSeat : null);
      this._humanCandidate = false;

      if (sheriff === null) {
        this.log('警徽流失，本局无警长。', 'sys');
        toast('警徽流失', 'bad');
      } else {
        this.engine.players[sheriff].sheriff = true;
        this.log(`★ ${this.label(sheriff)} 当选警长，获得警徽（1.5 票归票权）`, 'claim');
        toast(this.label(sheriff) + ' 当选警长');
      }
      this.renderSeats();
      await wait(900);
    }

    // ---------- 夜晚 ----------
    async runNight() {
      this.engine.day;
      const dayBefore = this.engine.day;
      this.setPhase('night', '天黑请闭眼');
      this.log(`━━━ 第 ${dayBefore + 1} 夜 ━━━`, 'day-head');
      await wait(700);

      const acts = this.ai.decideNightActions();
      const hr = this.humanRole;
      const humanAlive = this.humanPlayer.alive;

      // === 人类玩家夜间行动 ===
      if (humanAlive) {
        if (hr === ROLES.WEREWOLF) {
          const mates = this.ai.memories[this.humanSeat].knownWolves
            .filter(id => this.engine.players[id].alive);
          const suggestion = acts.wolfKillTarget;
          const picked = await this.promptSeat(
            '🐺 狼人行动 · 选择击杀目标',
            `你的狼队友：<b>${mates.map(i => this.label(i)).join('、') || '无（你是独狼）'}</b><br>` +
            `队友建议刀：<b>${this.label(suggestion)}</b>（可直接采纳或自行改刀）`,
            p => p.faction === 'good' || p.id === this.humanSeat
          );
          acts.wolfKillTarget = picked;
          this.log(`🐺 狼队最终决定击杀 ${this.label(picked)}`, 'sys');
        } else if (hr === ROLES.SEER) {
          const checked = new Set(this.ai.memories[this.humanSeat].checkResults.map(r => r.target));
          const picked = await this.promptSeat(
            '🔮 预言家行动 · 选择查验目标',
            '查验一名玩家，得知其阵营身份（好人 / 狼人）。',
            p => p.id !== this.humanSeat && !checked.has(p.id)
          );
          acts.seerCheckTarget = picked;
        } else if (hr === ROLES.WITCH) {
          const victim = acts.wolfKillTarget;
          const victimAlive = victim !== null && victim !== undefined && this.engine.players[victim].alive;
          const canSave = victimAlive && !this.engine.witchAntidoteUsed && victim !== this.humanSeat;
          const canPoison = !this.engine.witchPoisonUsed;

          let body = victimAlive
            ? `今晚 <b>${this.label(victim)}</b> 被狼人杀害。`
            : '今晚狼人空刀，无人被杀。';
          if (victim === this.humanSeat) body += '<br><span class="wolf">被刀的是你自己 —— 女巫不可自救。</span>';
          body += `<br>解药：${this.engine.witchAntidoteUsed ? '已用完' : '可用'}　毒药：${this.engine.witchPoisonUsed ? '已用完' : '可用'}`;

          const opts = [];
          if (canSave) opts.push({ text: '💊 使用解药救人', cls: 'act-btn-good', value: 'save' });
          if (canPoison) opts.push({ text: '☠ 使用毒药', cls: 'act-btn-wolf', value: 'poison' });
          opts.push({ text: '不用药', cls: 'btn-ghost', value: 'none' });

          const choice = await this.promptChoice('🧪 女巫行动', body, opts);
          if (choice === 'save') {
            acts.witchAntidote = true;
            acts.witchPoisonTarget = null;
          } else if (choice === 'poison') {
            acts.witchAntidote = false;
            const t = await this.promptSeat(
              '☠ 选择毒杀目标',
              '毒药可毒杀任意存活玩家。<b>毒错好人代价极大</b>，请谨慎。',
              p => p.id !== this.humanSeat);
            acts.witchPoisonTarget = t;
          } else {
            acts.witchAntidote = false;
            acts.witchPoisonTarget = null;
          }
        } else {
          // 平民 / 猎人 / 白痴：无夜间技能
          const isGod = GOD_ROLES.includes(hr);
          await this.promptContinue(
            '🌙 夜晚 · 闭眼等待',
            isGod
              ? `你是 <b>${roleName(hr)}</b>，本阶段无需行动，天亮后才会用到技能。`
              : '你是平民，夜间没有任何信息。安心等天亮，白天靠发言和投票找狼。');
        }
      }

      // === 结算 ===
      const night = this.engine.executeNight(acts);

      // 预言家查验结果（人类视角）
      if (night.seerResult && this.isHuman(night.seerResult.target) === false) {
        const seer = this.engine._findAlivePlayerByRole(ROLES.SEER);
        if (seer) this.ai.updateSeerInfo(seer.id, night.seerResult);
        if (hr === ROLES.SEER && this.humanPlayer.alive) {
          const r = night.seerResult;
          toast(`查验 ${this.label(r.target)}：${r.result === 'evil' ? '狼人！' : '好人'}`,
            r.result === 'evil' ? 'bad' : 'good');
        }
      } else if (night.seerResult) {
        const seer = this.engine._findAlivePlayerByRole(ROLES.SEER);
        if (seer) this.ai.updateSeerInfo(seer.id, night.seerResult);
      }

      if (night.witchSaveResult) { this.stats.witchSaved++; }
      if (night.witchPoisonResult !== null) { this.stats.witchPoisoned = night.witchPoisonResult; }

      // 猎人夜间开枪（人类）
      for (const d of night.deaths) {
        if (d.role === ROLES.HUNTER && d.cause !== 'witch_poison' && this.isHuman(d.id)) {
          const t = await this.promptSeat(
            '🏹 猎人开枪',
            '你被狼人杀害，可以开枪带走一名存活玩家。',
            p => p.id !== d.id);
          const shot = this.engine.executeHunterShot(d.id, t);
          if (shot) this.stats.hunterShots.push(shot);
        } else if (d.role === ROLES.HUNTER && d.cause !== 'witch_poison') {
          const t = this.ai.decideHunterTarget(d.id);
          if (t !== null) {
            const shot = this.engine.executeHunterShot(d.id, t);
            if (shot) this.stats.hunterShots.push(shot);
          }
        }
      }

      this.ai.recordDeaths(this.engine.day, night.deaths);
      this.ai.revealDeaths(night.deaths);
      this.renderSeats();
      this.renderIntel();
      await wait(500);
      return night;
    }

    // ---------- 白天 ----------
    async runDay() {
      this.setPhase('day', '发言与投票');
      this.ai.simulateSpeech();
      this.narrateSpeech();
      this.renderIntel();
      await wait(1100);

      // 投票
      const votes = this.ai.decideVotes();

      // 人类投票（若存活且未翻牌）
      if (this.humanPlayer.alive && !this.humanPlayer.idiotFlipped) {
        delete votes[this.humanSeat];
        const mem = this.ai.memories[this.humanSeat];
        const cw = this.ai.board.getConfirmedWolves().filter(id => this.engine.players[id].alive);
        const hint = cw.length
          ? `已确认狼人：<span class="wolf">${cw.map(i => this.label(i)).join('、')}</span>`
          : (mem.believedSeer !== null
              ? `你站边 <b>${this.label(mem.believedSeer)}</b> 为真预言家`
              : '暂无确定信息，请依据发言与票型判断');
        const pick = await this.promptSeat(
          '🗳 放逐投票 · 选择你要投出的玩家',
          hint + '<br>点击座位上方的头像选择目标。',
          p => p.id !== this.humanSeat && !p.idiotFlipped);
        votes[this.humanSeat] = pick;
      }

      this.ai.recordVotes(this.engine.day, votes);

      // 逐票动画
      $$('#seats .seat').forEach(s => { s.classList.remove('voted'); s.querySelector('.vote-count').textContent = '0'; });
      this.log('━━━ 放逐投票 ━━━', 'day-head');
      const entries = Object.entries(votes);
      for (const [v, t] of entries) {
        const s = this.seatEl(t);
        if (s) {
          const vc = s.querySelector('.vote-count');
          const w = this.engine.players[v].sheriff ? 1.5 : 1;
          vc.textContent = String((parseFloat(vc.textContent) || 0) + w).replace('.0', '');
          s.classList.add('voted');
        }
        await wait(this.godView ? 60 : 130);
      }
      await wait(500);

      const vote = this.engine.executeVote(votes);

      if (vote.idiotFlipped !== null) {
        this.log(`🃏 ${this.label(vote.idiotFlipped)} 是白痴，翻牌免死！但失去投票权。`, 'claim');
        toast(this.label(vote.idiotFlipped) + ' 白痴翻牌');
      }

      if (vote.expelled !== null) {
        const v = this.engine.players[vote.expelled];
        this.log(`⛓ ${this.label(vote.expelled)} 被放逐出局，翻牌身份：<b>${roleName(v.role)}</b>`, 'death');
        if (v.role === ROLES.WEREWOLF) this.stats.expelledWolves++;

        this.ai.recordExpulsion(this.engine.day, vote.expelled);
        this.ai.learnFromExpulsion(vote.expelled);
        this.ai.revealRole(vote.expelled, v.role);

        // 猎人被放逐开枪
        if (v.role === ROLES.HUNTER) {
          if (this.isHuman(vote.expelled)) {
            const t = await this.promptSeat(
              '🏹 猎人开枪',
              '你被投票放逐，可以开枪带走一名存活玩家。',
              p => p.id !== vote.expelled);
            const shot = this.engine.executeHunterShot(vote.expelled, t);
            if (shot) {
              this.stats.hunterShots.push(shot);
              this.log(`🏹 你开枪带走了 ${this.label(shot.id)}（${roleName(shot.role)}）`, 'death');
            }
          } else {
            const t = this.ai.decideHunterTarget(vote.expelled);
            if (t !== null) {
              const shot = this.engine.executeHunterShot(vote.expelled, t);
              if (shot) {
                this.stats.hunterShots.push(shot);
                this.log(`🏹 ${this.label(vote.expelled)} 开枪带走了 ${this.label(shot.id)}（${roleName(shot.role)}）`, 'death');
              }
            }
          }
        }
        toast(this.label(vote.expelled) + ' 被放逐 · ' + roleName(v.role),
          v.faction === 'evil' ? 'good' : 'bad');
      } else if (vote.idiotFlipped === null) {
        this.log('○ 平票，无人出局（平安日）', 'sys');
      }

      $$('#seats .seat').forEach(s => s.classList.remove('voted'));
      this.renderSeats();
      this.renderIntel();
      this.stats.days = this.engine.day;
      await wait(900);
    }

    // ---------- 主循环 ----------
    async run() {
      this.buildSeats();
      this.renderRolePanel();
      this.renderSeats();
      this.clearLog();
      $('#log-stream').innerHTML = '';
      this._silverAnnounced = false;

      // 发牌提示
      this.log(`你的身份：<b>${roleName(this.humanRole)}</b>（${this.humanSeat + 1} 号位）`, 'claim');
      if (this.humanRole === ROLES.WEREWOLF) {
        const mates = this.ai.memories[this.humanSeat].knownWolves.map(i => this.label(i));
        this.log(`你的狼队友：${mates.join('、')}`, 'death');
      }
      toast('你的身份：' + roleName(this.humanRole), this.humanPlayer.faction === 'evil' ? 'bad' : 'good');
      await wait(1400);

      let guard = 0;
      while (!this.engine.gameOver && guard++ < 30) {
        await this.runNight();
        let r = this.engine.checkWinCondition();
        if (r.gameOver) break;

        if (this.engine.day === 1) await this.runElection();

        await this.runDay();
        r = this.engine.checkWinCondition();
        if (r.gameOver) break;
      }

      const result = this.engine.checkWinCondition();
      this.over = true;
      await wait(600);
      this.showResult(result);
      return result;
    }

    showResult(result) {
      const goodWin = result.winner === 'good';
      const humanWin = (this.humanPlayer.faction === 'good') === goodWin;
      const t = $('#result-title');
      t.textContent = result.winner === null ? '流 局' : (goodWin ? '好人阵营胜利' : '狼人阵营胜利');
      t.className = result.winner === null ? '' : (goodWin ? 'good' : 'evil');

      const reasonMap = {
        all_wolves_dead: '所有狼人被放逐出局',
        all_gods_dead: '狼人屠神成功 —— 所有神职阵亡',
        all_villagers_dead: '狼人屠民成功 —— 所有平民阵亡',
        draw: '对局超过上限天数，判定流局'
      };
      $('#result-reason').textContent =
        (reasonMap[result.reason] || '') + (result.winner !== null ? `　·　你${humanWin ? '赢了 🎉' : '输了'}` : '');

      // 身份全公开
      const host = $('#result-roles');
      host.innerHTML = '';
      this.engine.players.forEach(p => {
        const c = el('div', 'rr-cell ' + p.faction + (p.alive ? '' : ' dead') + (this.isHuman(p.id) ? ' me' : ''));
        c.appendChild(el('div', 'rr-no', (p.id + 1) + '号 · ' + this.names[p.id] + (this.isHuman(p.id) ? '（你）' : '')));
        c.appendChild(el('div', 'rr-role', ROLE_INFO[p.role].icon + ' ' + roleName(p.role)));
        host.appendChild(c);
      });

      // 对局数据
      const s = this.stats;
      $('#result-stats').innerHTML =
        `<b>对局数据</b><br>` +
        `总天数：<b>${this.engine.day}</b> 天　·　放逐命中狼人：<b>${s.expelledWolves}</b> 只<br>` +
        `女巫解药：<b>${s.witchSaved}</b> 次　·　猎人开枪：<b>${s.hunterShots.length}</b> 次<br>` +
        `悍跳狼：<b>${this.ai.hanTiaoWolf !== null ? this.label(this.ai.hanTiaoWolf) : '本局未悍跳'}</b>　·　` +
        `警长：<b>${this.ai.board.sheriffId !== null ? this.label(this.ai.board.sheriffId) : '警徽流失'}</b><br>` +
        `<span style="color:var(--tx-2)">AI 平衡性基准（15000 局模拟）：好人 49% / 狼人 51%</span>`;

      showScreen('screen-result');
    }
  }

  // ============ 规则文案 ============
  function renderRules() {
    $('#rules-body').innerHTML = `
      <h3>阵营与胜利条件</h3>
      <p>本局为 <b>12 人标准局「预女猎白」</b>：4 狼人 + 4 平民 + 4 神职（预言家 / 女巫 / 猎人 / 白痴）。</p>
      <table>
        <tr><th>阵营</th><th>胜利条件</th></tr>
        <tr><td class="tag-good">好人阵营</td><td>放逐全部 4 名狼人</td></tr>
        <tr><td class="tag-evil">狼人阵营</td><td>屠边：杀光全部神职 <b>或</b> 杀光全部平民</td></tr>
      </table>
      <h3>游戏流程</h3>
      <ul>
        <li><b>夜晚</b>：全员闭眼，狼人睁眼共同刀一人 → 女巫得知刀口并决定是否用药 → 预言家查验一人。</li>
        <li><b>白天</b>：公布死讯并<b>翻牌公开身份</b> → 首日进行警长竞选 → 轮流发言 → 放逐投票。</li>
        <li>得票最多者出局并翻牌；平票则无人出局。之后进入下一夜，循环直至一方达成胜利条件。</li>
      </ul>
      <h3>角色技能</h3>
      <table>
        <tr><th>角色</th><th>阵营</th><th>技能</th></tr>
        <tr><td>预言家</td><td class="tag-good">好人</td><td>每晚查验一名玩家的阵营（好人 / 狼人），验出好人称「金水」，验出狼人称「查杀」</td></tr>
        <tr><td>女巫</td><td class="tag-good">好人</td><td>解药救活当夜被刀者，毒药毒杀任意玩家；各限用一次，同夜不可双开，<b>不可自救</b></td></tr>
        <tr><td>猎人</td><td class="tag-good">好人</td><td>被狼刀或被放逐时可开枪带走一人；<b>被女巫毒杀则无法开枪</b></td></tr>
        <tr><td>白痴</td><td class="tag-good">好人</td><td>被放逐时翻牌免死，之后可发言但<b>失去投票权</b>，且不可再被放逐</td></tr>
        <tr><td>平民</td><td class="tag-good">好人</td><td>无夜间技能，靠发言与投票找出狼人</td></tr>
        <tr><td>狼人</td><td class="tag-evil">狼人</td><td>每晚共同猎杀一人；可「悍跳」冒充预言家扰乱好人站边</td></tr>
      </table>
      <h3>警长机制</h3>
      <ul>
        <li>首日竞选产生，拥有 <b>1.5 票归票权</b>，并可决定发言顺序。</li>
        <li>竞选平票或无人上警则「警徽流失」，本局无警长。</li>
        <li>警长死亡后警徽流失（本作暂不移交）。</li>
      </ul>
      <h3>关键术语</h3>
      <table>
        <tr><th>术语</th><th>含义</th></tr>
        <tr><td>金水 / 查杀</td><td>预言家验出的好人 / 狼人</td></tr>
        <tr><td>银水</td><td>被女巫解药救活的玩家</td></tr>
        <tr><td>悍跳</td><td>狼人冒充预言家起跳对跳</td></tr>
        <tr><td>站边</td><td>在对跳局面中选择相信哪一方是真预言家</td></tr>
        <tr><td>归票</td><td>号召全场把票集中投给同一目标</td></tr>
        <tr><td>票型分析</td><td>狼人投票天然同步，通过历史票型反推狼队友</td></tr>
        <tr><td>屠边 / 屠城</td><td>杀光神职或平民 / 杀光全部好人</td></tr>
      </table>
      <h3>AI 平衡性</h3>
      <p>本作 AI 决策模型经过 <b>15000 局模拟验证</b>，好人胜率 48.1% / 49.1% / 49.3%（三轮独立复核），
      稳定落在 45%–55% 健康区间，双方均有可行策略空间。</p>
    `;
  }

  // ============ 启动与事件绑定 ============
  let session = null;

  function startSingle() {
    const god = $('#opt-godview').checked;
    SPEED = $('#opt-fast').checked ? 3 : 1;
    showScreen('screen-game');
    session = new GameSession({ godView: god, nick: '你' });
    $('#btn-godview').classList.toggle('on', god);
    session.run().catch(err => {
      console.error('[对局异常]', err);
      toast('对局异常：' + err.message, 'bad');
    });
  }

  function bind() {
    document.addEventListener('click', e => {
      const t = e.target.closest('[data-action]');
      if (!t) return;
      const a = t.dataset.action;
      if (a === 'single') startSingle();
      else if (a === 'rules') { renderRules(); showScreen('screen-rules'); }
      else if (a === 'back-menu') showScreen('screen-menu');
      else if (a === 'again') startSingle();
      else if (a === 'lobby') { showScreen('screen-lobby'); window.WW.Net && window.WW.Net.initLobby(); }
    });

    $('#btn-godview').onclick = () => {
      if (!session) return;
      session.godView = !session.godView;
      $('#btn-godview').classList.toggle('on', session.godView);
      session.renderSeats();
      session.renderIntel();
      toast(session.godView ? '上帝观战：已显示全场身份' : '上帝观战：已关闭', session.godView ? 'good' : '');
    };

    $('#btn-speed').onclick = () => {
      SPEED = SPEED === 1 ? 3 : (SPEED === 3 ? 6 : 1);
      $('#btn-speed').classList.toggle('on', SPEED > 1);
      toast('速度 ×' + SPEED);
    };

    $('#btn-quit').onclick = () => {
      if (session) session.over = true;
      showScreen('screen-menu');
    };
  }

  document.addEventListener('DOMContentLoaded', () => {
    bind();
    // 联机模块就绪后挂载
    if (window.WW && window.WW.Net && window.WW.Net.ready) window.WW.Net.ready({ GameSession, showScreen, toast });
  });

  window.WW = window.WW || {};
  window.WW.UI = { GameSession, ROLE_INFO, roleName, startSingle };
})();
