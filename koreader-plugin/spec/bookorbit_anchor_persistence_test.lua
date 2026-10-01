package.path = "koreader-plugin/bookorbit.koplugin/?.lua;" .. package.path
local sequence, captures, requests = 40, 0, 0
local persisted, reserve_ok = true, true
local last_event
package.loaded.bookorbit_native_anchor = {
    capture = function(_, revision, event)
        captures = captures + 1
        last_event = event
        return { anchor = { revision = revision, bookId = 1, bookFileId = 2, event = event } }
    end,
}
package.loaded.bookorbit_file_identity = {}
package.loaded.bookorbit_annotation_continuity = {}
package.loaded.bookorbit_anchor_store = { save = function() return true end }
package.loaded["ui/uimanager"] = {}
package.loaded.logger = { warn = function() end }
package.loaded.random = { uuid = function() return "uuid-" .. tostring(captures) end }
package.loaded.bookorbit_state_manager = {
    reserveReadingSequence = function(minimum)
        if not reserve_ok then return nil end
        sequence = math.max(sequence + 1, minimum)
        return sequence
    end,
}
G_reader_settings = { readSetting = function() return 100 end }
local record = { path = "/book.epub", copyId = "copy", anchor = { bookId = 1, bookFileId = 2,
    event = { id = "prior", deviceSequence = 90, resetGeneration = 3 } } }
local plugin = { device_id = "reader", reading_continuity = {
    ready = true, dirty = true, sha256 = string.rep("a", 64), record = record,
}, ui = { document = { file = "/book.epub" }, doc_settings = {
    saveSetting = function() end,
    flush = function() return persisted end,
} }, newClient = function() requests = requests + 1; error("must not synchronize unsaved reading") end }
local Continuity = require("bookorbit_reading_continuity")
reserve_ok = false
assert(Continuity.capture(plugin) == nil and captures == 0 and plugin.reading_continuity.dirty)
local handled, err = require("bookorbit_reading_exchange").run(plugin)
assert(handled and err == "anchor_persistence" and requests == 0)
reserve_ok, persisted = true, false
assert(Continuity.capture(plugin) == nil and captures == 1)
assert(last_event.deviceSequence == 101 and last_event.resetGeneration == 3)
assert(plugin.reading_continuity.persistence_pending)
assert(not Continuity.canSync(plugin), "unsaved anchors must also gate lifecycle synchronization")
local pending_event = last_event
handled, err = require("bookorbit_reading_exchange").run(plugin)
assert(handled and err == "anchor_persistence" and requests == 0 and captures == 1)
persisted = true
assert(Continuity.capture(plugin).event == pending_event)
assert(captures == 1 and not plugin.reading_continuity.persistence_pending)
assert(Continuity.canSync(plugin))
assert(sequence == 101, "retry the same event instead of fabricating new reading activity")
print("Anchor persistence tests passed")
