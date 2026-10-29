package.path = "koreader-plugin/bookorbit.koplugin/?.lua;" .. package.path
local operation
local function clone(value)
    if type(value) ~= "table" then return value end
    local result = {}
    for key, item in pairs(value) do result[key] = clone(item) end
    return result
end
local writes, removed = 0, 0
package.loaded["bookorbit_delivery_state"] = {
    load = function() return clone(operation) end,
    save = function(value) operation = clone(value); writes = writes + 1; return true end,
    remove = function() operation = nil; removed = removed + 1; return true end,
}
package.loaded["bookorbit_install_storage"] = { safePath = function() return true end,
    identity = function() return {} end, matches = function() return true end,
    parent = function() return "/books" end }
package.loaded["bookorbit_install_journal"] = { load = function() return nil end }
package.loaded["ffi/sha2"] = { sha256 = function() return "account" end }
local id = "734a2a8f-7e06-438a-9c61-d3b23b5ad6a1"
package.loaded["random"] = { uuid = function() return id end }
local job = { id = id, copyId = id, installedCopyId = id, pathname = "/books/story.epub", deviceId = "reader",
    bookFileId = 9, attempt = 1, installationState = "requested", revisionId = id, version = 4,
    expectedLocalSha256 = "old", expectedLocalSizeBytes = 10, sha256 = "new", sizeBytes = 20 }
package.loaded["bookorbit_anchor_store"] = { load = function()
    return { record = { copyId = id, anchor = { bookFileId = 9 }, inventory = { id = id } } }
end }
local now, uploads, downloads, claims, reports = 1000, 0, 0, 0, 0
local offline, malformed, claim_offline = true, false, false
local client = { device_id = "reader", request = function(_, _, path, body)
    if path:match("/claim$") then
        claims = claims + 1
        if claim_offline then return nil, "offline" end
        return { token = id, fence = claims, job = clone(job) }
    end
    if path:match("/progress$") then return { id = id, installationState = body.state } end
    assert(path:match("/failure$"))
    reports = reports + 1
    assert(operation.failureReport and writes > 0, "persist the failure before reporting it")
    assert(body.failureCode == "download_failed" and body.fence == claims)
    if offline then return nil, "offline" end
    return { id = malformed and "wrong-job" or id, failureCode = "download_failed" }
end, download = function() downloads = downloads + 1; return nil, "offline" end }
local options = { clock = function() return now end, is_current = function() return true end,
    is_open = function() return false end, upload_reading = function() uploads = uploads + 1; return true end }
local Runner = require("bookorbit_delivery_runner")
local ok, err = Runner.run(client, job, options)
assert(not ok and err == "offline")
assert(operation.failureReport.failureCode == "download_failed" and operation.failureReport.retryAt == 1030)
assert(uploads == 1 and downloads == 1 and reports == 1)

package.loaded["bookorbit_delivery_runner"] = nil
Runner = require("bookorbit_delivery_runner")
ok, err = Runner.run(client, job, options)
assert(not ok and err == "failure_report_pending" and claims == 1 and reports == 1)
now = 1030
claim_offline = true
ok, err = Runner.run(client, job, options)
assert(not ok and err == "offline" and operation.failureReport.retryAt == 1090)
assert(operation.failureReport.failureCode == "download_failed")
now = 1090
claim_offline, offline, malformed = false, false, true
ok, err = Runner.run(client, job, options)
assert(not ok and err == "failure_report_pending" and operation and removed == 0)
now = operation.failureReport.retryAt
malformed = false
ok, err = Runner.run(client, job, options)
assert(not ok and err == "delivery_failure_reported" and not operation and removed == 1)
assert(uploads == 1 and downloads == 1, "report recovery must never repeat reading uploads or installation")

offline = true
job.attempt = 2
Runner.run(client, job, options)
assert(operation.failureReport and downloads == 2)
job.attempt = 3
Runner.run(client, job, options)
assert(operation.attempt == 3 and downloads == 3, "only explicit retry starts a new installation attempt")
local Failure = require("bookorbit_delivery_failure")
operation.failureReport.retryAt = now + 10000
assert(Failure.due(operation, now), "a backward clock jump must not indefinitely suppress reporting")
operation.failureReport.attempts = 17
assert(select(2, Failure.due(operation, now)) == "invalid_delivery_state")
print("Durable delivery failure, lease renewal, backoff and explicit retry tests passed")
