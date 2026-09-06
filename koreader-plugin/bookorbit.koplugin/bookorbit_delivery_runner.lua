local Runner = {}
local Storage = require("bookorbit_install_storage")
local Journal = require("bookorbit_install_journal")
local State = require("bookorbit_delivery_state")
local AnchorStore = require("bookorbit_anchor_store")
local function uuid(value)
    return type(value) == "string" and #value == 36 and value:match("^[a-f0-9%-]+$")
end

function Runner.account(client)
    return require("ffi/sha2").sha256(tostring(client.server_url) .. "\n" .. tostring(client.username) .. "\n" .. tostring(client.device_id))
end

local function lease_body(operation)
    return { deviceId = operation.deviceId, token = operation.lease.token, fence = operation.lease.fence }
end

function Runner.cancel(client, job)
    if not uuid(job.id) or not Storage.safePath(job.pathname) then return nil, "invalid_delivery" end
    local operation, err = State.load(job.id)
    if err then return nil, err end
    if operation and operation.account ~= Runner.account(client) then return nil, "delivery_account_mismatch" end
    operation = operation or { version = 1, id = job.id, pathname = job.pathname, account = Runner.account(client),
        deviceId = client.device_id, attempt = job.attempt, claimId = require("random").uuid(true):lower(), sequence = 0 }
    operation.cancelRequested = true
    local saved
    saved, err = State.save(operation)
    if not saved then return nil, err end
    local current
    current, err = client:request("GET", "/koreader/plugin/deliveries/" .. job.id)
    if not current then return nil, err end
    if current.id ~= job.id then return nil, "invalid_delivery_response" end
    if current.cancelledAt or current.installationState == "installed" then return current end
    return client:request("POST", "/koreader/plugin/deliveries/" .. job.id .. "/cancel", { version = current.version })
end

local function post_report(client, operation)
    if not operation.pendingReport then return true end
    local response, err = client:request("POST", "/koreader/plugin/deliveries/" .. operation.id .. "/progress", operation.pendingReport)
    if not response then return nil, err end
    if response.id ~= operation.id or response.installationState ~= operation.pendingReport.state then return nil, "invalid_delivery_response" end
    operation.pendingReport = nil
    return State.save(operation)
end

local function report(client, operation, job, state, uploaded)
    local sent, err = post_report(client, operation)
    if not sent then return nil, err end
    operation.sequence = (operation.sequence or 0) + 1
    local body = lease_body(operation)
    body.sequence, body.state, body.pathname = operation.sequence, state, job.pathname
    body.localSha256, body.localSizeBytes, body.readingUploadsComplete = job.expectedLocalSha256, job.expectedLocalSizeBytes, uploaded
    operation.pendingReport = body
    local saved
    saved, err = State.save(operation)
    if not saved then return nil, err end
    return post_report(client, operation)
end

function Runner.recover(client, id, path, options)
    options = options or {}
    local pending, load_error = Journal.load(path)
    if load_error and load_error ~= "incomplete_preparation" then return nil, load_error end
    if pending and (type(pending.receipt) ~= "table" or pending.receipt.jobId ~= id
        or pending.receipt.account ~= Runner.account(client)) then return nil, "installation_receipt_mismatch" end
    local record, err = Journal.recover(path, options)
    if err then return nil, err end
    if not record or record.phase == "aborted" or record.phase == "cleanup_complete" then return false end
    local receipt = record.receipt
    if type(receipt) ~= "table" or receipt.jobId ~= id or receipt.account ~= Runner.account(client)
        or type(receipt.report) ~= "table" then return nil, "installation_receipt_mismatch" end
    local result
    result, err = client:request("POST", "/koreader/plugin/deliveries/" .. id .. "/progress", receipt.report)
    if not result then return nil, err end
    if result.id ~= id or result.installationState ~= "installed" then return nil, "invalid_delivery_response" end
    local inventoried
    inventoried, err = require("bookorbit_copy_inventory").installed(client, result, record.target)
    if not inventoried then return nil, err end
    local cleaned
    cleaned, err = Journal.acknowledge(path)
    if not cleaned then return nil, err end
    cleaned, err = State.remove(id)
    if not cleaned then return nil, err end
    return result
end

