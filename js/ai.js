/* UMD-WRAPPED: 用 IIFE 隔离顶层词法作用域，避免浏览器 classic script 之间的
   const 重名冲突（engine.js 与 ai.js 各自声明了 ROLES）。
   Node 环境下仍通过 module.exports 导出，浏览器环境下挂到 window.WW。 */
(function () {
'use strict';
/**
 * 狼人杀 AI 决策系统 v2.0
 *
 * v1 问题：好人投票接近随机、预言家信息不公开 → 狼人 99.6% 胜率
 * v2 修正：引入「公共信息板」建模真实博弈
 *   - 预言家起跳公开查验（警上竞选 + 警徽流）
 *   - 狼人悍跳制造对跳，好人被迫「站边」
 *   - 每个好人独立决定相信哪个预言家（50/50 基础 + 逻辑修正）
 *   - 狼人优先刀已起跳预言家（真实策略）
 *   - 警长机制：1.5 票归票权
 */

const ROLES = {
  WEREWOLF: 'werewolf', SEER: 'seer', WITCH: 'witch',
  HUNTER: 'hunter', IDIOT: 'idiot', VILLAGER: 'villager'
};

// ============ 玩家私有记忆 ============
class PlayerMemory {
  constructor(id, role, faction) {
    this.id = id;
    this.role = role;
    this.faction = faction;

    this.knownWolves = [];        // 狼人互知队友
    this.checkResults = [];        // 预言家查验记录
    this.hasClaimed = false;       // 是否已起跳
    this.believedSeer = null;      // 站边相信的预言家
    this.suspicion = {};           // 怀疑度
    this.trust = {};
    this.wolfDisguise = null;      // 狼人白天伪装身份
  }

  addCheck(target, result) {
    this.checkResults.push({ target, result });
  }

  bumpSuspicion(id, d) {
    this.suspicion[id] = (this.suspicion[id] || 0) + d;
  }

  bumpTrust(id, d) {
    this.trust[id] = (this.trust[id] || 0) + d;
  }
}

// ============ 公共信息板（所有玩家可见） ============
class PublicBoard {
  constructor() {
    this.claims = [];        // {playerId, role, day}
    this.publicChecks = [];  // {sourceId, target, result, day}
    this.deaths = [];        // {day, id, cause}
    this.expelled = [];      // {day, id}
    this.sheriffId = null;
    this.revealedRoles = {}; // {playerId: role} —— 出局翻牌公开的身份（官方规则）
    this.voteLog = [];       // [{day, votes:{voterId: targetId}}] —— 历史票型（公开信息）
    this.silverWater = [];   // 女巫公开报出的「银水」（被解药救活的玩家）
    this.leaderId = null;    // 预言家阵亡后接力带队的神职（女巫/猎人）
    this.leaderRole = null;
    this.leaderCall = null;  // 队长本轮归票目标
  }

  getClaimsForRole(role) {
    return this.claims.filter(c => c.role === role);
  }

  /** 由已翻牌身份反推出的确定狼人（如：真预言家翻牌后，另一个对跳者必为狼） */
  getConfirmedWolves() {
    return Object.keys(this.revealedRoles)
      .filter(id => this.revealedRoles[id] === 'confirmed_wolf')
      .map(id => parseInt(id));
  }
}

// ============ AI 决策引擎 ============
class AIDecision {
  constructor(engine) {
    this.engine = engine;
    this.board = new PublicBoard();
    this.memories = {};

    engine.players.forEach(p => {
      this.memories[p.id] = new PlayerMemory(p.id, p.role, p.faction);
    });

    // 狼人互知队友
    const wolves = engine.players.filter(p => p.role === ROLES.WEREWOLF).map(p => p.id);
    wolves.forEach(id => {
      this.memories[id].knownWolves = wolves.filter(w => w !== id);
    });

    // 真预言家永远知道自己是真的 → 站边自己（不可能被悍跳狼骗）
    const realSeer = engine.players.find(p => p.role === ROLES.SEER);
    if (realSeer) this.memories[realSeer.id].believedSeer = realSeer.id;

    // 女巫/猎人/白痴/平民：初始无站边
    // 狼人伪装分配：1 只悍跳狼（概率），其余深水/倒钩
    this.hanTiaoWolf = null;
    if (Math.random() < 0.75) {
      this.hanTiaoWolf = wolves[Math.floor(Math.random() * wolves.length)];
    }

    this.gameEnded = false;
    this.pendingSilverWater = null;   // 女巫昨夜救起、待公开的银水
  }

  _alive() {
    return this.engine.getAlivePlayers();
  }

  _aliveExcept(id) {
    return this._alive().filter(p => p.id !== id);
  }

  _isAlive(id) {
    const p = this.engine.players[id];
    return p && p.alive;
  }

  // ========== 夜晚决策 ==========

  decideNightActions() {
    const actions = {
      wolfKillTarget: null,
      seerCheckTarget: null,
      witchAntidote: false,
      witchPoisonTarget: null,
      guardTarget: null
    };

    // --- 狼人：优先刀已起跳的预言家，其次疑似女巫/猎人 ---
    const wolves = this._alive().filter(p => p.role === ROLES.WEREWOLF);
    if (wolves.length > 0) {
      actions.wolfKillTarget = this._decideWolfKill(wolves);
    }

    // --- 预言家 ---
    const seer = this.engine._findAlivePlayerByRole(ROLES.SEER);
    if (seer) actions.seerCheckTarget = this._decideSeerCheck(seer);

    // --- 女巫 ---
    const witch = this.engine._findAlivePlayerByRole(ROLES.WITCH);
    if (witch) {
      const w = this._decideWitch(witch, actions.wolfKillTarget);
      actions.witchAntidote = w.useAntidote;
      actions.witchPoisonTarget = w.poisonTarget;
    }

    return actions;
  }

  _decideWolfKill(wolves) {
    const mem = this.memories[wolves[0].id];
    const goods = this._alive().filter(p => p.faction === 'good');
    if (goods.length === 0) return null;

    // 1. 已起跳的真预言家 → 最高优先（这是公开信息，狼人可以合理知道）
    const seerClaims = this.board.getClaimsForRole(ROLES.SEER)
      .filter(c => this._isAlive(c.playerId) && !mem.knownWolves.includes(c.playerId));
    if (seerClaims.length > 0) {
      return seerClaims[0].playerId;
    }

    // 2. 首夜：10% 自刀骗药
    if (this.engine.day <= 1 && Math.random() < 0.10) {
      return wolves[0].id;
    }

    // 3. 「抿身份」：狼人不掌握神职位置，只能靠发言观察猜测
    //    建模为 25% 准确率 —— 猜中则精准刀神，猜错则退化为随机刀
    //    ⚠️ 修正 v2.0 的重大缺陷：此前直接读取 p.isGod（上帝视角），导致屠神率虚高
    const guessCorrect = Math.random() < 0.25;
    if (guessCorrect) {
      const gods = goods.filter(p => p.isGod);
      if (gods.length > 0) return gods[Math.floor(Math.random() * gods.length)].id;
    }

    // 4. 随机刀（真实狼人多数夜晚的真实状态）
    return goods[Math.floor(Math.random() * goods.length)].id;
  }

  _decideSeerCheck(seer) {
    const mem = this.memories[seer.id];
    const candidates = this._aliveExcept(seer.id)
      .filter(p => !mem.checkResults.some(r => r.target === p.id));

    const pool = candidates.length > 0 ? candidates : this._aliveExcept(seer.id);
    if (pool.length === 0) return null;

    // 优先验怀疑度高的
    pool.sort((a, b) => (mem.suspicion[b.id] || 0) - (mem.suspicion[a.id] || 0));
    return Math.random() < 0.7 ? pool[0].id : pool[Math.floor(Math.random() * pool.length)].id;
  }

  _decideWitch(witch, wolfKillTarget) {
    const mem = this.memories[witch.id];
    const out = { useAntidote: false, poisonTarget: null };

    // 解药：首夜 90% 救，之后 45%（留药救预言家的权衡）
    if (!this.engine.witchAntidoteUsed && wolfKillTarget !== null && wolfKillTarget !== undefined) {
      const victim = this.engine.players[wolfKillTarget];
      if (victim && victim.alive && victim.id !== witch.id) {
        const p = this.engine.day === 1 ? 0.90 : 0.45;
        // 被刀的是已起跳预言家 → 必救
        const isClaimedSeer = this.board.getClaimsForRole(ROLES.SEER)
          .some(c => c.playerId === wolfKillTarget);
        out.useAntidote = Math.random() < (isClaimedSeer ? 0.95 : p);
      }
    }

    // 毒药：只在有「确定狼人」信息时使用，避免浪费在好人身上
    //   修正：此前 engine.day 在结算前仍是前一天，导致首夜后的第一晚被误判为 day<2 而跳过
    if (!this.engine.witchPoisonUsed && !out.useAntidote) {
      const knownWolf = this._publicKnownWolf(mem);
      if (knownWolf !== null) {
        // 明牌狼（翻牌确认 / 己方确信预言家的查杀）→ 高概率下毒
        const p = this.board.getConfirmedWolves().includes(knownWolf) ? 0.90 : 0.60;
        if (Math.random() < p) out.poisonTarget = knownWolf;
      } else if (this.engine.day >= 2) {
        // 调平 v2.1：无明牌狼时，允许女巫凭票型分析毒最可疑者（真实局的「女巫带队」）
        const alive = this.engine.getAlivePlayers().filter(x => x.id !== witch.id);
        if (alive.length > 0) {
          const scored = alive
            .map(x => ({ id: x.id, s: (mem.suspicion[x.id] || 0) - (mem.trust[x.id] || 0) * 1.8 }))
            .sort((a, b) => b.s - a.s);
          // 仅当最可疑者的信号显著领先时才下毒，避免盲毒好人
          if (scored[0].s >= 12 && (scored.length < 2 || scored[0].s - scored[1].s >= 5)
              && Math.random() < 0.40) {
            out.poisonTarget = scored[0].id;
          }
        }
      }
    }

    return out;
  }

  /** 从公共信息中找一个仍然存活的确定狼人（翻牌明牌 > 所信预言家查杀） */
  _publicKnownWolf(mem) {
    // 1. 翻牌反推出的明牌狼
    const confirmed = this.board.getConfirmedWolves().filter(id => this._isAlive(id));
    if (confirmed.length > 0) return confirmed[0];

    // 2. 所信预言家的查杀
    const kills = this.board.publicChecks.filter(c => c.result === 'evil');
    for (const k of kills) {
      if (mem.believedSeer !== null && k.sourceId !== mem.believedSeer) continue;
      if (this._isAlive(k.target)) return k.target;
    }
    return null;
  }

  // ========== 白天阶段 ==========

  /**
   * 警长竞选（仅首日）：预言家必上警，悍跳狼也上警，好人随机上警
   * 返回 sheriffId
   */
  runSheriffElection(humanCandidate) {
    const alive = this._alive();
    const seer = alive.find(p => p.role === ROLES.SEER);
    const candidates = [];
    const humanId = (typeof humanCandidate === 'number') ? humanCandidate : null;

    // 预言家上警
    if (seer) candidates.push(seer.id);
    // 悍跳狼上警
    if (this.hanTiaoWolf !== null && this._isAlive(this.hanTiaoWolf)) {
      candidates.push(this.hanTiaoWolf);
    }
    // 人类玩家主动上警
    if (humanId !== null && this._isAlive(humanId)) candidates.push(humanId);

    // 1-2 个 AI 好人陪跑上警（真实局常见）
    const others = alive.filter(p =>
      p.id !== seer?.id && p.id !== this.hanTiaoWolf && p.id !== humanId && p.faction === 'good');
    others.sort(() => Math.random() - 0.5);
    candidates.push(...others.slice(0, 1 + Math.floor(Math.random() * 2)).map(p => p.id));

    // 去重 + 过滤非法值
    const uniq = [...new Set(candidates.filter(c => typeof c === 'number' && this.engine.players[c]))];
    candidates.length = 0;
    candidates.push(...uniq);

    if (candidates.length === 0) return null;

    // 警下玩家投票：好人倾向真预言家（发言质量建模 55% 准确），狼人投自家悍跳狼
    const tally = {};
    candidates.forEach(c => { tally[c] = 0; });

    alive.forEach(voter => {
      if (candidates.includes(voter.id)) return; // 警上不投票
      const mem = this.memories[voter.id];
      let pick = null;

      if (voter.role === ROLES.WEREWOLF) {
        pick = candidates.includes(this.hanTiaoWolf) ? this.hanTiaoWolf
          : candidates.find(c => mem.knownWolves.includes(c)) ?? null;
      } else {
        // 好人：靠发言质量/心路历程/警徽流识别真预言家（72% 准确率）
        const realSeer = candidates.find(c => this.engine.players[c].role === ROLES.SEER);
        if (realSeer !== undefined && Math.random() < 0.72) {
          pick = realSeer;
        } else {
          pick = candidates[Math.floor(Math.random() * candidates.length)];
        }
      }

      if (pick !== null && tally[pick] !== undefined) tally[pick] += 1;
    });

    // 选出最高票
    let best = null, bestCount = -1, tie = false;
    for (const [id, c] of Object.entries(tally)) {
      if (c > bestCount) { bestCount = c; best = parseInt(id); tie = false; }
      else if (c === bestCount) tie = true;
    }

    if (tie || bestCount <= 0) {
      this.board.sheriffId = null;   // 警徽流失
      return null;
    }

    this.board.sheriffId = best;
    this.engine.players[best].sheriff = true;
    return best;
  }

  /**
   * 发言阶段：起跳、公开查验、悍跳、好人站边
   */
  simulateSpeech() {
    const alive = this._alive();

    // --- 1. 遗言：昨夜死亡的神职公开信息（首夜死亡有遗言）---
    this.board.deaths
      .filter(d => d.day === this.engine.day && !d.lastWordsDone)
      .forEach(d => {
        d.lastWordsDone = true;
        const p = this.engine.players[d.id];
        if (p.role === ROLES.SEER) {
          const mem = this.memories[d.id];
          this._publishChecks(d.id, mem, this.engine.day);
        }
      });

    // --- 2. 存活预言家起跳并公开查验 ---
    const seer = alive.find(p => p.role === ROLES.SEER);
    if (seer && !this.memories[seer.id].hasClaimed) {
      this.board.claims.push({ playerId: seer.id, role: ROLES.SEER, day: this.engine.day });
      this.memories[seer.id].hasClaimed = true;
    }
    if (seer) this._publishChecks(seer.id, this.memories[seer.id], this.engine.day);

    // --- 3. 悍跳狼对跳（在真预言家起跳后）---
    if (this.hanTiaoWolf !== null && this._isAlive(this.hanTiaoWolf)
        && !this.memories[this.hanTiaoWolf].hasClaimed
        && this.board.getClaimsForRole(ROLES.SEER).length >= 1) {
      this.board.claims.push({
        playerId: this.hanTiaoWolf, role: ROLES.SEER, day: this.engine.day
      });
      this.memories[this.hanTiaoWolf].hasClaimed = true;
      // 悍跳狼报假查杀：随机指向一个好人，并同样公开播报（信息对称，制造真实站边难题）
      const goods = this._alive().filter(p => p.faction === 'good');
      if (goods.length > 0) {
        const fake = goods[Math.floor(Math.random() * goods.length)].id;
        this.board.publicChecks.push({
          sourceId: this.hanTiaoWolf, target: fake, result: 'evil', day: this.engine.day
        });
        this._alive().forEach(p => {
          if (p.faction !== 'good' || p.id === this.hanTiaoWolf) return;
          const m = this.memories[p.id];
          const weight = (m.believedSeer === this.hanTiaoWolf) ? 1.0 : 0.5;
          m.bumpSuspicion(fake, 6 * weight);
        });
      }
    }

    // --- 3.5 女巫报银水（60% 概率公开，代价是暴露自身位置）---
    if (this.pendingSilverWater !== null && this.pendingSilverWater !== undefined) {
      const savedId = this.pendingSilverWater;
      this.pendingSilverWater = null;
      const witch = this.engine._findAlivePlayerByRole(ROLES.WITCH);
      if (witch && this._isAlive(savedId) && Math.random() < 0.60) {
        this.board.silverWater.push(savedId);
        // 全场好人采信银水（狼人自刀骗药属低概率行为）
        this._alive().forEach(p => {
          if (p.faction === 'good') this.memories[p.id].bumpTrust(savedId, 6);
        });
      }
    }

    // --- 4. 好人站边：每个好人独立决定相信哪个预言家 ---
    const seerClaims = this.board.getClaimsForRole(ROLES.SEER);
    alive.forEach(p => {
      if (p.faction !== 'good') return;
      const mem = this.memories[p.id];
      if (mem.believedSeer !== null && this._isAlive(mem.believedSeer)) return; // 已站边且对象活着
      if (seerClaims.length === 0) return;

      if (seerClaims.length === 1) {
        mem.believedSeer = seerClaims[0].playerId;
        mem.bumpTrust(seerClaims[0].playerId, 3);
      } else {
        // 对跳局面：好人靠「警徽」这个公共信号收敛站边（真实对局的核心机制）
        // 警徽由竞选产生，是真预言家的最强背书；无警徽时退化为发言逻辑判断
        const badgeHolder = this.board.sheriffId;
        const badgeIsClaimant = badgeHolder !== null && seerClaims.some(c => c.playerId === badgeHolder);

        if (badgeIsClaimant) {
          // 相信警徽持有者 80%（真实玩家高度依赖警徽流）
          mem.believedSeer = Math.random() < 0.80
            ? badgeHolder
            : seerClaims.find(c => c.playerId !== badgeHolder)?.playerId ?? seerClaims[0].playerId;
        } else {
          // 警徽流失/无人上警：靠发言逻辑，准确率随天数累积（悍跳狼谎言越久越容易崩）
          const acc = Math.min(0.58 + 0.06 * (this.engine.day - 1), 0.85);
          const realSeer = seerClaims.find(c => this.engine.players[c.playerId].role === ROLES.SEER);
          const believeReal = Math.random() < acc;
          mem.believedSeer = (believeReal && realSeer)
            ? realSeer.playerId
            : seerClaims.find(c => c.playerId !== realSeer?.playerId)?.playerId ?? seerClaims[0].playerId;
        }
      }

      // 站边后同步怀疑度
      this.board.publicChecks
        .filter(c => c.sourceId === mem.believedSeer)
        .forEach(c => {
          if (c.result === 'evil') mem.bumpSuspicion(c.target, 8);
          else mem.bumpTrust(c.target, 4);
        });
    });

    // --- 5. 平民发言噪声：随机怀疑（模拟乱踩/划水）---
    alive.forEach(p => {
      if (p.faction !== 'good' || p.role === ROLES.SEER) return;
      const targets = this._aliveExcept(p.id);
      if (targets.length === 0) return;
      const t = targets[Math.floor(Math.random() * targets.length)];
      this.memories[p.id].bumpSuspicion(t.id, 1);
    });

    // --- 6. 狼人倒钩：假装支持真预言家，误导部分好人 ---
    const wolves = alive.filter(p => p.role === ROLES.WEREWOLF);
    wolves.forEach(w => {
      if (w.id === this.hanTiaoWolf) return;
      const targets = this._alive().filter(p => p.faction === 'good' && p.id !== w.id);
      if (targets.length === 0) return;
      const scapegoat = targets[Math.floor(Math.random() * targets.length)];
      this._alive().forEach(o => {
        if (o.faction === 'good' && o.id !== w.id && Math.random() < 0.18) {
          this.memories[o.id].bumpSuspicion(scapegoat.id, 2);
        }
      });
    });

    // --- 7. 好人接力带队：预言家阵亡后由女巫/猎人起跳归票 ---
    //     这是好人阵营在失去信息源后仍能形成票型合力的关键机制（调平 v2.2）
    const seerAlive = alive.some(p => p.role === ROLES.SEER);
    if (!seerAlive && (this.board.leaderId === null || !this._isAlive(this.board.leaderId))) {
      const leader = alive.find(p => p.role === ROLES.WITCH)
                  || alive.find(p => p.role === ROLES.HUNTER)
                  || null;
      if (leader) {
        this.board.leaderId = leader.id;
        this.board.leaderRole = leader.role;
        this.board.claims.push({ playerId: leader.id, role: leader.role, day: this.engine.day });
      } else {
        this.board.leaderId = null;
        this.board.leaderRole = null;
      }
    } else if (seerAlive) {
      // 预言家仍在场，由预言家（通常持警徽）主导，不启用接力带队
      this.board.leaderId = null;
      this.board.leaderRole = null;
    }

    // 队长更新本轮归票目标（复用完整决策优先级，含明牌狼/查杀）
    if (this.board.leaderId !== null && this._isAlive(this.board.leaderId)) {
      this.board.leaderCall = this._decideVote(this.engine.players[this.board.leaderId]);
    } else {
      this.board.leaderCall = null;
    }
  }

  /** 女巫成功救人后由引擎回调，记录待公开的银水 */
  notifyWitchSave(savedId) {
    this.pendingSilverWater = savedId;
  }

  /**
   * 保护名单：好人已确认的好人身份，不应被自己人投出
   *   · 金水 —— 所信预言家查验为好人的玩家
   *   · 银水 —— 女巫公开报出的被救玩家（狼人自刀骗药概率低）
   */
  _protectedIds(mem) {
    const set = new Set([mem.id]);
    if (mem.believedSeer !== null) {
      this.board.publicChecks
        .filter(c => c.sourceId === mem.believedSeer && c.result === 'good')
        .forEach(c => set.add(c.target));
    }
    this.board.silverWater.forEach(id => set.add(id));
    return set;
  }

  _publishChecks(seerId, mem, day) {
    const newlyPublished = [];
    mem.checkResults.forEach(r => {
      const exists = this.board.publicChecks.some(c => c.sourceId === seerId && c.target === r.target);
      if (!exists) {
        this.board.publicChecks.push({ sourceId: seerId, target: r.target, result: r.result, day });
        newlyPublished.push(r);
      }
    });

    // 公开播报 → 所有存活好人获得部分信息
    // （可信度未知：可能是真预言家，也可能是悍跳狼，故只做中等强度加权）
    if (newlyPublished.length === 0) return;
    const sourceAlive = this._isAlive(seerId);
    this._alive().forEach(p => {
      if (p.faction !== 'good' || p.id === seerId) return;
      const m = this.memories[p.id];
      // 已确认站边该预言家 → 满额采信；未站边 → 50% 采信
      const weight = (m.believedSeer === seerId) ? 1.0 : 0.5;
      newlyPublished.forEach(r => {
        if (r.result === 'evil') m.bumpSuspicion(r.target, 6 * weight);
        else m.bumpTrust(r.target, 3 * weight);
      });
      if (!sourceAlive) m.bumpTrust(seerId, 1); // 死人报查验，可信度略高
    });
  }

  updateSeerInfo(seerId, checkResult) {
    if (!checkResult || seerId === null || seerId === undefined) return;
    const mem = this.memories[seerId];
    if (!mem) return;
    mem.addCheck(checkResult.target, checkResult.result);
    if (checkResult.result === 'evil') mem.bumpSuspicion(checkResult.target, 8);
    else mem.bumpTrust(checkResult.target, 4);
  }

  // ========== 投票决策 ==========

  decideVotes() {
    const votes = {};
    const alive = this._alive();

    // === 归票机制 ===
    // 关键修正：好人只跟随「自己站边相信」的警长归票。
    // 若好人认为警长是悍跳狼，则必须反投警长 —— 这是真实对局的核心博弈。
    let sheriffCall = null;
    const sheriffId = this.board.sheriffId;
    if (sheriffId !== null && this._isAlive(sheriffId)) {
      const sheriff = this.engine.players[sheriffId];
      if (!sheriff.idiotFlipped) {
        sheriffCall = this._decideVote(sheriff);
        if (sheriffCall !== null) votes[sheriffId] = sheriffCall;
      }
    }

    alive.forEach(p => {
      if (p.idiotFlipped) return;
      if (votes[p.id] !== undefined) return;

      const mem = this.memories[p.id];

      // 狼人跟随自家悍跳狼警长
      if (p.role === ROLES.WEREWOLF && sheriffCall !== null && sheriffCall !== p.id
          && mem.knownWolves.includes(sheriffId) && this._isAlive(sheriffCall)
          && Math.random() < 0.85) {
        votes[p.id] = sheriffCall;
        return;
      }

      // 好人：仅当自己站边的预言家就是警长时才跟随归票
      if (p.faction === 'good' && sheriffCall !== null && sheriffCall !== p.id
          && mem.believedSeer === sheriffId && this._isAlive(sheriffCall)
          && Math.random() < 0.85) {
        votes[p.id] = sheriffCall;
        return;
      }

      // 好人：预言家阵亡后跟随女巫/猎人队长归票（调平 v2.2）
      // 条件：自己没有存活的站边预言家可跟随，才接受接力带队
      const hasLiveSeer = mem.believedSeer !== null && this._isAlive(mem.believedSeer);
      if (p.faction === 'good' && !hasLiveSeer
          && this.board.leaderCall !== null && this.board.leaderId !== p.id
          && this._isAlive(this.board.leaderCall) && this.board.leaderCall !== p.id
          && Math.random() < 0.83) {
        votes[p.id] = this.board.leaderCall;
        return;
      }

      const t = this._decideVote(p);
      if (t !== null) votes[p.id] = t;
    });

    return votes;
  }

  _decideVote(player) {
    const mem = this.memories[player.id];
    const alive = this._aliveExcept(player.id);
    if (alive.length === 0) return null;

    if (player.role === ROLES.WEREWOLF) return this._wolfVote(player, alive, mem);

    // ===== 好人决策优先级 =====

    // 0. 真预言家的确定性推理：对跳者必为悍跳狼（自己就是真的）
    if (player.role === ROLES.SEER) {
      const rival = this.board.getClaimsForRole(ROLES.SEER)
        .map(c => c.playerId)
        .find(id => id !== player.id && this._isAlive(id));
      if (rival !== undefined) return rival;

      const ownKills = mem.checkResults.filter(r => r.result === 'evil' && this._isAlive(r.target));
      if (ownKills.length > 0) return ownKills[ownKills.length - 1].target;
    }

    // 1. 翻牌确认的明牌狼（最高优先，95% 执行）
    const confirmed = this.board.getConfirmedWolves().filter(id => this._isAlive(id));
    if (confirmed.length > 0 && Math.random() < 0.95) return confirmed[0];

    // 2. 站边逻辑：相信 B → 对跳的另一方必为狼，反投之
    const seerClaims = this.board.getClaimsForRole(ROLES.SEER).map(c => c.playerId);
    if (mem.believedSeer !== null && seerClaims.includes(mem.believedSeer)) {
      const rival = seerClaims.find(id => id !== mem.believedSeer && this._isAlive(id));
      if (rival !== undefined && Math.random() < 0.90) return rival;

      // 无对跳者存活 → 执行所信预言家的查杀
      const kills = this.board.publicChecks
        .filter(c => c.sourceId === mem.believedSeer && c.result === 'evil' && this._isAlive(c.target));
      if (kills.length > 0 && Math.random() < 0.90) return kills[kills.length - 1].target;
    }

    // 3. 未站边但存在单方起跳 → 倾向相信唯一预言家，执行其查杀
    if (mem.believedSeer === null && seerClaims.length === 1) {
      const only = seerClaims[0];
      const kills = this.board.publicChecks
        .filter(c => c.sourceId === only && c.result === 'evil' && this._isAlive(c.target));
      if (kills.length > 0 && Math.random() < 0.75) return kills[kills.length - 1].target;
    }

    return this._voteBySuspicion(alive, mem);
  }

  _wolfVote(player, alive, mem) {
    // 狼人目标：投出真预言家 / 抗推好人，绝不投队友
    const targets = alive.filter(p => !mem.knownWolves.includes(p.id) && p.faction === 'good');
    if (targets.length === 0) return alive[0].id;

    // 1. 优先投已起跳的真预言家
    const realSeer = targets.find(p =>
      p.role === ROLES.SEER && this.board.getClaimsForRole(ROLES.SEER).some(c => c.playerId === p.id));
    if (realSeer && Math.random() < 0.70) return realSeer.id;

    // 2. 其次投被己方悍跳狼查杀的好人（配合冲锋）
    const fakeKill = this.board.publicChecks
      .filter(c => c.sourceId === this.hanTiaoWolf && c.result === 'evil' && this._isAlive(c.target))
      .pop();
    if (fakeKill && Math.random() < 0.7) return fakeKill.target;

    // 3. 随机抗推
    return targets[Math.floor(Math.random() * targets.length)].id;
  }

  _voteBySuspicion(alive, mem) {
    // 排除已确认的好人（金水/银水），避免好人内耗
    const protectedSet = this._protectedIds(mem);
    const pool = alive.filter(p => !protectedSet.has(p.id));
    const candidates = pool.length > 0 ? pool : alive;

    // 调平 v2.1：降低随机噪声权重（2.5→1.0），提高确定性推理占比（0.72→0.86）
    // 依据：票型分析已提供真实信号，过高噪声会让好人退化为随机投票、大量误伤己方
    const scored = candidates.map(p => ({
      id: p.id,
      score: (mem.suspicion[p.id] || 0) - (mem.trust[p.id] || 0) * 1.8 + Math.random() * 1.0
    }));
    scored.sort((a, b) => b.score - a.score);
    return Math.random() < 0.86 ? scored[0].id
      : scored[Math.floor(Math.random() * Math.min(2, scored.length))].id;
  }

  // ========== 猎人开枪 ==========

  decideHunterTarget(hunterId) {
    const mem = this.memories[hunterId];
    const alive = this._aliveExcept(hunterId);
    if (alive.length === 0) return null;

    // 优先带走公共查杀的狼
    const known = this._publicKnownWolf(mem);
    if (known !== null && Math.random() < 0.95) return known;

    return this._voteBySuspicion(alive, mem);
  }

  // ========== 信息更新 ==========

  recordDeaths(day, deaths) {
    deaths.forEach(d => {
      this.board.deaths.push({ day, id: d.id, cause: d.cause, lastWordsDone: false });
    });
  }

  recordExpulsion(day, id) {
    if (id === null || id === undefined) return;
    this.board.expelled.push({ day, id });
    this.board.deaths.push({ day, id, cause: 'vote', lastWordsDone: true });
    // 警长死亡 → 警徽流失（简化：不移交）
    if (this.board.sheriffId === id) {
      this.board.sheriffId = null;
      this.engine.players[id].sheriff = false;
    }
  }

  /** 好人从放逐结果中学习（投错惩罚 / 投对强化） */
  learnFromExpulsion(expelledId) {
    const expelled = this.engine.players[expelledId];
    if (!expelled) return;
    this._alive().forEach(p => {
      if (p.faction !== 'good') return;
      const mem = this.memories[p.id];
      if (expelled.faction === 'evil') {
        // 投对了：强化所信预言家
        if (mem.believedSeer !== null) mem.bumpTrust(mem.believedSeer, 2);
      } else {
        // 投错了：动摇站边
        if (mem.believedSeer !== null && Math.random() < 0.35) mem.believedSeer = null;
      }
    });
  }

  // ========== 出局翻牌 · 公共身份公开（官方规则）==========

  /**
   * 玩家出局后翻牌，身份对全场公开。
   * 这是好人阵营最重要的信息来源：
   *   - 对跳预言家中有一方出局翻牌 → 另一方身份立刻确定
   *   - 翻出狼人 → 全场确认；翻出神职 → 对跳者必为悍跳狼
   */
  revealRole(id, role) {
    if (id === null || id === undefined) return;
    this.board.revealedRoles[id] = role;

    const seerClaims = this.board.getClaimsForRole(ROLES.SEER);
    const claimants = seerClaims.map(c => c.playerId);
    const isClaimant = claimants.includes(id);

    let exposedWolf = null;    // 由翻牌反推出的确定狼人
    let confirmedSeer = null;  // 由翻牌确认的真预言家（可已阵亡，其查验仍为黄金信息）

    if (role === ROLES.SEER) {
      // 翻出真预言家 → 其历史查验全部可信；对跳者必为悍跳狼
      confirmedSeer = id;
      if (isClaimant) {
        exposedWolf = claimants.filter(c => c !== id).find(r => this._isAlive(r)) ?? null;
      }
    } else if (role === ROLES.WEREWOLF && isClaimant) {
      // 悍跳狼翻牌 → 另一方是真预言家
      confirmedSeer = claimants.filter(c => c !== id).find(r => this._isAlive(r)) ?? null;
    }

    if (exposedWolf !== null) {
      this.board.revealedRoles[exposedWolf] = 'confirmed_wolf';
    }

    // 全场好人同步这条公共信息（翻牌是明牌，100% 生效）
    this._alive().forEach(p => {
      const mem = this.memories[p.id];
      if (p.faction !== 'good') return;

      if (exposedWolf !== null) {
        mem.bumpSuspicion(exposedWolf, 200);
        if (mem.believedSeer === exposedWolf) mem.believedSeer = null;
      }
      if (confirmedSeer !== null) {
        mem.believedSeer = confirmedSeer;
        mem.bumpTrust(confirmedSeer, 50);
        // 同步该预言家的全部公开查杀 → 转为确定狼人
        this.board.publicChecks
          .filter(c => c.sourceId === confirmedSeer && c.result === 'evil' && this._isAlive(c.target))
          .forEach(c => mem.bumpSuspicion(c.target, 200));
      }
      if (isClaimant && role === ROLES.SEER && mem.believedSeer === id) {
        // 己方预言家阵亡但身份已证实，查验信息保留
        mem.believedSeer = id;
      }
    });

    // 翻出狼人 → 触发票型回溯分析（好人锁定狼队友的主要手段）
    if (role === ROLES.WEREWOLF) {
      this._analyzeWolfVotes(id);
    }
  }

  /** 批量处理夜间死亡的翻牌 */
  revealDeaths(deaths) {
    deaths.forEach(d => this.revealRole(d.id, d.role));
  }

  /** 记录当天公开票型 */
  recordVotes(day, votes) {
    this.board.voteLog.push({ day, votes: { ...votes } });
  }

  /**
   * 票型分析 —— 好人阵营最核心的推理工具
   * 狼人投票天然同步（同一阵营目标一致），一旦某只狼翻牌确认，
   * 回溯历史票型即可高概率锁定其队友：
   *   · 与该狼多次同票的人 → 高度可疑（大概率狼队友）
   *   · 被该狼投票针对的人 → 大概率好人（狼不会刀/推自己人）
   */
  _analyzeWolfVotes(wolfId) {
    const sameVote = {};   // playerId -> 同票次数
    const targetedBy = {}; // playerId -> 被该狼投票次数

    this.board.voteLog.forEach(entry => {
      const wolfTarget = entry.votes[wolfId];
      for (const [voterId, targetId] of Object.entries(entry.votes)) {
        const v = parseInt(voterId);
        if (v === wolfId) continue;
        if (wolfTarget !== undefined && targetId === wolfTarget) {
          sameVote[v] = (sameVote[v] || 0) + 1;
        }
        if (wolfTarget === v) {
          targetedBy[v] = (targetedBy[v] || 0) + 1;
        }
      }
    });

    this._alive().forEach(p => {
      if (p.faction !== 'good') return;
      const mem = this.memories[p.id];
      for (const [id, count] of Object.entries(sameVote)) {
        const tid = parseInt(id);
        if (tid === p.id || !this._isAlive(tid)) continue;
        // 同票次数越多越可疑；单次同票可能只是巧合，给中等权重
        // 调平 v2.1：权重 7 → 10，让票型信号压过发言噪声
        mem.bumpSuspicion(tid, count * 10);
      }
      for (const [id, count] of Object.entries(targetedBy)) {
        const tid = parseInt(id);
        if (tid === p.id || !this._isAlive(tid)) continue;
        // 被狼推过 → 大概率好人（狼不会推自己队友）
        mem.bumpTrust(tid, count * 7);
        mem.bumpSuspicion(tid, -count * 7);
      }
    });
  }
}

if (typeof module !== 'undefined') {
  module.exports = { AIDecision, PlayerMemory, PublicBoard, ROLES };
}

// ============ 浏览器端全局导出 ============
if (typeof window !== 'undefined') {
  window.WW = window.WW || {};
  window.WW.AI = { AIDecision, PlayerMemory, PublicBoard };
}

})();
