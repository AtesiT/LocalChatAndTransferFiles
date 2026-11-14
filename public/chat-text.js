export const normalizeText = (value) =>
  String(value).normalize("NFKC").toLowerCase();
const word = (character) => !!character && /[\p{L}\p{N}_]/u.test(character);

// Match known room participants literally, not as a regular expression.
// Longest-name wins, including nicknames containing spaces or punctuation.
export function findMentions(text, people) {
  const names = new Map(
    people.map((person) => [normalizeText(person.name), person]),
  );
  const result = [];
  for (let start = 0; start < text.length; start++) {
    if (
      text[start] !== "@" ||
      word([...text.slice(0, start)].at(-1)) ||
      text[start - 1] === "@"
    )
      continue;
    let match = null;
    for (let end = start + 2; end <= Math.min(text.length, start + 97); end++) {
      const person = names.get(normalizeText(text.slice(start + 1, end)));
      if (
        person &&
        !word(
          end < text.length ? String.fromCodePoint(text.codePointAt(end)) : "",
        )
      )
        match = { start, end, id: person.id, name: person.name };
    }
    if (match) {
      result.push(match);
      start = match.end - 1;
    }
  }
  return result;
}

export const messageFiles = (message) =>
  message.attachments || (message.attachment ? [message.attachment] : []);
export function messagePreview(message) {
  return [
    ...(message.text ||
      messageFiles(message)
        .map((file) => file.name)
        .join(", ")),
  ]
    .slice(0, 240)
    .join("");
}
export function messageMatches(message, query) {
  if (!message) return false;
  const needle = normalizeText(query.trim());
  return (
    !needle ||
    [
      message.name,
      message.text,
      message.replyTo?.name,
      message.replyTo?.preview,
      ...messageFiles(message).map((file) => file.name),
    ].some((value) => value && normalizeText(value).includes(needle))
  );
}
