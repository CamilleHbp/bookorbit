package.path = "koreader-plugin/bookorbit.koplugin/?.lua;" .. package.path
local global, records, requests = {}, {}, {}
local persist_error, ack_error = false, false
local capabilities = { delivery = 1, position = 1 }
package.loaded.bookorbit_revision_capabilities = capabilities
package.loaded.bookorbit_delivery_runner = { account = function() return "account" end }
package.loaded["socket.url"] = { escape = function(value) return value end }
package.loaded.rapidjson = { null = {} }
package.loaded.bookorbit_state_manager = {
    session = function() return { global = global } end,
    mutateScoped = function(_, apply) apply({ global = global }) end,
}
local function clone(value)
    if type(value) ~= "table" then return value end
    local result = {}
    for key, item in pairs(value) do result[key] = clone(item) end
    return result
end
package.loaded.bookorbit_anchor_store = {
    load = function(path) return clone(records[path]) end,
    save = function(record, sidecar)
        if persist_error then return nil end
        records[record.path] = { record = clone(record), sidecarPath = sidecar }
        return true
    end,
}
local id = "adef91c7-ef94-4dba-bcaa-889a07538ec7"
local copy = { id = id, copyId = "local-copy", deviceId = "reader", bookFileId = 9, pathname = "/books/story.epub",
    sha256 = string.rep("a", 64), policy = "automatic", effectivePolicyVersion = "2:1", policyAcknowledged = false }
local record = { path = copy.pathname, copyId = copy.copyId, persistenceSequence = 1,
    anchor = { bookFileId = 9, event = { id = "original-event" } },
    inventory = { id = id, sha256 = copy.sha256, policy = "notify", policyVersion = "1:1", deliveryId = "retained-job" } }
records[copy.pathname] = { record = clone(record), sidecarPath = "/books/story.sdr/metadata.epub.lua" }
local page = { items = { copy }, nextCursor = id }
local client = { device_id = "reader", request = function(_, method, route, body)
    requests[#requests + 1] = { method = method, route = route, body = body }
    if method == "GET" then return page end
    assert(route == "/koreader/plugin/copies/policies/acknowledgements")
    assert(records[copy.pathname].record.inventory.policyVersion == "2:1", "policy must persist before acknowledgement")
    assert(body.deviceId == "reader" and body.copies[1].id == id and body.copies[1].effectivePolicyVersion == "2:1")
    if ack_error then return nil, 503 end
    return { accepted = { id } }
end }
local Policies = require("bookorbit_copy_policies")
persist_error = true
assert(not Policies.run(client) and #requests == 1 and global.deliveryPolicyCursor == nil)
persist_error, ack_error = false, true
assert(not Policies.run(client) and global.deliveryPolicyCursor == nil)
assert(records[copy.pathname].record.inventory.policy == "automatic")
ack_error = false
assert(Policies.run(client))
assert(global.deliveryPolicyCursor.cursor == id)
assert(records[copy.pathname].record.anchor.event.id == "original-event")
assert(records[copy.pathname].record.inventory.deliveryId == "retained-job")
copy.policyAcknowledged, page.nextCursor = true, nil
local before = #requests
assert(Policies.run(client) and #requests == before + 1)
assert(requests[#requests].route:find("cursor=" .. id, 1, true))
assert(global.deliveryPolicyCursor.cursor == nil)
copy.copyId, copy.policyAcknowledged = "different-copy", false
before = #requests
assert(Policies.run(client) and #requests == before + 1, "unrelated local copies cannot acknowledge policies")
capabilities.delivery = 0
before = #requests
assert(not Policies.run(client) and #requests == before)
print("Closed-copy policy acknowledgement tests passed")
