package.path = "koreader-plugin/bookorbit.koplugin/?.lua;" .. package.path
local record = { copyId = "copy", anchor = { bookFileId = 9 }, inventory = { deliveryId = "job", sha256 = string.rep("a", 64) } }
local plugin = { device_id = "reader", reading_continuity = { record = record, sha256 = record.inventory.sha256,
    failure = "native_verification", ready = false, restoring = false },
    ui = { document = { getXPointer = function() return "/body/p[1]" end, getPageFromXPointer = function() return 1 end } } }
package.loaded["bookorbit_reading_continuity"] = { setCopyInventory = function(_, current, inventory)
    assert(current == record)
    record.inventory = inventory
    return true
end }
local requests = {}
local offline = true
local client = { request = function(_, method, path, body)
    assert(method == "POST" and path == "/koreader/plugin/deliveries/job/restoration")
    requests[#requests + 1] = body
    if offline then return nil, "offline" end
    return { id = "job", copyId = "copy", sha256 = body.sha256, restorationState = body.quality }
end }
local Restoration = require("bookorbit_delivery_restoration")
local ok, err = Restoration.report(plugin, client)
assert(not ok and err == "offline" and record.inventory.restorationReported == nil)
offline = false
assert(Restoration.report(plugin, client))
assert(requests[2].quality == "failed" and requests[2].nativePosition == nil and requests[2].failureCode == "native_verification")
assert(record.anchor.event == nil, "a failed restoration cannot create a reading event")
plugin.reading_continuity.failure, plugin.reading_continuity.ready = nil, true
assert(Restoration.report(plugin, client))
assert(requests[3].quality == "approximate" and requests[3].nativePosition == "/body/p[1]")
assert(requests[3].eventId == nil and record.anchor.event == nil, "an unread book has no reading event to acknowledge")
assert(Restoration.report(plugin, client) and #requests == 3, "accepted restoration reports are deduplicated locally")
record.acknowledgement = { revision = "sha256:" .. plugin.reading_continuity.sha256,
    quality = "relocated", nativeLocator = { kind = "xpointer", value = "/body/p[5]" } }
assert(Restoration.report(plugin, client))
assert(requests[4].quality == "verified" and requests[4].nativePosition == "/body/p[5]")
assert(record.anchor.event == nil)
plugin.reading_continuity.sha256 = string.rep("b", 64)
assert(Restoration.report(plugin, client) == false and #requests == 4, "another external replacement invalidates the installation proof")
print("Independent delivery restoration tests passed")
