package.path = "koreader-plugin/bookorbit.koplugin/?.lua;" .. package.path
local Inventory = require("bookorbit_copy_inventory")
local signature = { mode = "file", dev = 1, ino = 2, size = 100, modification = 1, change = 1 }
package.loaded["libs/libkoreader-lfs"] = { attributes = function() return signature end }
local sequence, persistent, fail_save = 0, 0, false
package.loaded.bookorbit_state_manager = {
    reserveInventorySequence = function(minimum)
        if fail_save then return nil end
        sequence = math.max(sequence + 1, minimum or 0)
        persistent = sequence
        return sequence
    end,
}
package.loaded.bookorbit_reading_continuity = {
    setCopyInventory = function(plugin, record, inventory)
        if plugin.reading_continuity.record ~= record then return false end
        record.inventory = inventory
        return true
    end,
}
local original_time, now = os.time, 1000
os.time = function() return now end
local anchor = { bookFileId = 9, bookId = 4, revision = "newer-canonical-revision", event = { id = "original-reading-event" } }
local record = { copyId = "copy-one", path = "/books/story.epub", anchor = anchor }
local plugin = { device_id = "reader", ui = { document = { file = record.path } }, reading_continuity = {
    ready = true, sha256 = string.rep("a", 64), signature = signature, record = record,
} }
local calls = {}
local respond = function(body)
    return { nextSequence = body.sequence + 1, copies = { { copyId = body.copies[1].copyId, id = "server-copy", revisionId = "installed-old-revision",
        status = "accepted", policy = "notify", effectivePolicyVersion = "1:1" } } }
end
function plugin:newClient()
    return { plugin_version = "1.5.2", request = function(_, method, path, body)
        assert(method == "POST" and path == "/koreader/plugin/copies")
        assert(body.sequence == persistent, "sequence must be durable before network publication")
        calls[#calls + 1] = body
        return respond(body)
    end }
end
assert(Inventory.run(plugin))
assert(#calls == 1 and calls[1].copies[1].revisionId == nil, "canonical revision must not identify an older installed copy")
assert(calls[1].deliveryCapabilityVersion == 0 and calls[1].positionCapabilityVersion == 0)
assert(calls[1].copies[1].sha256 == string.rep("a", 64))
assert(record.anchor == anchor and record.anchor.event.id == "original-reading-event")
assert(Inventory.run(plugin) and #calls == 1, "unchanged inventory is rate limited")

now = now + 301
assert(Inventory.run(plugin))
assert(calls[2].copies[1].revisionId == "installed-old-revision")
plugin.reading_continuity.sha256 = string.rep("b", 64)
assert(Inventory.run(plugin))
assert(calls[3].copies[1].revisionId == nil, "external replacement must report provisional identity")

now = now + 301
respond = function(body)
    return { nextSequence = 50, copies = { { copyId = body.copies[1].copyId, status = "stale" } } }
end
assert(not Inventory.run(plugin))
assert(persistent == 50, "server sequence floor must survive local state reset")

local before = #calls
fail_save = true
assert(not Inventory.run(plugin) and #calls == before)
fail_save = false
plugin.reading_continuity.restoring = true
assert(not Inventory.run(plugin) and #calls == before)
plugin.reading_continuity.restoring = false

local second = { copyId = "copy-two", path = "/backup/story.epub", anchor = anchor }
plugin.ui.document.file = second.path
plugin.reading_continuity.record = second
respond = function(body)
    return { nextSequence = body.sequence + 1, copies = { { copyId = body.copies[1].copyId, id = "second-server-copy",
        status = "accepted", policy = "ignore", effectivePolicyVersion = "1:1" } } }
end
assert(Inventory.run(plugin))
assert(calls[#calls].sequence == 51 and calls[#calls].copies[1].copyId == "copy-two")
assert(record.inventory.id == "server-copy" and second.inventory.id == "second-server-copy")
os.time = original_time
print("Copy inventory tests passed")
