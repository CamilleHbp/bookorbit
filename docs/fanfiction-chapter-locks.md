# Local chapter edits

FanFicFare updates and full refreshes retain chapters whose XHTML head contains
`<meta name="bookorbit:chapter-lock" content="true"/>`. Chapters are matched by
their `chapterurl` metadata, including occurrence order for duplicate URLs.
New, unlocked chapters continue updating normally.

For additive updates, also set `bookorbit:chapter-baseline` to the relative path
of a JSON resource produced by `chapter_lock_merge.baseline_data()` from the
unedited source chapter. Include this resource in the EPUB manifest with media
type `application/json`. The baseline records the original XHTML and resource
hashes, without duplicating source images.

An update compares that baseline with the website chapter and inserts new
passages at matching boundaries in the locally edited chapter. The baseline then
advances to the website version for the next update. Local paragraphs, HTML
panels, illustrations, and stylesheets remain intact. Copied assets use separate
paths so website assets cannot overwrite them.

Source deletions, rewrites, missing chapters, or ambiguous insertion positions
stop the update with `chapter_lock_conflict`. The installed EPUB is unchanged.
Inspect the conflicting changes before publishing a resolved EPUB. A lock
without a baseline preserves the whole chapter without merging source changes.

To unlock a chapter, remove both metadata entries and publish the edited EPUB
through the managed revision service. Removing the lock lets later updates use
the website version of that chapter. Markers and baselines are scoped to their
containing book and survive application upgrades without a separate database
setting.
