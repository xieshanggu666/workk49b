import express from 'express'
import { db } from './db.js'
import { initEnergy, reconcileDevice, closeDevice, getSummary } from './energy.js'
import {
  initQuotas, evaluateQuotas, getOverview as getQuotaOverview,
  listAlerts, listAdjustments, getAlert, markHandled, markReopened,
  getQuota, recordAdjustment, isValidPeriod, periodLabel
} from './quotas.js'

// 必须在 db.js 建表/播种完成后初始化能耗模块（定额聚合依赖能耗分段表，其后再初始化）
initEnergy(db)
initQuotas(db)

const app = express()
app.use(express.json())

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)
const now = () => new Date().toLocaleString('zh-CN')

// 追加日志
function log(device, action, detail = '') {
  run('INSERT INTO device_logs (device_name,action,detail,time) VALUES (?,?,?,?)', device, action, detail, now())
  // 保留最近 200 条
  const c = q1('SELECT COUNT(*) c FROM device_logs').c
  if (c > 200) db.exec('DELETE FROM device_logs WHERE id <= (SELECT MAX(id)-200 FROM device_logs)')
}

// ===== 状态聚合 =====
app.get('/api/state', (req, res) => {
  // 拉取前兜底评估：即使前端正在操作设备，最新用量也能即时越线告警（评估内部按轮次/级别去重）
  evaluateQuotas()
  const energy = getSummary()
  const quota = getQuotaOverview()
  res.json({
    rooms: q('SELECT * FROM rooms'),
    types: q('SELECT * FROM device_types'),
    devices: q(`SELECT d.*, r.name room, t.name type_name, t.icon type_icon
                FROM devices d JOIN rooms r ON r.id=d.room_id JOIN device_types t ON t.id=d.type_id`),
    scenes: q('SELECT * FROM scenes').map((s) => {
      const actions = q(`SELECT sa.id, sa.device_id, sa.device_key, sa.action, d.name device_name,
                                (SELECT COUNT(*) FROM devices x WHERE x.name=sa.device_key) key_match_count
                         FROM scene_actions sa LEFT JOIN devices d ON d.id=sa.device_id
                         WHERE sa.scene_id=? ORDER BY sa.order_no, sa.id`, s.id)
        .map((a) => ({
          ...a,
          // device_id 为空时区分原因：同名设备不止一台=迁移时无法判定归属，需人工重新绑定；否则为设备已删除
          unresolved: !a.device_name ? (a.key_match_count > 1 ? 'duplicate' : 'missing') : null
        }))
      return { ...s, action_count: actions.length, actions }
    }),
    logs: q('SELECT * FROM device_logs ORDER BY id DESC LIMIT 50'),
    energy,
    quota,
    alerts: computeAlerts(energy, quota)
  })
})

function computeAlerts(energy, quota) {
  const devs = q('SELECT * FROM devices')
  const alerts = []
  for (const d of devs) {
    if (d.status === 'error') alerts.push({ device: d.name, level: 'error', text: '设备离线/异常' })
    else if (d.battery < 40) alerts.push({ device: d.name, level: 'warn', text: `电量低(${d.battery}%)` })
    else if (d.signal < 60) alerts.push({ device: d.name, level: 'warn', text: `信号弱(${d.signal})` })
  }
  // 能耗尖峰：按设备标识聚合近 24h 的小时桶，存在一个小时明显偏离其活跃时段均值即告警
  // （改名/换房不影响识别；已删除设备不产生尖峰告警）
  for (const d of energy.devices) {
    if (!d.deleted && !d.unbound && d.active_buckets >= 6 && d.peak >= 0.05 && d.avg > 0 && d.peak > d.avg * 3) {
      alerts.push({ device: d.device_name, level: 'info', text: `能耗尖峰：单小时 ${d.peak.toFixed(2)}kWh，远超均值 ${d.avg.toFixed(2)}kWh` })
    }
  }
  // 定额告警：本周期在途（未处理）的预警/超标并入告警中心；超标按 error、预警按 warn
  for (const a of quota.open_alerts) {
    const tag = a.scope === 'room' ? '房间定额' : '设备定额'
    alerts.push({
      device: a.target_name,
      level: a.level === 'over' ? 'error' : 'warn',
      text: `[${tag}·${periodLabel(a.period)}] ${a.message}`,
      kind: 'quota',
      quota_alert_id: a.id
    })
  }
  return alerts
}

