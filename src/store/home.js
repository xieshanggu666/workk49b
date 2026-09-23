import { defineStore } from 'pinia'

async function api(path, method = 'GET', body) {
  const opt = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opt.body = JSON.stringify(body)
  const r = await fetch('/api' + path, opt)
  const data = await r.json()
  if (!r.ok) throw new Error(data.error || '请求失败')
  return data
}

export const useHomeStore = defineStore('home', {
  state: () => ({
    loaded: false,
    tab: 'dash',
    rooms: [],
    types: [],
    devices: [],
    scenes: [],
    logs: [],
    energy: { total: 0, trend: [], rooms: [], devices: [] },
    alerts: [],
    quota: { quotas: [], open_alerts: [], summary: { total: 0, enabled: 0, open_count: 0, over_count: 0, warn_count: 0 } },
    quotaAlerts: [],
    adjustments: [],
    toast: null,
    timer: null,
    // 已弹过 toast 的定额告警 id：只有轮询中新出现的未处理告警才通知，避免每 20s 重复打扰
    seenQuotaAlertIds: null
  }),
  getters: {
    onlineCount: (s) => s.devices.filter((d) => d.status === 'online').length,
    errorCount: (s) => s.devices.filter((d) => d.status === 'error').length,
    onCount: (s) => s.devices.filter((d) => d.power_on).length,
    totalWatts: (s) => s.devices.reduce((sum, d) => sum + (d.power_on ? d.watts : 0), 0),
    openQuotaCount: (s) => s.quota.summary?.open_count || 0
  },
  actions: {
    async load() {
      const d = await api('/state')
      this.rooms = d.rooms
      this.types = d.types
      this.devices = d.devices
      this.scenes = d.scenes
      this.logs = d.logs
      this.energy = d.energy
      this.alerts = d.alerts
      this.quota = d.quota
      this.notifyNewQuotaAlerts(d.quota?.open_alerts || [])
      this.loaded = true
    },
    // 超标/预警持续聚合触发后的实时通知：首次加载只建立基线不弹，之后新出现即 toast
    notifyNewQuotaAlerts(openAlerts) {
      const ids = new Set(openAlerts.map((a) => a.id))
      if (this.seenQuotaAlertIds === null) {
        this.seenQuotaAlertIds = ids
        return
      }
      for (const a of openAlerts) {
        if (!this.seenQuotaAlertIds.has(a.id)) {
          this.toastMsg(`⚠️ ${a.target_name} ${a.message}`, a.level === 'over' ? 'warn' : 'info')
        }
      }
      // 被处理关闭的告警 id 从集合移除，将来同目标新一轮告警仍可再次通知
      this.seenQuotaAlertIds = ids
    },
    // 看板趋势/实时用电随模拟节拍轻量刷新；轮询失败静默（手动操作仍会立即拉取）
    startAutoRefresh() {
      if (this.timer) return
      this.timer = setInterval(() => { this.load().catch(() => {}) }, 20_000)
    },
    toastMsg(msg, type = 'info') {
      this.toast = { msg, type, id: Date.now() }
    },
    clearToast() { this.toast = null },

    async addDevice(p) {
      try { await api('/device', 'POST', p); await this.load(); this.toastMsg('已新增设备', 'success') }
      catch (e) { this.toastMsg(e.message, 'warn') }
    },
    async removeDevice(id) {
      await api('/device/' + id, 'DELETE'); await this.load()
    },
    async toggleDevice(id) {
      try {
        const r = await api(`/device/${id}/toggle`, 'POST'); await this.load()
        return r.power_on
      } catch (e) { this.toastMsg(e.message, 'warn') }
    },
    async updateDevice(id, patch) {
      await api(`/device/${id}/update`, 'POST', patch); await this.load()
    },
    async addScene(scene) {
      const r = await api('/scene', 'POST', scene); await this.load(); this.toastMsg('场景已创建', 'success'); return r.id
    },
    async deleteScene(id) {
      await api('/scene/' + id, 'DELETE'); await this.load()
    },
    async toggleScene(id) {
      await api(`/scene/${id}/toggle`, 'POST'); await this.load()
    },
    async runScene(id) {
      try {
        const r = await api(`/scene/${id}/run`, 'POST')
        await this.load()
        if (r.failed?.length)
          this.toastMsg(`场景执行完成：成功 ${r.executed.length} 项，失败 ${r.failed.length} 项`, 'warn')
        else
          this.toastMsg(`场景已触发，成功执行 ${r.executed.length} 个动作`, 'success')
        return r
      } catch (e) {
        this.toastMsg(e.message, 'warn')
      }
    },

    // ===== 能耗定额 =====
    async refreshQuotaExtras() {
      const [alerts, adjusts] = await Promise.all([
        api('/quota/alerts'), api('/quota/adjustments')
      ])
      this.quotaAlerts = alerts
      this.adjustments = adjusts
    },
    async createQuota(p) {
      try {
        await api('/quota', 'POST', p)
        await this.load()
        await this.refreshQuotaExtras()
        this.toastMsg('定额已创建并立即核算', 'success')
        return true
      } catch (e) { this.toastMsg(e.message, 'warn'); return false }
    },
    async updateQuota(id, patch) {
      try {
        await api('/quota/' + id, 'POST', patch)
        await this.load()
        await this.refreshQuotaExtras()
        this.toastMsg('定额已更新', 'success')
        return true
      } catch (e) { this.toastMsg(e.message, 'warn'); return false }
    },
    async deleteQuota(id) {
      try {
        await api('/quota/' + id, 'DELETE')
        await this.load()
        await this.refreshQuotaExtras()
        this.toastMsg('定额已删除，历史告警保留', 'info')
      } catch (e) { this.toastMsg(e.message, 'warn') }
    },
    async handleQuotaAlert(id, note) {
      try {
        await api(`/quota/alert/${id}/handle`, 'POST', { note })
        await this.load()
        await this.refreshQuotaExtras()
        this.toastMsg('告警已标记处理', 'success')
        return true
      } catch (e) { this.toastMsg(e.message, 'warn'); return false }
    },
    async reopenQuotaAlert(id) {
      try {
        await api(`/quota/alert/${id}/reopen`, 'POST')
        await this.load()
        await this.refreshQuotaExtras()
        this.toastMsg('告警已重新打开', 'info')
      } catch (e) { this.toastMsg(e.message, 'warn') }
    }
  }
})
