<template>
  <div class="quotas">
    <!-- 概览 KPI -->
    <div class="kpis">
      <div class="kpi"><b>{{ store.quota.summary.total }}</b><em>定额总数</em></div>
      <div class="kpi"><b>{{ store.quota.summary.enabled }}</b><em>启用中</em></div>
      <div class="kpi warn"><b>{{ store.quota.summary.warn_count }}</b><em>预警中（≥预警线）</em></div>
      <div class="kpi over"><b>{{ store.quota.summary.over_count }}</b><em>超标未处理</em></div>
    </div>

    <div class="toolbar">
      <div class="hint">📌 按房间或设备配置日/周/月用电额度，用量持续按分段用电聚合；达预警线通知，超标后在此闭环处理</div>
      <button class="add" @click="showForm = !showAdd">＋ 新建定额</button>
    </div>

    <!-- 新建定额 -->
    <form v-if="showAdd" class="add-form" @submit.prevent="submitCreate">
      <select v-model="form.scope" @change="form.target_id=''">
        <option value="room">房间定额</option>
        <option value="device">设备定额</option>
      </select>
      <select v-model="form.target_id" required>
        <option disabled value="">选择{{ form.scope === 'room' ? '房间' : '设备' }}</option>
        <template v-if="form.scope === 'room'">
          <option v-for="r in store.rooms" :key="r.id" :value="r.id">{{ r.name }}</option>
        </template>
        <template v-else>
          <option v-for="d in store.devices" :key="d.id" :value="d.id">{{ d.type_icon }} {{ d.name }}（{{ d.room }}）</option>
        </template>
      </select>
      <select v-model="form.period" required>
        <option value="daily">每日</option><option value="weekly">每周</option><option value="monthly">每月</option>
      </select>
      <input v-model.number="form.limit_kwh" type="number" min="0.01" step="0.01" placeholder="额度 kWh" required />
      <label class="wl">预警线 <input v-model.number="form.warn_ratio" type="number" min="0.05" max="1" step="0.05"/> 比例</label>
      <button type="submit">保存</button>
      <button type="button" class="ghost" @click="showAdd = false">取消</button>
    </form>

    <!-- 定额执行卡片 -->
    <div class="cards">
      <div v-for="q in store.quota.quotas" :key="q.id" class="qcard" :class="{off:!q.enabled, deleted:q.deleted}">
        <div class="q-head">
          <span class="q-ic">{{ q.scope === 'room' ? '🏠' : '🔌' }}</span>
          <div class="q-id">
            <b>{{ q.target_name }}</b>
            <span>{{ q.scope === 'room' ? '房间定额' : '设备定额' }}{{ q.room ? ' · ' + q.room : '' }} · {{ q.period_label }}</span>
          </div>
          <span class="state" :class="q.open_level || (q.enabled ? 'ok' : 'off')">
            {{ !q.enabled ? '已停用' : q.open_level === 'over' ? '超标' : q.open_level === 'warn' ? '预警' : '正常' }}
          </span>
          <i v-if="q.deleted" class="tag del">设备已删除</i>
        </div>

        <div class="progress" :title="progressTitle(q)">
          <i :style="{width: barWidth(q) + '%'}" :class="barClass(q)"></i>
          <span class="pct-label">{{ Math.round(q.ratio * 100) }}%</span>
        </div>
        <div class="q-nums">
          <span>本周期已用 <b :class="q.open_level || ''">{{ q.usage_kwh.toFixed(2) }}</b> / {{ q.limit_kwh.toFixed(2) }} kWh</span>
          <span class="window">周期 {{ fmtWindow(q.period_start) }} ~ {{ fmtWindow(q.period_end) }}</span>
        </div>
        <div class="warn-line">预警线 {{ Math.round(q.warn_ratio * 100) }}%（{{ (q.limit_kwh * q.warn_ratio).toFixed(2) }} kWh）· 剩余 {{ remain(q).toFixed(2) }} kWh</div>

        <div class="q-actions">
          <button @click="openAdjust(q)">✏️ 调整额度</button>
          <button @click="toggleEnable(q)">{{ q.enabled ? '停用' : '启用' }}</button>
          <button class="danger" @click="remove(q)">删除</button>
        </div>

        <!-- 调整额度（必须填原因） -->
        <form v-if="editingId === q.id" class="adj-form" @submit.prevent="submitAdjust(q)">
          <input v-model.number="editForm.limit_kwh" type="number" min="0.01" step="0.01" placeholder="新额度 kWh" required />
          <input v-model.number="editForm.warn_ratio" type="number" min="0.05" max="1" step="0.05" placeholder="预警比例 0.8" required />
          <input v-model="editForm.reason" placeholder="调整原因（必填，将记入历史）" required />
          <button type="submit">确认调整</button>
          <button type="button" class="ghost" @click="editingId = null">取消</button>
        </form>
      </div>
      <div v-if="!store.quota.quotas.length" class="empty">还没有能耗定额，点击「新建定额」按房间或设备配置周期额度</div>
    </div>

    <!-- 告警闭环 -->
    <div class="card">
      <h4>🚨 定额告警与处理 <em>（处理状态全程保留；同一周期同一级别不重复告警，滚动到下一周期自动开新一轮）</em></h4>
      <div class="filter-row">
        <button v-for="f in alertFilters" :key="f.v" :class="{active: alertFilter === f.v}" @click="alertFilter = f.v">{{ f.label }}</button>
      </div>
      <table>
        <thead><tr><th>状态</th><th>目标</th><th>级别</th><th>用量/额度</th><th>周期</th><th>说明</th><th>时间</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="a in filteredAlerts" :key="a.id" :class="a.status">
            <td><span class="astate" :class="a.status">{{ a.status === 'open' ? '待处理' : '已处理' }}</span></td>
            <td>{{ a.scope === 'room' ? '🏠' : '🔌' }} {{ a.target_name }}</td>
            <td><span class="lv" :class="a.level">{{ a.level === 'over' ? '超标' : '预警' }}</span></td>
            <td>{{ a.usage_kwh.toFixed(2) }} / {{ a.limit_kwh.toFixed(2) }}</td>
            <td>{{ a.period_label }}<i class="tag">{{ fmtWindow(a.period_start) }}</i></td>
            <td class="msg">{{ a.message }}<div v-if="a.note" class="note">📝 {{ a.note }}<span v-if="a.handled_at" class="htime">（{{ a.handled_at }}）</span></div></td>
            <td class="time">{{ a.triggered_at }}</td>
            <td class="ops">
              <button v-if="a.status === 'open'" @click="openHandle(a.id)">处理</button>
              <button v-else class="ghost" @click="store.reopenQuotaAlert(a.id)">重开</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!filteredAlerts.length" class="empty">{{ alertFilter === 'handled' ? '暂无已处理告警' : '暂无在途告警，用量越线后自动出现' }}</div>

      <!-- 处理输入 -->
      <form v-if="handlingId" class="handle-form" @submit.prevent="submitHandle">
        <b>处理告警 #{{ handlingId }}</b>
        <input v-model="handleNote" placeholder="请填写处理说明，如：已关闭空调/已上调额度复核/设备故障已维修" required />
        <button type="submit">确认处理</button>
        <button type="button" class="ghost" @click="handlingId = null">取消</button>
      </form>
    </div>

    <!-- 调整历史 -->
    <div class="card">
      <h4>🗂 额度调整历史</h4>
      <table>
        <thead><tr><th>目标</th><th>周期</th><th>额度变化</th><th>预警线变化</th><th>原因</th><th>操作人</th><th>时间</th></tr></thead>
        <tbody>
          <tr v-for="r in store.adjustments" :key="r.id">
            <td>{{ r.scope === 'room' ? '🏠' : '🔌' }} {{ r.target_name }}</td>
            <td>{{ ({daily:'每日',weekly:'每周',monthly:'每月'})[r.period] }}</td>
            <td><span :class="r.new_limit >= (r.old_limit||0) ? 'up' : 'down'">{{ r.old_limit?.toFixed(2) ?? '—' }} → {{ r.new_limit.toFixed(2) }} kWh</span></td>
            <td>{{ Math.round((r.old_warn||0)*100) }}% → {{ Math.round(r.new_warn*100) }}%</td>
            <td class="msg">{{ r.reason }}</td>
            <td>{{ r.created_by }}</td>
            <td class="time">{{ r.created_at }}</td>
          </tr>
        </tbody>
      </table>
      <div v-if="!store.adjustments.length" class="empty">暂无调整记录</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useHomeStore } from '@/store/home'