// ===== 设备 =====
app.post('/api/device', (req, res) => {
  const { name, type_id, room_id } = req.body
  if (!name || !type_id || !room_id) return res.status(400).json({ error: 'missing' })
  const r = run('INSERT INTO devices (name,type_id,room_id) VALUES (?,?,?)', name, type_id, room_id)
  log(name, '新增设备', `房间 ${q1('SELECT name FROM rooms WHERE id=?', room_id).name}`)
  res.json({ ok: true, id: r.lastInsertRowid })
})
app.delete('/api/device/:id', (req, res) => {
  const d = q1('SELECT * FROM devices WHERE id=?', req.params.id)
  if (!d) return res.status(404).json({ error: 'not found' })
  // 引用该设备的场景动作将随外键 ON DELETE SET NULL 置空（失效引用）
  const affected = q1('SELECT COUNT(*) c FROM scene_actions WHERE device_id=?', d.id).c
  // 设备定额不级联删除：保留配置与告警/调整历史（标记为设备已删除，可人工删除定额）
  const quotasKept = q1("SELECT COUNT(*) c FROM energy_quotas WHERE scope='device' AND device_id=?", d.id).c
  // 先结落未结用电段（历史记录保留），再删除设备
  closeDevice(d.id)
  run('DELETE FROM devices WHERE id=?', d.id)
  const detail = [affected ? `${affected} 个场景动作失效` : '', quotasKept ? `${quotasKept} 条设备定额保留待处理` : ''].filter(Boolean).join('；')
  log(d.name, '删除设备', detail)
  res.json({ ok: true, affected_actions: affected })
})
// 切换开关
app.post('/api/device/:id/toggle', (req, res) => {
  const d = q1('SELECT * FROM devices WHERE id=?', req.params.id)
  if (!d) return res.status(404).json({ error: 'not found' })
  if (d.status === 'error') return res.status(409).json({ error: '设备异常，无法操作' })
  const on = d.power_on ? 0 : 1
  run('UPDATE devices SET power_on=? WHERE id=?', on, d.id)
  // 开关即分段边界：关闭结落本段用电，开启打开新段
  reconcileDevice(d.id)
  log(d.name, on ? '开启' : '关闭')
  res.json({ ok: true, power_on: on })
})
// 更新设备字段
app.post('/api/device/:id/update', (req, res) => {
  const d = q1('SELECT * FROM devices WHERE id=?', req.params.id)
  if (!d) return res.status(404).json({ error: 'not found' })
  const { name, room_id, watts, power_on } = req.body
  if (room_id != null && !q1('SELECT id FROM rooms WHERE id=?', room_id))
    return res.status(400).json({ error: '房间不存在' })
  if (watts != null && (!Number.isFinite(+watts) || +watts < 0 || +watts > 10000))
    return res.status(400).json({ error: '功率需为 0-10000 的数字' })
  const nextName = (name ?? d.name).toString()
  const nextRoom = room_id ?? d.room_id
  const nextWatts = watts ?? d.watts
  const nextOn = power_on ?? d.power_on
  run('UPDATE devices SET name=?, room_id=?, watts=?, power_on=? WHERE id=?',
    nextName, nextRoom, nextWatts, nextOn, d.id)
  // 改名后同步场景动作里的名称快照（关联仍按 device_id，不受影响）
  if (nextName !== d.name) {
    run('UPDATE scene_actions SET device_key=? WHERE device_id=?', nextName, d.id)
    // 定额按 device_id 稳定归属，名称仅作展示快照，同步刷新；已生成的告警快照不动
    run('UPDATE energy_quotas SET target_name=? WHERE scope=\'device\' AND device_id=?', nextName, d.id)
  }
  // 功率/开关变化、改名、换房都构成分段边界：旧段按旧快照结落，新段用新快照记账
  if (nextName !== d.name || nextRoom !== d.room_id || nextWatts !== d.watts || nextOn !== d.power_on)
    reconcileDevice(d.id)
  const detail = []
  if (nextName !== d.name) detail.push(`改名「${d.name}」→「${nextName}」`)
  if (nextRoom !== d.room_id) detail.push(`换到 ${q1('SELECT name FROM rooms WHERE id=?', nextRoom).name}`)
  if (nextWatts !== d.watts) detail.push(`功率 ${d.watts}W→${nextWatts}W`)
  if (nextOn !== d.power_on) detail.push(nextOn ? '已开启' : '已关闭')
  log(nextName, '更新设备', detail.join('，'))
  res.json({ ok: true })
})

