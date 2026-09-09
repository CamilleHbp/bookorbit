local Store = {}
local MAX_BYTES = 64 * 1024

local function location(path)
    if type(path) ~= "string" or #path == 0 or #path > 4096 then return nil end
    local digest = require("ffi/sha2").sha256(path)
    local root = require("datastorage"):getSettingsDir() .. "/bookorbit-reading-anchors"
    return root .. "/" .. digest:sub(1, 2) .. "/" .. digest .. ".json", root
end

local function valid(record, path)
    return type(record) == "table" and record.path == path and type(record.anchor) == "table"
        and type(record.sha256) == "string" and #record.sha256 == 64 and record.sha256:match("^[a-f0-9]+$")
        and type(record.persistenceSequence) == "number" and record.persistenceSequence > 0
        and record.persistenceSequence <= 9007199254740991 and record.persistenceSequence % 1 == 0
end

function Store.load(path)
    local filename = location(path)
    if not filename then return nil, "invalid_path" end
    local file = io.open(filename, "rb")
    if not file then return nil end
    local bytes = file:read(MAX_BYTES + 1)
    file:close()
    if not bytes or #bytes > MAX_BYTES then return nil, "invalid_anchor_size" end
    local ok, value = pcall(require("rapidjson").decode, bytes)
    if not ok or type(value) ~= "table" or value.version ~= 1 or not valid(value.record, path) then return nil, "invalid_anchor" end
    if value.sidecarPath ~= nil and (type(value.sidecarPath) ~= "string" or #value.sidecarPath > 8192) then return nil, "invalid_sidecar_path" end
    return value
end

function Store.save(record, sidecar_path)
    if not valid(record, record and record.path) then return false, "invalid_anchor" end
    local filename, root = location(record.path)
    if not filename then return false, "invalid_path" end
    local json_ok, bytes = pcall(require("rapidjson").encode, { version = 1, record = record, sidecarPath = sidecar_path })
    if not json_ok or #bytes > MAX_BYTES then return false, "invalid_anchor_size" end
    local lfs, sync = require("libs/libkoreader-lfs"), require("ffi/util")
    local directory = filename:match("^(.*)/[^/]+$")
    for _, path in ipairs({ root, directory }) do
        if lfs.attributes(path, "mode") ~= "directory" then
            if not lfs.mkdir(path) and lfs.attributes(path, "mode") ~= "directory" then return false, "anchor_directory_failed" end
        end
        local parent = path:match("^(.*)/[^/]+$")
        if not sync.fsyncDirectory(parent) then return false, "anchor_directory_sync_failed" end
    end
    local temporary = filename .. ".tmp"
    local file = io.open(temporary, "wb")
    if not file then return false, "anchor_open_failed" end
    local ok, result = pcall(function()
        if not file:write(bytes) or not file:flush() then return false end
        return sync.fsyncOpenedFile(file) == true
    end)
    local closed = file:close()
    if not ok or not result or not closed then os.remove(temporary); return false, "anchor_sync_failed" end
    if not os.rename(temporary, filename) then os.remove(temporary); return false, "anchor_publish_failed" end
    if not sync.fsyncDirectory(directory) then return false, "anchor_directory_sync_failed" end
    return true
end

return Store
