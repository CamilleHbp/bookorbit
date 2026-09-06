local fixture_dir, plugin_dir, work_dir = assert(arg[1]), assert(arg[2]), assert(arg[3])
require("setupkoenv")
package.path = plugin_dir .. "/?.lua;plugins/statistics.koplugin/?.lua;" .. package.path
require("dbg"):turnOff()
local logger = require("logger")
logger:setLevel(logger.levels.warn)
G_defaults = require("luadefaults"):open(work_dir .. "/defaults.lua")
G_reader_settings = require("luasettings"):open(work_dir .. "/settings.lua")
G_reader_settings:saveSetting("document_metadata_folder", arg[4] or "dir")
G_reader_settings:saveSetting("device_id", "offline-runtime-device")
G_reader_settings:saveSetting("bookorbit", { settings_version = 1, auto_sync = false })
einkfb = require("ffi/framebuffer")
einkfb.dummy = true
local Device = require("device")
Device.screen:init()
require("document/canvascontext"):init(Device)
Device.input.dummy = true
local Loader = require("pluginloader")
local plugin = dofile(plugin_dir .. "/main.lua")
plugin.path = plugin_dir
local statistics = dofile("plugins/statistics.koplugin/main.lua")
statistics.path = "plugins/statistics.koplugin"
Loader.enabled_plugins, Loader.disabled_plugins, Loader.loaded_plugins = { plugin, statistics }, {}, {}
local ReaderUI = require("apps/reader/readerui")
local Registry = require("document/documentregistry")
local UIManager = require("ui/uimanager")
local Event = require("ui/event")
local Continuity = require("bookorbit_reading_continuity")
local path = work_dir .. "/installed.epub"
local function replace(name)
    local input = assert(io.open(fixture_dir .. "/" .. name .. ".epub", "rb"))
    local output = assert(io.open(path .. ".incoming", "wb"))
    assert(output:write(input:read("*a")))
    input:close()
    output:close()
    assert(os.rename(path .. ".incoming", path))
end
local function open()
    local ui = ReaderUI:new { dimen = Device.screen:getSize(), document = Registry:openDocument(path) }
    UIManager:show(ui)
    for _ = 1, 200 do
        UIManager:setInputTimeout(0)
        UIManager:handleInput()
        if ui.bookorbit.reading_continuity.ready then return ui end
    end
    error("continuity did not finish: " .. tostring(ui.bookorbit.reading_continuity.failure))
end
local function close(ui)
    ui:onClose()
end
local ui, original, annotation_anchor, old_sidecar
if arg[5] ~= "restore" then
    replace("original")
    ui = open()
    local toc = ui.document:getToc()
    ui:handleEvent(Event:new("GotoPage", math.floor((toc[9].page + toc[10].page) / 2)))
    original = assert(Continuity.capture(ui.bookorbit))
    original.bookId, original.bookFileId = 2, 9
    assert(original.event, "deliberate navigation must produce an event")
    assert(original.chapterTitle == "Chapter 9")
    local start_xp, end_xp = ui.document:getXPointer(), ui.document:getXPointer()
    for _ = 1, 80 do end_xp = assert(ui.document:getNextVisibleChar(end_xp)) end
    ui.annotation.annotations = { { datetime = "2026-09-05 12:00:00", page = start_xp, pos0 = start_xp, pos1 = end_xp,
        drawer = "lighten", text = ui.document:getTextFromXPointers(start_xp, end_xp, false), note = "Keep my note" } }
    annotation_anchor = assert(require("bookorbit_native_anchor").captureAnnotation(ui, ui.annotation.annotations[1], original.revision))
    close(ui)
    if arg[5] == "capture" then
        assert(require("bookorbit_anchor_store").load(path).record.anchor.event.id == original.event.id)
        print("KOReader durable anchor captured before process exit")
        return
    end
