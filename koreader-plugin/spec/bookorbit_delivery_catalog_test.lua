package.path = "koreader-plugin/bookorbit.koplugin/?.lua;" .. package.path
local id = "734a2a8f-7e06-438a-9c61-d3b23b5ad6a1"
local target = { bookFileId = 9, bookId = 2, revisionId = id, sha256 = string.rep("b", 64), sizeBytes = 200 }
local record = { copyId = id, persistenceSequence = 1, anchor = { bookFileId = 9, bookId = 2 }, inventory = { id = id } }
local writes, queued, cancelled, current = 0, 0, 0, true
package.loaded["bookorbit_anchor_store"] = { save = function(value) assert(value == record); writes = writes + 1; return true end }
package.loaded["bookorbit_install_storage"] = { matches = function() return false end }
package.loaded["random"] = { uuid = function() return id end }
package.loaded["bookorbit_copy_registration"] = { register = function(_, path, value)
    assert(path == "/books/story.epub" and value.bookFileId == 9 and value.bookId == 2)
    return { record = record, identity = { sha256 = string.rep("a", 64), sizeBytes = 100 } }
end }
package.loaded["bookorbit_delivery"] = {
    options = function() return { is_current = function() return current end, is_open = function() return false end } end,
    request = function() queued = queued + 1 end,
}
local cancel_during_run = false
package.loaded["bookorbit_delivery_runner"] = {
    run = function()
        if cancel_during_run then current = false; cancelled = cancelled + 1; return nil, "cancelled" end
        return nil, "waiting_for_close"
    end,
    cancel = function() cancelled = cancelled + 1 end,
}
local requests = {}
local job = { id = id, pathname = "/books/story.epub", copyId = id, revisionId = id, version = 3 }
local client = { request = function(_, method, path, body)
    requests[#requests + 1] = { method = method, path = path, body = body }
    if path:match("/targets$") then return { items = { target } } end
    if path:match("/retry$") then assert(body.version == 3); return job end
    assert(path == "/koreader/plugin/deliveries/copies/" .. id)
    assert(body.idempotencyKey == id and body.expectedRevisionId == id)
    return job
end }
local catalog = { _manager = {}, client = client }
local CatalogDelivery = require("bookorbit_delivery_catalog")
local detail, file = { id = 2 }, { id = 9 }
local ok, err, result = CatalogDelivery.replace(catalog, "/books/story.epub", detail, file, function() return current end)
assert(ok and not err and result.queued and queued == 1 and writes == 1)
assert(requests[1].path:match("/targets$") and requests[1].body.bookFileIds[1] == 9)
file.revisionId, file.sha256, file.sizeBytes = target.revisionId, target.sha256, target.sizeBytes
requests = {}
assert(CatalogDelivery.replace(catalog, "/books/story.epub", detail, file, function() return current end))
assert(#requests == 1 and writes == 1, "bulk manifests reuse strong revision evidence and uncertain requests reuse their durable identity")
job.cancelledAt = "cancelled"
requests = {}
assert(CatalogDelivery.replace(catalog, "/books/story.epub", detail, file, function() return current end))
assert(requests[2].path:match("/retry$"), "an explicit overwrite may retry a cancelled revision")
job.cancelledAt = nil
cancel_during_run = true
ok, err = CatalogDelivery.replace(catalog, "/books/story.epub", detail, file, function() return current end)
assert(not ok and err == "cancelled" and cancelled == 1)
assert(record.anchor.event == nil, "requesting an overwrite cannot manufacture a reading event")
print("Shared catalog replacement tests passed")
