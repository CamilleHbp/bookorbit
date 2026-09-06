local plugin_dir = assert(arg[1])
require("setupkoenv")
package.path = plugin_dir .. "/?.lua;" .. package.path
local Journal = require("bookorbit_install_journal")
local Storage = require("bookorbit_install_storage")
local lfs, sync = require("libs/libkoreader-lfs"), require("ffi/util")
local root = require("datastorage"):getSettingsDir() .. "/installation-tests"
assert(Storage.directory(root))
local function fixture(name)
    local directory = root .. "/" .. name
    assert(Storage.directory(directory))
    local path, staged = directory .. "/story.epub", directory .. "/download.epub"
    assert(Storage.write(path, "original EPUB bytes"))
    assert(Storage.write(staged, "new verified EPUB bytes"))
    assert(Storage.write(directory .. "/old-settings.lua", 'return { last_xpointer="old", bookmark="passage" }'))
    return { path = path, staged = staged, expected = Storage.identity(path), target = Storage.identity(staged),
        receipt = { jobId = "expected-job", eventId = "original-event", sequence = 7 },
        sidecars = { { source = directory .. "/old-settings.lua", destination = directory .. "/new.sdr/metadata.epub.lua" } } }
end
local options = { authorize = function() return true end, is_current = function() return true end }
local first = fixture("success")
assert(Journal.prepare(first))
local installed = assert(Journal.publish(first.path, options))
assert(installed.phase == "state_committed")
assert(installed.restoration == "verification_pending")
assert(installed.receipt.eventId == "original-event" and installed.receipt.sequence == 7)
assert(Storage.matches(Storage.identity(first.path), first.target))
assert(Storage.matches(Storage.identity(first.sidecars[1].source), Storage.identity(first.sidecars[1].destination)))
assert(Journal.acknowledge(first.path))
assert(not lfs.attributes(Journal.directory(first.path)))

local count = 0
local original_file_sync, original_dir_sync, original_rename = sync.fsyncOpenedFile, sync.fsyncDirectory, os.rename
local function instrument(fail_at)
    count = 0
    local function step(fn, ...)
        count = count + 1
        if count == fail_at then error("simulated process interruption") end
        return fn(...)
    end
    sync.fsyncOpenedFile = function(...) return step(original_file_sync, ...) end
    sync.fsyncDirectory = function(...) return step(original_dir_sync, ...) end
    os.rename = function(...) return step(original_rename, ...) end
end
local function restore()
    sync.fsyncOpenedFile, sync.fsyncDirectory, os.rename = original_file_sync, original_dir_sync, original_rename
end
local baseline = fixture("baseline")
instrument(0)
assert(Journal.prepare(baseline))
assert(Journal.publish(baseline.path, options))
assert(Journal.acknowledge(baseline.path))
local transitions = count
restore()
for transition = 1, transitions do
    local current = fixture("crash-" .. transition)
    instrument(transition)
    pcall(function()
        local prepared = Journal.prepare(current)
        if not prepared then return end
        local published = Journal.publish(current.path, options)
        if published then Journal.acknowledge(current.path) end
    end)
    restore()
    local recovered, err = Journal.recover(current.path, options)
    assert(not err, "transition " .. transition .. ": " .. tostring(err))
    local identity = assert(Storage.identity(current.path))
    assert(Storage.matches(identity, current.expected) or Storage.matches(identity, current.target), "never publish partial bytes")
    if Storage.matches(identity, current.target) then
        assert(Storage.matches(Storage.identity(current.sidecars[1].source), Storage.identity(current.sidecars[1].destination)), "finish sidecars after publication")
        if recovered and recovered.phase == "state_committed" then
            assert(recovered.receipt.eventId == "original-event")
            assert(Journal.acknowledge(current.path))
        end
    end
end
local cancelled = fixture("cancelled")
assert(Journal.prepare(cancelled))
local result, err = Journal.publish(cancelled.path, { authorize = options.authorize, is_current = function() return false end })
assert(not result and err == "cancelled")
assert(Journal.recover(cancelled.path).phase == "aborted")
assert(Storage.matches(Storage.identity(cancelled.path), cancelled.expected))

local changed = fixture("changed")
assert(Journal.prepare(changed))
result, err = Journal.publish(changed.path, { authorize = function()
    assert(Storage.write(changed.path, "external replacement"))
    return true
end })
assert(not result and err == "copy_changed")
result, err = Journal.recover(changed.path)
assert(not result and err == "copy_changed", "unknown external bytes must never be overwritten by recovery")

local conflict = fixture("sidecar-conflict")
assert(Storage.directory(Storage.parent(conflict.sidecars[1].destination)))
assert(Storage.write(conflict.sidecars[1].destination, "another copy's annotations"))
result, err = Journal.prepare(conflict)
assert(not result and err == "sidecar_conflict")
assert(Journal.recover(conflict.path).phase == "aborted")

local symlink = fixture("symlink")
local link = Storage.parent(symlink.path) .. "/linked.epub"
assert(lfs.link(symlink.path, link, true))
assert(not Storage.safePath(link))
print("KOReader installation journal acceptance passed: " .. transitions .. " interrupted durability transitions")
