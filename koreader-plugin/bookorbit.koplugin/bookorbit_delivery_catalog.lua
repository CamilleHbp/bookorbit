local CatalogDelivery = {}
local Store = require("bookorbit_anchor_store")
local Storage = require("bookorbit_install_storage")

function CatalogDelivery.replace(catalog, path, detail, file, is_current)
    local plugin = catalog._manager
    if not plugin then return nil, "delivery_unavailable" end
    local client = catalog.client
    local options = require("bookorbit_delivery").options(plugin, client, is_current)
    if not options.is_current() then return nil, "cancelled" end
    if options.is_open(path) then require("bookorbit_reading_continuity").capture(plugin) end
    local target
    if type(file.revisionId) == "string" and type(file.sha256) == "string" and type(file.sizeBytes) == "number" then
        target = { bookFileId = file.id, bookId = detail.id, revisionId = file.revisionId, sha256 = file.sha256, sizeBytes = file.sizeBytes }
    else
        local response, err = client:request("POST", "/koreader/plugin/deliveries/targets", { bookFileIds = { file.id } })
        if not response then return nil, err end
        target = type(response.items) == "table" and #response.items == 1 and response.items[1]
    end
    if not target or target.bookFileId ~= file.id or target.bookId ~= detail.id then return nil, "revision_unavailable" end
    local registered, err = require("bookorbit_copy_registration").register(client, path, target, options)
    if not registered then return nil, err end
    if Storage.matches(registered.identity, target) then return true, nil, { hash = require("util").partialMD5(path) } end
    local record = registered.record
    if type(record.deliveryRequest) ~= "table" or record.deliveryRequest.revisionId ~= target.revisionId then
        record.deliveryRequest = { revisionId = target.revisionId, idempotencyKey = require("random").uuid(true):lower() }
        record.persistenceSequence = record.persistenceSequence + 1
        local saved
        saved, err = Store.save(record, registered.sidecarPath)
        if not saved then return nil, err end
    end
    local job
    job, err = client:request("POST", "/koreader/plugin/deliveries/copies/" .. record.inventory.id,
        { expectedRevisionId = target.revisionId, idempotencyKey = record.deliveryRequest.idempotencyKey })
    if not job then return nil, err end
    if job.pathname ~= path or job.copyId ~= record.copyId or job.revisionId ~= target.revisionId then return nil, "invalid_delivery_response" end
    if job.cancelledAt or job.failureCode then
        job, err = client:request("POST", "/koreader/plugin/deliveries/" .. job.id .. "/retry", { version = job.version })
        if not job then return nil, err end
    end
    local installed
    installed, err = require("bookorbit_delivery_runner").run(client, job, options)
    if installed then return true, nil, { hash = require("util").partialMD5(path), deliveryId = job.id } end
    if not options.is_current() then
        if err ~= "cancelled" then require("bookorbit_delivery_runner").cancel(client, job) end
        return nil, "cancelled"
    end
    if err == "waiting_for_uploads" or err == "waiting_for_close" then
        require("bookorbit_delivery").request(plugin, "catalog")
        return true, nil, { queued = true, deliveryId = job.id, delivery = { id = job.id, pathname = path, attempt = job.attempt } }
    end
    return nil, err
end

return CatalogDelivery