const store = useHomeStore()

onMounted(() => { store.refreshQuotaExtras().catch(() => {}) })

const showAdd = ref(false)
const form = ref({ scope: 'room', target_id: '', period: 'daily', limit_kwh: 10, warn_ratio: 0.8 })
const editingId = ref(null)
const editForm = ref({ limit_kwh: 0, warn_ratio: 0.8, reason: '' })
const handlingId = ref(null)
const handleNote = ref('')
const alertFilter = ref('open')
const alertFilters = [
  { v: 'open', label: '待处理' }, { v: 'handled', label: '已处理' }, { v: 'all', label: '全部' }
]

async function submitCreate() {
  const ok = await store.createQuota({
    scope: form.value.scope,
    target_id: Number(form.value.target_id),
    period: form.value.period,
    limit_kwh: Number(form.value.limit_kwh),
    warn_ratio: Number(form.value.warn_ratio)
  })
  if (ok) { showAdd.value = false; form.value = { scope: 'room', target_id: '', period: 'daily', limit_kwh: 10, warn_ratio: 0.8 } }
}
function openAdjust(q) {
  editingId.value = editingId.value === q.id ? null : q.id
  editForm.value = { limit_kwh: q.limit_kwh, warn_ratio: q.warn_ratio, reason: '' }
}
async function submitAdjust(q) {
  const ok = await store.updateQuota(q.id, {
    limit_kwh: Number(editForm.value.limit_kwh),
    warn_ratio: Number(editForm.value.warn_ratio),
    period: q.period,
    reason: editForm.value.reason
  })
  if (ok) editingId.value = null
}
async function toggleEnable(q) {
  await store.updateQuota(q.id, { enabled: q.enabled ? false : true })
}
async function remove(q) {
  if (confirm(`删除「${q.target_name}」的${q.period_label}定额？\n历史告警与调整记录将保留。`))
    await store.deleteQuota(q.id)
}
function openHandle(id) { handlingId.value = id; handleNote.value = '' }
async function submitHandle() {
  const id = handlingId.value
  const ok = await store.handleQuotaAlert(id, handleNote.value)
  if (ok) { handlingId.value = null; handleNote.value = '' }
}

