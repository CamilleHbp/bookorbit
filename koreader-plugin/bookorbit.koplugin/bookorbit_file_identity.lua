local FileIdentity = {}
local MAX_BYTES = 512 * 1024 * 1024
local CHUNK_BYTES = 64 * 1024

local function same(a, b)
    return a and b and a.mode == "file" and b.mode == "file"
        and a.dev == b.dev and a.ino == b.ino and a.size == b.size
        and a.modification == b.modification and a.change == b.change
end

function FileIdentity.begin(path, options)
    options = options or {}
    local lfs = options.lfs or require("libs/libkoreader-lfs")
    local sha = options.sha or require("ffi/sha2")
    local clock = options.clock or os.time
    local before = lfs.attributes(path)
    if not before then return nil, "missing" end
    if before.mode ~= "file" or before.size < 0 or before.size > MAX_BYTES then return nil, "size_or_type" end
    local file = io.open(path, "rb")
    if not file then return nil, "retryable" end
    file:setvbuf("no")
    if not same(before, lfs.attributes(path)) then file:close(); return nil, "retryable" end
    local append = sha.sha256()
    local started, count, done = clock(), 0, false
    local first_digest
    local job = {}

    local function finish(status, result)
        if not done then file:close() end
        done = true
        return status, result
    end

    function job:cancel()
        return finish("cancelled")
    end

    function job:step()
        if done then return "closed" end
        if not same(before, lfs.attributes(path)) then return finish("retryable", "changed") end
        if clock() - started > 120 then return finish("retryable", "timeout") end
        for _ = 1, 2 do
            local chunk, err = file:read(CHUNK_BYTES)
            if not chunk then
                if err or count ~= before.size or not same(before, lfs.attributes(path)) then
                    return finish("retryable", "changed")
                end
                local digest = append()
                if not first_digest then
                    -- LFS timestamps can have only second precision on reader devices.
                    first_digest = digest
                    if not file:seek("set", 0) then return finish("retryable", "seek") end
                    append, count = sha.sha256(), 0
                    return "pending"
                end
                if digest ~= first_digest then return finish("retryable", "changed") end
                return finish("stable", { sha256 = digest, sizeBytes = count, signature = before })
            end
            count = count + #chunk
            if count > before.size or count > MAX_BYTES then return finish("retryable", "changed") end
            append(chunk)
        end
        return "pending"
    end

    return job
end

return FileIdentity
