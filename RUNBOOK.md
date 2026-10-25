# 狼人杀 · 技术部署手册

> 庸人工作室 · 狼人杀网页游戏
> 本手册与「游戏画面与人物动画制作」任务共享记忆库。

## 0. 基本信息

- 项目名：狼人杀（12 人标准局「预女猎白」）
- 版本：v1.0.0
- 仓库：https://github.com/xvlain/werewolf （main 分支）
- Pages 地址：https://xvlain.github.io/werewolf/
- Supabase 项目：`xajqidptrsnbavqxraws`（与「二游情报铺」同一项目，**独立 `wr_*` 表**）
- Supabase URL：`https://xajqidptrsnbavqxraws.supabase.co`
- 本地工程目录：`/root/userdata/workspace/werewolf-site/`
- 算法研究目录：`/root/userdata/workspace/werewolf/`（引擎与 AI 的模拟验证原始工程）
- GitHub Token 路径：`/root/userdata/workspace/.secrets/github_token`

> ⚠️ 本项目**新建独立仓库**，未触碰 `xvlain/shop`（二游情报铺）与 `xvlain/game`（未定之旅），
> 两个既有站点不受任何影响。

## 1. 技术栈

- 前端：原生 HTML5 + CSS3 + JavaScript（零框架、零构建步骤）
- 脚本加载：classic `<script>` 标签（**非** ES Module），因此 `file://` 直接双击也能跑
- 后端：Supabase（PostgreSQL + RPC + RLS + Realtime）
- 部署：GitHub Pages（main 分支根目录）

## 2. 文件结构

```
werewolf-site/
├── index.html              # 入口：主菜单 / 大厅 / 对局 / 结算 / 规则 五屏
├── css/style.css           # 暗夜主题，12 座位环形布局，桌面+移动双端自适应
├── js/
│   ├── engine.js           # 规则引擎（纯结算，UMD 包装）
│   ├── ai.js               # AI 决策系统（记忆模型+公共信息板，UMD 包装）
│   ├── config.js           # Supabase 配置 + 板子配置（9/10/12 人）
│   ├── net.js              # 联机层：RPC 调用 + Realtime 订阅 + 轮询兜底
│   └── ui.js               # 渲染、第一人称交互、发言叙述层、对局编排
├── sql/
│   └── werewolf_schema.sql # 联机后端：表 + RLS + RPC 函数（需手动执行）
└── tools/
    ├── devtest.html        # 自动化冒烟测试（无头浏览器跑 6 局完整对局）
    └── shot.html           # 截图用测试页
```

## 3. 职责边界（重要）

| 层 | 只负责 | 绝不负责 |
|---|---|---|
| `engine.js` | 规则结算：技能生效、死亡判定、投票统计、胜负 | 任何策略决策 |
| `ai.js` | 决策数学：站边、票型分析、归票、用药时机 | 任何界面渲染 |
| `ui.js` | 把决策翻译成人话 + 渲染 + 人类玩家交互 | 游戏规则判定 |
| `net.js` | 与服务端通信 | 本地规则结算 |

**这个边界是刻意保持的**：引擎与 AI 已通过 15000 局模拟验证，
UI 层改动不会影响平衡性；反之调整 AI 参数也不会破坏界面。

## 4. 单机模式

开箱即用，无需任何后端。主菜单 →「单人对战」即可。

- 你随机获得 12 个座位中的一个，其余 11 位由 AI 扮演
- 默认**第一人称视角**：只能看到自己的身份与公共信息
- HUD 的 👁 按钮可随时切换**上帝观战模式**（显示全场身份，用于复盘调试）
- HUD 的 ⏩ 按钮切换速度：×1 → ×3 → ×6

## 5. 联机模式（需先初始化后端）

### 5.1 一次性初始化

