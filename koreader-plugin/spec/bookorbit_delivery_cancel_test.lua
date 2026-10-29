package.path = "koreader-plugin/bookorbit.koplugin/?.lua;" .. package.path
local operation
local function clone(value)
    if type(value) ~= "table" then return value end
    local result = {}
    for key, item in pairs(value) do result[key] = clone(item) end
    return result
end
package.loaded["bookorbit_delivery_state"] = {
    load = function() return clone(operation) end,
    save = function(value) operation = clone(value); return true end,
}
package.loaded["bookorbit_install_storage"] = { safePath = function() return true end }
package.loaded["bookorbit_install_journal"] = { load = function() return nil end }
package.loaded["ffi/sha2"] = { sha256 = function() return "account" end }
local id = "734a2a8f-7e06-438a-9c61-d3b23b5ad6a1"
package.loaded["random"] = { uuid = function() return id end }
local job = { id = id, copyId = id, installedCopyId = id, pathname = "/books/story.epub", deviceId = "reader",
    bookFileId = 9, attempt = 1, installationState = "requested", revisionId = id, version = 4 }
package.loaded["bookorbit_anchor_store"] = { load = function()
    return { record = { copyId = id, anchor = { bookFileId = 9 }, inventory = { id = id } } }
end }
local offline = true
local requests = {}
local client = { device_id = "reader", request = function(_, method, path, body)
    requests[#requests + 1] = { method = method, path = path, body = body }
    if offline then return nil, "offline" end
    if path:match("/claim$") then return nil, "stop_after_claim" end
    if method == "GET" then return clone(job) end
    assert(path:match("/cancel$") and body.version == 4)
    return { id = id, cancelledAt = "cancelled" }
end }
local Runner = require("bookorbit_delivery_runner")
local ok, err = Runner.cancel(client, job)
assert(not ok and err == "offline" and operation.cancelRequested)
offline = false
local options = { is_current = function() return true end, is_open = function() return false end,
    upload_reading = function() error("cancelled jobs must never upload or install") end }
ok, err = Runner.run(client, job, options)
assert(not ok and err == "cancelled" and requests[#requests].path:match("/cancel$"))
job.attempt = 2
ok, err = Runner.run(client, job, options)
assert(not ok and err == "stop_after_claim")
assert(operation.attempt == 2 and not operation.cancelRequested, "only explicit server retry clears cancellation suppression")
print("Durable delivery cancellation tests passed")