// ===== 场景 =====
app.post('/api/scene', (req, res) => {
  const { name, actions } = req.body
  const list = Array.isArray(actions) ? actions : []
  for (const a of list) {
    if (!q1('SELECT id FROM devices WHERE id=?', a.device_id))
      return res.status(400).json({ error: `动作引用了不存在的设备（ID ${a.device_id}）` })
  }
  const r = run('INSERT INTO scenes (name,desc,enabled) VALUES (?,?,1)', name || '新场景', '')
  const act = db.prepare('INSERT INTO scene_actions (scene_id,device_id,device_key,action,order_no) VALUES (?,?,?,?,?)')
  list.forEach((a, i) => {
    const d = q1('SELECT name FROM devices WHERE id=?', a.device_id)
    act.run(r.lastInsertRowid, a.device_id, d.name, a.action, i)
  })
  res.json({ ok: true, id: r.lastInsertRowid })
})
app.delete('/api/scene/:id', (req, res) => {
  const s = q1('SELECT * FROM scenes WHERE id=?', req.params.id)
  if (s) { run('DELETE FROM scenes WHERE id=?', s.id); run('DELETE FROM scene_actions WHERE scene_id=?', s.id) }
  res.json({ ok: true })
})
app.post('/api/scene/:id/toggle', (req, res) => {
  const s = q1('SELECT * FROM scenes WHERE id=?', req.params.id)
  if (!s) return res.status(404).json({ error: 'not found' })
  run('UPDATE scenes SET enabled=? WHERE id=?', s.enabled ? 0 : 1, s.id)
  res.json({ ok: true, enabled: s.enabled ? 0 : 1 })
})
// 触发场景：按 device_id 逐条执行，成功/失败如实记录并返回
app.post('/api/scene/:id/run', (req, res) => {
  const s = q1('SELECT * FROM scenes WHERE id=?', req.params.id)
  if (!s) return res.status(404).json({ error: 'not found' })
  if (!s.enabled) return res.status(409).json({ error: '场景已停用，无法执行' })
  const actions = q(`SELECT sa.*, d.id did, d.name dname, d.status dstatus,
                            (SELECT COUNT(*) FROM devices x WHERE x.name=sa.device_key) key_match_count
                     FROM scene_actions sa LEFT JOIN devices d ON d.id=sa.device_id
                     WHERE sa.scene_id=? ORDER BY sa.order_no, sa.id`, s.id)
  const executed = [], failed = []
  for (const a of actions) {
    const label = a.dname || a.device_key || `设备#${a.device_id ?? '?'}`
    if (!a.did) {
      // 未绑定动作一律跳过，绝不按名称猜测执行，避免误控同名设备
      const duplicate = a.key_match_count > 1
      const reason = duplicate ? '存在重名设备，待重新绑定' : '设备已删除'
      failed.push({ device: label, action: a.action, reason })
      log(label, `场景「${s.name}」执行失败`, `${a.action}（${reason}）`)
      continue
    }
    if (a.dstatus !== 'online') {
      failed.push({ device: a.dname, action: a.action, reason: '设备离线/异常' })
      log(a.dname, `场景「${s.name}」执行失败`, `${a.action}（设备离线/异常）`)
      continue
    }
    // 每个动作确定性地映射为开/关：关闭/关机/撤防→关，其余（开启/启动/布防/制冷/调光…）→开
    const on = /关|撤防/.test(a.action) ? 0 : 1
    run('UPDATE devices SET power_on=? WHERE id=?', on, a.did)
    reconcileDevice(a.did)
    log(a.dname, `场景「${s.name}」执行`, a.action)
    executed.push({ device: a.dname, action: a.action })
  }
  res.json({ ok: failed.length === 0, executed, failed })
})

