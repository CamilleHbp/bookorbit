--[[--
Live progress sync mixin for the BookOrbit plugin (kosync mirror).

Push/pull of reading progress with conflict strategies and a 25 second
debounce, the periodic page-turn push, and the progress reconciliation that
runs before a manual book sync. Installed onto the plugin controller as
regular methods.
]]

local Device = require("device")
local Event = require("ui/event")
local InfoMessage = require("ui/widget/infomessage")
local Math = require("optmath")
local NetworkMgr = require("ui/network/manager")
local UIManager = require("ui/uimanager")
local logger = require("logger")
local time = require("ui/time")
local util = require("util")
local T = require("ffi/util").template
local _ = require("gettext")

local BookOrbitStateManager = require("bookorbit_state_manager")
local DeviceNames = require("bookorbit_device_names")
-- Loaded on first use: specs load this module without KOReader's widgets.
local Toast = setmetatable({}, { __index = function(_t, key) return require("bookorbit_toast")[key] end })

local API_CALL_DEBOUNCE_DELAY = time.s(25)

-- Assigned from the plugin class on install; shared with the menu module.
local SYNC_STRATEGY

local ProgressSync = {}

local function showSyncError()
    Toast.error(_("Could not sync progress with BookOrbit"))
end

-- "54%" for a 0..1 fraction.
local function pctLabel(fraction)
    return tostring(Math.round((fraction or 0) * 100)) .. "%"
end

-- Where the reader now is, after following BookOrbit's position.
local function showMoved(body)
    local device = DeviceNames.label(body.device)
    if device then
        Toast.show(T(_("Now at %1, from %2"), pctLabel(body.percentage), device))
    else
        Toast.show(T(_("Now at %1"), pctLabel(body.percentage)))
    end
end

-- The This book sheet, opened as the prompt.
local function openPrompt(self, body, newer, before_upload, on_jump, on_stay)
    require("bookorbit_book_sheet").openPrompt(self, {
        remote = { percentage = body.percentage, device = body.device, timestamp = body.timestamp },
        newer = newer,
        before_upload = before_upload,
        on_jump = on_jump,
        on_stay = on_stay,
    })
end

function ProgressSync:getLastPercent()
    if self.ui.document.info.has_pages then
        return Math.roundPercent(self.ui.paging:getLastPercent())
    else
        return Math.roundPercent(self.ui.rolling:getLastPercent())
    end
end

function ProgressSync:getLastProgress()
    if self.ui.document.info.has_pages then
        return self.ui.paging:getLastProgress()
    else
        return self.ui.rolling:getLastProgress()
    end
end

-- Always the binary partial MD5: BookOrbit matches on the scanner-computed
-- partial MD5 of the file, so the filename checksum method does not exist here.
function ProgressSync:getDocumentDigest()
    if not self.ui or not self.ui.document then return nil end
    local file = self.ui.document.file
    if not file then return nil end
    if self.bookorbit_document_digest and self.bookorbit_document_digest.file == file then
        return self.bookorbit_document_digest.digest
    end

    local doc_settings = self.ui.doc_settings
    local cached = doc_settings and doc_settings:readSetting("partial_md5_checksum") or nil
    local ok, computed = pcall(util.partialMD5, file)
    if not ok or not computed then return cached end

    self.bookorbit_document_digest = {
        file = file,
        digest = computed,
        repaired = cached ~= nil and cached ~= computed,
    }
    if cached ~= computed then
        if doc_settings then
            doc_settings:saveSetting("partial_md5_checksum", computed)
        end
        local repaired, repair_err = pcall(
            BookOrbitStateManager.repairFileIdentity, file, cached, computed)
        if not repaired then
            logger.warn("BookOrbit: could not repair cached file identity:", repair_err)
        end
    end
    return computed
end

