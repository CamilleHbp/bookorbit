local Continuity = require("bookorbit_reading_continuity")
local Exchange = {}

function Exchange.run(plugin)
    local state = plugin.reading_continuity
    if not state or not state.ready or state.restoring then return false end
    Continuity.capture(plugin)
    local record = state.record
    if not record or not record.anchor.bookFileId then return false end
    local client = plugin:newClient()
    local path = "/koreader/plugin/files/" .. record.anchor.bookFileId .. "/reading-events"
    local remote, err = client:request("GET", path)
    if not remote then return state.changed or state.protocol or err ~= 404, err end
    state.protocol = true
    if remote.bookFileId ~= record.anchor.bookFileId or remote.bookId ~= record.anchor.bookId
        or type(remote.resetGeneration) ~= "number" then return true, "invalid_reading_state" end
    local event = record.anchor.event
    if event and event.resetGeneration == remote.resetGeneration then
        remote, err = client:request("POST", path, { anchor = record.anchor })
        if not remote then return true, err end
    end
    -- Network requests yield to the UI. New navigation takes precedence over this response.
    if plugin.reading_continuity ~= state or state.record ~= record or state.dirty then return true, "reading_changed" end
    if not Continuity.applyCanonical(plugin, remote.anchor, remote.resetGeneration) then return true, "native_verification" end
    local acknowledgement = record.acknowledgement
    if remote.anchor and remote.anchor.event and acknowledgement then
        local accepted
        accepted, err = client:request("POST", path .. "/acknowledgements", {
            deviceId = plugin.device_id, copyId = record.copyId, acknowledgement = acknowledgement,
        })
        if not accepted then return true, err end
    end
    if plugin.reading_continuity ~= state or state.record ~= record or state.dirty then return true, "reading_changed" end
    if not Continuity.reconciled(plugin) then return true, "anchor_persistence" end
    pcall(function() require("bookorbit_copy_inventory").run(plugin) end)
    return true
end

return Exchange
