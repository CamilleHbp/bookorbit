<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ref } from 'vue'
import type { KoreaderInstalledCopy } from '@bookorbit/types'
import KoreaderDeliveryPanel from './KoreaderDeliveryPanel.vue'
import { Button } from '@/components/ui/button'
import { formatDate as formatLocaleDate } from '@/i18n/formatters'
import { useKoreaderCopies } from '../composables/useKoreaderCopies'

const props = defineProps<{ bookFileId?: number }>()
const { t } = useI18n()
const expandedCopy = ref('')
function selectCopy(copy: KoreaderInstalledCopy) {
  expandedCopy.value = expandedCopy.value === copy.id ? '' : copy.id
}
const formatDate = (iso: string) => formatLocaleDate(new Date(iso))
const {
  permitted,
  copies,
  devices,
  copyCursor,
  deviceCursor,
  deviceId,
  busy,
  error,
  copyPolicies,
  devicePolicies,
  refresh,
  nextCopies,
  nextDevices,
  filterCopies,
  supportsAutomatic,
  saveCopy,
  saveDevice,
} = useKoreaderCopies(() => props.bookFileId)
</script>

<template>
  <section v-if="permitted" class="space-y-5" :aria-label="t('koreaderCopies.title')" :aria-busy="busy">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 class="font-medium">{{ t('koreaderCopies.title') }}</h3>
        <p class="text-sm text-muted-foreground">{{ t('koreaderCopies.description') }}</p>
      </div>
      <Button variant="outline" :disabled="busy" @click="refresh">{{ t('koreaderCopies.refresh') }}</Button>
    </div>
    <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
    <div v-if="bookFileId === undefined" class="space-y-3">
      <h4 class="text-sm font-medium">{{ t('koreaderCopies.deviceDefaults') }}</h4>
      <article v-for="device in devices" :key="device.deviceId" class="rounded-lg border border-border p-4 space-y-2">
        <p class="break-all font-medium">{{ device.deviceId }}</p>
        <p class="text-xs text-muted-foreground">
          {{ t('koreaderCopies.lastContact', { date: formatDate(device.lastContactAt) }) }} · {{ device.pluginVersion }}
        </p>
        <p v-if="device.deliveryCapabilityVersion < 1 || device.positionCapabilityVersion < 1" class="text-sm text-muted-foreground">
          {{ t('koreaderCopies.updateRequired') }}
        </p>
        <div class="flex flex-wrap items-center gap-2">
          <label :for="`device-policy-${device.deviceId}`" class="text-sm">{{ t('koreaderCopies.defaultPolicy') }}</label>
          <select
            :id="`device-policy-${device.deviceId}`"
            v-model="devicePolicies[device.deviceId]"
            :disabled="busy"
            class="rounded-md border border-input bg-background p-2 text-sm"
          >
            <option value="notify">{{ t('koreaderCopies.notify') }}</option>
            <option value="automatic" :disabled="!supportsAutomatic(device)">{{ t('koreaderCopies.automatic') }}</option>
            <option value="ignore">{{ t('koreaderCopies.ignore') }}</option>
          </select>
          <Button variant="outline" :disabled="busy || devicePolicies[device.deviceId] === device.policy" @click="saveDevice(device)">{{
            t('koreaderCopies.save')
          }}</Button>
        </div>
      </article>
      <Button v-if="deviceCursor" variant="outline" :disabled="busy" @click="nextDevices">{{ t('koreaderCopies.nextDevices') }}</Button>
      <div class="flex flex-wrap items-center gap-2">
        <label for="copy-device-filter" class="text-sm">{{ t('koreaderCopies.deviceFilter') }}</label>
        <input
          id="copy-device-filter"
          v-model="deviceId"
          maxlength="100"
          :disabled="busy"
          class="rounded-md border border-input bg-background p-2 text-sm"
        />
        <Button variant="outline" :disabled="busy" @click="filterCopies">{{ t('koreaderCopies.filter') }}</Button>
      </div>
    </div>
    <p v-if="!busy && copies.length === 0" class="text-sm text-muted-foreground">{{ t('koreaderCopies.empty') }}</p>
    <article v-for="copy in copies" :key="copy.id" class="space-y-3 rounded-lg border border-border p-4">
      <div>
        <p class="font-medium break-all">{{ copy.deviceId }}</p>
        <p class="text-sm break-all">{{ copy.pathname }}</p>
      </div>
      <dl class="grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt class="text-muted-foreground">{{ t('koreaderCopies.serverStatus') }}</dt>
          <dd>
            {{
              t(
                copy.currentSha256 === null
                  ? 'koreaderCopies.serverPending'
                  : copy.sha256 === copy.currentSha256
                    ? 'koreaderCopies.current'
                    : 'koreaderCopies.different',
              )
            }}
          </dd>
        </div>
        <div>
          <dt class="text-muted-foreground">{{ t('koreaderCopies.installedStatus') }}</dt>
          <dd>{{ t(copy.identity === 'known' ? 'koreaderCopies.identified' : 'koreaderCopies.provisional') }}</dd>
        </div>
        <div>
          <dt class="text-muted-foreground">{{ t('koreaderCopies.positionSupport') }}</dt>
          <dd>{{ t(copy.positionCapabilityVersion >= 1 ? 'koreaderCopies.supported' : 'koreaderCopies.updateRequired') }}</dd>
        </div>
        <div>
          <dt class="text-muted-foreground">{{ t('koreaderCopies.effectivePolicy') }}</dt>
          <dd>
            {{ t(`koreaderCopies.${copy.policy}`) }} ·
            {{ t(copy.policyAcknowledged ? 'koreaderCopies.acknowledged' : 'koreaderCopies.awaitingAcknowledgement') }}
          </dd>
        </div>
      </dl>
      <p class="text-xs text-muted-foreground">{{ t('koreaderCopies.lastContact', { date: formatDate(copy.lastContactAt) }) }}</p>
      <div class="flex flex-wrap items-center gap-2">
        <label :for="`copy-policy-${copy.id}`" class="text-sm">{{ t('koreaderCopies.copyPolicy') }}</label>
        <select
          :id="`copy-policy-${copy.id}`"
          v-model="copyPolicies[copy.id]"
          :disabled="busy"
          class="rounded-md border border-input bg-background p-2 text-sm"
        >
          <option value="">{{ t('koreaderCopies.inherit') }}</option>
          <option value="notify">{{ t('koreaderCopies.notify') }}</option>
          <option value="automatic" :disabled="!supportsAutomatic(copy)">{{ t('koreaderCopies.automatic') }}</option>
          <option value="ignore">{{ t('koreaderCopies.ignore') }}</option>
        </select>
        <Button variant="outline" :disabled="busy || copyPolicies[copy.id] === (copy.policyOverride ?? '')" @click="saveCopy(copy)">{{
          t('koreaderCopies.save')
        }}</Button>
      </div>
      <Button variant="outline" :aria-expanded="expandedCopy === copy.id" @click="selectCopy(copy)">{{ t('koreaderDelivery.manage') }}</Button>
      <KoreaderDeliveryPanel v-if="expandedCopy === copy.id" :copy="copy" />
    </article>
    <Button v-if="copyCursor" variant="outline" :disabled="busy" @click="nextCopies">{{ t('koreaderCopies.nextCopies') }}</Button>
  </section>
</template>
