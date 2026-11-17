import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findMentions,
  messageMatches,
  messagePreview,
} from "../public/chat-text.js";
const people = [
  { id: "bob", name: "Bob" },
  { id: "full", name: "Bob Smith" },
  { id: "unicode", name: "Алиса" },
  { id: "punctuation", name: "a+b[.]" },
];

test("mentions match literal room names, longest first, with Unicode/case normalization", () => {
  const text = "@BOB Smith: hi @ＡＬＩＣＥ, @АЛИСА! (@a+b[.]) @bob.";
  const spans = findMentions(text, people);
  assert.deepEqual(
    spans.map((span) => span.id),
    ["full", "unicode", "punctuation", "bob"],
  );
  assert.deepEqual(
    spans.map((span) => text.slice(span.start, span.end)),
    ["@BOB Smith", "@АЛИСА", "@a+b[.]", "@bob"],
  );
  assert.equal(findMentions("@Ｂｏｂ", people)[0].id, "bob");
});

test("mentions exclude emails, unknown names, partial names and Unicode word suffixes", () => {
  for (const text of [
    "me@Bob.com",
    "@Bobby",
    "@@Bob",
    "@Bob𝒜",
    "𝒜@Bob",
    "@Unknown",
    "hello@Bob",
  ])
    assert.deepEqual(findMentions(text, people), [], text);
  assert.equal(findMentions("hi, @Bob!", people).length, 1);
  assert.deepEqual(findMentions("@Bob", []), []);
});

test("room search matches text, author, quoted context and attachment names without regex syntax", () => {
  const message = {
    name: "Алиса",
    text: "Deploy [ready]",
    attachments: [{ name: "Notes.PDF" }],
    replyTo: { name: "Bob", preview: "Original question" },
  };
  for (const query of [
    "алиса",
    "[READY]",
    "notes.pdf",
    "original",
    "bob",
    "",
    "   ",
  ])
    assert.equal(messageMatches(message, query), true);
  for (const query of ["missing", ".*", "<script>"])
    assert.equal(messageMatches(message, query), false);
  assert.equal(messageMatches({ name: "ＡＬＥＸ", text: "" }, "alex"), true);
  assert.equal(
    messageMatches({ attachment: { name: "legacy.bin" } }, "LEGACY"),
    true,
  );
});

test("reply previews are bounded, Unicode-safe and support file-only messages", () => {
  assert.equal([...messagePreview({ text: "😀".repeat(300) })].length, 240);
  assert.equal(
    messagePreview({ text: "caption", attachments: [{ name: "one" }] }),
    "caption",
  );
  assert.equal(
    messagePreview({
      text: "",
      attachments: [{ name: "one" }, { name: "two" }],
    }),
    "one, two",
  );
  assert.equal(messagePreview({ attachment: { name: "legacy" } }), "legacy");
});
