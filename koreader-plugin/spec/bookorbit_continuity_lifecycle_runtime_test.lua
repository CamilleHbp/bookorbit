local fixture_dir, plugin_dir, work_dir = assert(arg[1]), assert(arg[2]), assert(arg[3])
require("setupkoenv")
package.path = plugin_dir .. "/?.lua;plugins/statistics.koplugin/?.lua;" .. package.path
require("dbg"):turnOff()
local logger = require("logger")
logger:setLevel(logger.levels.warn)
G_defaults = require("luadefaults"):open(work_dir .. "/defaults.lua")
G_reader_settings = require("luasettings"):open(work_dir .. "/settings.lua")
G_reader_settings:saveSetting("document_metadata_folder", "dir")
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
replace("original")
local ui = open()
local toc = ui.document:getToc()
ui:handleEvent(Event:new("GotoPage", math.floor((toc[9].page + toc[10].page) / 2)))
local original = assert(Continuity.capture(ui.bookorbit))
original.bookId, original.bookFileId = 2, 9
assert(original.event, "deliberate navigation must produce an event")
assert(original.chapterTitle == "Chapter 9")
local original_id = original.event.id
local start_xp, end_xp = ui.document:getXPointer(), ui.document:getXPointer()
for _ = 1, 80 do end_xp = assert(ui.document:getNextVisibleChar(end_xp)) end
ui.annotation.annotations = { { datetime = "2026-09-05 12:00:00", page = start_xp, pos0 = start_xp, pos1 = end_xp,
    drawer = "lighten", text = ui.document:getTextFromXPointers(start_xp, end_xp, false), note = "Keep my note" } }
local annotation_anchor = assert(require("bookorbit_native_anchor").captureAnnotation(ui, ui.annotation.annotations[1], original.revision))
close(ui)
replace("regenerated")
ui = open()
local state = ui.bookorbit.reading_continuity
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
        return remote
    end }
end
local handled, exchange_error = require("bookorbit_reading_exchange").run(ui.bookorbit)
assert(handled and not exchange_error, tostring(exchange_error))
assert(#exchange_calls == 3, "reconnect must exchange the original event and separate acknowledgement")
assert(exchange_calls[2][3].anchor.event.id == original_id)
assert(exchange_calls[3][3].acknowledgement.eventId == original_id)
assert(state.record.anchor.revision == original.revision, "reconciliation must retain the canonical source revision")
assert(not state.changed and ui.statistics.mem_read_pages == 0)
remote = { bookId = 2, bookFileId = 9, resetGeneration = 1 }
handled, exchange_error = require("bookorbit_reading_exchange").run(ui.bookorbit)
assert(handled and not exchange_error)
assert(state.record.anchor.event == nil and state.record.resetGeneration == 1, "reset generation must invalidate the old event")
close(ui)
print("KOReader offline reader lifecycle acceptance passed")
