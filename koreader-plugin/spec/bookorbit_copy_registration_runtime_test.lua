local plugin_dir = assert(arg[1])
require("setupkoenv")
package.path = plugin_dir .. "/?.lua;" .. package.path
local root = require("datastorage"):getSettingsDir()
G_reader_settings = require("luasettings"):open(root .. "/registration-settings.lua")
local Storage = require("bookorbit_install_storage")
local Registration = require("bookorbit_copy_registration")
local Store = require("bookorbit_anchor_store")
local path = root .. "/legacy.epub"
assert(Storage.write(path, "legacy EPUB bytes"))
local settings = require("docsettings"):open(path)
settings:saveSetting("percent_finished", 0.37)
settings:saveSetting("last_xpointer", "/body/p[3]")
settings:saveSetting("annotations", { { text = "Keep my old note", note = "A legacy annotation" } })
assert(settings:flush())
local target = { bookFileId = 9, bookId = 2 }
local sent = {}
local replace_during_report = false
local client = { device_id = "registration-reader", plugin_version = "validation",
    request = function(_, method, route, body)
        assert(method == "POST" and route == "/koreader/plugin/copies")
        sent[#sent + 1] = body
        if replace_during_report then assert(Storage.write(path, "another external replacement")) end
        return { nextSequence = body.sequence + 1, copies = { { copyId = body.copies[1].copyId,
            status = "accepted", id = "ec73c821-d077-460a-b924-8b7a0655e849", policy = "notify", effectivePolicyVersion = "1:1" } } }
    end }
local options = { is_current = function() return true end }
local registered = assert(Registration.register(client, path, target, options))
assert(registered.record.anchor.event == nil and registered.record.anchor.bookFraction == 0.37)
assert(registered.record.anchor.nativeLocator.value == "/body/p[3]")
assert(sent[1].copies[1].sha256 == registered.identity.sha256)
assert(sent[1].copies[1].revisionId == nil, "legacy bytes must not be labelled with the current server revision")
assert(Store.load(path).record.copyId == registered.record.copyId)
local original_copy = registered.record.copyId
assert(Registration.register(client, path, target, options).record.copyId == original_copy)
assert(sent[2].sequence > sent[1].sequence and sent[2].copies[1].copyId == original_copy)
assert(require("docsettings"):open(path):readSetting("annotations")[1].note == "A legacy annotation")
local conflict, err = Registration.register(client, path, { bookFileId = 10, bookId = 3 }, options)
assert(not conflict and err == "copy_identity_conflict" and #sent == 2)
local other_path = root .. "/other-copy.epub"
assert(Storage.copy(path, other_path))
assert(Registration.register(client, other_path, target, options).record.copyId ~= original_copy)
replace_during_report = true
local changed
changed, err = Registration.register(client, path, target, options)
assert(not changed and err == "copy_changed")
assert(Store.load(path).record.anchor.event == nil)
print("KOReader legacy copy registration acceptance passed")
