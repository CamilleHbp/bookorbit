<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { KoreaderInstalledCopy } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { formatDate as formatLocaleDate } from '@/i18n/formatters'
import { useKoreaderDelivery } from '../composables/useKoreaderDelivery'
const props = defineProps<{ copy: KoreaderInstalledCopy }>()
const { t } = useI18n()
const formatDate = (iso: string) => formatLocaleDate(new Date(iso))
const { permitted, supported, canRequest, jobs, nextCursor, busy, error, refresh, nextPage, requestDelivery, canCancel, canRetry, cancel, retry } =
  useKoreaderDelivery(() => props.copy)
</script>

<template>
  <section v-if="permitted" class="space-y-3 border-t border-border pt-4" :aria-label="t('koreaderDelivery.title')" :aria-busy="busy">
    <div class="flex flex-wrap gap-2 items-center">
      <h4 class="text-sm font-medium">{{ t('koreaderDelivery.title') }}</h4>
      <Button v-if="canRequest" :disabled="busy" @click="requestDelivery">{{ t('koreaderDelivery.request') }}</Button>
      <Button variant="outline" :disabled="busy" @click="refresh">{{ t('koreaderCopies.refresh') }}</Button>
    </div>
    <p v-if="!supported" class="text-sm text-muted-foreground">{{ t('koreaderCopies.updateRequired') }}</p>
    <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
    <p v-if="!busy && !jobs.length" class="text-sm text-muted-foreground">{{ t('koreaderDelivery.empty') }}</p>
    <article v-for="job in jobs" :key="job.id" class="rounded-md bg-muted/30 p-3 space-y-2">
      <p class="text-xs text-muted-foreground">{{ formatDate(job.createdAt) }}</p>
      <dl class="grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt class="text-muted-foreground">{{ t('koreaderDelivery.installation') }}</dt>
          <dd>{{ t(`koreaderDelivery.${job.installationState}`) }}</dd>
        </div>
        <div>
          <dt class="text-muted-foreground">{{ t('koreaderDelivery.restoration') }}</dt>
          <dd>{{ t(job.installationState === 'installed' ? `koreaderDelivery.${job.restorationState}` : 'koreaderDelivery.afterInstallation') }}</dd>
        </div>
      </dl>
      <p v-if="job.cancelledAt" class="text-sm">{{ t('koreaderDelivery.cancelled') }}</p>
      <p v-if="job.failureCode" class="text-sm text-destructive">{{ t(`koreaderDelivery.failures.${job.failureCode}`) }}</p>
      <p v-if="job.restorationFailureCode" class="text-sm text-destructive">{{ t('koreaderDelivery.restorationFailed') }}</p>
      <div class="flex flex-wrap gap-2">
        <Button v-if="canRetry(job)" variant="outline" :disabled="busy" @click="retry(job)">{{ t('koreaderDelivery.retry') }}</Button>
        <Button v-if="canCancel(job)" variant="outline" :disabled="busy" @click="cancel(job)">{{ t('koreaderDelivery.cancel') }}</Button>
      </div>
    </article>
    <Button v-if="nextCursor" variant="outline" :disabled="busy" @click="nextPage">{{ t('koreaderDelivery.older') }}</Button>
  </section>
</template>