// ===== 能耗定额与超标预警 =====
// 校验并解析定额目标；返回错误响应由调用方处理（ok=false 时已写出 4xx）
function resolveQuotaTarget(body, res) {
  const scope = body.scope
  if (scope !== 'room' && scope !== 'device') return res.status(400).json({ error: '定额范围须为房间或设备' })
  const targetId = Number(body.target_id)
  if (!Number.isInteger(targetId) || targetId <= 0) return res.status(400).json({ error: '请选择定额目标' })
  if (scope === 'room') {
    const r = q1('SELECT id, name FROM rooms WHERE id=?', targetId)
    if (!r) return res.status(400).json({ error: '房间不存在' })
    return { scope, room_id: r.id, device_id: null, target_name: r.name }
  }
  const d = q1(`SELECT d.id, d.name FROM devices d WHERE d.id=?`, targetId)
  if (!d) return res.status(400).json({ error: '设备不存在' })
  return { scope, room_id: null, device_id: d.id, target_name: d.name }
}

function validateQuotaBody(body) {
  if (!isValidPeriod(body.period)) return { error: '周期须为每日/每周/每月' }
  const limit = Number(body.limit_kwh)
  if (!Number.isFinite(limit) || limit <= 0 || limit > 100000) return { error: '周期额度须为 0-100000 kWh 的正数' }
  const warn = body.warn_ratio == null ? 0.8 : Number(body.warn_ratio)
  if (!Number.isFinite(warn) || warn <= 0 || warn > 1) return { error: '预警比例须为 0-1（不含0）' }
  return { limit, warn }
}

app.get('/api/quota/overview', (req, res) => {
  evaluateQuotas()
  res.json(getQuotaOverview())
})
app.get('/api/quota/alerts', (req, res) => {
  res.json(listAlerts(req.query.status || 'all'))
})
app.get('/api/quota/adjustments', (req, res) => {
  res.json(listAdjustments())
})

// 新建定额
app.post('/api/quota', (req, res) => {
  const target = resolveQuotaTarget(req.body, res)
  if (!target) return
  const v = validateQuotaBody(req.body)
  if (v.error) return res.status(400).json({ error: v.error })
  const dup = q1(`SELECT id FROM energy_quotas
    WHERE scope=? AND COALESCE(room_id,-1)=? AND COALESCE(device_id,-1)=? AND period=?`,
    target.scope, target.room_id ?? -1, target.device_id ?? -1, req.body.period)
  if (dup) return res.status(409).json({ error: '该目标同一周期已有定额，请编辑现有定额' })
  const ts = now()
  const r = run(`INSERT INTO energy_quotas
    (scope,room_id,device_id,target_name,period,limit_kwh,warn_ratio,enabled,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`,
    target.scope, target.room_id, target.device_id, target.target_name,
    req.body.period, v.limit, v.warn, req.body.enabled === false ? 0 : 1, ts, ts)
  // 建后即评估：新定额可能立即命中已有用量
  evaluateQuotas()
  log(target.target_name, '新增能耗定额', `${target.scope === 'room' ? '房间定额' : '设备定额'}·${periodLabel(req.body.period)} ${v.limit} kWh（预警线 ${Math.round(v.warn * 100)}%）`)
  res.json({ ok: true, id: r.lastInsertRowid })
})