function ProgressSync:syncToProgress(progress, percentage_fallback)
    logger.dbg("BookOrbit: syncing to progress", progress, "percent", percentage_fallback)
    local has_position = progress ~= nil and progress ~= ""
    if not has_position and percentage_fallback then
        -- No exact position (push came from web/audio sync); jump by percentage.
        -- kosync percentage is 0-1; GotoPercent expects 0-100.
        self.ui:handleEvent(Event:new("GotoPercent", percentage_fallback * 100))
        if self.book_sheet then self.book_sheet:refreshProgress() end
        return
    end
    if self.ui.document.info.has_pages then
        self.ui:handleEvent(Event:new("GotoPage", tonumber(progress)))
    else
        self.ui:handleEvent(Event:new("GotoXPointer", progress))
    end
    if self.book_sheet then self.book_sheet:refreshProgress() end
end

function ProgressSync:remoteProgressIsNewer(body, local_percentage)
    local local_timestamp = self.last_page_turn_timestamp or 0
    if body.timestamp ~= nil then
        if local_timestamp > 0 then
            return body.timestamp > local_timestamp
        end
        return body.percentage > local_percentage
    end
    return body.percentage > local_percentage
end

function ProgressSync:applyRemoteProgress(body, on_done)
    self:syncToProgress(body.progress, body.percentage)
    if on_done then
        UIManager:scheduleIn(0.1, function()
            on_done(false)
        end)
    end
end

function ProgressSync:reconcileProgressBeforeBookSync(digest, on_done)
    if not self.ui or not self.ui.document then
        UIManager:show(InfoMessage:new{ text = _("No reader book is open."), timeout = 2 })
        return false
    end
    if self:getDocumentDigest() ~= digest then
        UIManager:show(InfoMessage:new{ text = _("The open book changed. Start the sync again."), timeout = 3 })
        return false
    end

    local client = self:newClient()
    local body, err = client:getProgress(digest)
    self.pull_timestamp = UIManager:getElapsedTimeSinceBoot()
    self:rememberRemoteProgress(digest, body)

    if not body then
        logger.dbg("BookOrbit: progress check before book sync failed:", err)
        Toast.show(_("Could not check BookOrbit's position"), { icon = "triangle-alert", timeout = 4 })
        on_done(true)
        return true
    end

    if not body.percentage then
        on_done(false)
        return true
    end

    if body.device == Device.model and body.device_id == self.device_id
            and (self.last_page_turn_timestamp or 0) > 0 then
        on_done(false)
        return true
    end

    body.percentage = Math.roundPercent(body.percentage)
    local local_progress = self:getLastProgress()
    local local_percentage = self:getLastPercent()

    if local_percentage == body.percentage or body.progress == local_progress then
        on_done(false)
        return true
    end

    local remote_newer = self:remoteProgressIsNewer(body, local_percentage)
    local strategy = remote_newer and self.settings.sync_forward or self.settings.sync_backward
    if strategy == SYNC_STRATEGY.SILENT then
        self:applyRemoteProgress(body, on_done)
        return true
    elseif strategy == SYNC_STRATEGY.PROMPT then
        openPrompt(self, body, remote_newer, true, function()
            self:applyRemoteProgress(body, on_done)
        end, function()
            on_done(remote_newer)
        end)
        return true
    elseif remote_newer then
        Toast.show(_("Kept your place. BookOrbit is further ahead."), { icon = "info", timeout = 4 })
        on_done(true)
        return true
    else
        on_done(false)
        return true
    end
end

-- "Sync now" in a book. Highlights, bookmarks, stats and state do not depend on
-- where the reader is, so they go first with the position held back; the
-- progress question comes after, and only the position waits for its answer.
-- `run_book_sync(skip_progress, after_sync)` calls `after_sync` once the book
-- sync finished without an error.
function ProgressSync:syncBookThenProgress(digest, run_book_sync)
    run_book_sync(true, function()
        UIManager:nextTick(function()
            self:reconcileProgressBeforeBookSync(digest, function(skip_progress)
                if not skip_progress then self:pushProgressAfterBookSync(digest) end
            end)
        end)
    end)
end

function ProgressSync:pushProgressAfterBookSync(digest)
    if not self.ui or not self.ui.document or self:getDocumentDigest() ~= digest then return end
    local body, err = self:newClient():updateProgress(digest, self:getLastPercent(), self:getLastProgress(), os.time())
    self.push_timestamp = UIManager:getElapsedTimeSinceBoot()
    if not body then
        logger.dbg("BookOrbit: progress push after book sync failed:", err)
    end
