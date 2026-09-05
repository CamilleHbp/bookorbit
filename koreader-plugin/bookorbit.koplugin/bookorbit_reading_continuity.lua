local Native = require("bookorbit_native_anchor")
local Identity = require("bookorbit_file_identity")
local Annotations = require("bookorbit_annotation_continuity")
local UIManager = require("ui/uimanager")
local logger = require("logger")
local Continuity = {}
local KEY = "bookorbit_revision_anchor_v1"

local function save(plugin)
    local state = plugin.reading_continuity
    if not state or not state.record or not plugin.ui.doc_settings then return false end
    plugin.ui.doc_settings:saveSetting(KEY, state.record)
    return plugin.ui.doc_settings:flush() ~= nil
end

function Continuity.begin(plugin)
    local ui = plugin.ui
    if not ui or not ui.document or not ui.document.getXPointer then return end
    local record = ui.doc_settings:readSetting(KEY)
    if type(record) ~= "table" or type(record.anchor) ~= "table" then
        record = nil
        local percent = ui.doc_settings:readSetting("percent_finished") or ui.doc_settings:readSetting("last_percent")
        if type(percent) == "number" and percent > 0 and percent <= 1 then
            record = { anchor = { schemaVersion = 1, revision = "legacy", chapterIndex = 0,
                chapterFraction = 0, bookFraction = percent }, legacy = true }
        end
    end
    plugin.reading_continuity = { record = type(record) == "table" and type(record.anchor) == "table" and record or nil, restoring = true }
    plugin.reading_continuity.annotations = Annotations.begin(ui, record)
    ui.doc_settings:delSetting("partial_md5_checksum")
    if record then
        local root = require("datastorage"):getDataDir() .. "/cache/cr3cache/"
        local path = ui.doc_settings:readSetting("cache_file_path")
        if type(path) == "string" and path:sub(1, #root) == root then
            local name = path:sub(#root + 1)
            if name ~= "." and name ~= ".." and name:match("^[%w._%-]+$") then os.remove(path) end
        end
    end
end

local function pauseStatistics(plugin, state)
    local stats = plugin.ui.statistics
    if stats and stats.onReadingPaused and not stats._reading_paused_ts then
        stats:onReadingPaused()
        state.paused_statistics = stats._reading_paused_ts ~= nil
    end
end

local function resumeStatistics(plugin, state)
    local stats = plugin.ui.statistics
    if not state.paused_statistics or not stats then return end
    local page = plugin.ui:getCurrentPage()
    if stats.page_stat and stats.curr_page ~= page then
        -- A mapped page is a new projection, so it must not pass through the page-turn counter.
        stats.curr_page = page
        stats.page_stat[page] = { { stats._reading_paused_ts or os.time(), 0 } }
        stats._reading_paused_curr_page = nil
    end
    stats:onReadingResumed()
    state.paused_statistics = nil
end

function Continuity.ready(plugin, on_done)
    local state = plugin.reading_continuity
    if not state then on_done(); return end
    local path = plugin.ui.document.file
    state.last_page = plugin.ui:getCurrentPage()
    local job, err = Identity.begin(path)
    if not job then state.failure = err; state.restoring = false; on_done(); return end
    state.job = job
    local function finish(status, result)
        state.job, state.task = nil, nil
        if status ~= "stable" then
            state.failure, state.restoring = tostring(result or status), false
            logger.warn("BookOrbit: revision identity unavailable", status)
            resumeStatistics(plugin, state)
            on_done()
            return
        end
        state.sha256, state.signature = result.sha256, result.signature
        local revision = "sha256:" .. state.sha256
        local record = state.record
        if record then
            record.copyId = record.path == path and record.copyId or require("random").uuid(true):lower()
            record.copyId = record.copyId or require("random").uuid(true):lower()
            record.path = path
        end
        state.changed = record ~= nil and not record.legacy and (record.awaitingReconciliation == true or record.sha256 ~= result.sha256)
        if record then record.awaitingReconciliation = state.changed end
        if record and not state.dirty then
            local target = record
            if record.acknowledgement and record.acknowledgement.revision == revision then
                local anchor = {}
                for key, value in pairs(record.anchor or {}) do anchor[key] = value end
                anchor.revision, anchor.nativeLocator = revision, record.acknowledgement.nativeLocator
                target = { anchor = anchor, chapter = record.chapter }
            end
            local ok, acknowledgement = pcall(Native.restore, plugin.ui, target, revision)
            if not ok or not acknowledgement then
                state.failure, state.restoring = "native_verification", false
                logger.warn("BookOrbit: local reading position could not be verified")
                resumeStatistics(plugin, state)
                on_done()
                return
            end
            record.acknowledgement = acknowledgement
            record.sha256, record.signature = state.sha256, state.signature
            if record.legacy then
                record.anchor.revision = revision
                record.anchor.provisionalSha256 = state.sha256
                record.anchor.nativeLocator = acknowledgement.nativeLocator
                record.legacy = nil
            end
            save(plugin)
        end
        resumeStatistics(plugin, state)
        state.annotations_pending = Annotations.ready(plugin.ui, state.annotations, state.sha256)
        state.ready, state.restoring = true, false
        state.last_page = plugin.ui:getCurrentPage()
        if not record or state.dirty then Continuity.capture(plugin) end
        on_done()
    end
    state.task = function()
        if plugin.reading_continuity ~= state or not plugin.ui or not plugin.ui.document or plugin.ui.document.file ~= path then
            job:cancel()
            return
        end
        if not state.started then pauseStatistics(plugin, state); state.started = true end
        local ok, status, result = pcall(job.step, job)
        if not ok then job:cancel(); finish("retryable", "hash_failed")
        elseif status == "pending" then UIManager:nextTick(state.task)
        else finish(status, result) end
    end
    UIManager:nextTick(state.task)
end

function Continuity.page(plugin, page)
    local state = plugin.reading_continuity
    if not state or state.restoring and not state.job then return end
    if state.last_page and page ~= state.last_page then
        state.dirty = true
        state.occurred_at = os.time()
    end
    state.last_page = page
end

function Continuity.capture(plugin)
    local state = plugin.reading_continuity
    if not state or not state.ready or state.restoring then return end
    if state.record and not state.record.anchor.bookFileId and plugin.getDocumentDigest then
        local matched = require("bookorbit_state_manager").getBook(plugin:getDocumentDigest())
        if matched and matched.file == plugin.ui.document.file then
            state.record.anchor.bookFileId, state.record.anchor.bookId = matched.fileId, matched.bookId
            save(plugin)
        end
    end
    if state.record and not state.dirty then return state.record.anchor end
    local previous = state.record and state.record.anchor and state.record.anchor.event
    local event
    if state.dirty then
        local sequence = (G_reader_settings:readSetting("bookorbit_reading_device_sequence") or 0) + 1
        G_reader_settings:saveSetting("bookorbit_reading_device_sequence", sequence)
        G_reader_settings:flush()
        event = {
            id = require("random").uuid(true):lower(), deviceId = plugin.device_id or "koreader",
            deviceSequence = sequence,
            occurredAt = os.date("!%Y-%m-%dT%H:%M:%SZ", state.occurred_at or os.time()),
            resetGeneration = previous and previous.resetGeneration or state.record and state.record.resetGeneration or 0,
        }
    end
    local ok, record = pcall(Native.capture, plugin.ui, "sha256:" .. state.sha256, event)
    if not ok or not record then return end
    record.sha256, record.signature = state.sha256, state.signature
    record.copyId = state.record and state.record.path == plugin.ui.document.file and state.record.copyId or require("random").uuid(true):lower()
    record.path, record.awaitingReconciliation = plugin.ui.document.file, state.changed
    if state.record then
        record.anchor.bookId = state.record.anchor.bookId
        record.anchor.bookFileId = state.record.anchor.bookFileId
    end
    record.anchor.provisionalSha256 = state.sha256
    record.anchor.event = event
    if not record.anchor.bookFileId and plugin.getDocumentDigest then
        local matched = require("bookorbit_state_manager").getBook(plugin:getDocumentDigest())
        if matched and matched.file == plugin.ui.document.file then
            record.anchor.bookFileId, record.anchor.bookId = matched.fileId, matched.bookId
        end
    end
    state.record, state.dirty = record, false
    if not save(plugin) then logger.warn("BookOrbit: reading anchor could not be persisted") end
    return record.anchor
end

function Continuity.applyCanonical(plugin, anchor, generation)
    local state = plugin.reading_continuity
    if not state or not state.ready or state.dirty then return false end
    if not anchor then
        if state.record.anchor.event and state.record.anchor.event.resetGeneration ~= generation then
            state.record.anchor.event = nil
            state.record.resetGeneration = generation
            state.record.acknowledgement = nil
        end
        return save(plugin)
    end
    state.restoring = true
    pauseStatistics(plugin, state)
    local target = { anchor = anchor }
    if state.record.anchor.event and state.record.anchor.event.id == anchor.event.id then target.chapter = state.record.chapter end
    local ok, acknowledgement = pcall(Native.restore, plugin.ui, target, "sha256:" .. state.sha256)
    resumeStatistics(plugin, state)
    state.restoring = false
    state.last_page = plugin.ui:getCurrentPage()
    if not ok or not acknowledgement then return false end
    state.record.anchor, state.record.chapter = anchor, target.chapter
    state.record.acknowledgement = acknowledgement
    state.record.resetGeneration = generation
    return save(plugin)
end

function Continuity.reconciled(plugin)
    local state = plugin.reading_continuity
    state.changed, state.record.awaitingReconciliation = false, false
    state.protocol = true
    return save(plugin)
end

function Continuity.close(plugin)
    local state = plugin.reading_continuity
    if not state then return end
    if state.task then UIManager:unschedule(state.task) end
    if state.job then state.job:cancel(); state.job = nil end
    if state.ready and not state.restoring then Annotations.capture(plugin.ui, state.sha256) end
    Continuity.capture(plugin)
    save(plugin)
end

function Continuity.suspend(plugin)
    local state = plugin.reading_continuity
    if state and state.ready and not state.restoring then Annotations.capture(plugin.ui, state.sha256) end
    Continuity.capture(plugin)
    save(plugin)
end

function Continuity.canSync(plugin)
    local state = plugin.reading_continuity
    return not state or state.ready == true and not state.restoring and not state.changed and not state.annotations_pending
end

function Continuity.isRestoring(plugin)
    local state = plugin.reading_continuity
    return state and (state.restoring or not state.ready) or false
end

return Continuity
