local fixture_dir, plugin_dir, work_dir = assert(arg[1]), assert(arg[2]), assert(arg[3])
require("setupkoenv")
package.path = plugin_dir .. "/?.lua;plugins/statistics.koplugin/?.lua;" .. package.path
require("dbg"):turnOff()
local logger = require("logger")
logger:setLevel(logger.levels.warn)
G_defaults = require("luadefaults"):open(work_dir .. "/defaults.lua")
G_reader_settings = require("luasettings"):open(work_dir .. "/settings.lua")
local config_file = assert(io.open(work_dir .. "/config.json", "rb"))
local config = require("rapidjson").decode(config_file:read("*a"))
config_file:close()
G_reader_settings:saveSetting("document_metadata_folder", config.sidecarMode)
G_reader_settings:saveSetting("device_id", "reader")
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
-- This fixture crosses two SSH forwards instead of the normal reader-to-server connection.
local socketutil = require("socketutil")
socketutil.LARGE_BLOCK_TIMEOUT, socketutil.LARGE_TOTAL_TIMEOUT = 60, 90
socketutil.FILE_BLOCK_TIMEOUT, socketutil.FILE_TOTAL_TIMEOUT = 60, 90
local capabilities = require("bookorbit_revision_capabilities")
capabilities.delivery, capabilities.position = 1, 1
local api = require("bookorbit_api").new({ server_url = "http://127.0.0.1:18441/api/v1",
    username = config.username, userkey = config.key, device_id = "reader" })
local function request(method, route, body)
    local result, err = api:request(method, route, body)
    assert(result, route .. ": " .. tostring(err))
    return result
end
local reading_path = "/koreader/plugin/files/" .. config.bookFileId .. "/reading-events"
replace("original")
local ui = open()
local toc = ui.document:getToc()
ui:handleEvent(Event:new("GotoPage", math.floor((toc[9].page + toc[10].page) / 2)))
local original = assert(Continuity.capture(ui.bookorbit))
assert(original.event and original.chapterTitle == "Chapter 9")
original.bookId, original.bookFileId, original.revision = config.bookId, config.bookFileId, config.oldRevisionId
close(ui)
local store = require("bookorbit_anchor_store")
local saved = assert(store.load(path))
saved.record.anchor, saved.record.copyId = original, config.localCopyId
saved.record.persistenceSequence = saved.record.persistenceSequence + 1
assert(store.save(saved.record, saved.sidecarPath))
local old = assert(require("bookorbit_install_storage").identity(path))
local inventory = request("POST", "/koreader/plugin/copies", { protocolVersion = 1, deviceId = "reader",
    sequence = 2, pluginVersion = "validation", deliveryCapabilityVersion = 1, positionCapabilityVersion = 1,
    copies = { { copyId = config.localCopyId, bookFileId = config.bookFileId, pathname = path,
        sha256 = old.sha256, sizeBytes = old.sizeBytes, revisionId = config.oldRevisionId } } })
assert(inventory.copies[1].id == config.copyId, require("rapidjson").encode(inventory))
assert(require("bookorbit_state_manager").reserveInventorySequence(inventory.nextSequence))
saved = assert(store.load(path))
saved.record.inventory = { id = config.copyId }
saved.record.persistenceSequence = saved.record.persistenceSequence + 1
assert(store.save(saved.record, saved.sidecarPath))
local receipt = request("POST", reading_path, { anchor = original })
assert(receipt.bookId == config.bookId and receipt.bookFileId == config.bookFileId)
local job
if config.replacement == "external" then
    replace("regenerated")
else
    job = request("POST", "/koreader/plugin/deliveries/copies/" .. config.copyId,
        { idempotencyKey = require("random").uuid(true):lower(), expectedRevisionId = config.revisionId })
    local delivered, delivery_error = require("bookorbit_delivery_runner").run(api, job, {
        is_open = function() return false end, is_current = function() return true end,
        upload_reading = function(_, operation)
            operation.readingCapture = assert(require("bookorbit_delivery_reading").captureKey(path))
            local closed = { getLifecycleOutbox = function() return {
                listMetadata = function() return {} end,
                enqueue = function() error("completed uploads must not be replayed") end,
            } end }
            return require("bookorbit_delivery_reading").upload(closed, api, job, operation)
        end,
    })
    assert(delivered, tostring(delivery_error))
    assert(delivered.installationState == "installed" and delivered.restorationState == "verification_pending")
end
ui = open()
local state = ui.bookorbit.reading_continuity
assert(state.record.anchor.event.id == original.event.id)
assert(state.record.acknowledgement.quality == "relocated")
assert(ui.statistics.mem_read_pages == 0 and ui.statistics.mem_read_time == 0)
assert(require("bookorbit_native_anchor").capture(ui, state.record.acknowledgement.revision).anchor.chapterTitle == "Chapter 9")
function ui.bookorbit:newClient() return api end
local handled, exchange_error = require("bookorbit_reading_exchange").run(ui.bookorbit)
assert(handled and not exchange_error, tostring(exchange_error))
if job then
    local final = request("GET", "/koreader/plugin/deliveries/" .. job.id)
    assert(final.restorationState == "verified", tostring(final.restorationState))
else
    assert(require("bookorbit_copy_inventory").run(ui.bookorbit))
end
assert(state.record.anchor.event.id == original.event.id and ui.statistics.mem_read_pages == 0)
close(ui)
print("REAL_API_RESULT:" .. require("rapidjson").encode({ eventId = original.event.id, jobId = job and job.id }))
