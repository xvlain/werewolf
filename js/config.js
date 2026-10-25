/**
 * config.js — 全局配置
 *
 * 后端复用「二游情报铺」同一 Supabase 项目，但使用独立的 wr_* 表，
 * 与站点原有的 shop_* / device_codes 等表完全隔离，互不影响。
 */
window.WW = window.WW || {};

window.WW.Config = {
  // ---- Supabase（anon key 为公开密钥，按设计可嵌入前端）----
  supabase: {
    url: 'https://xajqidptrsnbavqxraws.supabase.co',
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhhanFpZHB0cnNuYmF2cXhyYXdzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcxMjI0ODAsImV4cCI6MjEwMjY5ODQ4MH0.MsdG-uCbLv3C8w43grFPcybaas-RT20nKPyNLV8afM0',
    sdkCdn: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
  },

  // 轮询兜底间隔（Realtime 不可用时）
  pollInterval: 1500,

  // ---- 板子配置（按人数）----
  boards: {
    12: {
      name: '12人标准局 · 预女猎白',
      roles: ['werewolf','werewolf','werewolf','werewolf',
              'seer','witch','hunter','idiot',
              'villager','villager','villager','villager']
    },
    10: {
      name: '10人局 · 预女猎',
      roles: ['werewolf','werewolf','werewolf',
              'seer','witch','hunter',
              'villager','villager','villager','villager']
    },
    9: {
      name: '9人局 · 预女猎',
      roles: ['werewolf','werewolf','werewolf',
              'seer','witch','hunter',
              'villager','villager','villager']
    }
  },
  defaultBoard: 12,

  version: '1.0.0'
};
