local Reading = {}
local AnchorStore = require("bookorbit_anchor_store")
local Storage = require("bookorbit_install_storage")
local State = require("bookorbit_delivery_state")

function Reading.captureKey(path)
    local settings = require("bookorbit_install_sidecars").open(path)
    local source = settings.source_candidate
    if not source then return "no-sidecar", settings end
    local identity = Storage.identity(source)
    if not identity or identity.sizeBytes > 16 * 1024 * 1024 then return nil, "sidecar_changed" end
    return identity.sha256, settings
end

function Reading.verify(path, capture_key)
    if type(capture_key) ~= "string" then return nil, "waiting_for_uploads" end
    local current = Reading.captureKey(path)
    if current ~= capture_key then return nil, "waiting_for_uploads" end
    return true
end

local function pending(plugin, digest)
    for _, entry in ipairs(plugin:getLifecycleOutbox():listMetadata()) do
        if entry.digest == digest then
            plugin:requestLifecycleOutboxDrain("delivery")
            return true
        end
    end
    return false
end

function Reading.upload(plugin, client, job, operation)
    local ui = plugin.ui
    if ui and ui.document and ui.document.file == job.pathname then
        local handled, err = require("bookorbit_reading_exchange").run(plugin)
        if not handled or err then return nil, err or "waiting_for_uploads" end
        local snapshot = require("bookorbit_book_sync").capture(plugin)
        if not snapshot then return nil, "anchor_persistence" end
        if pending(plugin, snapshot.digest) then return nil, "waiting_for_uploads" end
        -- Closing captures final statistics and annotations before the next delivery attempt.
        return true
    end
    local backup, err = AnchorStore.load(job.pathname)
    if not backup then return nil, err or "anchor_missing" end
    local record = backup.record
    if record.copyId ~= job.copyId or record.anchor.bookFileId ~= job.bookFileId then return nil, "copy_changed" end
    local digest = require("util").partialMD5(job.pathname)
    if not digest then return nil, "copy_missing" end
    if pending(plugin, digest) then return nil, "waiting_for_uploads" end
    local capture_key, settings = Reading.captureKey(job.pathname)
    if not capture_key then return nil, settings end
    if record.sha256 ~= job.expectedLocalSha256 then
        local inventory = record.inventory
        if not inventory or inventory.sha256 ~= job.expectedLocalSha256 or inventory.readingCapture ~= capture_key then
            return nil, "waiting_for_uploads"
        end
        -- Unopened managed copies retain old native annotations that were already uploaded.
        if operation.readingCapture ~= capture_key then
            operation.readingCapture = capture_key
            if not State.save(operation) then return nil, "outbox_persistence" end
        end
    end
    if operation.readingCapture ~= capture_key then
        if settings.source_candidate then settings = require("docsettings").openSettingsFile(settings.source_candidate) end
        local data = require("bookorbit_sidecar").extract(job.pathname, settings) or {}
        if not Reading.verify(job.pathname, capture_key) then return nil, "waiting_for_uploads" end
        local metadata = require("bookorbit_stats_reader").primeIdentity(digest) or {}
        local snapshot = { digest = digest, file = job.pathname, expected_book_file_id = job.bookFileId,
            title = metadata.title, authors = metadata.authors, last_open = metadata.last_open or os.time(),
            stats_ids = metadata.ids or {}, stats_metadata_ambiguous = metadata.metadata_ambiguous == true,
            annotations = data.annotations or {}, ann_count = data.annotations_count or 0,
            ann_max_datetime = data.annotations_max_datetime, ann_signature = data.annotations_signature,
            bookmarks = data.bookmarks or {}, bm_signature = data.bookmarks_signature,
            status = data.status, status_modified = data.status_modified, rating = data.rating, review_note = data.review_note,
            ts = os.time() }
        local entry
        entry, err = plugin:getLifecycleOutbox():enqueue(snapshot, { reason = "delivery", annotation_sync = true })
        if not entry then return nil, err or "outbox_persistence" end
        operation.readingCapture = capture_key
        local saved
        saved, err = State.save(operation)
        if not saved then return nil, err end
        plugin:requestLifecycleOutboxDrain("delivery")
        return nil, "waiting_for_uploads"
    end
    local endpoint = "/koreader/plugin/files/" .. job.bookFileId .. "/reading-events"
    local remote
    remote, err = client:request("GET", endpoint)
    if not remote then return nil, err end
    if remote.bookFileId ~= job.bookFileId or remote.bookId ~= record.anchor.bookId
        or type(remote.resetGeneration) ~= "number" then return nil, "invalid_reading_state" end
    if record.anchor.event and record.anchor.event.resetGeneration == remote.resetGeneration then
        remote, err = client:request("POST", endpoint, { anchor = record.anchor })
        if not remote then return nil, err end
        if remote.bookFileId ~= job.bookFileId or remote.bookId ~= record.anchor.bookId
            or type(remote.resetGeneration) ~= "number" then return nil, "invalid_reading_state" end
    end
    local latest = AnchorStore.load(job.pathname)
    if not latest or latest.record.persistenceSequence ~= record.persistenceSequence then return nil, "reading_changed" end
    if remote.anchor then
        if remote.anchor.bookFileId ~= job.bookFileId or remote.anchor.bookId ~= record.anchor.bookId then return nil, "invalid_reading_state" end
        record.anchor = remote.anchor
    else
        record.anchor = { schemaVersion = 1, bookFileId = job.bookFileId, bookId = record.anchor.bookId,
            revision = "sha256:" .. record.sha256, chapterIndex = 0, chapterFraction = 0, bookFraction = 0 }
    end
    record.chapter, record.acknowledgement = nil, nil
    record.resetGeneration = remote.resetGeneration
    record.awaitingReconciliation = true
    record.persistenceSequence = record.persistenceSequence + 1
    return AnchorStore.save(record, backup.sidecarPath)
end

return Reading
