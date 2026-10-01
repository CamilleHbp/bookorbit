<script setup lang="ts">
import { onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FanfictionProfileSummary } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import DiscoveryWebsiteGroup from './DiscoveryWebsiteGroup.vue'
import { useDiscoveryReview } from '../composables/useDiscoveryReview'
const props = defineProps<{ libraryId: number; profiles: FanfictionProfileSummary[]; profileCursor: string | null }>()
const emit = defineEmits<{ moreProfiles: [] }>()
const { t } = useI18n()
const review = useDiscoveryReview(props.libraryId)
const { websites, cutoff, cursor, busy, error, job, pending, active, locked, recover, moreWebsites, scan, submitPending, cancel } = review
function moreProfiles() {
  emit('moreProfiles')
}
onMounted(recover)
</script>
<template>
  <section class="space-y-5">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="text-lg font-semibold">{{ t('fanfiction.sourceReview.heading') }}</h2>
        <p class="text-muted-foreground text-sm">{{ t('fanfiction.sourceReview.help') }}</p>
      </div>
      <Button variant="outline" :disabled="locked" @click="scan">{{ t('fanfiction.discovery.findLinks') }}</Button>
    </div>
    <p v-if="error" role="alert" class="text-destructive text-sm">{{ error }}</p>
    <div v-if="pending" class="border-border space-y-2 rounded-md border p-3" role="alert">
      <p class="text-sm">{{ t('fanfiction.discovery.uncertain') }}</p>
      <Button :disabled="busy" @click="submitPending">{{ t('fanfiction.retry') }}</Button>
    </div>
    <div v-if="job?.kind === 'discovery'" class="bg-muted space-y-2 rounded-md p-3 text-sm" role="status">
      <p class="font-medium">{{ t(`fanfiction.states.${job.state}`) }}</p>
      <p v-if="job.result?.discovery">{{ t('fanfiction.discovery.scanProgress', job.result.discovery) }}</p>
      <p v-if="job.errorCode" class="text-destructive">{{ t(`fanfiction.errors.${job.errorCode}`) }}</p>
      <Button v-if="active" variant="outline" :disabled="busy || job.cancellationRequested" @click="cancel">{{ t('fanfiction.cancel') }}</Button>
    </div>
    <p v-if="busy && !websites.length" role="status" class="text-muted-foreground py-8 text-sm">{{ t('fanfiction.discovery.loading') }}</p>
    <p v-else-if="!websites.length" class="text-muted-foreground py-8 text-sm">{{ t('fanfiction.sourceReview.empty') }}</p>
    <DiscoveryWebsiteGroup
      v-for="source in websites"
      :key="`${cutoff}:${source.website}`"
      :source="source"
      :cutoff="cutoff"
      :review="review"
      :profiles="profiles"
      :more-profiles="profileCursor !== null"
      @more-profiles="moreProfiles"
    />
    <Button v-if="cursor !== null" variant="outline" :disabled="locked" @click="moreWebsites">{{ t('fanfiction.sourceReview.moreWebsites') }}</Button>
  </section>
</template>
