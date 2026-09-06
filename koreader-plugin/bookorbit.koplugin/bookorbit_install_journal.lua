local Journal = {}
local Storage = require("bookorbit_install_storage")
local lfs = require("libs/libkoreader-lfs")
local sync = require("ffi/util")
local json = require("rapidjson")
local MAX_SIDECARS = 16
local MAX_SIDECAR_BYTES = 16 * 1024 * 1024
local MAX_SIDECAR_TOTAL = 32 * 1024 * 1024
local MAX_JOURNAL_BYTES = 64 * 1024
local phases = { preparing = true, prepared = true, filesystem_published = true, state_committed = true, cleanup_complete = true, aborted = true }

function Journal.directory(path)
    if not Storage.safePath(path) then return nil end
    return Storage.parent(path) .. "/.bookorbit-install-" .. require("ffi/sha2").sha256(path)
end

local function identity_valid(value)
    return type(value) == "table" and type(value.sha256) == "string" and #value.sha256 == 64
        and value.sha256:match("^[a-f0-9]+$") and type(value.sizeBytes) == "number"
        and value.sizeBytes >= 0 and value.sizeBytes <= 512 * 1024 * 1024 and value.sizeBytes % 1 == 0
end

local function persist(record)
    local ok, bytes = pcall(json.encode, record)
    if not ok or #bytes > MAX_JOURNAL_BYTES then return nil, "invalid_journal_size" end
    return Storage.write(Journal.directory(record.path) .. "/journal.json", bytes)
end

function Journal.load(path)
    local directory = Journal.directory(path)
    if not directory or not Storage.safePath(directory .. "/journal.json") then return nil, "unsafe_path" end
    local file = io.open(directory .. "/journal.json", "rb")
    if not file then
        return nil, lfs.attributes(directory) and "incomplete_preparation" or nil
    end
    local bytes = file:read(MAX_JOURNAL_BYTES + 1)
    file:close()
    if not bytes or #bytes > MAX_JOURNAL_BYTES then return nil, "invalid_journal" end
    local ok, record = pcall(json.decode, bytes)
    if not ok or type(record) ~= "table" or record.version ~= 1 or record.path ~= path or not phases[record.phase]
        or not identity_valid(record.expected) or not identity_valid(record.target)
        or type(record.sidecars) ~= "table" or #record.sidecars > MAX_SIDECARS then return nil, "invalid_journal" end
    for _, entry in ipairs(record.sidecars) do
        if type(entry) ~= "table" or not Storage.safePath(entry.destination)
            or not identity_valid(entry.identity) or entry.identity.sizeBytes > MAX_SIDECAR_BYTES then return nil, "invalid_journal" end
    end
    return record
end

local function cleanup(record)
    local directory = Journal.directory(record.path)
    -- Remove the journal last, so every interrupted cleanup remains replayable.
    for _, name in ipairs({ "next.epub", "previous.epub", "journal.json.tmp" }) do
        if lfs.symlinkattributes(directory .. "/" .. name) and not os.remove(directory .. "/" .. name) then return nil, "cleanup_failed" end
    end
    for index = 1, MAX_SIDECARS do
        local path = directory .. "/sidecar-" .. index
        if lfs.symlinkattributes(path) and not os.remove(path) then return nil, "cleanup_failed" end
    end
    if not sync.fsyncDirectory(directory) then return nil, "directory_sync_failed" end
    if lfs.attributes(directory .. "/journal.json") and not os.remove(directory .. "/journal.json") then return nil, "cleanup_failed" end
    if not lfs.rmdir(directory) then return nil, "cleanup_failed" end
    if not sync.fsyncDirectory(Storage.parent(directory)) then return nil, "directory_sync_failed" end
    return true
end

