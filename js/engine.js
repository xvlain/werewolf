/* UMD-WRAPPED: 用 IIFE 隔离顶层词法作用域，避免浏览器 classic script 之间的
   const 重名冲突（engine.js 与 ai.js 各自声明了 ROLES）。
   Node 环境下仍通过 module.exports 导出，浏览器环境下挂到 window.WW。 */
(function () {
'use strict';
/**
 * 狼人杀核心引擎 v1.0
 * 12人标准局 - 预女猎白
 * 
 * 角色: 4狼人 + 4平民 + 预言家 + 女巫 + 猎人 + 白痴
 * 胜利条件: 好人放逐所有狼人 / 狼人屠边(杀光神职或平民)
 */

// ============ 角色定义 ============
const ROLES = {
  WEREWOLF: 'werewolf',
  SEER: 'seer',
  WITCH: 'witch',
  HUNTER: 'hunter',
  IDIOT: 'idiot',
  VILLAGER: 'villager'
};

const FACTIONS = {
  GOOD: 'good',
  EVIL: 'evil'
};

function getRoleFaction(role) {
  return role === ROLES.WEREWOLF ? FACTIONS.EVIL : FACTIONS.GOOD;
}

function isGodRole(role) {
  return [ROLES.SEER, ROLES.WITCH, ROLES.HUNTER, ROLES.IDIOT].includes(role);
}

// ============ 12人标准局配置 ============
const STANDARD_CONFIG = {
  totalPlayers: 12,
  roles: [
    ROLES.WEREWOLF, ROLES.WEREWOLF, ROLES.WEREWOLF, ROLES.WEREWOLF,
    ROLES.SEER, ROLES.WITCH, ROLES.HUNTER, ROLES.IDIOT,
    ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER
  ]
};

// ============ 玩家状态 ============
class Player {
  constructor(id, role) {
    this.id = id;
    this.role = role;
    this.faction = getRoleFaction(role);
    this.alive = true;
    this.isGod = isGodRole(role);
    // 运行时状态
    this.guardedBy = null;      // 被谁守护
    this.witchSaved = false;    // 被女巫救
    this.witchPoisoned = false; // 被女巫毒
    this.idiotFlipped = false;  // 白痴是否翻牌
    this.sheriff = false;       // 是否是警长
    this.voteWeight = 1;        // 投票权重
  }

  resetRound() {
    this.guardedBy = null;
    this.witchSaved = false;
    this.witchPoisoned = false;
  }
}

// ============ 游戏日志 ============
class GameLog {
  constructor() {
    this.entries = [];
  }

  add(day, phase, message) {
    this.entries.push({ day, phase, message });
  }

  getRecent(count = 10) {
    return this.entries.slice(-count);
  }
}

// ============ 核心引擎 ============
class WerewolfEngine {
  constructor(config = STANDARD_CONFIG) {
    this.config = config;
    this.players = [];
    this.log = new GameLog();
    this.day = 0;
    this.phase = 'init'; // init, night, day_vote, day_speech, end
    this.gameOver = false;
    this.winner = null;
    this.sheriff = null;
    
    // 技能状态
    this.witchAntidoteUsed = false;  // 解药是否用过
    this.witchPoisonUsed = false;    // 毒药是否用过
    this.lastGuardTarget = null;     // 守卫上一轮守护目标
    
    // 每夜行动结果
    this.nightKillTarget = null;
    this.nightSeerResult = null;
    
    // 初始化
    this._initPlayers();
  }

  _initPlayers() {
    const shuffledRoles = this._shuffle([...this.config.roles]);
    for (let i = 0; i < this.config.totalPlayers; i++) {
      this.players.push(new Player(i, shuffledRoles[i]));
    }
  }

  _shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // 获取存活玩家
  getAlivePlayers() {
    return this.players.filter(p => p.alive);
  }

  getAlivePlayersByFaction(faction) {
    return this.getAlivePlayers().filter(p => p.faction === faction);
  }

  getAliveGods() {
    return this.getAlivePlayers().filter(p => p.isGod);
  }

  getAliveVillagers() {
    return this.getAlivePlayers().filter(p => p.role === ROLES.VILLAGER);
  }

  getAliveWerewolves() {
    return this.getAlivePlayers().filter(p => p.role === ROLES.WEREWOLF);
  }

  // ========== 夜晚阶段 ==========
  
  /**
   * 执行夜晚行动
   * @param {object} actions - AI决策的行动
   *   actions.guardTarget - 守卫守护目标 (playerId)
   *   actions.wolfKillTarget - 狼人击杀目标 (playerId)
   *   actions.seerCheckTarget - 预言家查验目标 (playerId)
   *   actions.witchAntidote - 女巫是否用解药 (boolean)
   *   actions.witchPoisonTarget - 女巫毒药目标 (playerId or null)
   */
  executeNight(actions) {
    this.day++;
    this.phase = 'night';
    
    // 重置每轮状态
    this.players.forEach(p => p.resetRound());
    
    // 1. 守卫行动（预女猎白板子无守卫，此分支自动跳过）
    let guardResult = null;
    const guardPlayer = this._findAlivePlayerByRole('guard');
    if (guardPlayer && actions.guardTarget !== null && actions.guardTarget !== undefined) {
      // 守卫不能连续两夜守护同一人
      if (actions.guardTarget !== this.lastGuardTarget) {
        const target = this.players[actions.guardTarget];
        if (target && target.alive) {
          target.guardedBy = 'guard';
          guardResult = actions.guardTarget;
        }
      }
    }
    this.lastGuardTarget = guardResult;

    // 2. 狼人行动 - 击杀目标
    const wolfKillTarget = actions.wolfKillTarget;
    this.nightKillTarget = wolfKillTarget;
    let wolfKillSuccess = false;
    
    if (wolfKillTarget !== null && wolfKillTarget !== undefined) {
      const victim = this.players[wolfKillTarget];
      if (victim && victim.alive) {
        // 检查守卫
        if (victim.guardedBy === 'guard') {
          // 被守护，击杀失败
          this.log.add(this.day, 'night', `狼人试图击杀${wolfKillTarget}号，但被守卫守护`);
          wolfKillSuccess = false;
        } else {
          wolfKillSuccess = true;
          this.log.add(this.day, 'night', `狼人击杀${wolfKillTarget}号(${victim.role})`);
        }
      }
    }

    // 3. 女巫行动
    let witchSaveResult = false;
    let witchPoisonResult = null;
    
    // 解药
    if (actions.witchAntidote && !this.witchAntidoteUsed && wolfKillSuccess) {
      const victim = this.players[wolfKillTarget];
      if (victim && victim.alive) {
        // 同守同救检测：如果守卫也在守护此人，该玩家死亡
        if (victim.guardedBy === 'guard') {
          // 同守同救 → 玩家死亡
          this.log.add(this.day, 'night', `同守同救！${wolfKillTarget}号仍然死亡`);
          witchSaveResult = false;
        } else {
          victim.witchSaved = true;
          wolfKillSuccess = false; // 救回来了
          this.witchAntidoteUsed = true;
          witchSaveResult = true;
          this.log.add(this.day, 'night', `女巫使用解药救了${wolfKillTarget}号`);
        }
      }
    }

    // 毒药
    if (actions.witchPoisonTarget !== null && actions.witchPoisonTarget !== undefined 
        && !this.witchPoisonUsed) {
      const poisonTarget = this.players[actions.witchPoisonTarget];
      if (poisonTarget && poisonTarget.alive) {
        poisonTarget.witchPoisoned = true;
        this.witchPoisonUsed = true;
        witchPoisonResult = actions.witchPoisonTarget;
        this.log.add(this.day, 'night', `女巫毒杀${actions.witchPoisonTarget}号(${poisonTarget.role})`);
      }
    }

    // 4. 预言家行动
    let seerResult = null;
    if (actions.seerCheckTarget !== null && actions.seerCheckTarget !== undefined) {
      const checkTarget = this.players[actions.seerCheckTarget];
      if (checkTarget && checkTarget.alive) {
        seerResult = {
          target: actions.seerCheckTarget,
          result: checkTarget.faction // 'good' or 'evil'
        };
        this.nightSeerResult = seerResult;
        this.log.add(this.day, 'night', `预言家查验${actions.seerCheckTarget}号，结果: ${checkTarget.faction === FACTIONS.GOOD ? '好人' : '狼人'}`);
      }
    }

    // 5. 结算死亡
    const deaths = [];
    
    // 狼人击杀
    if (wolfKillSuccess && wolfKillTarget !== null) {
      const victim = this.players[wolfKillTarget];
      victim.alive = false;
      deaths.push({ id: wolfKillTarget, cause: 'wolf_kill', role: victim.role });
    }

    // 毒药
    if (witchPoisonResult !== null) {
      const victim = this.players[witchPoisonResult];
      if (victim.alive) {
        victim.alive = false;
        deaths.push({ id: witchPoisonResult, cause: 'witch_poison', role: victim.role });
      }
    }

    // 猎人技能触发（被毒不能开枪）
    for (const death of deaths) {
      if (death.role === ROLES.HUNTER && death.cause === 'witch_poison') {
        // 被毒不能开枪
        this.log.add(this.day, 'night', `猎人被毒杀，无法开枪`);
      }
    }

    this.log.add(this.day, 'night', `夜晚结束，死亡人数: ${deaths.length}`);
    
    return {
      deaths,
      seerResult,
      wolfKillSuccess,
      witchSaveResult,
      witchPoisonResult
    };
  }

  // ========== 白天阶段 ==========

  /**
   * 执行投票
   * @param {Map<number, number>} votes - {voterId: targetId}
   * @returns {object} 投票结果
   */
  executeVote(votes) {
    this.phase = 'day_vote';
    
    const voteCounts = {};
    const alivePlayers = this.getAlivePlayers();
    
    // 初始化票数
    alivePlayers.forEach(p => {
      if (!p.idiotFlipped) { // 翻牌白痴没有投票权
        voteCounts[p.id] = 0;
      }
    });

    // 统计票数
    for (const [voterId, targetId] of Object.entries(votes)) {
      const voter = this.players[voterId];
      if (voter && voter.alive && !voter.idiotFlipped) {
        const weight = voter.sheriff ? 1.5 : 1;
        if (voteCounts[targetId] !== undefined) {
          voteCounts[targetId] = (voteCounts[targetId] || 0) + weight;
        }
      }
    }

    // 找出最高票
    let maxVotes = 0;
    let maxVoted = [];
    for (const [playerId, count] of Object.entries(voteCounts)) {
      if (count > 0) {
        if (count > maxVotes) {
          maxVotes = count;
          maxVoted = [parseInt(playerId)];
        } else if (count === maxVotes) {
          maxVoted.push(parseInt(playerId));
        }
      }
    }

    // 处理结果
    let expelled = null;
    let isTie = false;

    if (maxVoted.length === 0) {
      // 无人投票 → 平安日
      this.log.add(this.day, 'day', `无人被投票，平安日`);
    } else if (maxVoted.length === 1) {
      expelled = maxVoted[0];
    } else {
      isTie = true;
      this.log.add(this.day, 'day', `平票: ${maxVoted.join(',')}号`);
    }

    if (expelled !== null) {
      const victim = this.players[expelled];
      
      // 白痴翻牌检测
      if (victim.role === ROLES.IDIOT && !victim.idiotFlipped) {
        victim.idiotFlipped = true;
        victim.voteWeight = 0;
        this.log.add(this.day, 'day', `${expelled}号白痴翻牌免死，失去投票权`);
        return { expelled: null, idiotFlipped: expelled, isTie: false, voteCounts, maxVoted };
      } else if (victim.idiotFlipped) {
        // 已翻牌白痴不可再被放逐
        this.log.add(this.day, 'day', `${expelled}号白痴已翻牌，免疫放逐`);
        return { expelled: null, idiotFlipped: null, isTie: false, voteCounts, maxVoted };
      } else {
        victim.alive = false;
        this.log.add(this.day, 'day', `${expelled}号(${victim.role})被投票放逐`);
      }
    }

    return { expelled, idiotFlipped: null, isTie, voteCounts, maxVoted };
  }

  /**
   * 猎人开枪
   * @param {number} hunterId - 猎人ID
   * @param {number} targetId - 枪杀目标
   */
  executeHunterShot(hunterId, targetId) {
    const hunter = this.players[hunterId];
    if (!hunter || hunter.role !== ROLES.HUNTER || hunter.alive) return null;
    
    // 检查是否被毒杀
    if (hunter.witchPoisoned) {
      this.log.add(this.day, 'day', `猎人被毒杀，无法开枪`);
      return null;
    }

    const target = this.players[targetId];
    if (target && target.alive) {
      target.alive = false;
      this.log.add(this.day, 'day', `猎人开枪带走${targetId}号(${target.role})`);
      return { id: targetId, role: target.role };
    }
    return null;
  }

  // ========== 胜负判定 ==========

  checkWinCondition() {
    const aliveWolves = this.getAliveWerewolves().length;
    const aliveGods = this.getAliveGods().length;
    const aliveVillagers = this.getAliveVillagers().length;
    const aliveGood = this.getAlivePlayersByFaction(FACTIONS.GOOD).length;

    // 好人胜利：所有狼人死亡
    if (aliveWolves === 0) {
      this.gameOver = true;
      this.winner = FACTIONS.GOOD;
      this.log.add(this.day, 'end', `好人阵营胜利！所有狼人被消灭`);
      return { gameOver: true, winner: FACTIONS.GOOD, reason: 'all_wolves_dead' };
    }

    // 狼人胜利(屠边)：杀光所有神职 或 杀光所有平民
    if (aliveGods === 0) {
      this.gameOver = true;
      this.winner = FACTIONS.EVIL;
      this.log.add(this.day, 'end', `狼人阵营胜利(屠神)！所有神职被消灭`);
      return { gameOver: true, winner: FACTIONS.EVIL, reason: 'all_gods_dead' };
    }

    if (aliveVillagers === 0) {
      this.gameOver = true;
      this.winner = FACTIONS.EVIL;
      this.log.add(this.day, 'end', `狼人阵营胜利(屠民)！所有平民被消灭`);
      return { gameOver: true, winner: FACTIONS.EVIL, reason: 'all_villagers_dead' };
    }

    // 安全阀：超过20天算平局
    if (this.day > 20) {
      this.gameOver = true;
      this.winner = null;
      this.log.add(this.day, 'end', `超过20天，流局`);
      return { gameOver: true, winner: null, reason: 'draw' };
    }

    return { gameOver: false };
  }

  // ========== 辅助方法 ==========

  _findAlivePlayerByRole(role) {
    return this.players.find(p => p.role === role && p.alive);
  }

  getPlayerInfo(id) {
    const p = this.players[id];
    return {
      id: p.id,
      role: p.role,
      faction: p.faction,
      alive: p.alive,
      isGod: p.isGod,
      sheriff: p.sheriff,
      idiotFlipped: p.idiotFlipped
    };
  }

  // 获取所有玩家信息(调试用)
  getAllPlayerInfo() {
    return this.players.map(p => ({
      id: p.id,
      role: p.role,
      faction: p.faction,
      alive: p.alive
    }));
  }
}

// Node.js 导出
if (typeof module !== 'undefined') {
  module.exports = { WerewolfEngine, ROLES, FACTIONS, STANDARD_CONFIG, Player };
}

// ============ 浏览器端全局导出 ============
if (typeof window !== 'undefined') {
  window.WW = window.WW || {};
  window.WW.Engine = { WerewolfEngine, ROLES, FACTIONS, STANDARD_CONFIG, Player };
}

})();
