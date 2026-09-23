// ===== 能耗定额与超标预警闭环 =====
// 按「房间 / 设备」×「日 / 周 / 月」配置周期额度（kWh）。
// 用量持续聚合自分段模型：energy_records 中 end_time 落在本周期窗口内的结落段
// 全额计入，energy_segments 中仍在运行的段按与窗口的重叠时长折算。
// 达到额度的 warn_ratio（默认 80%）生成「预警」，达到 100% 生成「超标」；
// 同一周期、同一定额、同一级别只告警一次（处理后不重报），周期滚动后自然开新一轮。
// 告警保留处理状态（open/handled + 处理备注），额度的每次调整写入 quota_adjustments。

const EVAL_TICK_MS = 30_000
const PERIODS = ['daily', 'weekly', 'monthly']
const PERIOD_WORD = { daily: '日', weekly: '周', monthly: '月' }

// 由入口传入 db（必须在 initEnergy 之后：聚合依赖两张能耗表）
let db
let stmts
const round4 = (v) => Math.round(v * 10000) / 10000

export function initQuotas(database) {
  db = database
  db.exec(`
  CREATE TABLE IF NOT EXISTS energy_quotas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL,                  -- room / device
    room_id INTEGER,                      -- scope=room 时指向 rooms.id
    device_id INTEGER,                    -- scope=device 时指向 devices.id（删除设备不级联，定额保留）
    target_name TEXT NOT NULL,            -- 目标名称快照，仅用于展示
    period TEXT NOT NULL,                 -- daily / weekly / monthly
    limit_kwh REAL NOT NULL,
    warn_ratio REAL NOT NULL DEFAULT 0.8, -- 预警线，占额度比例
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_quota_uniq
    ON energy_quotas(scope, COALESCE(room_id,-1), COALESCE(device_id,-1), period);
  CREATE TABLE IF NOT EXISTS quota_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quota_id INTEGER NOT NULL,            -- 删除定额不级联，告警历史保留
    scope TEXT NOT NULL,
    target_name TEXT NOT NULL,            -- 告警产生时的目标名称快照
    period TEXT NOT NULL,
    period_start TEXT NOT NULL,           -- 周期窗口起（ISO），同轮去重键
    period_end TEXT NOT NULL,             -- 周期窗口止（ISO），仅展示
    level TEXT NOT NULL,                  -- warn（预警）/ over（超标）
    usage_kwh REAL NOT NULL,
    limit_kwh REAL NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',  -- open / handled
    note TEXT NOT NULL DEFAULT '',
    triggered_at TEXT NOT NULL,
    handled_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_quota_alerts_dedup
    ON quota_alerts(quota_id, period_start, level);
  CREATE INDEX IF NOT EXISTS idx_quota_alerts_status ON quota_alerts(status);
  CREATE TABLE IF NOT EXISTS quota_adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quota_id INTEGER NOT NULL,            -- 删除定额不级联，调整历史保留
    scope TEXT NOT NULL,
    target_name TEXT NOT NULL,
    period TEXT NOT NULL,
    old_limit REAL,
    new_limit REAL,
    old_warn REAL,
    new_warn REAL,
    reason TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '用户',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_quota_adjustments_quota ON quota_adjustments(quota_id);
  `)
  stmts = {
    allQuotas: db.prepare('SELECT * FROM energy_quotas ORDER BY id'),
    enabledQuotas: db.prepare('SELECT * FROM energy_quotas WHERE enabled=1'),
    quotaById: db.prepare('SELECT * FROM energy_quotas WHERE id=?'),
    roomName: db.prepare('SELECT name FROM rooms WHERE id=?'),
    deviceById: db.prepare(`SELECT d.id, d.name, r.name room FROM devices d
                            JOIN rooms r ON r.id=d.room_id WHERE d.id=?`),
    roomRecords: db.prepare('SELECT COALESCE(SUM(kwh),0) v FROM energy_records WHERE room=? AND end_time>=?'),
    deviceRecords: db.prepare('SELECT COALESCE(SUM(kwh),0) v FROM energy_records WHERE device_id=? AND end_time>=?'),
    roomSegs: db.prepare('SELECT * FROM energy_segments WHERE room=?'),
    deviceSegs: db.prepare('SELECT * FROM energy_segments WHERE device_id=?'),
    findAlert: db.prepare('SELECT id FROM quota_alerts WHERE quota_id=? AND period_start=? AND level=? LIMIT 1'),
    insertAlert: db.prepare(`INSERT INTO quota_alerts
      (quota_id,scope,target_name,period,period_start,period_end,level,usage_kwh,limit_kwh,message,status,triggered_at)
      VALUES (?,?,?,?,?,?,?,?,?,?, 'open', ?)`),
    openAlertsInPeriod: db.prepare("SELECT * FROM quota_alerts WHERE quota_id=? AND period_start=? AND status='open' ORDER BY id"),
    alertById: db.prepare('SELECT * FROM quota_alerts WHERE id=?'),
    handleAlert: db.prepare("UPDATE quota_alerts SET status='handled', note=?, handled_at=? WHERE id=?"),
    reopenAlert: db.prepare("UPDATE quota_alerts SET status='open', note='', handled_at=NULL WHERE id=?"),
    insertAdjustment: db.prepare(`INSERT INTO quota_adjustments
      (quota_id,scope,target_name,period,old_limit,new_limit,old_warn,new_warn,reason,created_by,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
  }

  seedQuotas()
  // 启动即评估一次，随后随模拟节拍持续评估；前端拉 /api/state 时也会兜底再评估
  evaluateQuotas()
  setInterval(() => { try { evaluateQuotas() } catch (e) { console.error('[QUOTA] eval failed', e) } }, EVAL_TICK_MS)
}

// ===== 周期窗口（本地时间）：日=今日0点；周=本周一0点；月=1日0点 =====
export function periodWindow(period, at = new Date()) {
  const start = new Date(at)
  start.setHours(0, 0, 0, 0)
  if (period === 'weekly') {
    const mondayOffset = (start.getDay() + 6) % 7 // 周日=6 … 周一=0
    start.setDate(start.getDate() - mondayOffset)
  } else if (period === 'monthly') {
    start.setDate(1)
  }
  const end = new Date(start)
  if (period === 'daily') end.setDate(end.getDate() + 1)
  else if (period === 'weekly') end.setDate(end.getDate() + 7)
  else end.setMonth(end.getMonth() + 1)
  return { start, end }
}

// 在跑段折算：段首早于窗口起点的部分不计入本周期
function segKwh(s, startMs, atMs) {
  const lo = Math.max(startMs, new Date(s.start_time).getTime())
  if (atMs <= lo) return 0
  return (s.watts * (atMs - lo)) / 3_600_000_000
}

// 定额在指定周期窗口内、截至 at 的累计用电
export function computeUsage(q, start, at = new Date()) {
  const startIso = start.toISOString()
  let v = 0
  if (q.scope === 'room') {
    const roomName = q.target_name_use ?? stmts.roomName.get(q.room_id)?.name
    if (!roomName) return 0
    v += stmts.roomRecords.get(roomName, startIso).v
    for (const s of stmts.roomSegs.all(roomName)) v += segKwh(s, start.getTime(), at.getTime())
  } else {
    v += stmts.deviceRecords.get(q.device_id, startIso).v
    const s = stmts.deviceSegs.get(q.device_id)
    if (s) v += segKwh(s, start.getTime(), at.getTime())
  }
  return round4(v)
}

function alertMessage(level, period, usage, limit) {
  const word = PERIOD_WORD[period]
  if (level === 'over') {
    return `周期能耗超标：本${word}已用 ${usage.toFixed(2)} kWh，超出定额 ${limit.toFixed(2)} kWh`
  }
  return `额度预警：本${word}已用 ${usage.toFixed(2)} kWh，达定额 ${limit.toFixed(2)} kWh 的 ${Math.round((usage / limit) * 100)}%`
}

function insertLog(name, action, detail = '') {
  db.prepare('INSERT INTO device_logs (device_name,action,detail,time) VALUES (?,?,?,?)')
    .run(name, action, detail, new Date().toLocaleString('zh-CN'))
  const c = db.prepare('SELECT COUNT(*) c FROM device_logs').get().c
  if (c > 200) db.exec('DELETE FROM device_logs WHERE id <= (SELECT MAX(id)-200 FROM device_logs)')
}

// ===== 评估全部启用定额：越线即生成去重告警并写入日志通知 =====
export function evaluateQuotas(at = new Date()) {
  const fired = []
  for (const q of stmts.enabledQuotas.all()) {
    const { start, end } = periodWindow(q.period, at)
    const usage = computeUsage(q, start, at)
    const level = usage >= q.limit_kwh
      ? 'over'
      : usage >= q.limit_kwh * q.warn_ratio ? 'warn' : null
    if (!level) continue
    const startIso = start.toISOString()
    // 同轮同级别已存在（含已处理）则不重报；处理后即使仍超标也不打扰
    if (stmts.findAlert.get(q.id, startIso, level)) continue
    const message = alertMessage(level, q.period, usage, q.limit_kwh)
    const triggeredAt = at.toLocaleString('zh-CN')
    const r = stmts.insertAlert.run(
      q.id, q.scope, q.target_name, q.period, startIso, end.toISOString(),
      level, usage, q.limit_kwh, message, triggeredAt)
    insertLog(q.target_name, level === 'over' ? '超标告警' : '额度预警',
      `${message}（${scopeLabel(q)} · ${periodLabel(q.period)}）`)
    fired.push({ id: Number(r.lastInsertRowid), quota_id: q.id, level, message, target_name: q.target_name })
  }
  return fired
}

const scopeLabel = (q) => (q.scope === 'room' ? '房间定额' : '设备定额')
export const periodLabel = (p) => ({ daily: '每日', weekly: '每周', monthly: '每月' }[p] || p)
export const isValidPeriod = (p) => PERIODS.includes(p)

// ===== 定额总览：逐条带本周期用量/占比/在途告警 =====
export function getOverview(at = new Date()) {
  const quotas = []
  let over = 0, warn = 0, enabledCount = 0
  const openAlertsFlat = []
  for (const q of stmts.allQuotas.all()) {
    const { start, end } = periodWindow(q.period, at)
    const usage = q.enabled ? computeUsage(q, start, at) : 0
    const openAlerts = q.enabled
      ? stmts.openAlertsInPeriod.all(q.id, start.toISOString())
      : []
    const worst = openAlerts.some((a) => a.level === 'over') ? 'over'
      : openAlerts.length ? 'warn' : null
    let room = null, deleted = false
    if (q.scope === 'device') {
      const d = stmts.deviceById.get(q.device_id)
      if (d) room = d.room
      else deleted = true // 设备已删除：定额与历史保留，本周期历史用量仍聚合
    }
    if (q.enabled) {
      enabledCount++
      if (worst === 'over') over++
      else if (worst === 'warn') warn++
    }
    for (const a of openAlerts) openAlertsFlat.push(a)
    quotas.push({
      ...q,
      room,
      deleted,
      period_label: periodLabel(q.period),
      period_start: start.toISOString(),
      period_end: end.toISOString(),
      usage_kwh: usage,
      ratio: q.limit_kwh > 0 ? round4(usage / q.limit_kwh) : 0,
      live_level: usage >= q.limit_kwh ? 'over'
        : usage >= q.limit_kwh * q.warn_ratio ? 'warn' : null,
      open_level: worst,
      open_count: openAlerts.length,
      open_alerts: openAlerts
    })
  }
  return {
    generated_at: at.toISOString(),
    quotas,
    open_alerts: openAlertsFlat,
    summary: {
      total: quotas.length,
      enabled: enabledCount,
      open_count: over + warn,
      over_count: over,
      warn_count: warn
    }
  }
}

export function listAlerts(status = 'all') {
  const sql = 'SELECT * FROM quota_alerts ORDER BY id DESC LIMIT 200'
  const rows = status === 'open' || status === 'handled'
    ? db.prepare('SELECT * FROM quota_alerts WHERE status=? ORDER BY id DESC LIMIT 200').all(status)
    : db.prepare(sql).all()
  return rows.map((a) => ({ ...a, period_label: periodLabel(a.period) }))
}

export function listAdjustments() {
  return db.prepare('SELECT * FROM quota_adjustments ORDER BY id DESC LIMIT 200').all()
}

export function getAlert(id) {
  return stmts.alertById.get(id)
}
export function markHandled(id, note, at = new Date()) {
  stmts.handleAlert.run(note, at.toLocaleString('zh-CN'), id)
}
export function markReopened(id) {
  stmts.reopenAlert.run(id)
}
export function getQuota(id) {
  return stmts.quotaById.get(id)
}
export function recordAdjustment(q, oldLimit, newLimit, oldWarn, newWarn, reason, at = new Date()) {
  stmts.insertAdjustment.run(
    q.id, q.scope, q.target_name, q.period, oldLimit, newLimit, oldWarn, newWarn,
    reason, '用户', at.toLocaleString('zh-CN'))
}

// ===== 首次启动演示数据：基于当前真实周期用量反推额度，使各状态立即可见 =====
function seedQuotas() {
  if (db.prepare('SELECT COUNT(*) c FROM energy_quotas').get().c > 0) return
  const at = new Date()
  const ts = at.toLocaleString('zh-CN')
  const insert = db.prepare(`INSERT INTO energy_quotas
    (scope,room_id,device_id,target_name,period,limit_kwh,warn_ratio,enabled,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,1,?,?)`)
  const usageOf = (q, period) => {
    const { start } = periodWindow(period, at)
    return computeUsage(q, start, at)
  }

  // 1) 客厅空调·每日：额度压到当前用量 60% → 启动即超标（设备在跑，后续持续超标）
  const ac = db.prepare(`SELECT d.id FROM devices d JOIN device_types t ON t.id=d.type_id
                         WHERE d.name='客厅空调' AND t.name='空调'`).get()
  let acId = null
  if (ac) {
    const q0 = { scope: 'device', device_id: ac.id }
    const u = usageOf(q0, 'daily')
    const limit = u > 0 ? Math.max(0.01, Math.floor(u * 0.6 * 100) / 100) : 0.01
    acId = insert.run('device', null, ac.id, '客厅空调', 'daily', limit, 0.8, ts, ts).lastInsertRowid
  }

  // 2) 客厅·每日：额度约为当前用量 1.11 倍（约 90% 占用）→ 预警态
  const living = stmts.roomName.get(1)?.name === '客厅' ? 1 : null
  let roomId = null
  if (living) {
    const q0 = { scope: 'room', room_id: 1 }
    const u = usageOf(q0, 'daily')
    const limit = u > 0 ? Math.max(0.02, Math.round(u * 1.11 * 100) / 100) : 2
    roomId = insert.run('room', 1, null, '客厅', 'daily', limit, 0.8, ts, ts).lastInsertRowid
  }

  // 3) 卧室·每周：宽额 → 正常态；挂一条上周超标→已处理→复核上调的完整闭环历史
  const bedroom = db.prepare("SELECT id FROM rooms WHERE name='卧室'").get()
  let weekId = null
  if (bedroom) {
    weekId = insert.run('room', bedroom.id, null, '卧室', 'weekly', 5, 0.8, ts, ts).lastInsertRowid
    const { start, end } = periodWindow('weekly', at)
    const prevStart = new Date(start.getTime() - 7 * 24 * 3600_000)
    const prevEnd = start
    const triggered = new Date(prevStart.getTime() + 2 * 3600_000).toLocaleString('zh-CN')
    const handled = new Date(prevEnd.getTime() - 3600_000).toLocaleString('zh-CN')
    const msg = alertMessage('over', 'weekly', 5.42, 3)
    db.prepare(`INSERT INTO quota_alerts
      (quota_id,scope,target_name,period,period_start,period_end,level,usage_kwh,limit_kwh,message,status,note,triggered_at,handled_at)
      VALUES (?,?,?,?,?,?,?,?,?,?, 'handled', ?, ?, ?)`).run(
      weekId, 'room', '卧室', 'weekly', prevStart.toISOString(), prevEnd.toISOString(),
      'over', 5.42, 3, msg, '核查为空调忘关，已通过离家模式自动关闭', triggered, handled)
    stmts.insertAdjustment.run(
      weekId, 'room', '卧室', 'weekly', 3, 5, 0.8, 0.8,
      '上周超标复核：夜间空调使用增加，上调每周额度', '用户', ts)
  }
}
