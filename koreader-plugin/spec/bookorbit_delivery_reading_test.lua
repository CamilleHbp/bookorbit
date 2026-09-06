package.path = "koreader-plugin/bookorbit.koplugin/?.lua;" .. package.path
local function clone(value)
    if type(value) ~= "table" then return value end
    local result = {}
    for key, item in pairs(value) do result[key] = clone(item) end
    return result
end
local saved = { sidecarPath = "/books/story.sdr/metadata.epub.lua", record = {
    copyId = "copy", persistenceSequence = 3, sha256 = string.rep("a", 64), chapter = { text = "old chapter" },
    anchor = { bookId = 2, bookFileId = 9, revision = "old", quote = "old passage",
        event = { id = "original-event", resetGeneration = 0, deviceSequence = 7 } },
} }
package.loaded["bookorbit_anchor_store"] = {
    load = function() return clone(saved) end,
    save = function(record, sidecar) saved = { record = clone(record), sidecarPath = sidecar }; return true end,
}
package.loaded["bookorbit_install_storage"] = { identity = function() return { sha256 = "unchanged-sidecar" } end }
local writes = 0
package.loaded["bookorbit_delivery_state"] = { save = function() writes = writes + 1; return true end }
package.loaded["util"] = { partialMD5 = function() return string.rep("b", 32) end }
package.loaded["docsettings"] = { findSidecarFile = function() return saved.sidecarPath end }
package.loaded["bookorbit_sidecar"] = { extract = function() return {
    annotations = { { text = "my highlight" } }, annotations_count = 1,
    percent_finished = 0.75, last_position = "old native locator", bookmarks = {},
} end }
package.loaded["bookorbit_stats_reader"] = { primeIdentity = function() return { ids = { 12 }, title = "Story" } end }
local entries, captured, drains = {}, nil, 0
local outbox = {
    listMetadata = function() return entries end,
    enqueue = function(_, snapshot)
        captured = snapshot
        entries = { { digest = snapshot.digest } }
        return entries[1]
    end,
}
local plugin = {
    getLifecycleOutbox = function() return outbox end,
    requestLifecycleOutboxDrain = function() drains = drains + 1 end,
}
local requests = {}
local remote = { bookId = 2, bookFileId = 9, resetGeneration = 0, anchor = {
    bookId = 2, bookFileId = 9, revision = "newer", quote = "richer canonical passage",
    event = { id = "newer-event", resetGeneration = 0, deviceSequence = 20 },
} }
local client = { request = function(_, method, path, body)
    requests[#requests + 1] = { method = method, path = path, body = clone(body) }
    return clone(remote)
end }
local job = { pathname = "/books/story.epub", copyId = "copy", bookFileId = 9 }
local operation = {}
local Reading = require("bookorbit_delivery_reading")
local ok, err = Reading.upload(plugin, client, job, operation)
assert(not ok and err == "waiting_for_uploads")
assert(#requests == 0 and writes == 1 and drains == 1)
assert(captured.expected_book_file_id == 9 and captured.annotations[1].text == "my highlight")
assert(captured.percentage == nil and captured.progress == nil, "delivery must never upload a stale native projection as new reading")
ok, err = Reading.upload(plugin, client, job, operation)
assert(not ok and err == "waiting_for_uploads" and #requests == 0)
entries = {}
assert(Reading.upload(plugin, client, job, operation))
assert(#requests == 2 and requests[1].method == "GET" and requests[2].method == "POST")
assert(requests[2].body.anchor.event.id == "original-event" and requests[2].body.anchor.event.deviceSequence == 7)
assert(saved.record.anchor.event.id == "newer-event" and saved.record.anchor.quote == "richer canonical passage")
assert(saved.record.sha256 == string.rep("a", 64), "canonical projection must not change installed byte identity")
assert(saved.record.chapter == nil and saved.record.acknowledgement == nil)
remote = { bookId = 2, bookFileId = 9, resetGeneration = 1 }
requests = {}
assert(Reading.upload(plugin, client, job, operation))
assert(#requests == 1 and requests[1].method == "GET", "reset must prevent replaying a previous-generation event")
assert(saved.record.anchor.event == nil and saved.record.anchor.bookFraction == 0 and saved.record.resetGeneration == 1)
print("Delivery reading prerequisite tests passed")
