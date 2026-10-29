package.path = "koreader-plugin/bookorbit.koplugin/?.lua;" .. package.path
local calls, applied, reconciled = {}, nil, false
package.loaded.bookorbit_reading_continuity = {
    capture = function() end,
    applyCanonical = function(plugin, anchor, generation)
        if plugin.reading_continuity.dirty then return false end
        applied = anchor
        plugin.reading_continuity.record.acknowledgement = {
            eventId = anchor and anchor.event.id, revision = "sha256:new", quality = "relocated",
        }
        return generation == 2
    end,
    reconciled = function() reconciled = true; return true end,
}
local Exchange = require("bookorbit_reading_exchange")
local anchor = { bookFileId = 8, bookId = 3, revision = "sha256:old", quote = "original passage",
    event = { id = "original-event", resetGeneration = 2 } }
local remote = { bookFileId = 8, bookId = 3, resetGeneration = 2, anchor = anchor }
local plugin = { device_id = "reader", reading_continuity = {
    ready = true, changed = true, record = { anchor = anchor, copyId = "copy-one" },
} }
local response = function() return remote end
function plugin:newClient()
    return { request = function(_, method, path, body)
        calls[#calls + 1] = { method = method, path = path, body = body }
        return response(method, path, body)
    end }
end
local handled, err = Exchange.run(plugin)
assert(handled and not err and reconciled)
assert(#calls == 3)
assert(calls[2].body.anchor == anchor and calls[2].body.anchor.event.id == "original-event")
assert(calls[3].body.acknowledgement.eventId == "original-event")
assert(calls[3].body.copyId == "copy-one")
assert(applied == anchor and anchor.revision == "sha256:old")

calls, reconciled, applied = {}, false, nil
response = function() plugin.reading_continuity.dirty = true; return remote end
handled, err = Exchange.run(plugin)
assert(handled and err == "reading_changed" and not reconciled and not applied)
plugin.reading_continuity.dirty = false

calls = {}
response = function() return nil, 403 end
handled, err = Exchange.run(plugin)
assert(handled and err == 403 and #calls == 1)

response = function() return nil, 404 end
plugin.reading_continuity.changed, plugin.reading_continuity.protocol = false, nil
handled = Exchange.run(plugin)
assert(not handled, "unchanged files may use a legacy server")
plugin.reading_continuity.changed = true
handled = Exchange.run(plugin)
assert(handled, "changed files must not fall through to percentage synchronization")

calls = {}
remote = { bookFileId = 8, bookId = 3, resetGeneration = 2 }
anchor.event.resetGeneration = 1
response = function() return remote end
Exchange.run(plugin)
assert(#calls == 1, "reset events must not be replayed")
print("Reading exchange continuity tests passed")
