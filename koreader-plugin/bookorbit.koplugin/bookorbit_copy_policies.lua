local Policies = {}

function Policies.run(client)
    local capabilities = require("bookorbit_revision_capabilities")
    if capabilities.delivery < 1 or capabilities.position < 1 then return false end
    local manager = require("bookorbit_state_manager")
    local account = require("bookorbit_delivery_runner").account(client)
    local saved = manager.session({ global = true }).global.deliveryPolicyCursor
    local cursor = saved and saved.account == account and saved.cursor or nil
    local route = "/koreader/plugin/copies?limit=100&deviceId=" .. require("socket.url").escape(client.device_id)
    if cursor then route = route .. "&cursor=" .. cursor end
    local page, err = client:request("GET", route)
    if not page then
        if err == 400 or err == 404 then
            pcall(manager.mutateScoped, { global = true }, function(state) state.global.deliveryPolicyCursor = nil end)
        end
        return nil, err
    end
    if type(page.items) ~= "table" or #page.items > 100 then return nil, "invalid_policy_response" end
    local next_cursor = page.nextCursor
    if next_cursor ~= nil and next_cursor ~= require("rapidjson").null
        and (type(next_cursor) ~= "string" or #next_cursor ~= 36 or not next_cursor:match("^[a-f0-9%-]+$")) then
        return nil, "invalid_policy_response"
    end
    local store = require("bookorbit_anchor_store")
    local acknowledgements = {}
    for _, copy in ipairs(page.items) do
        if type(copy) ~= "table" or copy.deviceId ~= client.device_id or type(copy.pathname) ~= "string"
            or type(copy.id) ~= "string" or #copy.id ~= 36 or not copy.id:match("^[a-f0-9%-]+$")
            or type(copy.effectivePolicyVersion) ~= "string" or #copy.effectivePolicyVersion > 21
            or not copy.effectivePolicyVersion:match("^%d+:%d+$")
            or (copy.policy ~= "automatic" and copy.policy ~= "notify" and copy.policy ~= "ignore") then
            return nil, "invalid_policy_response"
        end
        local backup = store.load(copy.pathname)
        local record = backup and backup.record
        local inventory = record and record.inventory
        if record and record.copyId == copy.copyId and record.anchor.bookFileId == copy.bookFileId
            and inventory and inventory.id == copy.id and inventory.sha256 == copy.sha256 then
            if inventory.policyVersion ~= copy.effectivePolicyVersion or inventory.policy ~= copy.policy then
                inventory.policyVersion = copy.effectivePolicyVersion
                inventory.policy = copy.policy
                record.persistenceSequence = record.persistenceSequence + 1
                if not store.save(record, backup.sidecarPath) then return nil, "policy_persistence" end
            end
            if not copy.policyAcknowledged then
                acknowledgements[#acknowledgements + 1] = { id = copy.id, effectivePolicyVersion = copy.effectivePolicyVersion }
            end
        end
    end
    if #acknowledgements > 0 then
        local result
        result, err = client:request("POST", "/koreader/plugin/copies/policies/acknowledgements", {
            deviceId = client.device_id, copies = acknowledgements,
        })
        if not result then return nil, err end
        if type(result.accepted) ~= "table" or #result.accepted > #acknowledgements then return nil, "invalid_policy_response" end
    end
    local ok = pcall(manager.mutateScoped, { global = true }, function(state)
        state.global.deliveryPolicyCursor = { account = account, cursor = type(next_cursor) == "string" and next_cursor or nil }
    end)
    return ok or nil, not ok and "policy_persistence" or nil
end

return Policies
