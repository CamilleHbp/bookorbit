local Capabilities = require("bookorbit_capabilities")
local _ = require("gettext")
local Delivery = {}

local errors = {
    invalid = _("The server returned an invalid EPUB delivery preference. Reconnect and retry."),
    load = _("Could not load the EPUB delivery default from BookOrbit. Reconnect and retry, or choose a variant for this download."),
    migrate = _("Could not migrate the EPUB delivery preference to BookOrbit. Reconnect and retry."),
    unsupported = _("This server cannot confirm support for the requested EPUB variant. Reconnect to a compatible server and retry."),
    save = _("Could not save the EPUB delivery preference in BookOrbit. Reconnect and retry."),
    default = _("This server does not support a server default. Update BookOrbit first."),
}

function Delivery.errorText(err)
    for _, message in pairs(errors) do
        if err == message then return message end
    end
end

local function validVariant(value)
    return value == "original" or value == "audioless_epub"
end

function Delivery.key(client)
    return tostring(client.server_url) .. "|" .. tostring(client.username)
end

local function legacyPreference(settings, client)
    return (settings.catalog_delivery_profiles or {})[Delivery.key(client)]
end

function Delivery.preference(settings, client)
    local cached = client.delivery_settings
    if cached and cached.key == Delivery.key(client) then return cached.readAloudDelivery end
    local remote = (settings.catalog_delivery_server_profiles or {})[Delivery.key(client)]
    if validVariant(remote) then return remote end
    return legacyPreference(settings, client) == "original" and "original" or "audioless_epub"
end

local function remember(settings, client, body)
    if type(body) ~= "table" or not validVariant(body.readAloudDelivery) then
        return nil, errors.invalid
    end
    local profiles = settings.catalog_delivery_server_profiles or {}
    profiles[Delivery.key(client)] = body.readAloudDelivery
    settings.catalog_delivery_server_profiles = profiles
    client.delivery_settings = {
        key = Delivery.key(client), readAloudDelivery = body.readAloudDelivery,
        credentialDefault = body.credentialDefault, deviceOverride = body.deviceOverride,
    }
    return body.readAloudDelivery
end

function Delivery.refresh(settings, client)
    local body = client:getDeliverySettings()
    if not body then return nil, errors.load end
    if type(body) ~= "table" or not validVariant(body.readAloudDelivery) then return remember(settings, client, body) end
    if body.deviceConfigured == false then
        local legacy = legacyPreference(settings, client)
        body = client:setDeliverySettings(validVariant(legacy) and legacy or nil, true)
        if not body then return nil, errors.migrate end
    end
    return remember(settings, client, body)
end

function Delivery.resolve(settings, client, override)
    local supported = client.getPluginVersion and Capabilities.supports(client, "readAloudDeliveryVariants")
    if supported then
        if override then return override end
        if Capabilities.supports(client, "readAloudDeliverySettings") then return Delivery.refresh(settings, client) end
        return Delivery.preference(settings, client)
    end
    local requested = override or Delivery.preference(settings, client)
    if requested == "original" or override then
        return nil, errors.unsupported
    end
    return nil
end

function Delivery.update(settings, client, variant)
    if client.getPluginVersion and Capabilities.supports(client, "readAloudDeliverySettings") then
        local body = client:setDeliverySettings(variant, false)
        if not body then return nil, errors.save end
        return remember(settings, client, body)
    end
    if not variant then return nil, errors.default end
    local resolved, err = Delivery.resolve(settings, client, variant)
    if err then return nil, err end
    Delivery.set(settings, client, resolved)
    return resolved
end

function Delivery.set(settings, client, variant)
    local profiles = settings.catalog_delivery_profiles or {}
    profiles[Delivery.key(client)] = variant
    settings.catalog_delivery_profiles = profiles
    return profiles
end


function Delivery.reportRestoration(plugin)
    if require("bookorbit_revision_capabilities").position < 1 or not plugin:isLoggedIn()
        or not require("ui/network/manager"):isConnected() then return false end
    return plugin:submitSyncJob({ family = "revision_restoration", label = require("gettext")("Reading position"),
        priority = require("bookorbit_sync_coordinator").PRIORITY.auto, interactive = false,
        run = function() require("bookorbit_delivery_restoration").report(plugin, plugin:newClient()) end })
end

function Delivery.options(plugin, client, current_override)
    local Runner = require("bookorbit_delivery_runner")
    local UIManager = require("ui/uimanager")
    local account = Runner.account(client)
    local function current()
        return plugin:isLoggedIn() and Runner.account(plugin:newClient()) == account
            and (not current_override or current_override())
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
    return { is_open = is_open, is_current = current, yield_step = yield_step,
        upload_reading = function(job, operation)
            return require("bookorbit_delivery_reading").upload(plugin, client, job, operation)
        end }
end

function Delivery.run(plugin)
    local Runner = require("bookorbit_delivery_runner")
    local State = require("bookorbit_delivery_state")
    local client = plugin:newClient()
    local account = Runner.account(client)
    local options = Delivery.options(plugin, client)
    local policy_ok, policy_error = require("bookorbit_copy_policies").run(client)
    if not policy_ok and policy_error then plugin:recordSyncError("delivery", "policy_sync_pending") end
    local current, is_open = options.is_current, options.is_open
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
