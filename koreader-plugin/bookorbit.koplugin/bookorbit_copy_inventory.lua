local Inventory = {}

function Inventory.installed(client, job, identity)
    local store = require("bookorbit_anchor_store")
    local backup, err = store.load(job.pathname)
    if not backup or backup.record.copyId ~= job.copyId or backup.record.anchor.bookFileId ~= job.bookFileId then
        return nil, err or "copy_changed"
    end
    local sequence = require("bookorbit_state_manager").reserveInventorySequence()
    if not sequence then return nil, "inventory_persistence" end
    local capabilities = require("bookorbit_revision_capabilities")
    local response
    response, err = client:request("POST", "/koreader/plugin/copies", {
        protocolVersion = 1, deviceId = client.device_id, sequence = sequence, pluginVersion = client.plugin_version or "unknown",
        deliveryCapabilityVersion = capabilities.delivery, positionCapabilityVersion = capabilities.position,
        copies = { { copyId = job.copyId, bookFileId = job.bookFileId, pathname = job.pathname,
            sha256 = identity.sha256, sizeBytes = identity.sizeBytes, revisionId = job.revisionId } },
    })
    if not response then return nil, err end
    local accepted = type(response.copies) == "table" and #response.copies == 1 and response.copies[1]
    if not accepted or accepted.copyId ~= job.copyId or accepted.id ~= job.installedCopyId
        or (accepted.status ~= "accepted" and accepted.status ~= "unchanged") or accepted.revisionId ~= job.revisionId then
        if type(response.nextSequence) == "number" then require("bookorbit_state_manager").reserveInventorySequence(response.nextSequence) end
        return nil, "inventory_not_accepted"
    end
    local latest = store.load(job.pathname)
    if not latest or latest.record.persistenceSequence ~= backup.record.persistenceSequence then return nil, "reading_changed" end
    backup.record.inventory = { id = accepted.id, sha256 = identity.sha256, revisionId = accepted.revisionId,
        policy = accepted.policy, policyVersion = accepted.effectivePolicyVersion, reportedAt = os.time(), deliveryId = job.id }
    backup.record.persistenceSequence = backup.record.persistenceSequence + 1
    return store.save(backup.record, backup.sidecarPath)
end

local function same_file(expected, current)
    return expected and current and expected.mode == "file" and current.mode == "file"
        and expected.dev == current.dev and expected.ino == current.ino and expected.size == current.size
        and expected.modification == current.modification and expected.change == current.change
end

function Inventory.run(plugin)
    local state = plugin.reading_continuity
    local record = state and state.record
    if not state or not state.ready or state.restoring or not record or not record.copyId
        or not record.anchor or not record.anchor.bookFileId or not state.sha256 or not state.signature then return false end
    local path = plugin.ui.document.file
    if path ~= record.path or not same_file(state.signature, require("libs/libkoreader-lfs").attributes(path)) then return false end
    local previous = record.inventory
    local now = os.time()
    if previous and previous.sha256 == state.sha256 and previous.reportedAt
        and now >= previous.reportedAt and now - previous.reportedAt < 300 then return true end
    local manager = require("bookorbit_state_manager")
    local sequence = manager.reserveInventorySequence()
    if not sequence then return false end
    local copy = { copyId = record.copyId, bookFileId = record.anchor.bookFileId,
        pathname = path, sha256 = state.sha256, sizeBytes = state.signature.size }
    if record.inventory and record.inventory.sha256 == state.sha256 and type(record.inventory.revisionId) == "string" then
        copy.revisionId = record.inventory.revisionId
    end
    local client = plugin:newClient()
    local capabilities = require("bookorbit_revision_capabilities")
    if capabilities.delivery >= 1 and capabilities.position >= 1 and previous and previous.sha256 == state.sha256 then
        copy.policyAcknowledgement = previous.policyVersion
    end
    local result, err = client:request("POST", "/koreader/plugin/copies", {
        protocolVersion = 1, deviceId = plugin.device_id, sequence = sequence,
        pluginVersion = client.plugin_version or "unknown",
        deliveryCapabilityVersion = capabilities.delivery, positionCapabilityVersion = capabilities.position, copies = { copy },
    })
    if not result or type(result.copies) ~= "table" or #result.copies ~= 1 then return false, err end
    if type(result.nextSequence) == "number" and result.nextSequence > sequence + 1 then
        if not manager.reserveInventorySequence(result.nextSequence) then return false end
    end
    local accepted = result.copies[1]
    if accepted.copyId ~= record.copyId or (accepted.status ~= "accepted" and accepted.status ~= "unchanged")
        or type(accepted.id) ~= "string" or type(accepted.effectivePolicyVersion) ~= "string"
        or (accepted.policy ~= "notify" and accepted.policy ~= "automatic" and accepted.policy ~= "ignore") then return false end
    if plugin.reading_continuity ~= state or state.record ~= record or plugin.ui.document.file ~= path then return false end
    return require("bookorbit_reading_continuity").setCopyInventory(plugin, record, {
        id = accepted.id, sha256 = copy.sha256, revisionId = type(accepted.revisionId) == "string" and accepted.revisionId or nil,
        policy = accepted.policy, policyVersion = accepted.effectivePolicyVersion, reportedAt = now,
        deliveryId = previous and previous.sha256 == copy.sha256 and previous.deliveryId or nil,
        restorationReported = previous and previous.sha256 == copy.sha256 and previous.restorationReported or nil,
    })
end

return Inventory
