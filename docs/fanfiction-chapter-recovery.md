# Chapter recovery

Recovery data is scoped to the library, user, source, operation and verification fingerprint. It cannot substitute content from a different source or freshness check.

Each completed chapter has an independent record under `v2/chapters/<story hash>/<chapter hash>.chapter`. A record contains a bounded JSON header, compressed chapter text, its checksum and an illustration manifest. Duplicate source URLs retain their occurrence identities.

Illustrations are stored once per checkpoint by SHA-256 under `v2/images/<hash prefix>/<hash suffix>`. Each illustration and chapter record is written through a private temporary file, synced, atomically renamed and followed by a directory sync. Illustration publication precedes chapter publication. An interrupted chapter cannot appear complete. Recovery verifies checksums; missing or damaged resources cause that chapter to be fetched again.

The aggregate recovery cache is not subject to a database or individual-file size ceiling. Chapter records and individual images remain bounded by the EPUB entry limits, and completed EPUBs retain their existing archive, expansion and process limits. Existing worker cleanup removes the entire scoped recovery directory, including illustration files, after a terminal successful operation. Shared images are never removed while another saved chapter in that checkpoint may reference them.

Legacy `chapters.sqlite` databases are opened read-only when a chapter is absent from the new store. Valid chapters and their illustrations are promoted lazily after verification, without fetching them again or rewriting the old database. The legacy database remains available throughout an interrupted upgrade and is removed with the scoped directory by normal cleanup.
