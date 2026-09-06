local Sidecars = {}
local Storage = require("bookorbit_install_storage")

function Sidecars.hashDirectory(path)
    local hash = require("util").partialMD5(path)
    if type(hash) ~= "string" or #hash ~= 32 or not hash:match("^[a-fA-F0-9]+$") then return nil end
    local root = require("docsettings").getSidecarStorage("hash")
    if type(root) ~= "string" then return nil end
    return root .. "/" .. hash:sub(1, 2) .. "/" .. hash .. ".sdr"
end

function Sidecars.plan(path, staged)
    if not Storage.safePath(path) or not Storage.safePath(staged) then return nil, "unsafe_path" end
    local DocSettings = require("docsettings")
    local settings = DocSettings:open(path)
    local destination
    if G_reader_settings:readSetting("document_metadata_folder", "doc") == "hash" then
        destination = Sidecars.hashDirectory(staged)
    else
        destination = settings:getSidecarDir(path)
    end
    if not destination or not Storage.safePath(destination) then return nil, "unsafe_sidecar" end
    local entries = {}
    local function add(source, filename)
        if source then entries[#entries + 1] = { source = source, destination = destination .. "/" .. filename } end
    end
    add(settings.source_candidate, DocSettings.getSidecarFilename(path))
    local cover = settings:getCustomCoverFile()
    if cover then add(cover, cover:match("[^/]+$")) end
    local metadata = settings:getCustomMetadataFile()
    if metadata then add(metadata, "custom_metadata.lua") end
    return entries
end

function Sidecars.reassociate(ui)
    if G_reader_settings:readSetting("document_metadata_folder", "doc") ~= "hash" then return true end
    local directory = Sidecars.hashDirectory(ui.document.file)
    if not directory then return nil, "sidecar_identity_failed" end
    -- KOReader caches partial MD5 by pathname across replacements in the same process.
    ui.doc_settings.hash_sidecar_dir = directory
    local filename = directory .. "/" .. require("docsettings").getSidecarFilename(ui.document.file)
    if require("libs/libkoreader-lfs").attributes(filename, "mode") == "file" then
        local loaded = require("docsettings").openSettingsFile(filename)
        local previous = ui.doc_settings:readSetting("bookorbit_revision_anchor_v1")
        local current = loaded:readSetting("bookorbit_revision_anchor_v1")
        if type(current) == "table" and type(current.persistenceSequence) == "number"
            and (type(previous) ~= "table" or type(previous.persistenceSequence) ~= "number"
                or current.persistenceSequence >= previous.persistenceSequence) then
            ui.doc_settings.data = loaded.data
            ui.doc_settings.data.doc_path = ui.document.file
        end
    end
    return true
end

return Sidecars