end

function ProgressSync:updateProgress(ensure_networking, interactive, on_suspend)
    if not self:isLoggedIn() then
        if interactive then self:promptLogin() end
        return
    end
    if not self.ui or not self.ui.document then
        if interactive then
            UIManager:show(InfoMessage:new{ text = _("No reader book is open."), timeout = 2 })
        end
        return
    end

    local now = UIManager:getElapsedTimeSinceBoot()
    if not interactive and now - self.push_timestamp <= API_CALL_DEBOUNCE_DELAY then
        logger.dbg("BookOrbit: push debounced")
        return
    end

    if ensure_networking and NetworkMgr:willRerunWhenConnected(function()
            self:runInSyncCoroutine(function()
                self:updateProgress(ensure_networking, interactive, on_suspend)
            end)
        end) then
        return
    end

    local digest = self:getDocumentDigest()
    if not digest then return end

    local client = self:newClient()
    local body, err = client:updateProgress(digest, self:getLastPercent(), self:getLastProgress(), os.time())
    if interactive then
        if body then
            if self.recordSyncSuccess then
                self:recordSyncSuccess("progress_push", _("Progress pushed"))
            end
            Toast.show(_("Progress sent to BookOrbit"))
            if not on_suspend then
                if self.requestUpdateCheck then
                    self:requestUpdateCheck(false, "progress_push")
                else
                    self:maybeCheckForUpdate(false)
                end
            end
        else
            if self.recordSyncError then
                self:recordSyncError("progress_push", err)
            end
            showSyncError()
        end
    elseif not body then
        if self.recordSyncError then
            self:recordSyncError("progress_push", err)
        end
        logger.dbg("BookOrbit: push failed:", err)
    elseif not on_suspend then
        if self.recordSyncSuccess then
            self:recordSyncSuccess("progress_push", _("Progress pushed"))
        end
        if self.requestUpdateCheck then
            self:requestUpdateCheck(false, "progress_push")
        else
            self:maybeCheckForUpdate(false)
        end
    end

    if on_suspend and Device:hasWifiManager() then
        NetworkMgr:disableWifi()
    end

    if body and self.book_sheet then self:fetchRemoteProgress(digest, nil, true) end

    self.push_timestamp = now
end

function ProgressSync:getProgress(ensure_networking, interactive)
    if not self:isLoggedIn() then
        if interactive then self:promptLogin() end
        return
    end
    if not self.ui or not self.ui.document then
        if interactive then
            UIManager:show(InfoMessage:new{ text = _("No reader book is open."), timeout = 2 })
        end
        return
    end

    local now = UIManager:getElapsedTimeSinceBoot()
    if not interactive and now - self.pull_timestamp <= API_CALL_DEBOUNCE_DELAY then
        logger.dbg("BookOrbit: pull debounced")
        return
    end

    if ensure_networking and NetworkMgr:willRerunWhenConnected(function()
            self:runInSyncCoroutine(function()
                self:getProgress(ensure_networking, interactive)
            end)
        end) then
        return
    end

    local digest = self:getDocumentDigest()
    if not digest then return end

    local document = self.ui.document
    local requested_progress = self:getLastProgress()
    local client = self:newClient()
    local body, err = client:getProgress(digest)
    -- Network requests yield; a later navigation must win over this response.
    if not self.ui or self.ui.document ~= document
            or self:getLastProgress() ~= requested_progress then
        return
    end
    self.pull_timestamp = now
    self:rememberRemoteProgress(digest, body)

    if not body then
        if interactive then showSyncError() end
        if self.recordSyncError then
            self:recordSyncError("progress_pull", err)
        end
        logger.dbg("BookOrbit: pull failed:", err)
        return
    end
    if self.requestUpdateCheck then
        self:requestUpdateCheck(false, "progress_pull")
    else
        self:maybeCheckForUpdate(false)
    end

    if not body.percentage then
        if interactive then
            Toast.show(_("BookOrbit has no position for this book yet"), { icon = "info" })
        end
        return
    end

    -- A fresh rendition or sidecar can resume behind this device's last upload.
    -- Explicit pulls and opens before any page turn must still recover that position.
    if not interactive and body.device == Device.model and body.device_id == self.device_id
            and (self.last_page_turn_timestamp or 0) > 0 then
        return
    end

    body.percentage = Math.roundPercent(body.percentage)
    local progress = self:getLastProgress()
    local percentage = self:getLastPercent()

    if percentage == body.percentage or body.progress == progress then
        if interactive then
            Toast.show(_("Already in sync"))
        end
        return
    end

    if interactive then
        self:syncToProgress(body.progress, body.percentage)
        if self.recordSyncSuccess then
            self:recordSyncSuccess("progress_pull", _("Progress pulled"))
        end
        showMoved(body)
        return
    end

    local self_older
    if body.timestamp ~= nil then
        self_older = (body.timestamp > self.last_page_turn_timestamp)
    else
        self_older = (body.percentage > percentage)
    end

    local strategy = self_older and self.settings.sync_forward or self.settings.sync_backward
    if strategy == SYNC_STRATEGY.SILENT then
        self:syncToProgress(body.progress, body.percentage)
        if self.recordSyncSuccess then
            self:recordSyncSuccess("progress_pull", _("Progress pulled"))
        end
        showMoved(body)
    elseif strategy == SYNC_STRATEGY.PROMPT then
        openPrompt(self, body, self_older, false, function()
            self:syncToProgress(body.progress, body.percentage)
            if self.recordSyncSuccess then
                self:recordSyncSuccess("progress_pull", _("Progress pulled"))
            end
            showMoved(body)
        end)
    end