// 更新定额：仅开关，或额度/预警线调整（调整必须填原因并留痕）
app.post('/api/quota/:id', (req, res) => {
  const q = getQuota(req.params.id)
  if (!q) return res.status(404).json({ error: '定额不存在' })
  const ts = now()

  if (req.body.enabled != null) {
    run('UPDATE energy_quotas SET enabled=?, updated_at=? WHERE id=?', req.body.enabled ? 1 : 0, ts, q.id)
    if (req.body.enabled) evaluateQuotas()
    log(q.target_name, req.body.enabled ? '启用定额' : '停用定额', `${periodLabel(q.period)} ${q.limit_kwh} kWh`)
    return res.json({ ok: true })
  }

  const v = validateQuotaBody({ ...q, ...req.body })
  if (v.error) return res.status(400).json({ error: v.error })
  const reason = (req.body.reason ?? '').toString().trim()
  if (v.limit !== q.limit_kwh || v.warn !== q.warn_ratio) {
    if (!reason) return res.status(400).json({ error: '调整额度或预警线必须填写调整原因' })
    recordAdjustment(q, q.limit_kwh, v.limit, q.warn_ratio, v.warn, reason)
  }
  run('UPDATE energy_quotas SET limit_kwh=?, warn_ratio=?, enabled=1, updated_at=? WHERE id=?',
    v.limit, v.warn, ts, q.id)
  // 上调后超标状态可能解除：不回写已生成的告警（由人工处理关闭），但下一轮评估只会按新线补新级别
  const fired = evaluateQuotas()
  const adjText = v.limit !== q.limit_kwh ? `额度 ${q.limit_kwh}→${v.limit} kWh；` : ''
  const warnText = v.warn !== q.warn_ratio ? `预警线 ${Math.round(q.warn_ratio * 100)}%→${Math.round(v.warn * 100)}%；` : ''
  if (adjText || warnText) log(q.target_name, '调整能耗定额', `${adjText}${warnText}原因：${reason}`)
  res.json({ ok: true, fired })
})

// 删除定额：告警与调整历史均保留（不级联），可继续在历史中追溯
app.delete('/api/quota/:id', (req, res) => {
  const q = getQuota(req.params.id)
  if (!q) return res.status(404).json({ error: '定额不存在' })
  const kept = q1('SELECT COUNT(*) c FROM quota_alerts WHERE quota_id=?', q.id).c
  run('DELETE FROM energy_quotas WHERE id=?', q.id)
  log(q.target_name, '删除能耗定额', `${periodLabel(q.period)}定额移除；${kept} 条历史告警保留`)
  res.json({ ok: true, kept_alerts: kept })
})

// 告警处理闭环：填写处理说明 → handled；支持重开
app.post('/api/quota/alert/:id/handle', (req, res) => {
  const a = getAlert(req.params.id)
  if (!a) return res.status(404).json({ error: '告警不存在' })
  if (a.status !== 'open') return res.status(409).json({ error: '该告警已处理' })
  const note = (req.body.note ?? '').toString().trim()
  if (!note) return res.status(400).json({ error: '请填写处理说明' })
  markHandled(a.id, note)
  log(a.target_name, a.level === 'over' ? '超标告警处理' : '预警处理', `${a.message}；处理：${note}`)
  res.json({ ok: true })
})
app.post('/api/quota/alert/:id/reopen', (req, res) => {
  const a = getAlert(req.params.id)
  if (!a) return res.status(404).json({ error: '告警不存在' })
  if (a.status === 'open') return res.status(409).json({ error: '该告警仍在处理中' })
  markReopened(a.id)
  log(a.target_name, '告警重新打开', a.message)
  res.json({ ok: true })
})

// ===== 日志 =====
app.get('/api/logs', (req, res) => {
  res.json(q('SELECT * FROM device_logs ORDER BY id DESC LIMIT 100'))
})

const PORT = 4120
app.listen(PORT, () => console.log(`[HOME] API running at http://localhost:${PORT}`))