const openingTag = /<!--\s*ai:(?:task|generated)\b([^>]*)-->/g;
const idAttribute = /(?:^|\s)id=([^\s>]+)/g;

/** Reads ids only from AI tag headers, never from prose or prompt bodies. */
export function collectAiTagIds(markdown: string): Set<string> {
  const ids = new Set<string>();
  for (const tag of markdown.matchAll(openingTag)) {
    for (const attribute of tag[1].matchAll(idAttribute)) ids.add(attribute[1]);
  }
  return ids;
}
