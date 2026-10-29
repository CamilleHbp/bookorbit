local plugin_dir = assert(arg[1])
require("setupkoenv")
package.path = plugin_dir .. "/?.lua;" .. package.path
local Store = require("bookorbit_anchor_store")
local sync = require("ffi/util")
local function record(path, sequence, quote)
    return { path = path, sha256 = string.rep("a", 64), persistenceSequence = sequence,
        anchor = { schemaVersion = 1, bookId = 2, bookFileId = 9, revision = "sha256:" .. string.rep("a", 64), quote = quote,
            event = { id = "d292dc18-a1da-4670-8b3f-d7a328760bdf", deviceSequence = 7 } } }
end
local path = "/books/Unicode café.epub"
assert(Store.save(record(path, 1, "Original passage"), "/books/Unicode café.sdr/metadata.epub.lua"))
assert(Store.load(path).record.anchor.quote == "Original passage")
assert(Store.save(record("/copies/Unicode café.epub", 1, "Another copy")))
assert(Store.load(path).record.anchor.quote == "Original passage", "copy backups must not overwrite each other")
local synced = sync.fsyncOpenedFile
sync.fsyncOpenedFile = function() return false, "simulated sync failure" end
assert(not Store.save(record(path, 2, "Uncommitted passage")))
sync.fsyncOpenedFile = synced
assert(Store.load(path).record.anchor.quote == "Original passage", "failed data sync must retain the last anchor")
local rename = os.rename
os.rename = function() return nil, "simulated rename failure" end
assert(not Store.save(record(path, 2, "Uncommitted passage")))
os.rename = rename
assert(Store.load(path).record.persistenceSequence == 1)
assert(not Store.save(record(path, 2, string.rep("x", 65536))), "anchor storage must remain bounded")
assert(Store.load(path).record.persistenceSequence == 1)
assert(Store.save(record(path, 2, "Retried passage")))
assert(Store.load(path).record.persistenceSequence == 2)
assert(Store.load(path).record.anchor.event.deviceSequence == 7, "persistence retries preserve the reading event")
local filename = require("datastorage"):getSettingsDir() .. "/bookorbit-reading-anchors/"
local digest = require("ffi/sha2").sha256(path)
filename = filename .. digest:sub(1, 2) .. "/" .. digest .. ".json"
local file = assert(io.open(filename, "wb")); assert(file:write("not JSON")); file:close()
local missing, err = Store.load(path)
assert(not missing and err == "invalid_anchor", "malformed state must not be treated as an anchor")
print("KOReader durable anchor storage acceptance passed")