function Journal.prepare(options)
    local path, staged = options.path, options.staged
    local directory = Journal.directory(path)
    if not directory or not Storage.safePath(staged) or not Storage.safePath(directory)
        or not identity_valid(options.expected) or not identity_valid(options.target)
        or Storage.matches(options.expected, options.target) then return nil, "invalid_installation" end
    local sidecars = options.sidecars or {}
    if #sidecars > MAX_SIDECARS then return nil, "too_many_sidecars" end
    if not lfs.mkdir(directory) then return nil, "installation_pending" end
    if not sync.fsyncDirectory(Storage.parent(directory)) then return nil, "directory_sync_failed" end
    local record = { version = 1, path = path, phase = "preparing", expected = options.expected,
        target = options.target, sidecars = {}, receipt = options.receipt, restoration = "verification_pending" }
    local saved, err = persist(record)
    if not saved then return nil, err end
    local current = Storage.identity(path, options.yield_step)
    if not Storage.matches(current, options.expected) then return nil, "copy_changed" end
    local candidate = Storage.identity(staged, options.yield_step)
    if not Storage.matches(candidate, options.target) then return nil, "verification_failed" end
    local copied
    copied, err = Storage.copy(staged, directory .. "/next.epub")
    if not copied then return nil, err end
    copied, err = Storage.copy(path, directory .. "/previous.epub")
    if not copied then return nil, err end
    if not Storage.matches(Storage.identity(directory .. "/previous.epub", options.yield_step), options.expected)
        or not Storage.matches(Storage.identity(directory .. "/next.epub", options.yield_step), options.target) then return nil, "copy_changed" end
    local total, destinations = 0, {}
    for index, entry in ipairs(sidecars) do
        if not Storage.safePath(entry.source) or not Storage.safePath(entry.destination)
            or destinations[entry.destination] or entry.destination == path
            or entry.destination:sub(1, #directory + 1) == directory .. "/" then return nil, "unsafe_sidecar" end
        destinations[entry.destination] = true
        local identity = Storage.identity(entry.source, options.yield_step)
        if not identity or identity.sizeBytes > MAX_SIDECAR_BYTES then return nil, "invalid_sidecar" end
        total = total + identity.sizeBytes
        if total > MAX_SIDECAR_TOTAL then return nil, "sidecar_budget_exceeded" end
        local existing = lfs.symlinkattributes(entry.destination)
        if existing and not Storage.matches(Storage.identity(entry.destination, options.yield_step), identity) then return nil, "sidecar_conflict" end
        copied, err = Storage.copy(entry.source, directory .. "/sidecar-" .. index, MAX_SIDECAR_BYTES)
        if not copied then return nil, err end
        if not Storage.matches(Storage.identity(directory .. "/sidecar-" .. index, options.yield_step), identity) then return nil, "sidecar_changed" end
        record.sidecars[index] = { destination = entry.destination, identity = { sha256 = identity.sha256, sizeBytes = identity.sizeBytes } }
    end
    record.phase = "prepared"
    saved, err = persist(record)
    if not saved then return nil, err end
    return record
end

local function finish(record, options)
    local directory = Journal.directory(record.path)
    if record.phase == "state_committed" then return record end
    record.phase = "filesystem_published"
    local saved, err = persist(record)
    if not saved then return nil, err end
    for index, entry in ipairs(record.sidecars) do
        if not Storage.matches(Storage.identity(entry.destination, options.yield_step), entry.identity) then
            if lfs.symlinkattributes(entry.destination) then return nil, "sidecar_conflict" end
            if not Storage.directory(Storage.parent(entry.destination)) then return nil, "sidecar_directory_failed" end
            local temporary = entry.destination .. ".bookorbit-install"
            local copied
            copied, err = Storage.copy(directory .. "/sidecar-" .. index, temporary, MAX_SIDECAR_BYTES)
            if not copied then return nil, err end
            if not Storage.matches(Storage.identity(temporary, options.yield_step), entry.identity) then return nil, "sidecar_changed" end
            if lfs.symlinkattributes(entry.destination) then return nil, "sidecar_conflict" end
            if not os.rename(temporary, entry.destination) then return nil, "sidecar_publish_failed" end
            if not sync.fsyncDirectory(Storage.parent(entry.destination)) then return nil, "directory_sync_failed" end
        end
    end
    if options.commit_state then
        local committed
        committed, err = options.commit_state(record)
        if not committed then return nil, err or "state_commit_failed" end
    end
    record.phase = "state_committed"
    saved, err = persist(record)
    if not saved then return nil, err end
    return record
end

function Journal.publish(path, options)
    options = options or {}
    local record, err = Journal.load(path)
    if not record then return nil, err or "installation_missing" end
    if record.phase ~= "prepared" then return nil, "recovery_required" end
    local directory = Journal.directory(path)
    if not Storage.matches(Storage.identity(directory .. "/next.epub", options.yield_step), record.target) then return nil, "verification_failed" end
    local current = Storage.identity(path, options.yield_step)
    if not Storage.matches(current, record.expected) then return nil, "copy_changed" end
    if not options.authorize then return nil, "publication_not_authorized" end
    local authorized
    authorized, err = options.authorize(record)
    if not authorized then return nil, err or "publication_not_authorized" end
    local saved
    saved, err = persist(record)
    if not saved then return nil, err end
    -- LFS timestamps can miss a same-second in-place edit while permission is requested.
    current = Storage.identity(path, options.yield_step)
    if not Storage.matches(current, record.expected) then return nil, "copy_changed" end
    if not Storage.safePath(path) or not Storage.same(current.signature, lfs.attributes(path)) then return nil, "copy_changed" end
    if options.is_current then
        local current, reason = options.is_current()
        if not current then return nil, reason or "cancelled" end
    end
    if not os.rename(directory .. "/next.epub", path) then return nil, "publication_failed" end
    if not sync.fsyncDirectory(Storage.parent(path)) then return nil, "directory_sync_failed" end
    return finish(record, options)
end

function Journal.recover(path, options)
    options = options or {}
    local record, err = Journal.load(path)
    if not record then
        if err == "incomplete_preparation" then
            local directory = Journal.directory(path)
            for name in lfs.dir(directory) do
                if name ~= "." and name ~= ".." and name ~= "journal.json.tmp" then return nil, err end
            end
            os.remove(directory .. "/journal.json.tmp")
            if not lfs.rmdir(directory) or not sync.fsyncDirectory(Storage.parent(directory)) then return nil, "cleanup_failed" end
            return { phase = "aborted", path = path }
        end
        return nil, err
    end
    if record.phase == "aborted" or record.phase == "cleanup_complete" then
        local cleaned
        cleaned, err = cleanup(record)
        return cleaned and record or nil, err
    end
    local current = options.verified_identity
    if not current or not Storage.same(current.signature, lfs.attributes(path)) then current = Storage.identity(path, options.yield_step) end
    if Storage.matches(current, record.expected) and (record.phase == "prepared" or record.phase == "preparing") then
        record.phase = "aborted"
        local saved
        saved, err = persist(record)
        if not saved then return nil, err end
        local cleaned
        cleaned, err = cleanup(record)
        return cleaned and { phase = "aborted", path = path } or nil, err
    end
    if not Storage.matches(current, record.target) then return nil, "copy_changed" end
    if record.phase == "preparing" then return nil, "incomplete_preparation" end
    return finish(record, options)
end

function Journal.acknowledge(path)
    local record, err = Journal.load(path)
    if not record then return nil, err end
    if record.phase ~= "state_committed" and record.phase ~= "cleanup_complete" then return nil, "installation_not_committed" end
    record.phase = "cleanup_complete"
    local saved
    saved, err = persist(record)
    if not saved then return nil, err end
    return cleanup(record)
end

return Journal
