import { computed, onScopeDispose, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FanfictionDownloadRow, FanfictionImportProgress } from '@bookorbit/types'

export function useDownloadActivity(
  source: () => {
    progress?: FanfictionImportProgress | null
    waitingFor?: FanfictionDownloadRow['waitingFor']
    nextAttemptAt?: string | null
    lastContactAt?: string | null
    site?: string
  },
) {
  const { t, locale } = useI18n()
  const now = ref(Date.now())
  let timer: ReturnType<typeof setInterval> | undefined
  watch(
    () => {
      const row = source()
      return !!(row.progress?.updatedAt || row.lastContactAt || (row.waitingFor === 'scheduled_retry' && row.nextAttemptAt))
    },
    (enabled) => {
      clearInterval(timer)
      if (enabled)
        timer = setInterval(() => {
          now.value = Date.now()
        }, 10000)
    },
    { immediate: true },
  )
  onScopeDispose(() => clearInterval(timer))
  const message = computed(() => {
    const row = source()
    if (row.waitingFor === 'paused') return t('bookMetadataFetch.label.paused')
    if (row.waitingFor === 'scheduled_retry' && row.nextAttemptAt && new Date(row.nextAttemptAt).getTime() > now.value)
      return t('fanfiction.liveActivity.retryAt', {
        time: new Date(row.nextAttemptAt).toLocaleTimeString(locale.value, { hour: 'numeric', minute: '2-digit' }),
      })
    if (row.waitingFor && row.waitingFor !== 'scheduled_retry') return t(`fanfiction.liveActivity.wait.${row.waitingFor}`, { site: row.site })
    if (row.waitingFor === 'scheduled_retry') return t('fanfiction.liveActivity.wait.ready')
    if (row.progress?.activity === 'chapter' && row.progress.currentChapter && row.progress.totalChapters) return ''
    if (row.progress?.activity === 'chapter' && !row.progress.currentChapter) return t('fanfiction.progress.downloading')
    if (row.progress?.activity === 'illustrations' && row.progress.illustration)
      return t('fanfiction.liveActivity.illustration', { count: row.progress.illustration })
    if (row.progress?.activity) return t(`fanfiction.liveActivity.step.${row.progress.activity}`, { chapter: row.progress.currentChapter })
    return ''
  })
  const freshness = computed(() => {
    const at = source().progress?.updatedAt
    if (!at || !Number.isFinite(new Date(at).getTime())) return ''
    const seconds = Math.max(0, Math.floor((now.value - new Date(at).getTime()) / 1000))
    return seconds < 60 ? t('fanfiction.liveActivity.justNow') : t('fanfiction.liveActivity.minutesAgo', { count: Math.floor(seconds / 60) })
  })
  const connected = computed(() => {
    const at = source().lastContactAt
    return !!at && now.value - new Date(at).getTime() < 45000
  })
  const chapter = computed(() => {
    const progress = source().progress
    if (!progress?.currentChapter || !progress.totalChapters) return ''
    const position = t('fanfiction.liveActivity.chapter', { chapter: progress.currentChapter, total: progress.totalChapters })
    return progress.currentChapterTitle ? t('fanfiction.liveActivity.chapterTitle', { position, title: progress.currentChapterTitle }) : position
  })
  return { message, freshness, connected, chapter }
}