else
    local backup = assert(require("bookorbit_anchor_store").load(path))
    original, old_sidecar = backup.record.anchor, assert(backup.sidecarPath)
    local settings = require("docsettings").openSettingsFile(old_sidecar)
    annotation_anchor = assert(settings:readSetting("bookorbit_revision_annotations_v1").anchors[1])
end
local original_id = original.event.id
local delivered_revision = "4d181dcb-1b1b-42e6-91bc-9c2d1392b2e0"
local delivery = arg[6] == "delivery" or arg[6] == "delivery_twice"
if arg[6] == "install" or delivery or arg[6] == "crash_install" then
    local Storage = require("bookorbit_install_storage")
    local Journal = require("bookorbit_install_journal")
    local staged = work_dir .. "/delivery.epub"
    assert(Storage.copy(fixture_dir .. "/regenerated.epub", staged))
    if delivery then
        local store = require("bookorbit_anchor_store")
        local saved = assert(store.load(path))
        saved.record.inventory = { id = "71476178-0822-47bb-854d-a410c2d26522" }
        saved.record.persistenceSequence = saved.record.persistenceSequence + 1
        assert(store.save(saved.record, saved.sidecarPath))
        local expected, target = Storage.identity(path), Storage.identity(staged)
        local job = { id = "725088ef-fc58-456b-819c-935bf164ccdf", copyId = saved.record.copyId,
            installedCopyId = saved.record.inventory.id, deviceId = "offline-runtime-device", bookFileId = 9,
            pathname = path, expectedLocalSha256 = expected.sha256, expectedLocalSizeBytes = expected.sizeBytes,
            sha256 = target.sha256, sizeBytes = target.sizeBytes, attempt = 1, installationState = "requested",
            revisionId = "4d181dcb-1b1b-42e6-91bc-9c2d1392b2e0" }
        local api = { server_url = "https://isolated-validation.invalid", username = "fixture", device_id = job.deviceId }
        local receipt, reports, uploads, downloads = nil, 0, 0, 0
        function api:request(method, route, body)
            if route:match("/reading%-events$") then
                if method == "POST" then assert(body.anchor.event.id == original_id) end
                return { bookId = 2, bookFileId = 9, resetGeneration = 0, anchor = original }
            end
            assert(method == "POST")
            if route == "/koreader/plugin/copies" then
                assert(body.copies[1].sha256 == target.sha256 and body.copies[1].revisionId == job.revisionId)
                return { copies = { { copyId = job.copyId, id = job.installedCopyId, revisionId = job.revisionId,
                    status = "accepted", policy = "notify", effectivePolicyVersion = "1:1" } } }
            elseif route:match("/claim$") then
                return { token = "0c6dc0f3-f7f5-44ad-9eb3-08f5b0285bcb", fence = 1, job = job }
            elseif route:match("/publication$") then
                assert(downloads == 1 and uploads == 1)
                return { token = "070069aa-5a40-40d2-8353-3f39b65d6f0f", revisionId = job.revisionId,
                    sha256 = job.sha256, sizeBytes = job.sizeBytes, validForMs = 30000 }
            elseif route:match("/progress$") then
                assert(body.deviceId == job.deviceId and body.fence == 1)
                if body.state == "installed" then
                    reports = reports + 1
                    assert(body.localSha256 == target.sha256 and body.publicationToken)
                    if not receipt then receipt = body; return nil, "network_disconnected" end
                    assert(body.sequence == receipt.sequence and body.publicationToken == receipt.publicationToken)
                else
                    assert(body.state == "downloading" and body.readingUploadsComplete)
                    assert(body.localSha256 == expected.sha256)
                end
                local response = {}
                for key, value in pairs(job) do response[key] = value end
                response.installationState = body.state
                return response
            end
            error("unexpected delivery request: " .. route)
        end
        function api:download(route, destination, options)
            assert(route:match("/download$") and destination == path and options.method == "POST")
            assert(uploads == 1 and options.body.fence == 1 and options.max_bytes == target.sizeBytes)
            downloads = downloads + 1
            assert(Storage.copy(staged, options.temp_path))
            return { temp_path = options.temp_path }
        end
        local Runner = require("bookorbit_delivery_runner")
        local function install(use_real_uploads)
          receipt, reports, uploads, downloads = nil, 0, 0, 0
          local delivered, delivery_error = Runner.run(api, job, {
            is_open = function() return false end, is_current = function() return true end,
            upload_reading = function(_, operation)
                uploads = uploads + 1
                assert(store.load(path).record.anchor.event.id == original_id)
                if use_real_uploads then
                    local closed = { getLifecycleOutbox = function() return {
                        listMetadata = function() return {} end,
                        enqueue = function() error("unopened sidecars must not replay uploaded annotations") end,
                    } end }
                    return require("bookorbit_delivery_reading").upload(closed, api, job, operation)
                end
                operation.readingCapture = assert(require("bookorbit_delivery_reading").captureKey(path))
                return true
            end,
        })
        assert(not delivered and delivery_error == "network_disconnected", tostring(delivery_error))
        assert(Journal.load(path).phase == "state_committed", "offline receipt must remain durable")
        assert(Runner.recover(api, job.id, path).installationState == "installed")
        assert(reports == 2 and downloads == 1 and uploads == 1, "receipt retry must not repeat installation or reading activity")
        assert(not Journal.load(path))
        end
        install(false)
        if arg[6] == "delivery_twice" then
            local before = assert(store.load(path))
            assert(before.record.inventory.readingCapture and before.record.sha256 ~= before.record.inventory.sha256)
            assert(Storage.copy(fixture_dir .. "/appended.epub", staged))
            expected, target = Storage.identity(path), Storage.identity(staged)
            job.id = "cdbd8aa0-9330-4588-bc33-cc82070cc3b6"
            delivered_revision = "54a6c180-11eb-48af-8439-5a1154c2be91"
            job.revisionId = delivered_revision
            job.expectedLocalSha256, job.expectedLocalSizeBytes = expected.sha256, expected.sizeBytes
            job.sha256, job.sizeBytes = target.sha256, target.sizeBytes
            install(true)
            assert(store.load(path).record.anchor.event.id == original_id)
        end
    else
        local sidecars = assert(require("bookorbit_install_sidecars").plan(path, staged))
        assert(Journal.prepare({ path = path, staged = staged, expected = Storage.identity(path), target = Storage.identity(staged),
            sidecars = sidecars, receipt = { eventId = original_id } }))
        if arg[6] == "crash_install" then
            local rename = os.rename
            os.rename = function(source, destination)
                local result, err = rename(source, destination)
                if result and destination == path then error("process interrupted after EPUB publication") end
                return result, err
            end
            local survived = pcall(Journal.publish, path, { authorize = function() return true end })
            os.rename = rename
            assert(not survived and Journal.load(path).phase == "prepared")
        else
            assert(Journal.publish(path, { authorize = function() return true end }))
            assert(Journal.recover(path).phase == "state_committed")
        end
    end