local function execute(client, job, options)
    options = options or {}
    if not uuid(job.id) or not uuid(job.copyId) or job.deviceId ~= client.device_id or not Storage.safePath(job.pathname)
        or not options.is_open or not options.upload_reading or not options.is_current then return nil, "invalid_delivery" end
    local account = Runner.account(client)
    local operation, err = State.load(job.id)
    if err then return nil, err end
    if operation and (operation.account ~= account or operation.pathname ~= job.pathname) then return nil, "delivery_account_mismatch" end
    local previous, journal_error = Journal.load(job.pathname)
    if journal_error then return nil, journal_error end
    if previous then
        local recovered
        recovered, err = Runner.recover(client, job.id, job.pathname, options)
        if recovered or err then return recovered, err end
    end
    if job.cancelledAt or job.failureCode or job.installationState == "installed" then return nil, "delivery_inactive" end
    if operation and operation.cancelRequested and operation.attempt == job.attempt then
        return nil, "cancelled"
    end
    local backup = AnchorStore.load(job.pathname)
    local record = backup and backup.record
    if not record or record.copyId ~= job.copyId or record.anchor.bookFileId ~= job.bookFileId
        or not record.inventory or record.inventory.id ~= job.installedCopyId then return nil, "copy_not_registered" end
    if not operation or operation.attempt ~= job.attempt then
        operation = { version = 1, id = job.id, pathname = job.pathname, deviceId = client.device_id, account = account,
            attempt = job.attempt, claimId = require("random").uuid(true):lower(), sequence = 0 }
        local saved
        saved, err = State.save(operation)
        if not saved then return nil, err end
    end
    local endpoint = "/koreader/plugin/deliveries/" .. job.id
    local claimed
    claimed, err = client:request("POST", endpoint .. "/claim", { deviceId = client.device_id, claimId = operation.claimId })
    if not claimed then return nil, err end
    if not uuid(claimed.token) or type(claimed.fence) ~= "number" or type(claimed.job) ~= "table"
        or claimed.job.id ~= job.id or claimed.job.revisionId ~= job.revisionId then return nil, "invalid_delivery_response" end
    if not operation.lease or operation.lease.fence ~= claimed.fence then operation.sequence, operation.pendingReport = 0, nil end
    operation.lease = { token = claimed.token, fence = claimed.fence }
    operation.phase = "upload"
    local saved
    saved, err = State.save(operation)
    if not saved then return nil, err end
    local uploaded
    uploaded, err = options.upload_reading(job, operation)
    if not uploaded then
        if claimed.job.installationState == "waiting_for_uploads" then report(client, operation, job, "waiting_for_uploads", false) end
        return nil, err or "waiting_for_uploads"
    end
    if options.is_open(job.pathname) then
        if claimed.job.installationState == "downloading" then return nil, "waiting_for_close" end
        local waiting
        waiting, err = report(client, operation, job, "waiting_for_close", true)
        return nil, err or (waiting and "waiting_for_close" or "waiting_for_uploads")
    end
    if not options.is_current() then return nil, "cancelled" end
    local identity = Storage.identity(job.pathname, options.yield_step)
    if not Storage.matches(identity, { sha256 = job.expectedLocalSha256, sizeBytes = job.expectedLocalSizeBytes }) then return nil, "copy_changed" end
    local reported
    reported, err = report(client, operation, job, "downloading", true)
    if not reported then return nil, err end
    operation.phase = "download"
    saved, err = State.save(operation)
    if not saved then return nil, err end
    local staged = Storage.parent(job.pathname) .. "/.bookorbit-delivery-" .. job.id .. ".part"
    if not Storage.safePath(staged) then return nil, "unsafe_path" end
    local result
    result, err = client:download(endpoint .. "/download", job.pathname, {
        method = "POST", body = lease_body(operation), temp_path = staged, publish = "parent",
        expected_bytes = job.sizeBytes, max_bytes = job.sizeBytes, expect_content_type = "application/epub+zip",
    })
    if not result then return nil, err end
    operation.phase = "publication"
    saved, err = State.save(operation)
    if not saved then os.remove(staged); return nil, err end
    if options.is_open(job.pathname) or not options.is_current() then os.remove(staged); return nil, "cancelled" end
    local sidecars
    sidecars, err = require("bookorbit_install_sidecars").plan(job.pathname, staged)
    if not sidecars then os.remove(staged); return nil, err end
    local prepared
    prepared, err = Journal.prepare({ path = job.pathname, staged = staged,
        expected = { sha256 = job.expectedLocalSha256, sizeBytes = job.expectedLocalSizeBytes },
        target = { sha256 = job.sha256, sizeBytes = job.sizeBytes }, sidecars = sidecars, yield_step = options.yield_step,
        receipt = { jobId = job.id, account = account } })
    os.remove(staged)
    if not prepared then return nil, err end
    local deadline = 0
    local clock = options.clock or require("socket").gettime
    local installed
    installed, err = Journal.publish(job.pathname, {
        yield_step = options.yield_step,
        authorize = function(journal)
            if options.is_open(job.pathname) or not options.is_current() then return nil, "cancelled" end
            local started = clock()
            local permit, permit_error = client:request("POST", endpoint .. "/publication", lease_body(operation))
            if not permit then return nil, permit_error end
            if not uuid(permit.token) or permit.revisionId ~= job.revisionId or permit.sha256 ~= job.sha256
                or permit.sizeBytes ~= job.sizeBytes or type(permit.validForMs) ~= "number"
                or permit.validForMs <= 1000 or permit.validForMs > 30000 then return nil, "invalid_publication_permit" end
            deadline = started + permit.validForMs / 1000 - 1
            local proof = lease_body(operation)
            proof.sequence, proof.state, proof.pathname = operation.sequence + 1, "installed", job.pathname
            proof.localSha256, proof.localSizeBytes = job.sha256, job.sizeBytes
            proof.readingUploadsComplete, proof.publicationToken = true, permit.token
            journal.receipt.report = proof
            return true
        end,
        is_current = function()
            if clock() >= deadline then return false, "publication_permission_expired" end
            if options.is_open(job.pathname) then return false, "waiting_for_close" end
            return options.is_current()
        end,
    })
    if not installed then return nil, err end
    return Runner.recover(client, job.id, job.pathname, options)
end

function Runner.run(client, job, options)
    local result, err = execute(client, job, options)
    if result or err == "waiting_for_uploads" or err == "waiting_for_close" then return result, err end
    if err == "cancelled" then Runner.cancel(client, job); return nil, err end
    local operation = State.load(job.id)
    if operation and operation.account == Runner.account(client) and operation.lease and not Journal.load(job.pathname) and err ~= "delivery_inactive" then
        local code = err == "copy_changed" and "copy_changed" or err == "verification_failed" and "verification_failed"
            or operation.phase == "download" and "download_failed" or operation.phase == "publication" and "publication_failed" or "upload_failed"
        local body = lease_body(operation)
        body.failureCode = code
        client:request("POST", "/koreader/plugin/deliveries/" .. job.id .. "/failure", body)
    end
    return nil, err
end

return Runner
