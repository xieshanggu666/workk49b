<template>
  <div class="energy">
    <div class="kpis">
      <div class="kpi"><b>{{ store.energy.total.toFixed(2) }}</b><em>近24小时总能耗 (kWh)</em></div>
      <div class="kpi"><b>{{ onDevices }}</b><em>开启中设备</em></div>
      <div class="kpi"><b>{{ peakRoom }}</b><em>峰值房间</em></div>
      <div class="kpi"><b>{{ (store.totalWatts/1000).toFixed(2) }}</b><em>实时功率 (kW)</em></div>
      <div class="kpi" :class="{over: quotaOverCount > 0, warn: quotaWarnCount > 0 && !quotaOverCount}">
        <b>{{ quotaOverCount || quotaWarnCount || 0 }}</b>
        <em>{{ quotaOverCount ? '定额超标未处理' : quotaWarnCount ? '定额预警中' : '定额执行正常' }}</em>
      </div>
    </div>

    <!-- 定额执行联动：按房间/设备配置的周期额度与当前周期占用 -->
    <div v-if="enabledQuotas.length" class="card quota-card">
      <h4>📈 周期定额执行
        <button class="goto" @click="store.tab = 'quota'">管理定额 / 处理告警 →</button>
      </h4>
      <div class="qrows">
        <div v-for="q in enabledQuotas" :key="q.id" class="qrow">
          <span class="ql">{{ q.scope === 'room' ? '🏠' : '🔌' }} {{ q.target_name }}<i>{{ q.period_label }}</i></span>
          <div class="qb"><i :class="q.open_level || 'ok'" :style="{width: barW(q) + '%'}"></i></div>
          <span class="qv" :class="q.open_level || ''">
            {{ q.usage_kwh.toFixed(2) }}/{{ q.limit_kwh.toFixed(2) }}
            <b v-if="q.open_level === 'over'">超标</b>
            <b v-else-if="q.open_level === 'warn'">预警</b>
          </span>
        </div>
      </div>
    </div>

    <div class="card">
      <h4>🏠 按房间能耗分布 · 近24小时 (kWh)</h4>
      <div class="rows">
        <div v-for="r in store.energy.rooms" :key="r.room" class="erow">
          <span class="rl">{{ r.room }}<i v-if="roomQuota(r.room)" class="qtag" :class="roomQuota(r.room).open_level">{{ roomQuota(r.room).open_level === 'over' ? '定额超标' : '定额预警' }}</i></span>
          <div class="rt"><i :style="{width: pct(r.v)+'%'}"></i></div>
          <span class="rv">{{ r.v.toFixed(2) }}</span>
        </div>
        <div v-if="!store.energy.rooms.length" class="empty">暂无用电数据，开启设备后将按运行分段累计</div>
      </div>
    </div>

    <div class="card">
      <h4>🚿 设备用电排行 · 近24小时 (kWh)</h4>
      <table>
        <thead><tr><th>设备</th><th>房间</th><th>能耗</th><th>占比</th></tr></thead>
        <tbody>
          <tr v-for="d in topDevices" :key="(d.device_id ?? 'x') + '-' + d.device_name">
            <td>
              {{ d.device_name }}
              <i v-if="d.deleted" class="tag del">已删除</i>
              <i v-else-if="d.unbound" class="tag old">旧记录</i>
              <i v-if="deviceQuota(d)" class="qtag" :class="deviceQuota(d).open_level">{{ deviceQuota(d).open_level === 'over' ? '定额超标' : '定额预警' }}</i>
            </td>
            <td>{{ d.room || '—' }}</td>
            <td>{{ d.v.toFixed(2) }} kWh</td>
            <td><div class="tb"><i :style="{width: pct(d.v)+'%'}"></i></div></td>
          </tr>
        </tbody>
      </table>
      <div v-if="!store.energy.devices.length" class="empty">暂无用电数据</div>
      <p v-if="hasDeleted" class="sub">已删除设备的历史用电按其设备标识与当时房间快照保留，不并入其他同名设备。</p>
    </div>

    <p class="note">💡 节能建议：异常/离线设备不产生用电；周期用量达到定额预警线会通知，超标后需在「定额预警」中闭环处理。</p>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useHomeStore } from '@/store/home'
const store = useHomeStore()

const onDevices = computed(() => store.onCount)
const peakRoom = computed(() => store.energy.rooms[0]?.room || '—')
const topDevices = computed(() => store.energy.devices.slice(0, 10))
const hasDeleted = computed(() => store.energy.devices.some((d) => d.deleted || d.unbound))

// 启用中的定额（当前周期），超标/预警优先，其余按占用率降序
const enabledQuotas = computed(() =>
  (store.quota.quotas || []).filter((q) => q.enabled)
    .sort((a, b) => (b.open_level === 'over') - (a.open_level === 'over') || b.ratio - a.ratio))
