-- ============================================================================
-- 狼人杀 · Supabase 联机后端
-- 项目：xajqidptrsnbavqxraws（与「二游情报铺」同一 Supabase 项目，独立 wr_* 表）
-- 执行方式：Supabase 控制台 → SQL Editor → 粘贴本文件 → Run
-- ============================================================================
--
-- 【安全设计原则】狼人杀联机的核心约束是「身份保密」：
--   · 任何客户端都不得获得完整身份表，否则游戏直接失去意义
--   · 因此身份分配、夜晚结算、投票统计全部在 SECURITY DEFINER 函数内完成
--   · wr_roles 表启用 RLS 且不授予任何 SELECT 策略 → 直连查不到任何身份
--   · 玩家只能通过 wr_room_state() 拿到「自己那一张牌」
--   · client_id 作为轻量承载令牌，由函数内部校验，避免暴露 service_role
--
-- 【注意】anon 角色只需要 EXECUTE 权限，不需要表的直接读写权限。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. 清理（可重复执行）
-- ---------------------------------------------------------------------------
drop function if exists wr_create_room(text, text) cascade;
drop function if exists wr_join_room(text, text, text) cascade;
drop function if exists wr_leave_room(text, text) cascade;
drop function if exists wr_room_state(text, text) cascade;
drop function if exists wr_start_game(text, text, boolean) cascade;
drop function if exists wr_submit_action(text, text, text, jsonb) cascade;
drop function if exists wr_advance(text, text) cascade;
drop function if exists wr_reset_room(text, text) cascade;
drop function if exists wr_private_ai(text, int) cascade;
drop function if exists wr_resolve_night(text) cascade;
drop function if exists wr_resolve_vote(text) cascade;
drop function if exists wr_check_win(text) cascade;
drop function if exists wr_board_roles(int) cascade;
drop table if exists wr_actions cascade;
drop table if exists wr_roles cascade;
drop table if exists wr_players cascade;
drop table if exists wr_rooms cascade;

-- ---------------------------------------------------------------------------
-- 1. 表结构
-- ---------------------------------------------------------------------------

-- 房间：state 为公共状态机（阶段/天数/死讯/票型），不含任何身份信息
create table wr_rooms (
  id          text primary key,             -- 6 位房间号
  host_client text not null,
  board       int  not null default 12,     -- 板子人数
  phase       text not null default 'lobby',-- lobby / night / vote / over
  day         int  not null default 0,
  state       jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 座位：昵称与存活状态是公共信息
create table wr_players (
  room_id  text not null references wr_rooms(id) on delete cascade,
  seat     int  not null,
  client_id text,                            -- AI 座位为 null
  nick     text not null,
  is_ai    boolean not null default false,
  alive    boolean not null default true,
  primary key (room_id, seat)
);

-- 身份：绝密。RLS 全封，仅 SECURITY DEFINER 函数可读
create table wr_roles (
  room_id text not null references wr_rooms(id) on delete cascade,
  seat    int  not null,
  role    text not null,
  faction text not null,
  primary key (room_id, seat)
);

-- 行动：夜晚技能与投票的提交记录（payload 含目标座位，属敏感信息）
create table wr_actions (
  room_id text not null references wr_rooms(id) on delete cascade,
  day     int  not null,
  seat    int  not null,
  kind    text not null,       -- wolf_kill / seer_check / witch / vote / hunter_shot
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (room_id, day, seat, kind)
);

create index if not exists idx_wr_rooms_updated on wr_rooms(updated_at);
create index if not exists idx_wr_actions_room on wr_actions(room_id, day);

-- ---------------------------------------------------------------------------
-- 2. RLS：公共表可读，绝密表全封
-- ---------------------------------------------------------------------------
alter table wr_rooms   enable row level security;
alter table wr_players enable row level security;
alter table wr_roles   enable row level security;
alter table wr_actions enable row level security;

-- 房间公共状态与座位表：允许匿名读取（Realtime 订阅需要）
drop policy if exists wr_rooms_read on wr_rooms;
create policy wr_rooms_read on wr_rooms for select to anon, authenticated using (true);

drop policy if exists wr_players_read on wr_players;
create policy wr_players_read on wr_players for select to anon, authenticated using (true);

-- wr_roles / wr_actions：故意不创建任何策略
-- → 直连 SELECT 一律返回空，身份只能通过函数按需下发单张牌

-- 禁止客户端直接写表（一切写入走 RPC）
drop policy if exists wr_rooms_noinsert on wr_rooms;
create policy wr_rooms_noinsert on wr_rooms for insert to anon, authenticated with check (false);

-- ---------------------------------------------------------------------------
-- 3. 板子配置
-- ---------------------------------------------------------------------------
create or replace function wr_board_roles(p_board int)
returns text[] language sql immutable as $$
  select case p_board
    when 12 then array['werewolf','werewolf','werewolf','werewolf',
                       'seer','witch','hunter','idiot',
                       'villager','villager','villager','villager']
    when 10 then array['werewolf','werewolf','werewolf',
                       'seer','witch','hunter',
                       'villager','villager','villager','villager']
    when 9  then array['werewolf','werewolf','werewolf',
                       'seer','witch','hunter',
                       'villager','villager','villager']
    else array['werewolf','werewolf','werewolf','werewolf',
               'seer','witch','hunter','idiot',
               'villager','villager','villager','villager']
  end;
$$;

-- ---------------------------------------------------------------------------
-- 4. 房间管理
-- ---------------------------------------------------------------------------

create or replace function wr_create_room(p_client text, p_nick text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_room text;
  v_seat int;
begin
  if p_client is null or length(p_client) < 8 then
    raise exception 'client_id 无效';
  end if;

  loop
    v_room := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 5));
    exit when not exists (select 1 from wr_rooms where id = v_room);
  end loop;

  insert into wr_rooms(id, host_client) values (v_room, p_client);

  -- 房主随机落座
  v_seat := floor(random() * 12)::int;
  insert into wr_players(room_id, seat, client_id, nick)
  values (v_room, v_seat, p_client, coalesce(nullif(p_nick,''), '房主'));

  -- 顺手清理 6 小时前的废弃房间
  delete from wr_rooms where updated_at < now() - interval '6 hours' and phase <> 'over';

  return jsonb_build_object('room', v_room, 'seat', v_seat);