1. 打开 Supabase 控制台 → 项目 `xajqidptrsnbavqxraws` → **SQL Editor**
2. 粘贴 `sql/werewolf_schema.sql` 全文 → **Run**
3. 验证：`select wr_create_room('c_test_12345678', '测试房主');`
   应返回 `{"room":"XXXXX","seat":n}`

> 我只有 anon 公开密钥，没有 service_role，**无法替你执行建表**。
> 这一步必须由你在控制台手动跑一次（和当初二游情报铺的 `*.sql` 流程一致）。
> 未执行前，联机大厅会明确提示「后端尚未初始化」，单机模式不受影响。

### 5.2 防作弊设计（狼人杀联机的第一约束）

身份一旦下发到客户端，游戏就失去意义。因此：

- `wr_roles` 表启用 RLS 且**不授予任何 SELECT 策略** → 直连查不到任何身份
- 身份分配、夜晚结算、投票统计全部在 `SECURITY DEFINER` 函数内完成
- 客户端只能通过 `wr_room_state()` 拿到**自己那一张牌**
- `wr_submit_action()` 内部校验「行动类型必须与身份匹配」，防止越权提交
- `client_id` 作为轻量承载令牌，由函数内部校验，避免暴露 service_role
- 女巫的刀口信息、狼人的队友座位，同样只下发给对应身份本人

### 5.3 同步机制

优先 Supabase **Realtime** 订阅 `wr_rooms` / `wr_players` 变更；
SDK 加载失败时自动降级为 **1.5s 轮询**，功能等价（回合制游戏对延迟不敏感）。

### 5.4 v1 已知范围限制

- 联机 AI 补位使用**服务端启发式策略**（`wr_private_ai`），保真度低于前端
  经过 15000 局调优的 `ai.js`。要让联机 AI 达到同等水平，需把票型分析等策略
  移植进 plpgsql，或改由「不参与对局的 AI 代理端」驱动 —— 列为 v1.1。
- 警长竞选、猎人开枪、白痴翻牌在联机侧尚未接入 `wr_advance` 状态机，
  当前联机 v1 覆盖：发牌 → 夜晚技能 → 放逐投票 → 胜负判定。

## 6. 部署流程（推送即上线）

```bash
cd /root/userdata/workspace/werewolf-site
git add -A
git commit -m "feat: <描述>"
git push origin main      # Pages 自动重建，约 1-2 分钟生效
```

## 7. 验证清单

改动后按顺序跑：

```bash
# 1. 语法检查
for f in js/*.js; do node --check "$f"; done

# 2. 算法回归（Node 侧，确认平衡性未被破坏）
cd ../werewolf && node simulator.js 1000 | grep -A1 "平衡性判定"

# 3. 浏览器端完整对局冒烟测试（6 局，双视角）
cd ../werewolf-site
google-chrome --headless=new --disable-gpu --no-sandbox \
  --disable-dev-shm-usage --user-data-dir=/tmp/cprof \
  --virtual-time-budget=180000 --dump-dom \
  "file://$PWD/tools/devtest.html" > /tmp/dom.html
# 期望 <title>TEST_PASS</title>
```

> ⚠️ Chrome 的 `--user-data-dir` **必须指向 /tmp**。
> 工作区文件系统不支持 SingletonLock，否则 Chrome 直接退出码 21。

## 8. 算法验证结论（已归档）

详见 `/root/userdata/workspace/werewolf/可行性验证报告.txt`。

- 15000 局模拟（三轮独立复核各 5000 局）
- 好人胜率 48.1% / 49.1% / 49.3%，稳定落在 45%–55% 健康区间
- 平均 4.34 天/局，76.7% 的对局在 4–5 天结束
- 单局模拟 0.16ms，浏览器实时运行无压力

## 9. 分工

- 技术：网站部署 / 代码实现 / 算法调优
- 美术：角色头像、座位框、技能图标、夜晚/白天氛围图（待补）
- 策划：板子扩展（守卫/骑士/狼美人等）、发言文案库

---

_最后更新：2026-10-25_
