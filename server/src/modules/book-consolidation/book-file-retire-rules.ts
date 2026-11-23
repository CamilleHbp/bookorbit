/**
 * What retiring a duplicate `book_files` row does with every column that references
 * `book_files.id`, keyed `table.column`. Deleting the row outright would cascade readers' sessions,
 * progress and KOReader state, so `retireFile` moves them to the copy that stays first. The guard
 * test fails when the schema gains a foreign key to `book_files` without an entry here.
 *
 * - `repoint`: rows move to the surviving file.
 * - `newer-wins`: one row per user (or device) on each file; the newer survives on the surviving file.
 * - `survivor-wins`: the surviving file's row is kept, the loser's moves only when the survivor has none.
 * - `drop`: the loser's rows are derived data and are deleted.
 * - `block`: retained revisions or managed imports prevent retiring the file.
 * - `primary`: the book's primary file moves to the survivor.
 */
export type BookFileRetireRuleKind = 'repoint' | 'newer-wins' | 'survivor-wins' | 'drop' | 'primary' | 'block';

export const BOOK_FILE_RETIRE_RULES: Readonly<Record<string, BookFileRetireRuleKind>> = {
  'book_dock_managed_imports.book_file_id': 'block',
  'book_file_revisions.book_file_id': 'block',
  'canonical_reading_events.book_file_id': 'block',
  'fanfiction_discovery_candidates.book_file_id': 'block',
  'fanfiction_sources.book_file_id': 'block',
  'koreader_installed_copies.book_file_id': 'block',
  'reading_event_heads.book_file_id': 'block',
  'reading_position_acknowledgements.book_file_id': 'block',
  'revision_publications.book_file_id': 'block',
  'books.primary_file_id': 'primary',
  'reading_progress.book_file_id': 'newer-wins',
  'reading_sessions.book_file_id': 'repoint',
  'audiobook_progress.current_file_id': 'repoint',
  'reader_preferences.book_file_id': 'survivor-wins',
  'tts_reading_position.book_file_id': 'newer-wins',
  'annotation_positions.book_file_id': 'survivor-wins',
  'bookmarks.book_file_id': 'repoint',
  'koreader_book_hash_links.book_file_id': 'survivor-wins',
  'koreader_device_progress.book_file_id': 'newer-wins',
  'koreader_page_stats.book_file_id': 'survivor-wins',
  'koreader_progress_resets.book_file_id': 'newer-wins',
  'koreader_session_tombstones.book_file_id': 'survivor-wins',
  'book_file_chapters.book_file_id': 'drop',
  'book_file_texts.file_id': 'drop',
  'book_file_audio_timelines.file_id': 'drop',
  'book_file_hash_history.book_file_id': 'repoint',
  'delivery_artifacts.book_file_id': 'drop',
  'delivery_inspections.book_file_id': 'drop',
  'email_send_log.book_file_id': 'repoint',
  'file_write_log.book_file_id': 'repoint',
  'kobo_device_deliveries.source_file_id': 'drop',
  'read_aloud_jobs.output_file_id': 'repoint',
  'read_aloud_jobs.replace_file_id': 'repoint',
};
