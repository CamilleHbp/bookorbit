// The final timestamp is the end of a fiction.live API range and moves when the chapter grows.
export function chapterSourceId(url: string | undefined) {
  return url?.replace(/^(https:\/\/fiction\.live\/api\/anonkun\/chapters\/[\w-]+\/\d+)\/\d+\/?$/, '$1/');
}
