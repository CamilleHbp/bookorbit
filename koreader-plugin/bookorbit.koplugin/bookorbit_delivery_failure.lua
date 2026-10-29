local Failure = {}
local State = require("bookorbit_delivery_state")
local codes = { copy_changed = true, verification_failed = true, download_failed = true,
    publication_failed = true, upload_failed = true }

function Failure.due(operation, now)
    local pending = operation.failureReport
    if not pending then return false end
    if type(pending) ~= "table" or not codes[pending.failureCode] or type(pending.attempts) ~= "number"
        or pending.attempts < 0 or pending.attempts > 16 or pending.attempts % 1 ~= 0
        or type(pending.retryAt) ~= "number" or pending.retryAt ~= pending.retryAt then
        return nil, "invalid_delivery_state"
    end
    return now >= pending.retryAt or pending.retryAt > now + 3600
end

function Failure.defer(operation, code, now)
    if not codes[code] then return nil, "invalid_delivery_failure" end
    local attempts = math.min(16, (operation.failureReport and operation.failureReport.attempts or 0) + 1)
    operation.failureReport = { failureCode = code, attempts = attempts,
        retryAt = now + math.min(3600, 15 * 2 ^ math.min(attempts, 8)) }
    return State.save(operation)
end

function Failure.post(client, operation)
    local pending = operation.failureReport
    if not pending or not operation.lease then return nil, "invalid_delivery_state" end
    local response, err = client:request("POST", "/koreader/plugin/deliveries/" .. operation.id .. "/failure", {
        deviceId = operation.deviceId, token = operation.lease.token, fence = operation.lease.fence,
        failureCode = pending.failureCode,
    })
    if not response then return nil, err end
    if response.id ~= operation.id or response.failureCode ~= pending.failureCode then return nil, "invalid_delivery_response" end
    return State.remove(operation.id)
end

return Failure
