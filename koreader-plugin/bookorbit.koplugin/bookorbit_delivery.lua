local Delivery = {}

function Delivery.run(plugin)
    local Runner = require("bookorbit_delivery_runner")
    local State = require("bookorbit_delivery_state")
    local UIManager = require("ui/uimanager")
    local client = plugin:newClient()
    local account = Runner.account(client)
    local function current()
        return plugin:isLoggedIn() and Runner.account(plugin:newClient()) == account
            and require("ui/network/manager"):isConnected()
    end
    local function is_open(path)
        local reader = require("apps/reader/readerui").instance
        return reader and reader.document and reader.document.file == path
    end
    local steps = 0
    local function yield_step()
        if not current() then return false end
        steps = steps + 1
        if steps % 8 ~= 0 then return true end
        local thread = coroutine.running()
        if thread and require("ui/trapper"):isWrapped() then
            UIManager:nextTick(function()
                local ok, err = coroutine.resume(thread)
                if not ok then require("logger").warn("BookOrbit: delivery continuation failed", err) end
            end)
            coroutine.yield()
        end
        return current()
    end
    local options = { is_open = is_open, is_current = current, yield_step = yield_step,
        upload_reading = function(job, operation)
            return require("bookorbit_delivery_reading").upload(plugin, client, job, operation)
        end }
    local pending = State.list(account)
    local cursor = plugin.delivery_recovery_cursor or 0
    for _ = 1, math.min(#pending, 10) do
        if not current() then break end
        cursor = cursor % #pending + 1
        local entry = pending[cursor]
        if not is_open(entry.pathname) then
            local result, err = Runner.recover(client, entry.id, entry.pathname, options)
            if err then plugin:recordSyncError("delivery", "recovery_pending") end
            if result == false then
                local job = client:request("GET", "/koreader/plugin/deliveries/" .. entry.id)
                if job and job.id == entry.id and (job.cancelledAt or job.failureCode or job.installationState == "installed") then
                    State.remove(entry.id)
                end
            end
        end
    end
    plugin.delivery_recovery_cursor = cursor
    local route = "/koreader/plugin/deliveries?activeOnly=true&limit=10&deviceId=" .. require("socket.url").escape(client.device_id)
    if plugin.delivery_cursor then route = route .. "&cursor=" .. plugin.delivery_cursor end
    local page, err = client:request("GET", route)
    if not page then
        if err == 400 or err == 404 then plugin.delivery_cursor = nil end
        return nil, err
    end
    if type(page.items) ~= "table" or #page.items > 10 then return nil, "invalid_delivery_response" end
    plugin.delivery_cursor = type(page.nextCursor) == "string" and page.nextCursor:match("^[a-f0-9%-]+$") and #page.nextCursor == 36
        and page.nextCursor or nil
    for _, job in ipairs(page.items) do
        if not current() then return nil, "cancelled" end
        local installed, failure = Runner.run(client, job, options)
        if installed then plugin:recordSyncSuccess("delivery", require("gettext")("Book installed. Position verification is pending until first open."))
        elseif failure ~= "waiting_for_uploads" and failure ~= "waiting_for_close" then
            plugin:recordSyncError("delivery", type(failure) == "number" and "network" or "installation_pending")
        end
    end
    return true
end

function Delivery.request(plugin, source)
    if require("bookorbit_revision_capabilities").delivery < 1 or not plugin:isLoggedIn()
        or not require("ui/network/manager"):isConnected() then return false end
    if not plugin.delivery_check_scheduled then
        plugin.delivery_check_scheduled = true
        require("ui/uimanager"):scheduleIn(60, function()
            plugin.delivery_check_scheduled = false
            Delivery.request(plugin, "poll")
        end)
    end
    return plugin:submitSyncJob({ family = "revision_delivery", label = require("gettext")("Book updates"), source = source,
        priority = require("bookorbit_sync_coordinator").PRIORITY.auto, interactive = false,
        run = function() Delivery.run(plugin) end })
end

return Delivery
