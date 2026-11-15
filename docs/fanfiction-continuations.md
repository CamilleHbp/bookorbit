# Published volumes and web continuations

A continuation EPUB can retain only chapters beyond its published volumes on subsequent updates and full refreshes. Its OPF metadata stores a `bookorbit:chapter-floor` entry whose `content` attribute contains JSON:

```json
{
  "version": 1,
  "storyUrl": "https://www.scribblehub.com/series/623932/on-astral-tides/",
  "minimum": [525, 176],
  "extraChapterUrls": []
}
```

For ScribbleHub, the two minimum values select main chapters and side stories independently. Chapter titles can use digits or spelled English numbers. For Royal Road, a single minimum selects numbered chapters, while two values select an arc and chapter pair.

Unnumbered chapters require an explicit URL in `extraChapterUrls`. Announcements are otherwise excluded. The cutoff applies before fetching chapters, survives metadata writes, and retains the continuation's title and series position. A missing result or an invalid policy stops the update without changing the saved book.
