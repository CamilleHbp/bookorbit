local Registration = {}
local Storage = require("bookorbit_install_storage")
local Store = require("bookorbit_anchor_store")

function Registration.register(client, path, target, options)
    local identity, err = Storage.identity(path, options.yield_step)
    if not identity then return nil, err end
    local backup
    backup, err = Store.load(path)
    if err then return nil, err end
    if not backup then
        local settings = require("docsettings"):open(path)
        local record = settings:readSetting("bookorbit_revision_anchor_v1")
        if type(record) ~= "table" or type(record.anchor) ~= "table" then
            local fraction = settings:readSetting("percent_finished") or settings:readSetting("last_percent") or 0
            if type(fraction) ~= "number" or fraction ~= fraction or fraction < 0 or fraction > 1 then fraction = 0 end
            local pointer = settings:readSetting("last_xpointer")
            record = { anchor = { schemaVersion = 1, revision = "sha256:" .. identity.sha256,
                chapterIndex = 0, chapterFraction = 0, bookFraction = fraction }, sha256 = identity.sha256 }
            if type(pointer) == "string" and #pointer > 0 and #pointer <= 4096 then record.anchor.nativeLocator = { kind = "xpointer", value = pointer } end
        end
        if record.path ~= path then record.copyId = nil end
        record.path, record.copyId = path, record.copyId or require("random").uuid(true):lower()
        record.persistenceSequence = record.persistenceSequence or 0
        backup = { record = record, sidecarPath = settings.source_candidate }
    end
    local record = backup.record
    if type(record.persistenceSequence) ~= "number" or record.persistenceSequence < 0 or record.persistenceSequence >= 9007199254740991 then
        return nil, "invalid_anchor"
    end
    if record.anchor.bookFileId and record.anchor.bookFileId ~= target.bookFileId then return nil, "copy_identity_conflict" end
    if record.anchor.bookId and record.anchor.bookId ~= target.bookId then return nil, "copy_identity_conflict" end
    record.anchor.bookFileId, record.anchor.bookId = target.bookFileId, target.bookId
    record.persistenceSequence = record.persistenceSequence + 1
    local saved
    saved, err = Store.save(record, backup.sidecarPath)
    if not saved then return nil, err end
    local manager = require("bookorbit_state_manager")
    local sequence = manager.reserveInventorySequence()
    if not sequence then return nil, "inventory_persistence" end
    local capabilities = require("bookorbit_revision_capabilities")
    local response
    response, err = client:request("POST", "/koreader/plugin/copies", {
        protocolVersion = 1, deviceId = client.device_id, sequence = sequence, pluginVersion = client.plugin_version or "unknown",
        deliveryCapabilityVersion = capabilities.delivery, positionCapabilityVersion = capabilities.position,
        copies = { { copyId = record.copyId, bookFileId = target.bookFileId, pathname = path, sha256 = identity.sha256, sizeBytes = identity.sizeBytes } },
    })
    if not response then return nil, err end
    local accepted = type(response.copies) == "table" and #response.copies == 1 and response.copies[1]
    if not accepted or accepted.copyId ~= record.copyId or type(accepted.id) ~= "string"
        or (accepted.status ~= "accepted" and accepted.status ~= "unchanged") then
        if type(response.nextSequence) == "number" then manager.reserveInventorySequence(response.nextSequence) end
        return nil, "inventory_not_accepted"
    end
    local latest = Store.load(path)
    if not latest or latest.record.persistenceSequence ~= record.persistenceSequence or not options.is_current()
        or not Storage.same(identity.signature, require("libs/libkoreader-lfs").attributes(path)) then return nil, "copy_changed" end
    local previous = record.inventory
    record.inventory = { id = accepted.id, sha256 = identity.sha256, revisionId = type(accepted.revisionId) == "string" and accepted.revisionId or nil,
        policy = accepted.policy, policyVersion = accepted.effectivePolicyVersion, reportedAt = os.time(),
        deliveryId = previous and previous.sha256 == identity.sha256 and previous.deliveryId or nil }
    record.persistenceSequence = record.persistenceSequence + 1
    saved, err = Store.save(record, backup.sidecarPath)
    if not saved then return nil, err end
    return { record = record, sidecarPath = backup.sidecarPath, identity = identity }
end

return Registration
