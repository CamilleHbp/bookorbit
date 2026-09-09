local Storage = {}
local lfs = require("libs/libkoreader-lfs")
local sync = require("ffi/util")
local MAX_FILE_BYTES = 512 * 1024 * 1024

function Storage.parent(path)
    return type(path) == "string" and path:match("^(.*)/[^/]+$")
end

function Storage.safePath(path)
    if type(path) ~= "string" or #path > 8192 or path:sub(1, 1) ~= "/" or path:find("%c") then return false end
    local current = ""
    for part in path:gmatch("[^/]+") do
        if part == "." or part == ".." then return false end
        current = current .. "/" .. part
        if lfs.symlinkattributes(current, "mode") == "link" then return false end
    end
    return current == path
end

function Storage.directory(path)
    if not Storage.safePath(path) then return nil, "unsafe_path" end
    if lfs.attributes(path, "mode") == "directory" then return true end
    local parent = Storage.parent(path)
    if parent ~= "" and not Storage.directory(parent) then return nil, "directory_failed" end
    if not lfs.mkdir(path) and lfs.attributes(path, "mode") ~= "directory" then return nil, "directory_failed" end
    if not sync.fsyncDirectory(parent ~= "" and parent or "/") then return nil, "directory_sync_failed" end
    return true
end

function Storage.write(path, bytes)
    if not Storage.safePath(path) or not Storage.safePath(path .. ".tmp") then return nil, "unsafe_path" end
    local file = io.open(path .. ".tmp", "wb")
    if not file then return nil, "write_failed" end
    local ok, result = pcall(function()
        return file:write(bytes) and file:flush() and sync.fsyncOpenedFile(file) == true
    end)
    local closed = file:close()
    if not ok or not result or not closed then os.remove(path .. ".tmp"); return nil, "file_sync_failed" end
    if not os.rename(path .. ".tmp", path) then return nil, "rename_failed" end
    if not sync.fsyncDirectory(Storage.parent(path)) then return nil, "directory_sync_failed" end
    return true
end

function Storage.copy(source, destination, max_bytes)
    if not Storage.safePath(source) or not Storage.safePath(destination) then return nil, "unsafe_path" end
    local before = lfs.attributes(source)
    local limit = math.min(max_bytes or MAX_FILE_BYTES, MAX_FILE_BYTES)
    if not before or before.mode ~= "file" or before.size > limit then return nil, "invalid_source" end
    local input = io.open(source, "rb")
    if not input then return nil, "read_failed" end
    local output = io.open(destination, "wb")
    if not output then input:close(); return nil, "write_failed" end
    local ok, result = pcall(function()
        local count = 0
        while true do
            local chunk, err = input:read(64 * 1024)
            if not chunk then
                if err then return false end
                break
            end
            count = count + #chunk
            if count > limit or not output:write(chunk) then return false end
        end
        local after = lfs.attributes(source)
        return count == before.size and Storage.same(before, after)
            and output:flush() and sync.fsyncOpenedFile(output) == true
    end)
    local input_closed, output_closed = input:close(), output:close()
    if not ok or not result or not input_closed or not output_closed then return nil, "copy_failed" end
    return true
end

function Storage.same(a, b)
    return a and b and a.mode == "file" and b.mode == "file" and a.dev == b.dev and a.ino == b.ino
        and a.size == b.size and a.modification == b.modification and a.change == b.change
end

function Storage.identity(path, yield_step)
    if not Storage.safePath(path) then return nil, "unsafe_path" end
    local job, err = require("bookorbit_file_identity").begin(path)
    if not job then return nil, err end
    while true do
        local status, identity = job:step()
        if status == "stable" then return identity end
        if status ~= "pending" then return nil, status end
        if yield_step then
            local ok, continuing = pcall(yield_step)
            if not ok or continuing == false then job:cancel(); return nil, "cancelled" end
        end
    end
end

function Storage.matches(identity, expected)
    return identity and expected and identity.sha256 == expected.sha256 and identity.sizeBytes == expected.sizeBytes
end

return Storage
