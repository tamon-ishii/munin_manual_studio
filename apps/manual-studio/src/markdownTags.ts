const openingTag = /<!--\s*ai:(?:task|generated)\b((?:"[^"]*"|'[^']*'|[^>"'])*)-->/g;
const attributes = /(?:^|\s)([a-zA-Z][a-zA-Z0-9_-]*)=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;

/** Reads ids only from AI tag headers, never from prose or prompt bodies. */
export function collectAiTagIds(markdown: string): Set<string> {
  const ids = new Set<string>();
  for (const tag of markdown.matchAll(openingTag)) {
    for (const attribute of tag[1].matchAll(attributes)) {
      if (attribute[1] === "id") ids.add(attribute[2] ?? attribute[3] ?? attribute[4]);
    }
  }
  return ids;
}