end

-- BookOrbit's position for the open book, as last pulled, for the This book
-- sheet. Kept in memory: it only means anything while the book is open.
function ProgressSync:rememberRemoteProgress(digest, body)
    if not digest or type(body) ~= "table" then return end
    if not body.percentage then
        if self.last_remote_progress and self.last_remote_progress.digest == digest then
            self.last_remote_progress = nil
            if self.book_sheet then self.book_sheet:refreshProgress() end
        end
        return
    end
    self.last_remote_progress = {
        digest = digest,
        percentage = Math.roundPercent(body.percentage),
        progress = body.progress,
        device = body.device,
        timestamp = body.timestamp,
        checked_at = os.time(),
    }
    if self.book_sheet then self.book_sheet:refreshProgress() end
end

-- Refreshes that position in the background when already online, without
-- moving the reader or prompting. on_done(ok) runs on the UI thread.
function ProgressSync:fetchRemoteProgress(digest, on_done, force)
    if not digest or not self:isLoggedIn() or not NetworkMgr:isConnected() then
        if on_done then on_done(false) end
        return
    end
    local recent = self.last_remote_progress
    if not force and recent and recent.digest == digest and os.time() - (recent.checked_at or 0) < 60 then
        if on_done then on_done(true) end
        return
    end
    self:runInSyncCoroutine(function()
        local body = self:newClient():getProgress(digest)
        self:rememberRemoteProgress(digest, body)
        if on_done then UIManager:nextTick(function() on_done(body ~= nil) end) end
    end)
end

function ProgressSync:schedulePeriodicPush()
    UIManager:unschedule(self.periodic_push_task)
    -- A sizable delay debounces nicely while skimming.
    UIManager:scheduleIn(10, self.periodic_push_task)
    self.periodic_push_scheduled = true
end

function ProgressSync:getSyncPeriod()
    if not self.settings.auto_sync then
        return _("Not available")
    end
    local period = self.settings.pages_before_update
    if period and period > 0 then
        return period
    end
    return _("Never")
end

function ProgressSync:setPagesBeforeUpdate(value)
    self.settings.pages_before_update = value
end

function ProgressSync.install(BookOrbit)
    SYNC_STRATEGY = BookOrbit.SYNC_STRATEGY
    for name, fn in pairs(ProgressSync) do
        if name ~= "install" then
            BookOrbit[name] = fn
        end
    end
end

return ProgressSync
