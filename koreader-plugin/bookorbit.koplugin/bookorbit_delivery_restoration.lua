local Restoration = {}

function Restoration.report(plugin, client)
    local state = plugin.reading_continuity
    local record = state and state.record
    local inventory = record and record.inventory
    if not state or state.restoring or not record or not inventory or not inventory.deliveryId then return false end
    if state.sha256 and inventory.sha256 ~= state.sha256 then return false end
    local body = { deviceId = plugin.device_id, copyId = record.copyId, sha256 = inventory.sha256 }
    if state.failure then
        body.quality = "failed"
        body.failureCode = state.failure == "native_verification" and "native_verification" or "identity_unavailable"
    elseif state.ready then
        local acknowledgement = record.acknowledgement
        if acknowledgement and acknowledgement.revision == "sha256:" .. state.sha256 then
            body.nativePosition = acknowledgement.nativeLocator and acknowledgement.nativeLocator.value
            body.quality = acknowledgement.quality == "approximate" and "approximate" or "verified"
        else
            local ok, pointer = pcall(plugin.ui.document.getXPointer, plugin.ui.document)
            if not ok or type(pointer) ~= "string" then return false end
            local valid, page = pcall(plugin.ui.document.getPageFromXPointer, plugin.ui.document, pointer)
            if not valid or type(page) ~= "number" or page <= 0 then return false end
            body.nativePosition, body.quality = pointer, "approximate"
        end
        if type(body.nativePosition) ~= "string" or #body.nativePosition == 0 or #body.nativePosition > 4096 then return false end
    else
        return false
    end
    local marker = body.sha256 .. ":" .. body.quality
    if inventory.restorationReported == marker then return true end
    local response, err = client:request("POST", "/koreader/plugin/deliveries/" .. inventory.deliveryId .. "/restoration", body)
    if not response then return nil, err end
    if response.id ~= inventory.deliveryId or response.copyId ~= record.copyId or response.sha256 ~= body.sha256 then return nil, "invalid_restoration_response" end
    if plugin.reading_continuity ~= state or state.record ~= record or record.inventory ~= inventory then return nil, "reading_changed" end
    local updated = {}
    for key, value in pairs(inventory) do updated[key] = value end
    updated.restorationReported = marker
    return require("bookorbit_reading_continuity").setCopyInventory(plugin, record, updated)
end

return Restoration