const filteredAlerts = computed(() =>
  store.quotaAlerts.filter((a) => alertFilter.value === 'all' || a.status === alertFilter.value))

function remain(q) { return Math.max(0, q.limit_kwh - q.usage_kwh) }
function barWidth(q) { return Math.min(100, Math.round(q.ratio * 100)) }
function barClass(q) {
  if (!q.enabled) return ''
  if (q.ratio >= 1) return 'over'
  if (q.ratio >= q.warn_ratio) return 'warn'
  return 'ok'
}
function progressTitle(q) { return `${q.usage_kwh.toFixed(3)} / ${q.limit_kwh.toFixed(2)} kWh` }
function fmtWindow(iso) {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}
</script>

<style scoped>
.quotas{display:flex;flex-direction:column;gap:14px;}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;}
.kpi{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:16px;text-align:center;}
.kpi b{display:block;font-size:26px;color:#ffd54f;}
.kpi.warn b{color:#ffb300;}.kpi.over b{color:#ef5350;}
.kpi em{font-size:12px;color:#8ba2c8;font-style:normal;}
.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;}
.hint{flex:1;min-width:220px;font-size:12px;color:#8ba2c8;}
.add{background:linear-gradient(135deg,#43a047,#2e7d32);border:none;color:#fff;font-weight:600;cursor:pointer;border-radius:8px;padding:8px 14px;font-size:12px;}
select,input,button{font-family:inherit;background:#13233f;border:1px solid rgba(120,160,220,0.2);color:#dbe4f3;border-radius:8px;padding:8px 10px;font-size:12px;}
.add-form{display:flex;gap:8px;flex-wrap:wrap;align-items:center;background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:12px;}
.add-form button,.adj-form button,.handle-form button{background:#2962ff;border:none;color:#fff;cursor:pointer;font-weight:600;}
button.ghost{background:#16263f;color:#aebadd;}
.wl{font-size:11px;color:#8ba2c8;display:flex;align-items:center;gap:6px;}
.wl input{width:70px;}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:12px;}
.qcard{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:8px;}
.qcard.off{opacity:.7;}
.qcard.deleted{border-color:rgba(239,83,80,.35);}
.q-head{display:flex;align-items:center;gap:10px;}
.q-ic{font-size:20px;}
.q-id{flex:1;min-width:0;}
.q-id b{color:#fff;font-size:14px;display:block;}
.q-id span{font-size:11px;color:#8ba2c8;}
.state{font-size:10px;padding:2px 8px;border-radius:6px;font-weight:600;}
.state.ok{background:#1b5e20;color:#a5d6a7;}.state.warn{background:#6d4c00;color:#ffd54f;}
.state.over{background:#b71c1c;color:#ffcdd2;}.state.off{background:#26324a;color:#8ba2c8;}
.tag{font-style:normal;font-size:10px;padding:1px 6px;border-radius:5px;background:#3a3320;color:#ffe082;margin-left:4px;}
.tag.del{background:#4a2020;color:#ffab91;}
.progress{position:relative;height:18px;background:#0c1730;border-radius:9px;overflow:hidden;}
.progress i{display:block;height:100%;transition:width .4s;}
.progress i.ok{background:linear-gradient(90deg,#43a047,#66bb6a);}
.progress i.warn{background:linear-gradient(90deg,#fb8c00,#ffb300);}
.progress i.over{background:linear-gradient(90deg,#e53935,#ef5350);}
.pct-label{position:absolute;right:8px;top:0;line-height:18px;font-size:10px;color:#fff;text-shadow:0 0 3px #000;font-weight:700;}
.q-nums{display:flex;justify-content:space-between;gap:8px;font-size:11px;color:#8ba2c8;flex-wrap:wrap;}
.q-nums b{font-size:13px;}
.q-nums b.warn{color:#ffb300;}.q-nums b.over{color:#ef5350;}
.window{color:#5b6f94;font-size:10px;}
.warn-line{font-size:10px;color:#5b6f94;}
.q-actions{display:flex;gap:6px;}
.q-actions button{padding:5px 10px;font-size:11px;cursor:pointer;}
.q-actions .danger{color:#ef9a9a;border-color:rgba(239,83,80,.4);margin-left:auto;}
.adj-form{display:flex;gap:6px;flex-wrap:wrap;align-items:center;background:#0c1730;border-radius:8px;padding:8px;}
.adj-form input{flex:1;min-width:90px;}
.card{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:16px;}
h4{margin:0 0 12px;color:#fff;font-size:14px;}
h4 em{font-size:11px;color:#5b6f94;font-weight:400;margin-left:8px;}
.filter-row{display:flex;gap:6px;margin-bottom:10px;}
.filter-row button{padding:5px 12px;font-size:11px;cursor:pointer;color:#8ba2c8;}
.filter-row button.active{background:#2962ff;color:#fff;border-color:transparent;}
table{width:100%;border-collapse:collapse;font-size:12px;}
th,td{padding:8px 8px;text-align:left;border-bottom:1px solid rgba(120,160,220,0.1);vertical-align:top;}
th{color:#8ba2c8;font-weight:600;font-size:11px;white-space:nowrap;}
td{color:#dbe4f3;}
tr.handled{opacity:.65;}
.astate{font-size:10px;padding:2px 7px;border-radius:5px;}
.astate.open{background:#b71c1c;color:#ffcdd2;}.astate.handled{background:#1b5e20;color:#a5d6a7;}
.lv{font-size:10px;padding:2px 7px;border-radius:5px;font-weight:600;}
.lv.over{background:#b71c1c;color:#ffcdd2;}.lv.warn{background:#6d4c00;color:#ffd54f;}
.msg{max-width:280px;}.msg .note{margin-top:4px;font-size:11px;color:#a5d6a7;}
.htime{color:#5b6f94;}
.time{color:#5b6f94;font-size:10px;white-space:nowrap;}
.ops button{padding:4px 10px;font-size:11px;cursor:pointer;}
.up{color:#66bb6a;font-weight:600;}.down{color:#ef5350;font-weight:600;}
.handle-form{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px;background:#0c1730;border:1px solid rgba(255,179,0,.3);border-radius:10px;padding:10px;}
.handle-form b{color:#ffb300;font-size:12px;}
.handle-form input{flex:1;min-width:240px;}
.empty{color:#5b6f94;text-align:center;padding:18px;font-size:12px;}
</style>
