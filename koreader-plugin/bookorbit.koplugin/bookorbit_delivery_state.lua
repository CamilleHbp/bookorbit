local State = {}
local Storage = require("bookorbit_install_storage")
local json = require("rapidjson")
local function filename(id)
    if type(id) ~= "string" or not id:match("^[a-f0-9%-]+$") or #id ~= 36 then return nil end
    return require("datastorage"):getSettingsDir() .. "/bookorbit-deliveries/" .. id .. ".json"
end

function State.load(id)
    local path = filename(id)
    if not path or not Storage.safePath(path) then return nil, "invalid_job" end
    local file = io.open(path, "rb")
    if not file then return nil end
    local bytes = file:read(65537)
    file:close()
    if not bytes or #bytes > 65536 then return nil, "invalid_delivery_state" end
    local ok, value = pcall(json.decode, bytes)
    if not ok or type(value) ~= "table" or value.version ~= 1 or value.id ~= id then return nil, "invalid_delivery_state" end
    return value
end

function State.save(value)
    local path = filename(value.id)
    if not path or not Storage.directory(Storage.parent(path)) then return nil, "delivery_storage_failed" end
    local ok, bytes = pcall(json.encode, value)
    if not ok or #bytes > 65536 then return nil, "invalid_delivery_state" end
    local manager = require("bookorbit_state_manager")
    local indexed, index_error = pcall(manager.mutateScoped, { global = true }, function(state)
        local pending = state.global.pendingDeliveries or {}
        local count = 0
        for _ in pairs(pending) do count = count + 1 end
        if not pending[value.id] and count >= 100 then error("delivery_capacity") end
        pending[value.id] = { pathname = value.pathname, account = value.account }
        state.global.pendingDeliveries = pending
    end)
    if not indexed then return nil, tostring(index_error) end
    return Storage.write(path, bytes)
end

function State.list(account)
    local result = {}
    for id, value in pairs(require("bookorbit_state_manager").session({ global = true }).global.pendingDeliveries or {}) do
        if value.account == account then result[#result + 1] = { id = id, pathname = value.pathname } end
        if #result >= 100 then break end
    end
    table.sort(result, function(a, b) return a.id < b.id end)
    return result
end

function State.remove(id)
    local path = filename(id)
    if not path or not Storage.safePath(path) then return nil, "invalid_job" end
    if require("libs/libkoreader-lfs").attributes(path) and not os.remove(path) then return nil, "delivery_cleanup_failed" end
    if not require("ffi/util").fsyncDirectory(Storage.parent(path)) then return nil, "delivery_cleanup_failed" end
    local ok = pcall(require("bookorbit_state_manager").mutateScoped, { global = true }, function(state)
        if state.global.pendingDeliveries then state.global.pendingDeliveries[id] = nil end
    end)
    return ok or nil, not ok and "delivery_cleanup_failed" or nil
end

return State