const quotaOverCount = computed(() => store.quota.summary?.over_count || 0)
const quotaWarnCount = computed(() => store.quota.summary?.warn_count || 0)

// 房间维度：只要该房间任一定额处于预警/超标即在分布图标记（取最严级别）
const roomQuotaMap = computed(() => {
  const m = {}
  for (const q of store.quota.quotas || []) {
    if (q.scope !== 'room' || !q.open_level) continue
    if (!m[q.target_name] || (q.open_level === 'over')) m[q.target_name] = q
  }
  return m
})
const deviceQuotaMap = computed(() => {
  const m = {}
  for (const q of store.quota.quotas || []) {
    if (q.scope !== 'device' || !q.open_level || q.deleted) continue
    m[q.device_id] = q
  }
  return m
})
const roomQuota = (name) => roomQuotaMap.value[name]
const deviceQuota = (d) => d.device_id != null ? deviceQuotaMap.value[d.device_id] : null

function barW(q) { return Math.min(100, Math.round(q.ratio * 100)) }
function pct(v) {
  const max = Math.max(...store.energy.rooms.map((r) => r.v), 0.001)
  return Math.round((v / max) * 100)
}
</script>

<style scoped>
.energy{display:flex;flex-direction:column;gap:16px;}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;}
.kpi{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:16px;text-align:center;}
.kpi b{display:block;font-size:28px;color:#ffd54f;}
.kpi em{font-size:12px;color:#8ba2c8;font-style:normal;}
.kpi.over b{color:#ef5350;}.kpi.warn b{color:#ffb300;}
.card{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:16px;}
h4{margin:0 0 12px;color:#fff;font-size:14px;}
.quota-card h4{display:flex;align-items:center;justify-content:space-between;}
.goto{background:none;border:none;color:#64b5f6;font-size:11px;cursor:pointer;padding:0;}
.qrows{display:flex;flex-direction:column;gap:8px;}
.qrow{display:flex;align-items:center;gap:10px;font-size:12px;}
.ql{width:130px;color:#dbe4f3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.ql i{font-style:normal;font-size:10px;color:#8ba2c8;margin-left:6px;background:#16263f;border-radius:4px;padding:0 5px;}
.qb{flex:1;height:12px;background:#0c1730;border-radius:6px;overflow:hidden;}
.qb i{display:block;height:100%;border-radius:6px;}
.qb i.ok{background:linear-gradient(90deg,#43a047,#66bb6a);}
.qb i.warn{background:linear-gradient(90deg,#fb8c00,#ffb300);}
.qb i.over{background:linear-gradient(90deg,#e53935,#ef5350);}
.qv{width:130px;text-align:right;color:#8ba2c8;white-space:nowrap;}
.qv.warn{color:#ffb300;}.qv.over{color:#ef5350;font-weight:600;}
.qv b{font-size:10px;border-radius:4px;padding:0 4px;margin-left:4px;}
.qv.warn b{background:#6d4c00;color:#ffd54f;}
.qv.over b{background:#b71c1c;color:#ffcdd2;}
.qtag{font-style:normal;font-size:10px;padding:1px 6px;border-radius:5px;margin-left:6px;vertical-align:middle;}
.qtag.warn{background:#6d4c00;color:#ffd54f;}
.qtag.over{background:#b71c1c;color:#ffcdd2;}
.rows{display:flex;flex-direction:column;gap:8px;}
.erow{display:flex;align-items:center;gap:10px;font-size:12px;color:#8ba2c8;}
.rl{width:52px;}.rv{width:60px;text-align:right;color:#dbe4f3;font-weight:600;}
.rt{flex:1;height:12px;background:#0c1730;border-radius:6px;overflow:hidden;}
.rt i{display:block;height:100%;background:linear-gradient(90deg,#42a5f5,#ff7043);}
table{width:100%;border-collapse:collapse;font-size:13px;}
th,td{padding:8px 10px;text-align:left;border-bottom:1px solid rgba(120,160,220,0.1);}
th{color:#8ba2c8;font-weight:600;font-size:11px;}
td{color:#dbe4f3;}
.tb{height:8px;background:#0c1730;border-radius:4px;overflow:hidden;min-width:120px;}
.tb i{display:block;height:100%;background:#42a5f5;}
.tag{font-style:normal;font-size:10px;padding:1px 6px;border-radius:5px;margin-left:6px;vertical-align:middle;}
.tag.del{background:#4a2020;color:#ffab91;}
.tag.old{background:#3a3320;color:#ffe082;}
.sub{margin:10px 0 0;font-size:11px;color:#5b6f94;}
.empty{color:#5b6f94;text-align:center;padding:14px;font-size:12px;}
.note{color:#8ba2c8;font-size:12px;background:#14273f;border:1px dashed #ffd54f;color:#ffd54f;border-radius:10px;padding:12px 16px;}
</style>