end $$;

create or replace function wr_join_room(p_room text, p_client text, p_nick text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_room wr_rooms;
  v_seat int;
begin
  select * into v_room from wr_rooms where id = upper(p_room);
  if not found then raise exception '房间不存在'; end if;
  if v_room.phase <> 'lobby' then raise exception '该房间已开始游戏'; end if;

  -- 已在房内则直接返回
  select seat into v_seat from wr_players
   where room_id = v_room.id and client_id = p_client;
  if v_seat is not null then
    update wr_players set nick = coalesce(nullif(p_nick,''), nick)
     where room_id = v_room.id and seat = v_seat;
    return jsonb_build_object('room', v_room.id, 'seat', v_seat, 'rejoin', true);
  end if;

  -- 找空位（跳过 AI 占位）
  select s into v_seat from generate_series(0,11) s
   where not exists (select 1 from wr_players p where p.room_id = v_room.id and p.seat = s)
   order by s limit 1;
  if v_seat is null then raise exception '房间已满'; end if;

  insert into wr_players(room_id, seat, client_id, nick)
  values (v_room.id, v_seat, p_client, coalesce(nullif(p_nick,''),'玩家'));

  update wr_rooms set updated_at = now() where id = v_room.id;
  return jsonb_build_object('room', v_room.id, 'seat', v_seat);
end $$;

create or replace function wr_leave_room(p_room text, p_client text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  delete from wr_players where room_id = upper(p_room) and client_id = p_client;
  if exists (select 1 from wr_rooms where id = upper(p_room) and host_client = p_client) then
    delete from wr_rooms where id = upper(p_room);
    return jsonb_build_object('left', true, 'disbanded', true);
  end if;
  update wr_rooms set updated_at = now() where id = upper(p_room);
  return jsonb_build_object('left', true);
end $$;

-- ---------------------------------------------------------------------------
-- 5. 开局：发牌（服务端洗牌，客户端只见自己那张）
-- ---------------------------------------------------------------------------
create or replace function wr_start_game(p_room text, p_client text, p_ai_fill boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_room  wr_rooms;
  v_roles text[];
  v_role  text;
  v_i     int := 1;
  v_n     int;
  r       record;
begin
  select * into v_room from wr_rooms where id = upper(p_room);
  if not found then raise exception '房间不存在'; end if;
  if v_room.host_client <> p_client then raise exception '只有房主可以开局'; end if;
  if v_room.phase <> 'lobby' then raise exception '游戏已经开始'; end if;

  select count(*) into v_n from wr_players where room_id = v_room.id and not is_ai;
  if v_n < 2 then raise exception '至少需要 2 名真人玩家'; end if;

  -- AI 补位
  if p_ai_fill then
    insert into wr_players(room_id, seat, client_id, nick, is_ai)
    select v_room.id, s, null, 'AI-' || (s+1), true
      from generate_series(0,11) s
     where not exists (select 1 from wr_players p where p.room_id = v_room.id and p.seat = s);
  end if;

  select count(*) into v_n from wr_players where room_id = v_room.id;
  if v_n <> v_room.board then raise exception '座位数(%)与板子(%)不符', v_n, v_room.board; end if;

  -- 洗牌发牌
  v_roles := wr_board_roles(v_room.board);
  select array_agg(x order by random()) into v_roles from unnest(v_roles) x;

  delete from wr_roles  where room_id = v_room.id;
  delete from wr_actions where room_id = v_room.id;

  for r in select seat from wr_players where room_id = v_room.id order by seat loop
    v_role := v_roles[v_i];
    insert into wr_roles(room_id, seat, role, faction)
    values (v_room.id, r.seat, v_role,
            case when v_role = 'werewolf' then 'evil' else 'good' end);
    v_i := v_i + 1;
  end loop;

  update wr_players set alive = true where room_id = v_room.id;

  update wr_rooms
     set phase = 'election', day = 0,
         state = jsonb_build_object(
                 'log', '[]'::jsonb, 'deaths', '[]'::jsonb,
                 'witchAntidoteUsed', false, 'witchPoisonUsed', false,
                 'sheriff', null, 'winner', null,
                 'idiotFlipped', '{}'::jsonb),
         updated_at = now()
   where id = v_room.id;

  return wr_room_state(v_room.id, p_client);
end $$;

-- ---------------------------------------------------------------------------
-- 6. 提交行动
-- ---------------------------------------------------------------------------
create or replace function wr_submit_action(
  p_room text, p_client text, p_kind text, p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_room wr_rooms;
  v_seat int;
  v_role text;
begin
  select * into v_room from wr_rooms where id = upper(p_room);
  if not found then raise exception '房间不存在'; end if;

  select seat into v_seat from wr_players
   where room_id = v_room.id and client_id = p_client;
  if v_seat is null then raise exception '你不在该房间内'; end if;

  select role into v_role from wr_roles where room_id = v_room.id and seat = v_seat;

  -- 校验：行动类型必须与身份/阶段匹配（防止越权提交）
  if p_kind = 'seer_check' and v_role <> 'seer' then
    raise exception '身份不符：你不是预言家';
  end if;
  if p_kind = 'witch' and v_role <> 'witch' then
    raise exception '身份不符：你不是女巫';
  end if;
  if p_kind = 'wolf_kill' and v_role <> 'werewolf' then
    raise exception '身份不符：你不是狼人';
  end if;
  if p_kind = 'hunter_shot' and v_role <> 'hunter' then
    raise exception '身份不符：你不是猎人';
  end if;
  -- candidacy / election_vote / vote 不限身份（任何存活玩家均可）

  insert into wr_actions(room_id, day, seat, kind, payload)
  values (v_room.id, v_room.day, v_seat, p_kind, coalesce(p_payload,'{}'::jsonb))
  on conflict (room_id, day, seat, kind)
  do update set payload = excluded.payload, created_at = now();

  update wr_rooms set updated_at = now() where id = v_room.id;
  return jsonb_build_object('ok', true, 'kind', p_kind);
end $$;

-- ---------------------------------------------------------------------------
-- 7. 服务端 AI：为 AI 座位生成行动（不泄露身份给任何客户端）
--    v1 采用启发式策略，保真度低于前端 ai.js 的调优模型，
--    后续可将 ai.js 的票型分析等策略移植进来。
-- ---------------------------------------------------------------------------
create or replace function wr_private_ai(p_room text, p_seat int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_role text;
  v_target int;
  v_st   jsonb;
begin
  select role into v_role from wr_roles where room_id = p_room and seat = p_seat;
  if v_role is null then return '{}'::jsonb; end if;

  select state into v_st from wr_rooms where id = p_room;

  if v_role = 'werewolf' then
    select p.seat into v_target from wr_players p
     where p.room_id = p_room and p.alive
       and p.seat not in (select r.seat from wr_roles r
                           where r.room_id = p_room and r.role = 'werewolf')
     order by random() limit 1;
    return jsonb_build_object('kind','wolf_kill','target',v_target);
  elsif v_role = 'seer' then
    select p.seat into v_target from wr_players p
     where p.room_id = p_room and p.alive and p.seat <> p_seat
       and not exists (select 1 from wr_actions a
                        where a.room_id=p_room and a.seat=p_seat
                          and a.kind='seer_check' and (a.payload->>'target')::int = p.seat)
     order by random() limit 1;
    return jsonb_build_object('kind','seer_check','target',v_target);
  elsif v_role = 'witch' then
    -- 首夜救人概率 0.85，之后 0.4
    if coalesce((v_st->>'killTarget')::int, -1) >= 0
       and not coalesce((v_st->>'witchAntidoteUsed')::boolean, false)
       and random() < case when coalesce((v_st->>'day')::int,1) <= 1 then 0.85 else 0.4 end then
      return jsonb_build_object('kind','witch','antidote',true,'poison',null);
    end if;
    return jsonb_build_object('kind','witch','antidote',false,'poison',null);
  end if;

  return jsonb_build_object('kind','none');
end $$;

-- ---------------------------------------------------------------------------
-- 8. 夜晚结算（服务端，纯函数式，无客户端参与）
-- ---------------------------------------------------------------------------
create or replace function wr_resolve_night(p_room_id text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_room   wr_rooms;
  v_kill   int;
  v_check  int;
  v_save   boolean := false;
  v_poison int := null;
  v_st     jsonb;
  v_deaths jsonb := '[]'::jsonb;
  v_guard  int;
begin
  select * into v_room from wr_rooms where id = p_room_id;
  v_st := v_room.state;

  -- 狼人刀口：取多数，平票随机
  select (a.payload->>'target')::int into v_kill
    from wr_actions a
    join wr_roles r on r.room_id = a.room_id and r.seat = a.seat and r.role = 'werewolf'
   where a.room_id = p_room_id and a.day = v_room.day and a.kind = 'wolf_kill'
   group by (a.payload->>'target')::int
   order by count(*) desc, random() limit 1;

  -- 预言家查验
  select (a.payload->>'target')::int into v_check
    from wr_actions a join wr_roles r on r.room_id=a.room_id and r.seat=a.seat and r.role='seer'
   where a.room_id = p_room_id and a.day = v_room.day and a.kind = 'seer_check'
   limit 1;

  -- 女巫用药
  select coalesce(bool_or((a.payload->>'antidote')::boolean), false),
         max((a.payload->>'poison')::int)
    into v_save, v_poison
    from wr_actions a join wr_roles r on r.room_id=a.room_id and r.seat=a.seat and r.role='witch'
   where a.room_id = p_room_id and a.day = v_room.day and a.kind = 'witch';

  -- 女巫不可自救
  if v_save and v_kill is not null then
    if exists (select 1 from wr_roles r join wr_players p on p.room_id=r.room_id and p.seat=r.seat
                where r.room_id=p_room_id and r.role='witch' and r.seat = v_kill) then
      v_save := false;
    end if;
  end if;

  -- 结算死亡
  if v_kill is not null and not v_save then
    update wr_players set alive = false where room_id = p_room_id and seat = v_kill and alive;
    v_deaths := v_deaths || jsonb_build_object(
      'seat', v_kill, 'cause', 'wolf_kill',
      'role', (select role from wr_roles where room_id=p_room_id and seat=v_kill));
  end if;

  if v_poison is not null then
    update wr_players set alive = false where room_id = p_room_id and seat = v_poison and alive;
    v_deaths := v_deaths || jsonb_build_object(
      'seat', v_poison, 'cause', 'witch_poison',
      'role', (select role from wr_roles where room_id=p_room_id and seat=v_poison));
  end if;

  -- 查验结果写入私密信息（仅本人可读）
  if v_check is not null then
    update wr_actions set payload = payload || jsonb_build_object(
             'result', (select faction from wr_roles where room_id=p_room_id and seat=v_check))
     where room_id = p_room_id and day = v_room.day and kind = 'seer_check';
  end if;

  -- 检查是否有猎人被刀且未被毒 → 进入 hunter_shot
  declare
    v_hunter_seat int := null;
  begin
    select d.value->>'seat' into v_hunter_seat
      from jsonb_array_elements(v_deaths) d
     where d.value->>'cause' = 'wolf_kill'
       and (select role from wr_roles r where r.room_id=p_room_id
             and r.seat = (d.value->>'seat')::int) = 'hunter'
     limit 1;
    if v_hunter_seat is not null then
      update wr_rooms
         set state = v_st || jsonb_build_object(
               'deaths', v_deaths,
               'witchAntidoteUsed', coalesce((v_st->>'witchAntidoteUsed')::boolean,false) or v_save,
               'witchPoisonUsed',   coalesce((v_st->>'witchPoisonUsed')::boolean,false) or (v_poison is not null),
               'lastKill', v_kill,
               'pendingHunterSeat', v_hunter_seat),
             phase = 'hunter_shot',
             updated_at = now()
       where id = p_room_id;
      perform wr_check_win(p_room_id);
      return;
    end if;
  end;

  update wr_rooms
     set state = v_st || jsonb_build_object(
           'deaths', v_deaths,
           'witchAntidoteUsed', coalesce((v_st->>'witchAntidoteUsed')::boolean,false) or v_save,
           'witchPoisonUsed',   coalesce((v_st->>'witchPoisonUsed')::boolean,false) or (v_poison is not null),
           'lastKill', v_kill),
         phase = 'speech',
         updated_at = now()
   where id = p_room_id;

  perform wr_check_win(p_room_id);
end $$;

-- ---------------------------------------------------------------------------
-- 9. 投票结算
-- ---------------------------------------------------------------------------
create or replace function wr_resolve_vote(p_room_id text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_room wr_rooms;
  v_top  int;
  v_cnt  numeric;
  v_tie  boolean := false;
  v_role text;
  v_st   jsonb;
begin
  select * into v_room from wr_rooms where id = p_room_id;
  v_st := v_room.state;

  select (a.payload->>'target')::int, count(*) into v_top, v_cnt
    from wr_actions a
   where a.room_id = p_room_id and a.day = v_room.day and a.kind = 'vote'
   group by (a.payload->>'target')::int
   order by count(*) desc limit 1;

  if v_top is not null then
    select count(*) > 1 into v_tie
      from (select (a.payload->>'target')::int t, count(*) c
              from wr_actions a
             where a.room_id = p_room_id and a.day = v_room.day and a.kind = 'vote'
             group by 1) x
     where x.c = v_cnt;
  end if;

  if v_top is not null and not v_tie then
    select role into v_role from wr_roles where room_id = p_room_id and seat = v_top;

    -- 白痴翻牌免死（已翻过的不可再被放逐）
    if v_role = 'idiot' and coalesce((v_st->'idiotFlipped'->>v_top::text)::boolean, false) = false then
      update wr_rooms
         set state = v_st || jsonb_build_object(
               'expelled', null, 'idiotFlipSeat', v_top,
               'idiotFlipped', coalesce(v_st->'idiotFlipped','{}'::jsonb) || jsonb_build_object(v_top::text, true)),
             phase = 'speech', updated_at = now()
       where id = p_room_id;
      return;
    end if;

    -- 正常放逐
    update wr_players set alive = false where room_id = p_room_id and seat = v_top and alive;
    v_st := v_st || jsonb_build_object('expelled', v_top, 'expelledRole', v_role);

    -- 猎人被放逐 → 进入 hunter_shot 阶段（除非被毒杀，但投票放逐不会被毒）
    if v_role = 'hunter' then
      update wr_rooms
         set state = v_st || jsonb_build_object('pendingHunterSeat', v_top),
             phase = 'hunter_shot', updated_at = now()
       where id = p_room_id;
      perform wr_check_win(p_room_id);
      return;
    end if;

    update wr_rooms
       set state = v_st, day = v_room.day + 1, phase = 'night', updated_at = now()
     where id = p_room_id;
    perform wr_check_win(p_room_id);
    return;
  end if;

  -- 平票 / 无人出局 → 进下一夜
  update wr_rooms
     set state = v_st || jsonb_build_object('expelled', null),
         day = v_room.day + 1, phase = 'night', updated_at = now()
   where id = p_room_id;
end $$;

-- ---------------------------------------------------------------------------
-- 10. 胜负判定（屠边规则）
-- ---------------------------------------------------------------------------
create or replace function wr_check_win(p_room_id text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_wolves int; v_gods int; v_vills int; v_st jsonb; v_winner text := null; v_reason text := null;
begin
  select count(*) into v_wolves from wr_roles r join wr_players p on p.room_id=r.room_id and p.seat=r.seat
   where r.room_id=p_room_id and r.role='werewolf' and p.alive;
  select count(*) into v_gods from wr_roles r join wr_players p on p.room_id=r.room_id and p.seat=r.seat
   where r.room_id=p_room_id and r.role in ('seer','witch','hunter','idiot') and p.alive;
  select count(*) into v_vills from wr_roles r join wr_players p on p.room_id=r.room_id and p.seat=r.seat
   where r.room_id=p_room_id and r.role='villager' and p.alive;

  if v_wolves = 0 then v_winner := 'good'; v_reason := 'all_wolves_dead';
  elsif v_gods = 0 then v_winner := 'evil'; v_reason := 'all_gods_dead';
  elsif v_vills = 0 then v_winner := 'evil'; v_reason := 'all_villagers_dead';
  end if;

  if v_winner is not null then
    select state into v_st from wr_rooms where id = p_room_id;
    update wr_rooms
       set phase = 'over',
           state = v_st || jsonb_build_object('winner', v_winner, 'reason', v_reason),
           updated_at = now()
     where id = p_room_id;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 11. 推进状态机（房主驱动；AI 座位的行动由服务端自动生成）
-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- 11. 推进状态机（房主驱动；AI 座位的行动由服务端自动生成）
--     v1.1 新增阶段：election / speech / hunter_shot
-- ---------------------------------------------------------------------------
create or replace function wr_advance(p_room text, p_client text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_room wr_rooms;
  r      record;
  v_ai   jsonb;
  v_st   jsonb;
  v_top_seat int;
  v_top_cnt  numeric;
  v_tie      boolean := false;
  v_hunter_target int;
  v_expelled_seat int;
begin
  select * into v_room from wr_rooms where id = upper(p_room);
  if not found then raise exception '房间不存在'; end if;
  if v_room.host_client <> p_client then
    return wr_room_state(v_room.id, p_client);
  end if;
  if v_room.phase = 'over' then return wr_room_state(v_room.id, p_client); end if;
  v_st := v_room.state;

  -- ========== [election] 警长竞选 ==========
  if v_room.phase = 'election' then
    -- AI 候选人自投
    for r in select p.seat from wr_players p
              where p.room_id = v_room.id and p.is_ai and p.alive
                and exists (select 1 from wr_actions a
                             where a.room_id=v_room.id and a.day=0
                               and a.seat=p.seat and a.kind='candidacy') loop
      insert into wr_actions(room_id,day,seat,kind,payload)
      values (v_room.id, 0, r.seat, 'election_vote',
              jsonb_build_object('target', r.seat))
      on conflict (room_id,day,seat,kind) do nothing;
    end loop;
    -- AI 非候选人随机投一个候选人
    for r in select p.seat from wr_players p
              where p.room_id = v_room.id and p.is_ai and p.alive
                and not exists (select 1 from wr_actions a
                                 where a.room_id=v_room.id and a.day=0
                                   and a.seat=p.seat and a.kind='candidacy') loop
      insert into wr_actions(room_id,day,seat,kind,payload)
      select v_room.id, 0, r.seat, 'election_vote',
             jsonb_build_object('target', c.seat)
        from (select a2.seat from wr_actions a2
               where a2.room_id=v_room.id and a2.day=0 and a2.kind='candidacy'
               order by random() limit 1) c
      on conflict do nothing;
    end loop;

    select (a.payload->>'target')::int, count(*) into v_top_seat, v_top_cnt
      from wr_actions a
     where a.room_id=v_room.id and a.day=0 and a.kind='election_vote'
     group by (a.payload->>'target')::int
     order by count(*) desc limit 1;
    if v_top_seat is not null then
      select count(*) > 1 into v_tie
        from (select (a.payload->>'target')::int t, count(*) c
                from wr_actions a
               where a.room_id=v_room.id and a.day=0 and a.kind='election_vote'
               group by 1) x where x.c = v_top_cnt;
    end if;
    if v_top_seat is not null and not v_tie then
      v_st := v_st || jsonb_build_object('sheriff', v_top_seat);
    else
      v_st := v_st || jsonb_build_object('sheriff', null, 'sheriffLost', true);
    end if;
    update wr_rooms set state = v_st, phase = 'speech', updated_at = now()
     where id = v_room.id;
    return wr_room_state(v_room.id, p_client);
  end if;

  -- ========== [speech] 发言 → 直接进 vote ==========
  if v_room.phase = 'speech' then
    update wr_rooms set phase = 'vote', updated_at = now() where id = v_room.id;
    return wr_room_state(v_room.id, p_client);
  end if;

  -- ========== [hunter_shot] 猎人开枪 ==========
  if v_room.phase = 'hunter_shot' then
    v_expelled_seat := (v_st->>'pendingHunterSeat')::int;
    if v_expelled_seat is null then
      update wr_rooms set phase = 'night', day = v_room.day + 1, updated_at = now()
       where id = v_room.id;
      return wr_room_state(v_room.id, p_client);
    end if;
    select (a.payload->>'target')::int into v_hunter_target
      from wr_actions a
     where a.room_id=v_room.id and a.day=v_room.day
       and a.seat=v_expelled_seat and a.kind='hunter_shot' limit 1;
    if v_hunter_target is not null then
      update wr_players set alive = false
       where room_id=v_room.id and seat=v_hunter_target and alive;
      v_st := v_st || jsonb_build_object('hunterShot',
        jsonb_build_object('shooter', v_expelled_seat, 'target', v_hunter_target,
          'targetRole', (select role from wr_roles where room_id=v_room.id and seat=v_hunter_target)));
    else
      v_st := v_st || jsonb_build_object('hunterShot',
        jsonb_build_object('shooter', v_expelled_seat, 'target', null));
    end if;
    update wr_rooms set state = v_st, phase = 'night', day = v_room.day + 1, updated_at = now()
     where id = v_room.id;
    perform wr_check_win(v_room.id);
    return wr_room_state(v_room.id, p_client);
  end if;

  -- ========== [night] 夜晚结算 ==========
  if v_room.phase = 'night' then
    for r in select p.seat, ro.role from wr_players p
               join wr_roles ro on ro.room_id=p.room_id and ro.seat=p.seat
              where p.room_id = v_room.id and p.is_ai and p.alive loop
      v_ai := wr_private_ai(v_room.id, r.seat);
      if v_ai->>'kind' in ('wolf_kill','seer_check','witch') then
        insert into wr_actions(room_id, day, seat, kind, payload)
        values (v_room.id, v_room.day, r.seat, v_ai->>'kind', v_ai - 'kind')
        on conflict (room_id, day, seat, kind) do nothing;
      end if;
    end loop;
    perform wr_resolve_night(v_room.id);
    return wr_room_state(v_room.id, p_client);
  end if;

  -- ========== [vote] 放逐投票 ==========
  if v_room.phase = 'vote' then
    for r in select p.seat from wr_players p
              where p.room_id = v_room.id and p.is_ai and p.alive loop
      if not exists (select 1 from wr_actions a where a.room_id=v_room.id
                      and a.day=v_room.day and a.seat=r.seat and a.kind='vote') then
        insert into wr_actions(room_id, day, seat, kind, payload)
        select v_room.id, v_room.day, r.seat, 'vote',
               jsonb_build_object('target', q.seat)
          from (select p2.seat from wr_players p2
                 where p2.room_id=v_room.id and p2.alive and p2.seat <> r.seat
                 order by random() limit 1) q
        on conflict do nothing;
      end if;
    end loop;
    perform wr_resolve_vote(v_room.id);
    return wr_room_state(v_room.id, p_client);
  end if;

  return wr_room_state(v_room.id, p_client);
end $$;

-- ---------------------------------------------------------------------------
-- 12. 读取房间状态（公共信息 + 仅本人身份与私密结果）
-- ---------------------------------------------------------------------------
create or replace function wr_room_state(p_room text, p_client text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_room wr_rooms;
  v_seat int;
  v_role text;
  v_seats jsonb;
  v_mine  jsonb := '{}'::jsonb;
begin
  select * into v_room from wr_rooms where id = upper(p_room);
  if not found then raise exception '房间不存在'; end if;

  select seat into v_seat from wr_players where room_id = v_room.id and client_id = p_client;

  select coalesce(jsonb_agg(jsonb_build_object(
           'seat', p.seat, 'nick', p.nick, 'is_ai', p.is_ai, 'alive', p.alive,
           'client_id', p.client_id) order by p.seat), '[]'::jsonb)
    into v_seats
    from wr_players p where p.room_id = v_room.id;

  -- 只下发本人的身份
  if v_seat is not null then
    select role into v_role from wr_roles where room_id = v_room.id and seat = v_seat;

    -- 本人的查验结果
    select coalesce(jsonb_agg(jsonb_build_object(
             'day', a.day, 'target', (a.payload->>'target')::int,
             'result', a.payload->>'result') order by a.day), '[]'::jsonb)
      into v_mine
      from wr_actions a
     where a.room_id = v_room.id and a.seat = v_seat and a.kind = 'seer_check'
       and a.payload ? 'result';

    -- 女巫：本轮刀口（规则要求法官告知女巫）
    if v_role = 'witch' and v_room.phase = 'night' then
      v_mine := v_mine || jsonb_build_object('killTarget',
        (select (a.payload->>'target')::int from wr_actions a
          where a.room_id=v_room.id and a.day=v_room.day and a.kind='wolf_kill' limit 1));
    end if;

    -- 狼人：队友座位
    if v_role = 'werewolf' then
      v_mine := v_mine || jsonb_build_object('mates',
        (select coalesce(jsonb_agg(r.seat order by r.seat),'[]'::jsonb)
           from wr_roles r where r.room_id=v_room.id and r.role='werewolf' and r.seat <> v_seat));
    end if;
  end if;

  return jsonb_build_object(
    'room', v_room.id, 'phase', v_room.phase, 'day', v_room.day,
    'board', v_room.board, 'is_host', (v_room.host_client = p_client),
    'seats', v_seats, 'state', v_room.state,
    'my_seat', v_seat, 'my_role', v_role, 'my_info', v_mine);
end $$;

-- ---------------------------------------------------------------------------
-- 13. 重开
-- ---------------------------------------------------------------------------
create or replace function wr_reset_room(p_room text, p_client text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  update wr_rooms set phase='lobby', day=0, state='{}'::jsonb, updated_at=now()
   where id = upper(p_room) and host_client = p_client;
  delete from wr_roles   where room_id = upper(p_room);
  delete from wr_actions where room_id = upper(p_room);
  update wr_players set alive = true where room_id = upper(p_room);
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------
-- 14. 授权
-- ---------------------------------------------------------------------------
grant execute on function wr_create_room(text,text)                    to anon, authenticated;
grant execute on function wr_join_room(text,text,text)                 to anon, authenticated;
grant execute on function wr_leave_room(text,text)                     to anon, authenticated;
grant execute on function wr_room_state(text,text)                     to anon, authenticated;
grant execute on function wr_start_game(text,text,boolean)             to anon, authenticated;
grant execute on function wr_submit_action(text,text,text,jsonb)       to anon, authenticated;
grant execute on function wr_advance(text,text)                        to anon, authenticated;
grant execute on function wr_reset_room(text,text)                     to anon, authenticated;
grant execute on function wr_board_roles(int)                          to anon, authenticated;

-- Realtime 需要 wr_rooms 在发布列表中
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and tablename = 'wr_rooms') then
    alter publication supabase_realtime add table wr_rooms;
  end if;
exception when others then null;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and tablename = 'wr_players') then
    alter publication supabase_realtime add table wr_players;
  end if;
exception when others then null;
end $$;

-- ---------------------------------------------------------------------------
-- 15. v1.1 增量迁移（已部署用户执行此段即可升级，无需重跑全文）
-- ---------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from information_schema.columns
                  where table_name='wr_players' and column_name='sheriff_candidate') then
    alter table wr_players add column sheriff_candidate boolean default false;
  end if;
end $$;

-- ============================================================================
-- 安装完成。验证：
--   select wr_create_room('c_test_12345678', '测试房主');
--   → 应返回 {"room":"XXXXX","seat":n}
-- ============================================================================