else
    replace("regenerated")
    if arg[6] == "external_registration" then
        assert(require("bookorbit_state_manager").linkFiles({
            { digest = assert(require("util").partialMD5(path)), bookFileId = 9, bookId = 2, file = path },
        }))
        assert(require("bookorbit_anchor_store").load(path).record.anchor.event.id == original_id,
            "external file registration must preserve the original reading event")
    end
end
ui = open()
local state = ui.bookorbit.reading_continuity
if old_sidecar and arg[4] == "hash" then
    assert(require("bookorbit_anchor_store").load(path).sidecarPath ~= old_sidecar,
        "cold restart must restore from the old hash sidecar into the new hash association")
end
assert(state.record.anchor.event.id == original_id, "restoration must preserve the reading event")
assert(state.record.acknowledgement.quality == "relocated", "offline replacement must relocate the passage")
assert(state.record.acknowledgement.revision == "sha256:" .. state.sha256)
assert(state.changed, "offline replacement must await server reconciliation")
local _, annotation_error = require("bookorbit_native_anchor").resolveAnnotation(ui, annotation_anchor)
assert(#ui.annotation.annotations == 1, "verified annotation must follow the passage: " .. tostring(annotation_error))
local annotation = ui.annotation.annotations[1]
assert(annotation.note == "Keep my note")
local highlighted = ui.document:getTextFromXPointers(annotation.pos0, annotation.pos1, false)
assert(require("bookorbit_anchor_text").normalize(highlighted).text == require("bookorbit_anchor_text").normalize(annotation.text).text)
assert(ui.bookorbit.page_update_counter == 0, "restoration must not count as reading activity")
assert(ui.statistics.mem_read_pages == 0, "restoration must not increment statistics pages")
assert(ui.statistics.mem_read_time == 0, "restoration must not increment statistics time")
local record = assert(ui.doc_settings:readSetting("bookorbit_revision_anchor_v1"))
assert(record.anchor.event.id == original_id, "restoration must persist the original event")
close(ui)
ui = open()
state = ui.bookorbit.reading_continuity
assert(state.record.anchor.event.id == original_id)
assert(state.record.acknowledgement.quality == "exact", "second open must use the verified native projection")
assert(state.changed, "reopening must preserve pending reconciliation")
local exchange_calls = {}
local remote = { bookId = 2, bookFileId = 9, resetGeneration = 0, anchor = original }
function ui.bookorbit:newClient()
    return { request = function(_, method, request_path, body)
        exchange_calls[#exchange_calls + 1] = { method, request_path, body }
        if request_path:match("/restoration$") then
            return { id = state.record.inventory.deliveryId, copyId = body.copyId, sha256 = body.sha256, restorationState = body.quality }
        end
        if request_path == "/koreader/plugin/copies" then
            return { nextSequence = body.sequence + 1, copies = { { copyId = body.copies[1].copyId,
                status = "accepted", id = "accepted-copy", policy = "notify", effectivePolicyVersion = "1:1" } } }
        end
        return remote
    end }
end
local handled, exchange_error = require("bookorbit_reading_exchange").run(ui.bookorbit)
assert(handled and not exchange_error, tostring(exchange_error))
assert(#exchange_calls == 4, "reconnect must exchange the original event and separate acknowledgements")
assert(exchange_calls[2][3].anchor.event.id == original_id)
assert(exchange_calls[3][3].acknowledgement.eventId == original_id)
if delivery then
    assert(exchange_calls[4][2]:match("/restoration$") and exchange_calls[4][3].quality == "verified" and exchange_calls[4][3].eventId == nil,
        "installation restoration is acknowledged independently of canonical events")
    assert(state.record.inventory.sha256 == state.sha256 and state.record.inventory.revisionId == delivered_revision,
        "installation reports the installed revision independently of the older canonical anchor")
else
    assert(exchange_calls[4][3].copies[1].sha256 == state.sha256, "copy inventory must identify the installed bytes")
    assert(exchange_calls[4][3].copies[1].revisionId == nil, "canonical progress cannot label different installed bytes")
end
assert(state.record.anchor.revision == original.revision, "reconciliation must retain the canonical source revision")
assert(not state.changed and ui.statistics.mem_read_pages == 0)
remote = { bookId = 2, bookFileId = 9, resetGeneration = 1 }
handled, exchange_error = require("bookorbit_reading_exchange").run(ui.bookorbit)
assert(handled and not exchange_error)
assert(state.record.anchor.event == nil and state.record.resetGeneration == 1, "reset generation must invalidate the old event")
close(ui)
print("KOReader offline reader lifecycle acceptance passed")
