---
target: Fanfiction Updates tab
total_score: 21
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 2
target_identity: "file:/Users/camille/Dev/Personal/bookorbit/client/src/features/fanfiction/FanfictionPage.vue"
target_fingerprint: "sha256:0b9919cf404882572457940eac789bd10b61c28e5fb3f53d5c7328aabd01cb56"
target_path: /Users/camille/Dev/Personal/bookorbit/client/src/features/fanfiction/FanfictionPage.vue
timestamp: 2026-11-05T15-42-14Z
slug: src-features-fanfiction-fanfictionpage-vue
---
# Updates tab critique (FanfictionPage.vue activity section)
Method: dual-agent. Fixture preview, 50 changes/page, 5 tasks. Live app not inspected (sign-in required).
Score 21/40 (Acceptable). H1 2, H2 2, H3 3, H4 2, H5 3, H6 2, H7 1, H8 2, H9 2, H10 2.
## Priority issues
- [P0] Task history buried ~7.8 screens down (y=5961 of 6727px) and closed by default; running/failed jobs invisible on landing. Fix: move above recent changes, always show queued/running/failed, fold completed into "Show N completed".
- [P1] Recent story changes: 50 x 3-line rows, 50 identical "Open book" links, always open. Fix: collapsible (closed by default, remembered), one-line rows with title as link + kind + relative time, group by day, kind filter passed to API.
- [P1] Collapsed summaries carry no count/severity; "Website access needs attention" expands to nothing when there are no repairs (WebsiteConnections.vue:90 renders nothing in repairsOnly with 0 rows). Summaries duplicate child h2s. Fix: counts in summaries, auto-open when >0, hide when 0, one heading per section.
- [P2] Task cards use raw URL as title (L645) and offer Retry on authentication_required at attempt 3/3 (L656-667). Fix: story title + site, branch actions on errorCode (Fix login via fixSourceLogin), check-only success state instead of 100% bar.
## Detector
CLI: 0 findings on 5 files. Overlay: cream-palette (intentional token), repeating-stripes-gradient (false positive: unused .pattern-* rules), low-contrast 4.4:1 on text-destructive over card (real, marginal, token-level).
